const axios = require('axios');
const businessService = require('../services/business.service');
const tenantService = require('../services/tenant.service');
const subscriptionService = require('../services/subscription.service');
const bookingService = require('../services/booking.service');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const { successResponse, errorResponse } = require('../utils/response');
const { generateTokens, saveTokenToRedis } = require('../services/auth.service');
const logger = require('../utils/logger');
const r2 = require('../services/r2.service');
const config = require('../config/env');

const META_GRAPH_BASE = 'https://graph.facebook.com/v21.0';

// Valid business categories
const VALID_BUSINESS_CATEGORIES = [
  'tailor',
  'salon',
  'garage',
  'cab',
  'coaching',
  'gym',
  'medical',
  'general',
  'photographer',
  'caterer',
  'tutor',
  'jeweller',
  'boutique',
  'grocery',
  'bakery',
  'electronics_repair',
  'real_estate',
  'driving_school',
  'travels'
];

/**
 * GET /api/business
 * Get the logged-in owner's business profile
 */
const getBusiness = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return successResponse(res, 200, null, 'No business created yet');
    }

    const business = await businessService.getBusinessByOwnerId(req.user.userId);

    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    // Remove accessToken from response (never expose it)
    const businessData = business.toObject();
    delete businessData.accessToken;

    const { remaining, resetAt } = bookingService.getPreviewCreditsStatus(business);
    businessData.previewCreditsRemaining = remaining;
    businessData.previewCreditsResetAt = resetAt;

    return successResponse(res, 200, businessData);
  } catch (error) {
    logger.error('Error in getBusiness:', error);
    next(error);
  }
};

/**
 * POST /api/business
 * Create business (only if user does not have one yet)
 */
const createBusiness = async (req, res, next) => {
  try {
    const { name, businessCategory, displayName, address, city } = req.body;

    // Check if user already has a business
    if (req.user.businessId) {
      return errorResponse(res, 409, 'You already have a business. Use PUT /api/business to update it.');
    }

    // Validate required fields
    if (!name) {
      return errorResponse(res, 400, 'Business name is required');
    }

    if (!businessCategory) {
      return errorResponse(res, 400, 'Business category is required');
    }

    // Validate business category
    if (!VALID_BUSINESS_CATEGORIES.includes(businessCategory)) {
      return errorResponse(res, 400, `Invalid business category. Must be one of: ${VALID_BUSINESS_CATEGORIES.join(', ')}`);
    }

    // Create business
    const business = await businessService.createBusiness(req.user.userId, {
      name,
      businessCategory,
      displayName,
      address,
      city
    });

    // Generate new tokens with businessId
    const userPayload = {
      userId: req.user.userId,
      email: req.user.email,
      role: req.user.role,
      businessId: business._id
    };

    const { accessToken, refreshToken } = await generateTokens(userPayload);

    // Save refresh token to Redis
    await saveTokenToRedis(req.user.userId, refreshToken);

    // Remove accessToken from business data
    const businessData = business.toObject();
    delete businessData.accessToken;

    return successResponse(res, 201, {
      business: businessData,
      accessToken,
      refreshToken,
      message: 'Business created successfully. Default rules have been added based on your business category.'
    });
  } catch (error) {
    logger.error('Error in createBusiness:', error);
    next(error);
  }
};

/**
 * PUT /api/business
 * Update business profile
 */
const updateBusiness = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    if (req.body.disabledBookingFields !== undefined) {
      const currentBusiness = await businessService.getBusinessById(businessId);
      const template = await BusinessTypeTemplate.findOne({ businessCategory: currentBusiness.businessCategory });
      const templateFieldsByKey = new Map((template?.bookingFields || []).map(field => [field.fieldKey, field]));

      const invalidFieldKeys = req.body.disabledBookingFields.filter(fieldKey => {
        const templateField = templateFieldsByKey.get(fieldKey);
        return !templateField || templateField.required === true;
      });

      if (invalidFieldKeys.length > 0) {
        return errorResponse(res, 400, `Cannot disable field(s): ${invalidFieldKeys.join(', ')}. Each must be an optional field defined in the ${currentBusiness.businessCategory} booking template.`);
      }
    }

    const business = await businessService.updateBusiness(businessId, req.body);

    // Remove accessToken from response
    const businessData = business.toObject();
    delete businessData.accessToken;

    return successResponse(res, 200, businessData);
  } catch (error) {
    logger.error('Error in updateBusiness:', error);
    next(error);
  }
};

