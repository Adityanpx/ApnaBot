const redis = require('../config/redis');
const Usage = require('../models/Usage');
const logger = require('../utils/logger');

/**
 * Get current month key in YYYY-MM format
 */
const getCurrentMonthKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Build Redis key for usage
 * @param {string} shopId 
 * @returns {string}
 */
const getUsageKey = (shopId) => {
  const month = getCurrentMonthKey();
  return `usage:${shopId}:${month}`;
};

/**
 * Increment usage counter for a shop
 * @param {string} shopId - The shop ID
 * @param {string} type - Type: 'inbound', 'outbound', 'booking', 'paymentLink'
 * @returns {Promise<number>} - Current message count
 */
const incrementUsage = async (shopId, type) => {
  const usageKey = getUsageKey(shopId);
  const month = getCurrentMonthKey();

  try {
    // Increment counters in Redis atomically
    await redis.hincrby(usageKey, 'msgCount', 1);
    await redis.hincrby(usageKey, `${type}Count`, 1);

    // Check/set TTL (only if key is newly created)
    const ttl = await redis.ttl(usageKey);
    if (ttl === -1) {
      // Set TTL to end of current month
      const now = new Date();
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const secondsUntilEndOfMonth = Math.floor((lastDay - now) / 1000);
      await redis.expire(usageKey, secondsUntilEndOfMonth);
    }

    // Get current count
    const msgCount = await redis.hget(usageKey, 'msgCount');

    // Every 10 increments, persist to MongoDB (fire and forget)
    if (msgCount % 10 === 0) {
      Usage.findOneAndUpdate(
        { shopId, month },
        { $inc: { msgCount: 10, [`${type}Count`]: 1 } },
        { upsert: true, new: true }
      ).catch(err => logger.error('Error persisting usage to MongoDB:', err));
    }

    return msgCount;
  } catch (error) {
    logger.error('Error in incrementUsage:', error);
    throw error;
  }
};

/**
 * Check if shop has exceeded usage limit
 * @param {string} shopId - The shop ID
 * @param {number} planMsgLimit - Message limit from plan (-1 for unlimited)
 * @returns {Promise<Object>} - { allowed, current, limit }
 */
const checkUsageLimit = async (shopId, planMsgLimit) => {
  if (planMsgLimit === -1) {
    return { allowed: true, current: 0, limit: -1 };
  }

  const usageKey = getUsageKey(shopId);
  const month = getCurrentMonthKey();

  try {
    // Try to get from Redis first
    let current = await redis.hget(usageKey, 'msgCount');

    if (!current) {
      // Fall back to MongoDB
      const usageDoc = await Usage.findOne({ shopId, month });
      current = usageDoc ? usageDoc.msgCount : 0;
    }

    current = parseInt(current) || 0;

    if (current >= planMsgLimit) {
      return { allowed: false, current, limit: planMsgLimit };
    }

    return { allowed: true, current, limit: planMsgLimit };
  } catch (error) {
    logger.error('Error in checkUsageLimit:', error);
    // On error, allow the request (fail open)
    return { allowed: true, current: 0, limit: planMsgLimit };
  }
};

/**
 * Get usage for a shop
 * @param {string} shopId - The shop ID
 * @returns {Promise<Object>} - Usage stats
 */
const getUsageForShop = async (shopId) => {
  const usageKey = getUsageKey(shopId);
  const month = getCurrentMonthKey();

  try {
    // Try Redis first
    const redisData = await redis.hgetall(usageKey);

    if (redisData && Object.keys(redisData).length > 0) {
      return {
        msgCount: parseInt(redisData.msgCount) || 0,
        inboundCount: parseInt(redisData.inboundCount) || 0,
        outboundCount: parseInt(redisData.outboundCount) || 0,
        bookingCount: parseInt(redisData.bookingCount) || 0,
        paymentLinkCount: parseInt(redisData.paymentLinkCount) || 0,
        month
      };
    }

    // Fall back to MongoDB
    const usageDoc = await Usage.findOne({ shopId, month });
    
    return {
      msgCount: usageDoc ? usageDoc.msgCount : 0,
      inboundCount: usageDoc ? usageDoc.inboundCount : 0,
      outboundCount: usageDoc ? usageDoc.outboundCount : 0,
      bookingCount: usageDoc ? usageDoc.bookingCount : 0,
      paymentLinkCount: usageDoc ? usageDoc.paymentLinkCount : 0,
      month
    };
  } catch (error) {
    logger.error('Error in getUsageForShop:', error);
    return {
      msgCount: 0,
      inboundCount: 0,
      outboundCount: 0,
      bookingCount: 0,
      paymentLinkCount: 0,
      month
    };
  }
};

/**
 * Force sync Redis counts to MongoDB
 * @param {string} shopId - The shop ID
 */
const syncUsageToMongoDB = async (shopId) => {
  const usageKey = getUsageKey(shopId);
  const month = getCurrentMonthKey();

  try {
    const redisData = await redis.hgetall(usageKey);

    if (redisData && Object.keys(redisData).length > 0) {
      await Usage.findOneAndUpdate(
        { shopId, month },
        {
          $set: {
            msgCount: parseInt(redisData.msgCount) || 0,
            inboundCount: parseInt(redisData.inboundCount) || 0,
            outboundCount: parseInt(redisData.outboundCount) || 0,
            bookingCount: parseInt(redisData.bookingCount) || 0,
            paymentLinkCount: parseInt(redisData.paymentLinkCount) || 0
          }
        },
        { upsert: true, new: true }
      );
      logger.info(`Usage synced to MongoDB for shop ${shopId}`);
    }
  } catch (error) {
    logger.error('Error in syncUsageToMongoDB:', error);
    throw error;
  }
};

module.exports = {
  incrementUsage,
  checkUsageLimit,
  getUsageForShop,
  syncUsageToMongoDB,
  getCurrentMonthKey
};
