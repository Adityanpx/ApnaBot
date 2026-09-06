// src/services/razorpaySubscriptions.service.js
const Razorpay = require('razorpay');
const config = require('../config/env');
const logger = require('../utils/logger');
const supabase = require('../config/supabase');

const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * Look up plan.razorpay_plan_ids[pricePaise]; create + persist a new
 * Razorpay Plan if that price hasn't been mapped yet. Persist via the
 * set_razorpay_plan_id RPC (atomic jsonb merge against the live row) so a
 * concurrent request for the same (plan, price) pair never creates two
 * Razorpay Plans for it — supabase-js's .update() can't reference a
 * column's own current value, hence the RPC.
 */
const getOrCreateRazorpayPlan = async (plan, pricePaise) => {
  const priceKey = String(pricePaise);
  const existingId = plan.razorpay_plan_ids?.[priceKey];
  if (existingId) return existingId;

  const created = await razorpay.plans.create({
    period: 'monthly',
    interval: 1,
    item: {
      name: `${plan.display_name} — Monthly`,
      amount: pricePaise,
      currency: 'INR',
      description: `Monthly autopay for ${plan.display_name}`
    },
    notes: {
      apnabot_plan_id: plan.id,
      price_paise: priceKey
    }
  });

  const { error } = await supabase.rpc('set_razorpay_plan_id', {
    p_plan_id: plan.id,
    p_price_key: priceKey,
    p_rzp_plan_id: created.id
  });
  if (error) throw error;

  logger.info(`Created Razorpay plan ${created.id} for plan ${plan.id} at ${pricePaise} paise`);
  return created.id;
};

/**
 * Create a Razorpay Subscription — this is what the customer authorizes.
 * total_count = number of billing cycles; caller passes 120 (10 years) for
 * "until cancelled". start_at is a unix timestamp; omit for immediate
 * first-cycle start.
 */
const createRazorpaySubscription = async ({ razorpayPlanId, totalCount, startAt, notes }) => {
  const sub = await razorpay.subscriptions.create({
    plan_id: razorpayPlanId,
    total_count: totalCount,
    quantity: 1,
    customer_notify: 1,
    start_at: startAt || undefined,
    notes: notes || {}
  });

  logger.info(`Created Razorpay subscription ${sub.id} for plan ${razorpayPlanId}`);
  return sub;
};

/**
 * Cancel a Razorpay Subscription. cancelAtCycleEnd=true keeps the current
 * billing period active and stops future charges; omit/false cancels
 * immediately. NOTE: the SDK takes an options object ({cancel_at_cycle_end})
 * as the second arg, not a raw 0/1 int — verified against razorpay-node's
 * own docs (documents/subscription.md) before writing this.
 * Idempotent: a 400 "subscription already cancelled/completed" from
 * Razorpay is treated as success.
 */
const cancelRazorpaySubscription = async (razorpaySubscriptionId, { cancelAtCycleEnd } = {}) => {
  try {
    const cancelled = cancelAtCycleEnd
      ? await razorpay.subscriptions.cancel(razorpaySubscriptionId, { cancel_at_cycle_end: true })
      : await razorpay.subscriptions.cancel(razorpaySubscriptionId);
    logger.info(`Cancelled Razorpay subscription ${razorpaySubscriptionId} (cancelAtCycleEnd=${!!cancelAtCycleEnd})`);
    return cancelled;
  } catch (error) {
    const description = error?.error?.description || error?.description || '';
    if (/already\s+(cancelled|canceled)|already been cancelled|completed/i.test(description)) {
      logger.info(`Razorpay subscription ${razorpaySubscriptionId} already cancelled — treating as success`);
      return null;
    }
    throw error;
  }
};

/**
 * Fetch a Razorpay Subscription's current state. Used by admin diagnostics
 * and by the webhook handler when it needs to reconfirm state.
 */
const fetchRazorpaySubscription = async (razorpaySubscriptionId) => {
  return razorpay.subscriptions.fetch(razorpaySubscriptionId);
};

module.exports = {
  getOrCreateRazorpayPlan,
  createRazorpaySubscription,
  cancelRazorpaySubscription,
  fetchRazorpaySubscription
};
