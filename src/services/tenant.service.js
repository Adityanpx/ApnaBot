const Business = require('../models/Business');
const Subscription = require('../models/Subscription');
const redis = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Resolve business by phone number ID (used by webhook tenant resolution)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @returns {Promise<Object|null>}
 */
const resolveBusinessByPhoneNumberId = async (phoneNumberId) => {
  try {
    const cacheKey = `tenant:${phoneNumberId}`;

    // Step 1: Check Redis cache
    const cachedTenant = await redis.get(cacheKey);
    if (cachedTenant) {
      logger.info(`Tenant cache hit for phoneNumberId: ${phoneNumberId}`);
      return JSON.parse(cachedTenant);
    }

    // Step 2: Cache miss - query DB
    const business = await Business.findOne({
      phoneNumberId,
      isActive: true
    }).populate('ownerUserId', 'name email');

    if (!business) {
      logger.warn(`No business found for phoneNumberId: ${phoneNumberId}`);
      return null;
    }

    // Step 3: Load active subscription for business
    const subscription = await Subscription.findOne({
      businessId: business._id,
      status: 'active'
    }).populate('planId');

    // Step 4: Build tenant object
    const tenant = {
      businessId: business._id,
      businessName: business.name,
      displayName: business.displayName,
      phoneNumberId: business.phoneNumberId,
      accessToken: business.accessToken, // Still encrypted here
      fallbackReply: business.fallbackReply,
      enableSmartFallback: business.enableSmartFallback,
      businessCategory: business.businessCategory,
      isActive: business.isActive,
      subscription: subscription || null,
      plan: subscription ? subscription.planId : null
    };

    // Step 5: Store in Redis with 1 hour TTL
    await redis.set(cacheKey, JSON.stringify(tenant), 'EX', 3600);
    logger.info(`Tenant cached for phoneNumberId: ${phoneNumberId}`);

    return tenant;
  } catch (error) {
    logger.error('Error in resolveBusinessByPhoneNumberId:', error);
    throw error;
  }
};

/**
 * Invalidate tenant cache when business WhatsApp connection changes
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
  resolveBusinessByPhoneNumberId,
  invalidateTenantCache
};
