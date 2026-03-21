const Shop = require('../models/Shop');
const Subscription = require('../models/Subscription');
const redis = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Resolve shop by phone number ID (used by webhook tenant resolution)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @returns {Promise<Object|null>}
 */
const resolveShopByPhoneNumberId = async (phoneNumberId) => {
  try {
    const cacheKey = `tenant:${phoneNumberId}`;

    // Step 1: Check Redis cache
    const cachedTenant = await redis.get(cacheKey);
    if (cachedTenant) {
      logger.info(`Tenant cache hit for phoneNumberId: ${phoneNumberId}`);
      return JSON.parse(cachedTenant);
    }

    // Step 2: Cache miss - query DB
    const shop = await Shop.findOne({ 
      phoneNumberId, 
      isActive: true 
    }).populate('ownerUserId', 'name email');

    if (!shop) {
      logger.warn(`No shop found for phoneNumberId: ${phoneNumberId}`);
      return null;
    }

    // Step 3: Load active subscription for shop
    const subscription = await Subscription.findOne({ 
      shopId: shop._id, 
      status: 'active' 
    }).populate('planId');

    // Step 4: Build tenant object
    const tenant = {
      shopId: shop._id,
      shopName: shop.name,
      phoneNumberId: shop.phoneNumberId,
      accessToken: shop.accessToken, // Still encrypted here
      fallbackReply: shop.fallbackReply,
      businessType: shop.businessType,
      isActive: shop.isActive,
      subscription: subscription || null,
      plan: subscription ? subscription.planId : null
    };

    // Step 5: Store in Redis with 1 hour TTL
    await redis.set(cacheKey, JSON.stringify(tenant), 'EX', 3600);
    logger.info(`Tenant cached for phoneNumberId: ${phoneNumberId}`);

    return tenant;
  } catch (error) {
    logger.error('Error in resolveShopByPhoneNumberId:', error);
    throw error;
  }
};

/**
 * Invalidate tenant cache when shop WhatsApp connection changes
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 */
const invalidateTenantCache = async (phoneNumberId) => {
  try {
    const cacheKey = `tenant:${phoneNumberId}`;
    await redis.del(cacheKey);
    logger.info(`Tenant cache invalidated for phoneNumberId: ${phoneNumberId}`);
  } catch (error) {
    logger.error('Error in invalidateTenantCache:', error);
    throw error;
  }
};

module.exports = {
  resolveShopByPhoneNumberId,
  invalidateTenantCache
};
