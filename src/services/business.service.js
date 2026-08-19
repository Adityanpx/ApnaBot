const Business = require('../models/Business');
const User = require('../models/User');
const Rule = require('../models/Rule');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const RouteFare = require('../models/RouteFare');
const { generateWebhookToken } = require('../utils/crypto');
const { encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

/**
 * Get business by owner user ID
 * @param {string} ownerUserId - The owner's user ID
 * @returns {Promise<Business|null>}
 */
const getBusinessByOwnerId = async (ownerUserId) => {
  try {
    return await Business.findOne({ ownerUserId });
  } catch (error) {
    logger.error('Error in getBusinessByOwnerId:', error);
    throw error;
  }
};

/**
 * Get business by ID
 * @param {string} businessId - The business ID
 * @returns {Promise<Business|null>}
 */
const getBusinessById = async (businessId) => {
  try {
    return await Business.findById(businessId);
  } catch (error) {
    logger.error('Error in getBusinessById:', error);
    throw error;
  }
};

/**
 * Get business by phone number ID (used by webhook tenant resolution)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @returns {Promise<Business|null>}
 */
const getBusinessByPhoneNumberId = async (phoneNumberId) => {
  try {
    return await Business.findOne({ phoneNumberId });
  } catch (error) {
    logger.error('Error in getBusinessByPhoneNumberId:', error);
    throw error;
  }
};

/**
 * Create a new business
 * @param {string} ownerUserId - The owner's user ID
 * @param {Object} data - Business data
 * @returns {Promise<Business>}
 */
const createBusiness = async (ownerUserId, data) => {
  try {
    const { name, businessCategory, address, city, displayName } = data;

    // Generate webhook verify token
    const webhookVerifyToken = generateWebhookToken();

    // Create business document
    const business = await Business.create({
      name,
      businessCategory,
      address,
      city,
      displayName: displayName || name,
      ownerUserId,
      webhookVerifyToken,
      isActive: true,
      isWhatsappConnected: false
    });

    // Update owner user with businessId
    await User.findByIdAndUpdate(ownerUserId, { businessId: business._id });

    // Copy default rules from BusinessTypeTemplate
    const template = await BusinessTypeTemplate.findOne({ businessCategory });
    if (template && template.defaultRules && template.defaultRules.length > 0) {
      const rulesToCreate = template.defaultRules.map(rule => ({
        businessId: business._id,
        keyword: rule.keyword,
        matchType: rule.matchType || 'contains',
        reply: rule.reply || rule.response || '',
        replyType: rule.replyType || 'text',
        priority: rule.priority || 0,
        isActive: true,
        triggerCount: 0
      }));

      await Rule.insertMany(rulesToCreate);
      logger.info(`Created ${rulesToCreate.length} default rules for business ${business._id}`);
    }

    return business;
  } catch (error) {
    logger.error('Error in createBusiness:', error);
    throw error;
  }
};

/**
 * Update business profile
 * @param {string} businessId - The business ID
 * @param {Object} data - Fields to update
 * @returns {Promise<Business>}
 */
const updateBusiness = async (businessId, data) => {
  try {
    const allowedFields = ['name', 'displayName', 'address', 'city', 'profileImage', 'upiId', 'fallbackReply', 'welcomeMessage', 'isMenuEnabled', 'menuItems', 'enableDistanceFares', 'enableSmartFallback', 'roundTripPerDayKm', 'roundTripDriverDaEnabled', 'roundTripDriverDaAmount', 'disabledBookingFields'];
    const updateData = {};

    // Only allow updating specific fields
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    const business = await Business.findByIdAndUpdate(
      businessId,
      updateData,
      { new: true }
    );

    return business;
  } catch (error) {
    logger.error('Error in updateBusiness:', error);
    throw error;
  }
};

/**
 * Get a business's servedCities list
 * @param {string} businessId - The business ID
 * @returns {Promise<Array<string>|null>}
 */
const getServedCities = async (businessId) => {
  try {
    const business = await Business.findById(businessId).select('servedCities');
    return business ? (business.servedCities || []) : null;
  } catch (error) {
    logger.error('Error in getServedCities:', error);
    throw error;
  }
};

/**
 * Replace a business's servedCities list
 * @param {string} businessId - The business ID
 * @param {Array<string>} cities - Sanitized city list (trimmed, deduped, capped by the caller)
 * @returns {Promise<Array<string>|null>}
 */
const updateServedCities = async (businessId, cities) => {
  try {
    const business = await Business.findByIdAndUpdate(
      businessId,
      { servedCities: cities },
      { new: true }
    ).select('servedCities');
    return business ? (business.servedCities || []) : null;
  } catch (error) {
    logger.error('Error in updateServedCities:', error);
    throw error;
  }
};

/**
 * Title-case a lowercase city name for display (RouteFare stores fromCity/toCity lowercased).
 */
const toTitleCase = (str) => str.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1));

