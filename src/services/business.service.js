const supabase = require('../config/supabase');
const Rule = require('../models/Rule');
const RouteFare = require('../models/RouteFare');
const { generateWebhookToken } = require('../utils/crypto');
const { encrypt } = require('../utils/crypto');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

const businessFieldMap = {
  name: 'name', displayName: 'display_name', address: 'address', city: 'city',
  profileImage: 'profile_image', upiId: 'upi_id', fallbackReply: 'fallback_reply',
  welcomeMessage: 'welcome_message', isMenuEnabled: 'is_menu_enabled', menuItems: 'menu_items',
  enableDistanceFares: 'enable_distance_fares', enableSmartFallback: 'enable_smart_fallback',
  roundTripPerDayKm: 'round_trip_per_day_km', roundTripDriverDaEnabled: 'round_trip_driver_da_enabled',
  roundTripDriverDaAmount: 'round_trip_driver_da_amount', disabledBookingFields: 'disabled_booking_fields'
};

/**
 * Get business by owner user ID
 * @param {string} ownerUserId - The owner's user ID
 * @returns {Promise<Object|null>} camelCase business row, so existing callers written
 *   against the old Mongoose field names (business.businessCategory etc.) keep working
 */
const getBusinessByOwnerId = async (ownerUserId) => {
  try {
    const { data, error } = await supabase
      .from('businesses').select('*').eq('owner_user_id', ownerUserId).maybeSingle();
    if (error) throw error;
    return toCamelCase(data);
  } catch (error) {
    logger.error('Error in getBusinessByOwnerId:', error);
    throw error;
  }
};

/**
 * Get business by ID
 * @param {string} businessId - The business ID
 * @returns {Promise<Object|null>}
 */
const getBusinessById = async (businessId) => {
  try {
    const { data, error } = await supabase
      .from('businesses').select('*').eq('id', businessId).maybeSingle();
    if (error) throw error;
    return toCamelCase(data);
  } catch (error) {
    logger.error('Error in getBusinessById:', error);
    throw error;
  }
};

/**
 * Get business by phone number ID (used by webhook tenant resolution)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @returns {Promise<Object|null>}
 */
const getBusinessByPhoneNumberId = async (phoneNumberId) => {
  try {
    const { data, error } = await supabase
      .from('businesses').select('*').eq('phone_number_id', phoneNumberId).maybeSingle();
    if (error) throw error;
    return toCamelCase(data);
  } catch (error) {
    logger.error('Error in getBusinessByPhoneNumberId:', error);
    throw error;
  }
};

/**
 * Create a new business
 * @param {string} ownerUserId - The owner's user ID
 * @param {Object} data - Business data
 * @returns {Promise<Object>}
 */
const createBusiness = async (ownerUserId, data) => {
  try {
    const { name, businessCategory, address, city, displayName } = data;

    const webhookVerifyToken = generateWebhookToken();

    const { data: business, error } = await supabase.from('businesses').insert({
      name,
      business_category: businessCategory,
      address,
      city,
      display_name: displayName || name,
      owner_user_id: ownerUserId,
      webhook_verify_token: webhookVerifyToken,
      is_active: true,
      is_whatsapp_connected: false
    }).select().single();
    if (error) throw error;

    // Link owner -> business (User is on Supabase too, so this is a plain FK update now)
    const { error: userErr } = await supabase
      .from('users').update({ business_id: business.id }).eq('id', ownerUserId);
    if (userErr) throw userErr;

    // Copy default rules from BusinessTypeTemplate (Supabase — migrated earlier).
    const { data: template, error: templateErr } = await supabase
      .from('business_type_templates').select('default_rules').eq('business_category', businessCategory).maybeSingle();
    if (templateErr) throw templateErr;

    if (template && template.default_rules && template.default_rules.length > 0) {
      // BROKEN — Rule is still Mongoose, and business.id is now a Postgres
      // UUID, so Rule.insertMany will throw a CastError on businessId. New
      // businesses get zero default rules until Rule is migrated to Supabase.
      // Caught below and logged loudly rather than failing business creation.
      try {
        const rulesToCreate = template.default_rules.map(rule => ({
          businessId: business.id,
          keyword: rule.keyword,
          matchType: rule.matchType || 'contains',
          reply: rule.reply || rule.response || '',
          replyType: rule.replyType || 'text',
          priority: rule.priority || 0,
          isActive: true,
          triggerCount: 0
        }));

        await Rule.insertMany(rulesToCreate);
        logger.info(`Created ${rulesToCreate.length} default rules for business ${business.id}`);
      } catch (ruleError) {
        logger.error(`FAILED to create default rules for business ${business.id} — Rule model not yet migrated to Supabase:`, ruleError);
      }
    }

    return toCamelCase(business);
  } catch (error) {
    logger.error('Error in createBusiness:', error);
    throw error;
  }
};

