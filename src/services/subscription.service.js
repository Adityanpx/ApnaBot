// src/services/subscription.service.js — CREATE THIS FILE

const Subscription = require('../models/Subscription');
const Shop = require('../models/Shop');
const redis = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_KEY = (shopId) => `subscription:${shopId}`;
const CACHE_TTL = 300; // 5 minutes

/**
 * Get active subscription for shop with plan details.
 * Redis-first, falls back to MongoDB.
 */
const getActiveSubscription = async (shopId) => {
  try {
    const cacheKey = CACHE_KEY(shopId);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const sub = await Subscription.findOne({ shopId, status: 'active' })
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
const invalidateSubscriptionCache = async (shopId) => {
  try {
    await redis.del(CACHE_KEY(shopId));
    logger.info(`Subscription cache cleared for shop ${shopId}`);
  } catch (error) {
    logger.error('Error clearing subscription cache:', error);
  }
};

/**
 * Create a new subscription (trial or paid).
 * Cancels any existing active subscription first.
 */
const createSubscription = async (shopId, planId, options = {}) => {
  try {
    // Cancel existing active subscriptions
    await Subscription.updateMany(
      { shopId, status: 'active' },
      { status: 'cancelled' }
    );

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1); // 1 month validity

    const sub = await Subscription.create({
      shopId,
      planId,
      status: options.status || 'active',
      startDate,
      endDate,
      razorpaySubscriptionId: options.razorpaySubscriptionId || null,
      razorpayPaymentId: options.razorpayPaymentId || null,
      autoRenew: options.autoRenew !== undefined ? options.autoRenew : true
    });

    // Activate shop on subscription creation
    await Shop.findByIdAndUpdate(shopId, { isActive: true });

    await invalidateSubscriptionCache(shopId);

    logger.info(`Subscription created for shop ${shopId}, plan ${planId}`);
    return sub;
  } catch (error) {
    logger.error('Error in createSubscription:', error);
    throw error;
  }
};

/**
 * Daily expiry check — called by cron job in server.js
 * Expires subscriptions past endDate, deactivates shops
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

        await Shop.findByIdAndUpdate(sub.shopId, { isActive: false });

        // Clear Redis caches
        await redis.del(CACHE_KEY(sub.shopId));
        const shop = await Shop.findById(sub.shopId).select('phoneNumberId');
        if (shop?.phoneNumberId) {
          await redis.del(`tenant:${shop.phoneNumberId}`);
        }

        logger.info(`Subscription expired for shop ${sub.shopId}`);
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