/**
 * Suggested servedCities prefill list, built from this business's active
 * RouteFare routes (unique fromCity/toCity values, title-cased for display).
 * Read-only — callers decide whether/what to save via updateServedCities.
 * @param {string} businessId - The business ID
 * @returns {Promise<Array<string>>}
 */
const getServedCitySuggestions = async (businessId) => {
  try {
    const routeFares = await RouteFare.find({ businessId, isActive: true }).select('fromCity toCity');
    const seen = new Set();
    const suggestions = [];
    for (const rf of routeFares) {
      for (const city of [rf.fromCity, rf.toCity]) {
        if (!city || seen.has(city)) continue;
        seen.add(city);
        suggestions.push(toTitleCase(city));
      }
    }
    return suggestions.sort((a, b) => a.localeCompare(b));
  } catch (error) {
    logger.error('Error in getServedCitySuggestions:', error);
    throw error;
  }
};

/**
 * Connect WhatsApp to business
 * @param {string} businessId - The business ID
 * @param {Object} data - WhatsApp connection data
 * @returns {Promise<Business>}
 */
const connectWhatsapp = async (businessId, data) => {
  try {
    const { phoneNumberId, wabaId, whatsappNumber, accessToken, displayName } = data;

    // Encrypt access token before saving
    const encryptedAccessToken = encrypt(accessToken);

    const updateData = {
      phoneNumberId,
      wabaId,
      whatsappNumber,
      accessToken: encryptedAccessToken,
      isWhatsappConnected: true
    };

    if (displayName) {
      updateData.displayName = displayName;
    }

    const business = await Business.findByIdAndUpdate(
      businessId,
      updateData,
      { new: true }
    );

    return business;
  } catch (error) {
    logger.error('Error in connectWhatsapp:', error);
    throw error;
  }
};

/**
 * Disconnect WhatsApp from business
 * @param {string} businessId - The business ID
 * @returns {Promise<Business>}
 */
const disconnectWhatsapp = async (businessId) => {
  try {
    const business = await Business.findByIdAndUpdate(
      businessId,
      {
        phoneNumberId: null,
        wabaId: null,
        whatsappNumber: null,
        accessToken: null,
        isWhatsappConnected: false
      },
      { new: true }
    );

    return business;
  } catch (error) {
    logger.error('Error in disconnectWhatsapp:', error);
    throw error;
  }
};

/**
 * Get dashboard statistics for a business
 * @param {string} businessId - The business ID
 * @returns {Promise<Object>}
 */
const getDashboardStats = async (businessId) => {
  try {
    // Get start of today
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Get current month in YYYY-MM format
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Run all queries in parallel
    const [
      todayMessageCount,
      todayInboundCount,
      todayBookingCount,
      totalCustomers,
      newCustomersToday,
      pendingBookings,
      currentMonthUsage
    ] = await Promise.all([
      // todayMessageCount
      require('../models/Message').countDocuments({
        businessId,
        createdAt: { $gte: startOfToday }
      }),
      // todayInboundCount
      require('../models/Message').countDocuments({
        businessId,
        direction: 'inbound',
        createdAt: { $gte: startOfToday }
      }),
      // todayBookingCount
      require('../models/Booking').countDocuments({
        businessId,
        createdAt: { $gte: startOfToday }
      }),
      // totalCustomers
      require('../models/Customer').countDocuments({ businessId }),
      // newCustomersToday
      require('../models/Customer').countDocuments({
        businessId,
        firstSeenAt: { $gte: startOfToday }
      }),
      // pendingBookings
      require('../models/Booking').countDocuments({
        businessId,
        status: 'pending'
      }),
      // currentMonthUsage
      require('../models/Usage').findOne({
        businessId,
        month: currentMonth
      })
    ]);

    return {
      todayMessageCount,
      todayInboundCount,
      todayBookingCount,
      totalCustomers,
      newCustomersToday,
      pendingBookings,
      currentMonthUsage: currentMonthUsage || null
    };
  } catch (error) {
    logger.error('Error in getDashboardStats:', error);
    throw error;
  }
};

module.exports = {
  getBusinessByOwnerId,
  getBusinessById,
  getBusinessByPhoneNumberId,
  createBusiness,
  updateBusiness,
  getServedCities,
  updateServedCities,
  getServedCitySuggestions,
  connectWhatsapp,
  disconnectWhatsapp,
  getDashboardStats
};
