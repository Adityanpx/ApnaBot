const shopService = require('../services/shop.service');
const tenantService = require('../services/tenant.service');
const { successResponse, errorResponse } = require('../utils/response');
const { generateTokens, saveTokenToRedis } = require('../services/auth.service');
const logger = require('../utils/logger');
const cloudinary = require('../services/cloudinary.service');

// Valid business types
const VALID_BUSINESS_TYPES = [
  'tailor',
  'salon',
  'garage',
  'cab',
  'coaching',
  'gym',
  'medical',
  'general'
];

/**
 * GET /api/shop
 * Get the logged-in owner's shop profile
 */
const getShop = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    if (!shopId) {
      return successResponse(res, 200, null, 'No shop created yet');
    }

    const shop = await shopService.getShopByOwnerId(req.user.userId);

    if (!shop) {
      return errorResponse(res, 404, 'Shop not found');
    }

    // Remove accessToken from response (never expose it)
    const shopData = shop.toObject();
    delete shopData.accessToken;

    return successResponse(res, 200, shopData);
  } catch (error) {
    logger.error('Error in getShop:', error);
    next(error);
  }
};

/**
 * POST /api/shop
 * Create shop (only if user does not have one yet)
 */
const createShop = async (req, res, next) => {
  try {
    const { name, businessType, displayName, address, city } = req.body;

    // Check if user already has a shop
    if (req.user.shopId) {
      return errorResponse(res, 409, 'You already have a shop. Use PUT /api/shop to update it.');
    }

    // Validate required fields
    if (!name) {
      return errorResponse(res, 400, 'Shop name is required');
    }

    if (!businessType) {
      return errorResponse(res, 400, 'Business type is required');
    }

    // Validate business type
    if (!VALID_BUSINESS_TYPES.includes(businessType)) {
      return errorResponse(res, 400, `Invalid business type. Must be one of: ${VALID_BUSINESS_TYPES.join(', ')}`);
    }

    // Create shop
    const shop = await shopService.createShop(req.user.userId, {
      name,
      businessType,
      displayName,
      address,
      city
    });

    // Generate new tokens with shopId
    const userPayload = {
      userId: req.user.userId,
      email: req.user.email,
      role: req.user.role,
      shopId: shop._id
    };

    const { accessToken, refreshToken } = await generateTokens(userPayload);

    // Save refresh token to Redis
    await saveTokenToRedis(req.user.userId, refreshToken);

    // Remove accessToken from shop data
    const shopData = shop.toObject();
    delete shopData.accessToken;

    return successResponse(res, 201, {
      shop: shopData,
      accessToken,
      refreshToken,
      message: 'Shop created successfully. Default rules have been added based on your business type.'
    });
  } catch (error) {
    logger.error('Error in createShop:', error);
    next(error);
  }
};

/**
 * PUT /api/shop
 * Update shop profile
 */
const updateShop = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    if (!shopId) {
      return errorResponse(res, 404, 'No shop found');
    }

    const shop = await shopService.updateShop(shopId, req.body);

    // Remove accessToken from response
    const shopData = shop.toObject();
    delete shopData.accessToken;

    return successResponse(res, 200, shopData);
  } catch (error) {
    logger.error('Error in updateShop:', error);
    next(error);
  }
};

/**
 * POST /api/shop/connect-whatsapp
 * Connect WhatsApp Business number to shop
 */
const connectWhatsapp = async (req, res, next) => {
  try {
    const { phoneNumberId, wabaId, whatsappNumber, accessToken, displayName } = req.body;

    // Validate required fields
    if (!phoneNumberId) {
      return errorResponse(res, 400, 'Phone number ID is required');
    }

    if (!wabaId) {
      return errorResponse(res, 400, 'WhatsApp Business Account ID is required');
    }

    if (!whatsappNumber) {
      return errorResponse(res, 400, 'WhatsApp number is required');
    }

    if (!accessToken) {
      return errorResponse(res, 400, 'Access token is required');
    }

    // Validate WhatsApp number format (10-15 digits, no + sign)
    const whatsappRegex = /^[0-9]{10,15}$/;
    if (!whatsappRegex.test(whatsappNumber)) {
      return errorResponse(res, 400, 'WhatsApp number must be in E.164 format without + sign. Example: 919822xxxxxx');
    }

    // Check if phoneNumberId is already used by another shop
    const existingShop = await shopService.getShopByPhoneNumberId(phoneNumberId);
    if (existingShop && existingShop._id.toString() !== req.user.shopId) {
      return errorResponse(res, 409, 'This WhatsApp number is already connected to another shop.');
    }

    // Connect WhatsApp
    const shop = await shopService.connectWhatsapp(req.user.shopId, {
      phoneNumberId,
      wabaId,
      whatsappNumber,
      accessToken,
      displayName
    });

    // Invalidate tenant cache after connecting
    await tenantService.invalidateTenantCache(phoneNumberId);

    // Remove accessToken from response
    const shopData = shop.toObject();
    delete shopData.accessToken;

    return successResponse(res, 200, {
      shop: shopData,
      message: 'WhatsApp connected successfully'
    });
  } catch (error) {
    logger.error('Error in connectWhatsapp:', error);
    next(error);
  }
};

/**
 * DELETE /api/shop/disconnect-whatsapp
 * Disconnect WhatsApp from shop
 */
const disconnectWhatsapp = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    if (!shopId) {
      return errorResponse(res, 404, 'No shop found');
    }

    // Get shop first to get phoneNumberId for cache invalidation
    const shop = await shopService.getShopById(shopId);
    const phoneNumberId = shop?.phoneNumberId;

    // Disconnect WhatsApp
    await shopService.disconnectWhatsapp(shopId);

    // Invalidate tenant cache after disconnecting
    if (phoneNumberId) {
      await tenantService.invalidateTenantCache(phoneNumberId);
    }

    return successResponse(res, 200, null, 'WhatsApp disconnected successfully');
  } catch (error) {
    logger.error('Error in disconnectWhatsapp:', error);
    next(error);
  }
};

/**
 * GET /api/shop/dashboard-stats
 * Get today's stats for shop dashboard
 */
const getDashboardStats = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    if (!shopId) {
      return errorResponse(res, 404, 'No shop found');
    }

    const stats = await shopService.getDashboardStats(shopId);

    return successResponse(res, 200, stats);
  } catch (error) {
    logger.error('Error in getDashboardStats:', error);
    next(error);
  }
};

/**
 * POST /api/shop/upload-image
 * Upload profile image to Cloudinary
 */
const uploadProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }

    const shopId = req.user.shopId;
    if (!shopId) {
      return errorResponse(res, 404, 'No shop found');
    }

    // Upload to Cloudinary
    const result = await cloudinary.uploadImage(
      req.file.buffer,
      'shop-profiles',
      `shop-${shopId}`
    );

    // Update shop with new profile image URL
    await shopService.updateShop(shopId, { profileImage: result.secure_url });

    return successResponse(res, 200, { profileImage: result.secure_url });
  } catch (error) {
    logger.error('Error in uploadProfileImage:', error);
    next(error);
  }
};

module.exports = {
  getShop,
  createShop,
  updateShop,
  connectWhatsapp,
  disconnectWhatsapp,
  getDashboardStats,
  uploadProfileImage
};
