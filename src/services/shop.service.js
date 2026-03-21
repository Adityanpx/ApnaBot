const Shop = require('../models/Shop');
const User = require('../models/User');
const Rule = require('../models/Rule');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const { generateWebhookToken } = require('../utils/crypto');
const { encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

/**
 * Get shop by owner user ID
 * @param {string} ownerUserId - The owner's user ID
 * @returns {Promise<Shop|null>}
 */
const getShopByOwnerId = async (ownerUserId) => {
  try {
    return await Shop.findOne({ ownerUserId });
  } catch (error) {
    logger.error('Error in getShopByOwnerId:', error);
    throw error;
  }
};

/**
 * Get shop by ID
 * @param {string} shopId - The shop ID
 * @returns {Promise<Shop|null>}
 */
const getShopById = async (shopId) => {
  try {
    return await Shop.findById(shopId);
  } catch (error) {
    logger.error('Error in getShopById:', error);
    throw error;
  }
};

/**
 * Get shop by phone number ID (used by webhook tenant resolution)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @returns {Promise<Shop|null>}
 */
const getShopByPhoneNumberId = async (phoneNumberId) => {
  try {
    return await Shop.findOne({ phoneNumberId });
  } catch (error) {
    logger.error('Error in getShopByPhoneNumberId:', error);
    throw error;
  }
};

/**
 * Create a new shop
 * @param {string} ownerUserId - The owner's user ID
 * @param {Object} data - Shop data
 * @returns {Promise<Shop>}
 */
const createShop = async (ownerUserId, data) => {
  try {
    const { name, businessType, address, city, displayName } = data;

    // Generate webhook verify token
    const webhookVerifyToken = generateWebhookToken();

    // Create shop document
    const shop = await Shop.create({
      name,
      businessType,
      address,
      city,
      displayName: displayName || name,
      ownerUserId,
      webhookVerifyToken,
      isActive: true,
      isWhatsappConnected: false
    });

    // Update owner user with shopId
    await User.findByIdAndUpdate(ownerUserId, { shopId: shop._id });

    // Copy default rules from BusinessTypeTemplate
    const template = await BusinessTypeTemplate.findOne({ businessType });
    if (template && template.defaultRules && template.defaultRules.length > 0) {
      const rulesToCreate = template.defaultRules.map(rule => ({
        shopId: shop._id,
        keyword: rule.keyword,
        matchType: rule.matchType || 'contains',
        reply: rule.reply || rule.response || '',
        replyType: rule.replyType || 'text',
        priority: rule.priority || 0,
        isActive: true,
        triggerCount: 0
      }));
      
      await Rule.insertMany(rulesToCreate);
      logger.info(`Created ${rulesToCreate.length} default rules for shop ${shop._id}`);
    }

    return shop;
  } catch (error) {
    logger.error('Error in createShop:', error);
    throw error;
  }
};

/**
 * Update shop profile
 * @param {string} shopId - The shop ID
 * @param {Object} data - Fields to update
 * @returns {Promise<Shop>}
 */
const updateShop = async (shopId, data) => {
  try {
    const allowedFields = ['name', 'displayName', 'address', 'city', 'profileImage', 'upiId', 'fallbackReply'];
    const updateData = {};
    
    // Only allow updating specific fields
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    }

    const shop = await Shop.findByIdAndUpdate(
      shopId,
      updateData,
      { new: true }
    );

    return shop;
  } catch (error) {
    logger.error('Error in updateShop:', error);
    throw error;
  }
};

/**
 * Connect WhatsApp to shop
 * @param {string} shopId - The shop ID
 * @param {Object} data - WhatsApp connection data
 * @returns {Promise<Shop>}
 */
const connectWhatsapp = async (shopId, data) => {
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

    const shop = await Shop.findByIdAndUpdate(
      shopId,
      updateData,
      { new: true }
    );

    return shop;
  } catch (error) {
    logger.error('Error in connectWhatsapp:', error);
    throw error;
  }
};

/**
 * Disconnect WhatsApp from shop
 * @param {string} shopId - The shop ID
 * @returns {Promise<Shop>}
 */
const disconnectWhatsapp = async (shopId) => {
  try {
    const shop = await Shop.findByIdAndUpdate(
      shopId,
      {
        phoneNumberId: null,
        wabaId: null,
        whatsappNumber: null,
        accessToken: null,
        isWhatsappConnected: false
      },
      { new: true }
    );

    return shop;
  } catch (error) {
    logger.error('Error in disconnectWhatsapp:', error);
    throw error;
  }
};

/**
 * Get dashboard statistics for a shop
 * @param {string} shopId - The shop ID
 * @returns {Promise<Object>}
 */
const getDashboardStats = async (shopId) => {
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
        shopId,
        createdAt: { $gte: startOfToday }
      }),
      // todayInboundCount
      require('../models/Message').countDocuments({
        shopId,
        direction: 'inbound',
        createdAt: { $gte: startOfToday }
      }),
      // todayBookingCount
      require('../models/Booking').countDocuments({
        shopId,
        createdAt: { $gte: startOfToday }
      }),
      // totalCustomers
      require('../models/Customer').countDocuments({ shopId }),
      // newCustomersToday
      require('../models/Customer').countDocuments({
        shopId,
        firstSeenAt: { $gte: startOfToday }
      }),
      // pendingBookings
      require('../models/Booking').countDocuments({
        shopId,
        status: 'pending'
      }),
      // currentMonthUsage
      require('../models/Usage').findOne({
        shopId,
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
  getShopByOwnerId,
  getShopById,
  getShopByPhoneNumberId,
  createShop,
  updateShop,
  connectWhatsapp,
  disconnectWhatsapp,
  getDashboardStats
};