/**
 * GET /api/business/booking-fields
 * Full (unfiltered) booking field sequence for the owner's business category,
 * including fields currently in disabledBookingFields — powers the dashboard's
 * Booking Flow page, where the owner needs to see and toggle every field, not
 * just the active ones (unlike GET /bookings/preview-fields).
 */
const getBookingFields = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { fields } = await bookingService.getAllBookingFields(businessId);

    return successResponse(res, 200, { fields });
  } catch (error) {
    logger.error('Error in getBookingFields:', error);
    next(error);
  }
};

// A WhatsApp list message allows at most 10 rows total (Meta limit). We
// reserve one row for the always-appended "Other" option, so at most 9
// business-entered cities are accepted.
const MAX_SERVED_CITIES = 9;

/**
 * GET /api/business/served-cities
 * Get the logged-in business's servedCities list
 */
const getServedCities = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const servedCities = await businessService.getServedCities(businessId);

    return successResponse(res, 200, { servedCities: servedCities || [] });
  } catch (error) {
    logger.error('Error in getServedCities:', error);
    next(error);
  }
};

/**
 * PUT /api/business/served-cities
 * Replace the business's servedCities list
 * Body: { cities: string[] }
 */
const updateServedCities = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { cities } = req.body;
    if (!Array.isArray(cities)) {
      return errorResponse(res, 400, 'cities must be an array of strings');
    }

    // Trim, drop empties, and dedupe case-insensitively (keeping the first
    // occurrence's casing) — stored casing is for display, matching
    // elsewhere is case-insensitive.
    const seen = new Set();
    const sanitizedCities = [];
    for (const city of cities) {
      if (typeof city !== 'string') continue;
      const trimmed = city.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sanitizedCities.push(trimmed);
    }

    if (sanitizedCities.length > MAX_SERVED_CITIES) {
      return errorResponse(res, 400, `A maximum of ${MAX_SERVED_CITIES} served cities is supported (WhatsApp list messages allow at most 10 options, including "Other").`);
    }

    const servedCities = await businessService.updateServedCities(businessId, sanitizedCities);

    return successResponse(res, 200, { servedCities: servedCities || [] });
  } catch (error) {
    logger.error('Error in updateServedCities:', error);
    next(error);
  }
};

/**
 * GET /api/business/served-cities/suggestions
 * Suggested prefill list of cities, built from this business's active
 * RouteFare routes. Read-only — never saves; the frontend's "prefill from my
 * existing routes" button decides what (if anything) to submit to
 * PUT /served-cities.
 */
const getServedCitySuggestions = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const suggestions = await businessService.getServedCitySuggestions(businessId);

    return successResponse(res, 200, { suggestions });
  } catch (error) {
    logger.error('Error in getServedCitySuggestions:', error);
    next(error);
  }
};

/**
 * POST /api/business/connect-whatsapp
 * Connect WhatsApp Business number to business
 */
