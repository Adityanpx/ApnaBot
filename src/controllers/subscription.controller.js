const Razorpay = require('razorpay');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const subscriptionService = require('../services/subscription.service');
const usageService = require('../services/usage.service');
const { successResponse, errorResponse } = require('../utils/response');
const config = require('../config/env');
const logger = require('../utils/logger');

const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * GET /api/subscription
 * Get current plan + usage + expiry for the business
 */
const getCurrentSubscription = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const [subResult, usage] = await Promise.all([
      supabase
        .from('subscriptions')
        .select('*, plan:plans(*)')
        .eq('business_id', businessId)
        .in('status', ['active', 'trial'])
        .maybeSingle(),
      usageService.getUsageForBusiness(businessId)
    ]);

    if (subResult.error) throw subResult.error;
    const subscription = subResult.data;

    return successResponse(res, 200, {
      subscription: subscription || null,
      plan: subscription?.plan || null,
      usage,
      isActive: !!subscription
    });
  } catch (error) {
    logger.error('Error in getCurrentSubscription:', error);
    next(error);
  }
};

/**
 * GET /api/subscription/plans
 * List all available active plans
 */
const getPlans = async (req, res, next) => {
  try {
    const { data: plans, error } = await supabase
      .from('plans')
      .select('*')
      .eq('is_active', true)
      .order('price', { ascending: true });
    if (error) throw error;
    return successResponse(res, 200, { plans });
  } catch (error) {
    logger.error('Error in getPlans:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/create
 * Create a Razorpay order for subscription payment
 */
const createSubscriptionOrder = async (req, res, next) => {
  try {
    const { planId } = req.body;
    const businessId = req.user.businessId;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const { data: plan } = await supabase.from('plans').select('*').eq('id', planId).maybeSingle();
    if (!plan || !plan.is_active) return errorResponse(res, 404, 'Plan not found');

    const order = await razorpay.orders.create({
      amount: plan.price * 100, // paise
      currency: 'INR',
      receipt: `sub_${Date.now()}`, // Max 40 chars: "sub_" + 13 digits = 17 chars
      notes: {
        businessId: businessId.toString(),
        planId: planId.toString(),
        planName: plan.name
      }
    });

    logger.info(`Razorpay order created: ${order.id} for business ${businessId}`);
    return successResponse(res, 200, {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      plan: {
        _id: plan.id,
        name: plan.name,
        displayName: plan.display_name,
        price: plan.price
      }
    });
  } catch (error) {
    logger.error('Error in createSubscriptionOrder:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/verify
 * Verify Razorpay payment signature and activate subscription
 */
const verifyAndActivate = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId
    } = req.body;
    const businessId = req.user.businessId;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planId) {
      return errorResponse(res, 400, 'Missing payment verification fields');
    }

    // Verify Razorpay signature
    const expectedSig = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      logger.warn(`Invalid payment signature for business ${businessId}`);
      return errorResponse(res, 400, 'Invalid payment signature');
    }

    // Activate subscription
    const subscription = await subscriptionService.createSubscription(businessId, planId, {
      status: 'active',
      razorpayPaymentId: razorpay_payment_id,
      razorpaySubscriptionId: razorpay_order_id
    });

    const { data: populated, error } = await supabase
      .from('subscriptions')
      .select('*, plan:plans(*)')
      .eq('id', subscription.id)
      .single();
    if (error) throw error;

    logger.info(`Subscription activated for business ${businessId}, payment ${razorpay_payment_id}`);
    return successResponse(res, 200, { subscription: populated }, 'Subscription activated successfully');
  } catch (error) {
    logger.error('Error in verifyAndActivate:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/cancel
 * Disable auto-renew. Subscription stays active until endDate.
 */
const cancelAutoRenew = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data: sub } = await supabase
      .from('subscriptions').select('*').eq('business_id', businessId).eq('status', 'active').maybeSingle();
    if (!sub) return errorResponse(res, 404, 'No active subscription found');
    if (!sub.auto_renew) return errorResponse(res, 400, 'Auto-renew is already disabled');

    const { data: updated, error } = await supabase
      .from('subscriptions').update({ auto_renew: false }).eq('id', sub.id).select().single();
    if (error) throw error;

    logger.info(`Auto-renew cancelled for business ${businessId}`);
    return successResponse(
      res, 200, updated,
      `Auto-renew cancelled. Subscription active until ${new Date(updated.end_date).toDateString()}`
    );
  } catch (error) {
    logger.error('Error in cancelAutoRenew:', error);
    next(error);
  }
};

module.exports = {
  getCurrentSubscription,
  getPlans,
  createSubscriptionOrder,
  verifyAndActivate,
  cancelAutoRenew
};
