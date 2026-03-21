// src/controllers/subscription.controller.js — CREATE THIS FILE

const Razorpay = require('razorpay');
const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
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
 * Get current plan + usage + expiry for the shop
 */
const getCurrentSubscription = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const [subscription, usage] = await Promise.all([
      Subscription.findOne({ shopId, status: { $in: ['active', 'trial'] } })
        .populate('planId')
        .lean(),
      usageService.getUsageForShop(shopId)
    ]);

    return successResponse(res, 200, {
      subscription: subscription || null,
      plan: subscription?.planId || null,
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
    const plans = await Plan.find({ isActive: true }).sort({ price: 1 });
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
    const shopId = req.user.shopId;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const plan = await Plan.findById(planId);
    if (!plan || !plan.isActive) return errorResponse(res, 404, 'Plan not found');

    const order = await razorpay.orders.create({
      amount: plan.price * 100, // paise
      currency: 'INR',
      receipt: `sub_${shopId}_${Date.now()}`,
      notes: {
        shopId: shopId.toString(),
        planId: planId.toString(),
        planName: plan.name
      }
    });

    logger.info(`Razorpay order created: ${order.id} for shop ${shopId}`);
    return successResponse(res, 200, {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      plan: {
        _id: plan._id,
        name: plan.name,
        displayName: plan.displayName,
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
    const shopId = req.user.shopId;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planId) {
      return errorResponse(res, 400, 'Missing payment verification fields');
    }

    // Verify Razorpay signature
    const expectedSig = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      logger.warn(`Invalid payment signature for shop ${shopId}`);
      return errorResponse(res, 400, 'Invalid payment signature');
    }

    // Activate subscription
    const subscription = await subscriptionService.createSubscription(shopId, planId, {
      status: 'active',
      razorpayPaymentId: razorpay_payment_id,
      razorpaySubscriptionId: razorpay_order_id
    });

    const populated = await Subscription.findById(subscription._id).populate('planId');

    logger.info(`Subscription activated for shop ${shopId}, payment ${razorpay_payment_id}`);
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
    const shopId = req.user.shopId;

    const sub = await Subscription.findOne({ shopId, status: 'active' });
    if (!sub) return errorResponse(res, 404, 'No active subscription found');
    if (!sub.autoRenew) return errorResponse(res, 400, 'Auto-renew is already disabled');

    sub.autoRenew = false;
    await sub.save();

    logger.info(`Auto-renew cancelled for shop ${shopId}`);
    return successResponse(
      res, 200, sub,
      `Auto-renew cancelled. Subscription active until ${sub.endDate.toDateString()}`
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
