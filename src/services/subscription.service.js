const supabase = require('../config/supabase');
const redis = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_KEY = (businessId) => `subscription:${businessId}`;
const CACHE_TTL = 300; // 5 minutes

/**
 * Get active subscription for business with plan details.
 * Redis-first, falls back to Supabase.
 */
const getActiveSubscription = async (businessId) => {
  try {
    const cacheKey = CACHE_KEY(businessId);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Ordered multi-row select instead of .maybeSingle() — defense in
    // depth. A write-path bug (or a manual DB edit, or a migration) could
    // leave 2+ 'active' rows for a business; .maybeSingle() throws
    // PGRST116 on that instead of returning one, which took down SG
    // Travels' webhook on 2026-08-31. Take the most recent instead of
    // failing, but log it so the underlying duplicate is still visible.
    const { data: subs, error } = await supabase
      .from('subscriptions')
      .select('*, plan:plans(*)')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .order('created_at', { ascending: false });
    if (error) throw error;

    if (subs && subs.length > 1) {
      logger.warn(`Business ${businessId} has ${subs.length} active subscriptions — using most recent (${subs[0].id}, created_at ${subs[0].created_at}). Duplicate-active-row state should be investigated.`);
    }

    const sub = subs && subs.length > 0 ? subs[0] : null;

    if (sub) await redis.set(cacheKey, JSON.stringify(sub), 'EX', CACHE_TTL);
    return sub;
  } catch (error) {
    logger.error('Error in getActiveSubscription:', error);
    throw error;
  }
};

/**
 * Invalidate subscription cache — call after any subscription change
 */
const invalidateSubscriptionCache = async (businessId) => {
  try {
    await redis.del(CACHE_KEY(businessId));
    logger.info(`Subscription cache cleared for business ${businessId}`);
  } catch (error) {
    logger.error('Error clearing subscription cache:', error);
  }
};

/**
 * Create a new subscription (trial or paid).
 * Cancels any existing active subscription first.
 */
const createSubscription = async (businessId, planId, options = {}) => {
  try {
    // Cancel existing active subscriptions
    const { error: cancelErr } = await supabase
      .from('subscriptions')
      .update({ status: 'cancelled' })
      .eq('business_id', businessId)
      .eq('status', 'active');
    if (cancelErr) throw cancelErr;

    const durationMonths = options.durationMonths || 1;
    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + durationMonths);

    const { data: sub, error } = await supabase
      .from('subscriptions')
      .insert({
        business_id: businessId,
        plan_id: planId,
        status: options.status || 'active',
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        razorpay_subscription_id: options.razorpaySubscriptionId || null,
        razorpay_payment_id: options.razorpayPaymentId || null,
        auto_renew: options.autoRenew !== undefined ? options.autoRenew : true
      })
      .select()
      .single();
    if (error) throw error;

    // Activate business on subscription creation
    const { error: bizErr } = await supabase
      .from('businesses').update({ is_active: true }).eq('id', businessId);
    if (bizErr) throw bizErr;

    await invalidateSubscriptionCache(businessId);

    logger.info(`Subscription created for business ${businessId}, plan ${planId}`);
    return sub;
  } catch (error) {
    logger.error('Error in createSubscription:', error);
    throw error;
  }
};

/**
 * Daily expiry check — called by cron job in server.js
 * Expires subscriptions past endDate, deactivates businesses
 */
const runExpiryCheck = async () => {
  try {
    const now = new Date().toISOString();
    logger.info('Running subscription expiry check...');

    const { data: expiredSubs, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('status', 'active')
      .lt('end_date', now);
    if (error) throw error;

    logger.info(`Found ${expiredSubs.length} expired subscriptions`);

    for (const sub of expiredSubs) {
      try {
        const { error: subErr } = await supabase
          .from('subscriptions').update({ status: 'expired' }).eq('id', sub.id);
        if (subErr) throw subErr;

        const { error: bizErr } = await supabase
          .from('businesses').update({ is_active: false }).eq('id', sub.business_id);
        if (bizErr) throw bizErr;

        // Clear Redis caches
        await redis.del(CACHE_KEY(sub.business_id));

        const { data: business } = await supabase
          .from('businesses').select('phone_number_id').eq('id', sub.business_id).maybeSingle();
        if (business?.phone_number_id) {
          await redis.del(`tenant:${business.phone_number_id}`);
        }

        logger.info(`Subscription expired for business ${sub.business_id}`);
      } catch (err) {
        logger.error(`Error processing expiry for sub ${sub.id}:`, err);
      }
    }

    return expiredSubs.length;
  } catch (error) {
    logger.error('Error in runExpiryCheck:', error);
    throw error;
  }
};

module.exports = {
  getActiveSubscription,
  invalidateSubscriptionCache,
  createSubscription,
  runExpiryCheck
};