const connectWhatsapp = async (req, res, next) => {
  try {
    const { code, wabaId, phoneNumberId } = req.body;

    // Validate required fields
    if (!code) {
      return errorResponse(res, 400, 'Authorization code is required');
    }

    if (!wabaId) {
      return errorResponse(res, 400, 'WhatsApp Business Account ID is required');
    }

    if (!phoneNumberId) {
      return errorResponse(res, 400, 'Phone number ID is required');
    }

    // Check if phoneNumberId is already used by another business
    const existingBusiness = await businessService.getBusinessByPhoneNumberId(phoneNumberId);
    if (existingBusiness && existingBusiness._id.toString() !== req.user.businessId.toString()) {
      return errorResponse(res, 409, 'This WhatsApp number is already connected to another business.');
    }

    // Exchange the OAuth code for an access token server-side (never trust a
    // client-supplied token)
    let accessToken;
    try {
      const tokenResponse = await axios.get(`${META_GRAPH_BASE}/oauth/access_token`, {
        params: {
          client_id: config.META_APP_ID,
          client_secret: config.META_APP_SECRET,
          code
        }
      });
      accessToken = tokenResponse.data.access_token;
    } catch (error) {
      logger.error('Error exchanging WhatsApp signup code:', error.response?.data || error.message);
      return errorResponse(res, 400, 'Failed to exchange authorization code with Meta');
    }

    if (!accessToken) {
      return errorResponse(res, 400, 'Meta did not return an access token');
    }

    // Fetch the phone number's display number and verified business name
    let whatsappNumber;
    let displayName;
    try {
      const phoneResponse = await axios.get(`${META_GRAPH_BASE}/${phoneNumberId}`, {
        params: { fields: 'display_phone_number,verified_name' },
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      whatsappNumber = (phoneResponse.data.display_phone_number || '').replace(/[^0-9]/g, '');
      displayName = phoneResponse.data.verified_name;
    } catch (error) {
      logger.error('Error fetching WhatsApp phone number details:', error.response?.data || error.message);
      return errorResponse(res, 400, 'Failed to fetch WhatsApp phone number details from Meta');
    }

    // Validate WhatsApp number format (10-15 digits, no + sign)
    const whatsappRegex = /^[0-9]{10,15}$/;
    if (!whatsappRegex.test(whatsappNumber)) {
      return errorResponse(res, 400, 'Could not determine a valid WhatsApp number for this phone number ID');
    }

    // Connect WhatsApp (service encrypts the access token before saving)
    const business = await businessService.connectWhatsapp(req.user.businessId, {
      phoneNumberId,
      wabaId,
      whatsappNumber,
      accessToken,
      displayName
    });

    // Invalidate caches after connecting so the new connection takes effect immediately
    await subscriptionService.invalidateSubscriptionCache(req.user.businessId.toString());
    await tenantService.invalidateTenantCache(phoneNumberId);

    // Remove accessToken from response
    const businessData = business.toObject();
    delete businessData.accessToken;

    return successResponse(res, 200, { business: businessData }, 'WhatsApp connected successfully');
  } catch (error) {
    logger.error('Error in connectWhatsapp:', error);
    next(error);
  }
};

/**
 * DELETE /api/business/disconnect-whatsapp
 * Disconnect WhatsApp from business
 */
const disconnectWhatsapp = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    // Get business first to get phoneNumberId for cache invalidation
    const business = await businessService.getBusinessById(businessId);
    const phoneNumberId = business?.phoneNumberId;

    // Disconnect WhatsApp
    await businessService.disconnectWhatsapp(businessId);

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
 * GET /api/business/dashboard-stats
 * Get today's stats for business dashboard
 */
const getDashboardStats = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const stats = await businessService.getDashboardStats(businessId);

    return successResponse(res, 200, stats);
  } catch (error) {
    logger.error('Error in getDashboardStats:', error);
    next(error);
  }
};

/**
 * POST /api/business/upload-image
 * Upload profile image to R2
 */
const uploadProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }

    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    // Upload to R2
    const result = await r2.uploadImage(
      req.file.buffer,
      'business-profiles',
      `business-${businessId}`,
      req.file.mimetype
    );

    // Update business with new profile image URL
    await businessService.updateBusiness(businessId, { profileImage: result.url });

    return successResponse(res, 200, { profileImage: result.url });
  } catch (error) {
    logger.error('Error in uploadProfileImage:', error);
    next(error);
  }
};

module.exports = {
  getBusiness,
  createBusiness,
  updateBusiness,
  getBookingFields,
  getServedCities,
  updateServedCities,
  getServedCitySuggestions,
  connectWhatsapp,
  disconnectWhatsapp,
  getDashboardStats,
  uploadProfileImage
};