/**
 * Update business profile
 * @param {string} businessId - The business ID
 * @param {Object} data - Fields to update
 * @returns {Promise<Object>}
 */
const updateBusiness = async (businessId, data) => {
  try {
    const updateData = {};
    for (const [field, column] of Object.entries(businessFieldMap)) {
      if (data[field] !== undefined) {
        updateData[column] = data[field];
      }
    }

    const { data: business, error } = await supabase
      .from('businesses').update(updateData).eq('id', businessId).select().single();
    if (error) throw error;

    return toCamelCase(business);
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
    const { data, error } = await supabase
      .from('businesses').select('served_cities').eq('id', businessId).maybeSingle();
    if (error) throw error;
    return data ? (data.served_cities || []) : null;
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
    const { data, error } = await supabase
      .from('businesses').update({ served_cities: cities }).eq('id', businessId).select('served_cities').single();
    if (error) throw error;
    return data ? (data.served_cities || []) : null;
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
 *
 * BROKEN — RouteFare is still Mongoose, and businessId is now a Postgres
 * UUID, so this always fails and returns []. Fails soft (not critical path)
 * until RouteFare is migrated to Supabase.
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
    logger.error('Error in getServedCitySuggestions (RouteFare not yet migrated):', error);
    return [];
  }
};

/**
 * Connect WhatsApp to business
 * @param {string} businessId - The business ID
 * @param {Object} data - WhatsApp connection data
 * @returns {Promise<Object>}
 */
const connectWhatsapp = async (businessId, data) => {
  try {
    const { phoneNumberId, wabaId, whatsappNumber, accessToken, displayName } = data;

    const encryptedAccessToken = encrypt(accessToken);

    const updateData = {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      whatsapp_number: whatsappNumber,
      access_token: encryptedAccessToken,
      is_whatsapp_connected: true
    };

    if (displayName) {
      updateData.display_name = displayName;
    }

    const { data: business, error } = await supabase
      .from('businesses').update(updateData).eq('id', businessId).select().single();
    if (error) throw error;

    return toCamelCase(business);
  } catch (error) {
    logger.error('Error in connectWhatsapp:', error);
    throw error;
  }
};

/**
 * Disconnect WhatsApp from business
 * @param {string} businessId - The business ID
 * @returns {Promise<Object>}
 */
const disconnectWhatsapp = async (businessId) => {
  try {
    const { data: business, error } = await supabase.from('businesses').update({
      phone_number_id: null,
      waba_id: null,
      whatsapp_number: null,
      access_token: null,
      is_whatsapp_connected: false
    }).eq('id', businessId).select().single();
    if (error) throw error;

    return toCamelCase(business);
  } catch (error) {
    logger.error('Error in disconnectWhatsapp:', error);
    throw error;
  }
};

/**
 * Get dashboard statistics for a business
 *
 * BROKEN — Message/Booking/Customer/Usage are still Mongoose, and businessId
 * is now a Postgres UUID, so each of these queries throws a CastError. Each
 * is caught individually so one broken model doesn't 500 the whole dashboard;
 * broken stats come back as 0/null until those models are migrated.
 * @param {string} businessId - The business ID
 * @returns {Promise<Object>}
 */
const getDashboardStats = async (businessId) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const safe = async (fn, label, fallback) => {
    try {
      return await fn();
    } catch (error) {
      logger.error(`getDashboardStats: ${label} failed (model not yet migrated?):`, error.message);
      return fallback;
    }
  };

  const [
    todayMessageCount,
    todayInboundCount,
    todayBookingCount,
    totalCustomers,
    newCustomersToday,
    pendingBookings,
    currentMonthUsage
  ] = await Promise.all([
    safe(() => require('../models/Message').countDocuments({ businessId, createdAt: { $gte: startOfToday } }), 'todayMessageCount', 0),
    safe(() => require('../models/Message').countDocuments({ businessId, direction: 'inbound', createdAt: { $gte: startOfToday } }), 'todayInboundCount', 0),
    safe(() => require('../models/Booking').countDocuments({ businessId, createdAt: { $gte: startOfToday } }), 'todayBookingCount', 0),
    safe(() => require('../models/Customer').countDocuments({ businessId }), 'totalCustomers', 0),
    safe(() => require('../models/Customer').countDocuments({ businessId, firstSeenAt: { $gte: startOfToday } }), 'newCustomersToday', 0),
    safe(() => require('../models/Booking').countDocuments({ businessId, status: 'pending' }), 'pendingBookings', 0),
    safe(() => require('../models/Usage').findOne({ businessId, month: currentMonth }), 'currentMonthUsage', null)
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
