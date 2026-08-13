// src/services/subscription.service.js — CREATE THIS FILE

const Subscription = require('../models/Subscription');
const Business = require('../models/Business');
const redis = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_KEY = (businessId) => `subscription:${businessId}`;
const CACHE_TTL = 300; // 5 minutes

/**
 * Get active subscription for business with plan details.
 * Redis-first, falls back to MongoDB.
 */
const getActiveSubscription = async (businessId) => {
  try {
    const cacheKey = CACHE_KEY(businessId);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const sub = await Subscription.findOne({ businessId, status: 'active' })
      .populate('planId')
      .lean();

    if (sub) await redis.set(cacheKey, JSON.stringify(sub), 'EX', CACHE_TTL);
    return sub || null;
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
    await Subscription.updateMany(
      { businessId, status: 'active' },
      { status: 'cancelled' }
    );

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1); // 1 month validity

    const sub = await Subscription.create({
      businessId,
      planId,
      status: options.status || 'active',
      startDate,
      endDate,
      razorpaySubscriptionId: options.razorpaySubscriptionId || null,
      razorpayPaymentId: options.razorpayPaymentId || null,
      autoRenew: options.autoRenew !== undefined ? options.autoRenew : true
    });

    // Activate business on subscription creation
    await Business.findByIdAndUpdate(businessId, { isActive: true });

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
    const now = new Date();
    logger.info('Running subscription expiry check...');

    const expiredSubs = await Subscription.find({
      status: 'active',
      endDate: { $lt: now }
    });

    logger.info(`Found ${expiredSubs.length} expired subscriptions`);

    for (const sub of expiredSubs) {
      try {
        sub.status = 'expired';
        await sub.save();

        await Business.findByIdAndUpdate(sub.businessId, { isActive: false });

        // Clear Redis caches
        await redis.del(CACHE_KEY(sub.businessId));
        const business = await Business.findById(sub.businessId).select('phoneNumberId');
        if (business?.phoneNumberId) {
          await redis.del(`tenant:${business.phoneNumberId}`);
        }

        logger.info(`Subscription expired for business ${sub.businessId}`);
      } catch (err) {
        logger.error(`Error processing expiry for sub ${sub._id}:`, err);
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
