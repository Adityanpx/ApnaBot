const axios = require('axios');
const businessService = require('../services/business.service');
const tenantService = require('../services/tenant.service');
const subscriptionService = require('../services/subscription.service');
const bookingService = require('../services/booking.service');
const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { generateTokens, saveTokenToRedis } = require('../services/auth.service');
const logger = require('../utils/logger');
const r2 = require('../services/r2.service');
const config = require('../config/env');
const { isValidLanguageCode, LANGUAGE_CATALOG } = require('../utils/languageCatalog');
const { validateLabelTranslations } = require('../utils/bookingFieldValidation');

const META_GRAPH_BASE = 'https://graph.facebook.com/v21.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves the WABA's phone number ID server-side, for the "connect existing
 * WhatsApp Business app" (QR migration) signup path where Meta's FINISH
 * postMessage often arrives before the number migration has finished on
 * Meta's side, so the frontend doesn't reliably get a phoneNumberId. Retries
 * a few times since the registration can still be in flight.
 */
const resolvePhoneNumberIdForWaba = async (wabaId, accessToken) => {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info('resolvePhoneNumberIdForWaba: starting attempt', { wabaId, attempt, maxAttempts });

    const response = await axios.get(`${META_GRAPH_BASE}/${wabaId}/phone_numbers`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const numbers = response.data.data || [];

    logger.info('resolvePhoneNumberIdForWaba: Graph API returned phone numbers', {
      wabaId,
      attempt,
      count: numbers.length
    });

    if (numbers.length === 1) {
      return numbers[0].id;
    }

    if (numbers.length > 1) {
      throw new Error('MULTIPLE_PHONE_NUMBERS');
    }

    if (attempt < maxAttempts) {
      logger.info('resolvePhoneNumberIdForWaba: no phone number yet, retrying', { wabaId, attempt, maxAttempts });
      await sleep(2000);
    }
  }
  return null;
};

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
  'travels',
  'software_it'
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
    const businessData = { ...business, _id: business.id };
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
      businessId: business.id
    };

    const { accessToken, refreshToken } = await generateTokens(userPayload);

    // Save refresh token to Redis
    await saveTokenToRedis(req.user.userId, refreshToken);

    // Remove accessToken from business data
    const businessData = { ...business, _id: business.id };
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
      // Validate against this business's own business_flows.booking_fields,
      // not the shared business_type_templates row — a business's flow can
      // diverge from its category template after creation, so that's the
      // only correct source of "what fields does this business actually have".
      const { data: flow } = await supabase
        .from('business_flows')
        .select('booking_fields')
        .eq('business_id', businessId)
        .maybeSingle();
      const flowFieldsByKey = new Map((flow?.booking_fields || []).map(field => [field.fieldKey, field]));

      const invalidFieldKeys = req.body.disabledBookingFields.filter(fieldKey => {
        const flowField = flowFieldsByKey.get(fieldKey);
        return !flowField || flowField.required === true;
      });

      if (invalidFieldKeys.length > 0) {
        return errorResponse(res, 400, `Cannot disable field(s): ${invalidFieldKeys.join(', ')}. Each must be an optional field defined in this business's booking flow.`);
      }
    }

    if (req.body.enabledLanguages !== undefined) {
      const { enabledLanguages } = req.body;
      if (!Array.isArray(enabledLanguages) || enabledLanguages.length < 1 || enabledLanguages.length > 3) {
        return errorResponse(res, 400, 'enabledLanguages must include between 1 and 3 languages.');
      }
      const invalidCodes = enabledLanguages.filter(code => !isValidLanguageCode(code));
      if (invalidCodes.length > 0) {
        return errorResponse(res, 400, `Invalid language code(s): ${invalidCodes.join(', ')}. Must be one of: ${Object.keys(LANGUAGE_CATALOG).join(', ')}`);
      }
      const uniqueCodes = new Set(enabledLanguages);
      if (uniqueCodes.size !== enabledLanguages.length) {
        return errorResponse(res, 400, 'enabledLanguages must not contain duplicate language codes.');
      }
      if (!enabledLanguages.includes('en')) {
        return errorResponse(res, 400, 'English cannot be removed from enabled languages.');
      }
    }

    const business = await businessService.updateBusiness(businessId, req.body);

    // Remove accessToken from response
    const businessData = { ...business, _id: business.id };
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

const VALID_BOOKING_FIELD_TYPES = ['text', 'buttons', 'list'];

// booking.service.js's processBookingStep branches on these exact fieldKey
// literals for travels-shaped businesses (Other-date/Other-location/Other-time
// text swaps, and tripType-driven Round Trip/Local Rental branching + fare
// lookups). Renaming or removing one doesn't error — the special behavior
// just silently stops firing — so updateBookingFields below refuses to let
// these keys change for these categories.
const TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS = ['cab', 'travels'];
const RESERVED_TRAVEL_FIELD_KEYS = ['tripType', 'pickupLocation', 'dropLocation', 'travelDate', 'pickupTime'];

/**
 * PUT /api/business/booking-fields
 * Full replacement of the owner's business_flows.booking_fields content —
 * modeled on admin.controller.js's updateTemplate, scoped to the caller's
 * own business instead of superadmin/global. Enabling/disabling fields is a
 * separate concern (PUT /api/business { disabledBookingFields }) and is
 * untouched here except for clearing entries orphaned by this update.
 * Body: { bookingFields: [...] } — same shape as
 * business_type_templates.booking_fields.
 */
const updateBookingFields = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { bookingFields } = req.body;
    if (!Array.isArray(bookingFields) || bookingFields.length === 0) {
      return errorResponse(res, 400, 'bookingFields must be a non-empty array');
    }

    const { data: flow, error: flowErr } = await supabase
      .from('business_flows')
      .select('booking_fields, business:businesses(business_category)')
      .eq('business_id', businessId)
      .maybeSingle();
    if (flowErr) throw flowErr;
    if (!flow) return errorResponse(res, 404, 'No booking flow found for this business');

    // vehicle_carousel fields are normally only ever generated transiently in
    // a Redis booking session (booking.service.js processBookingStep), never
    // written to business_flows. The one exception: the 'cab' category's
    // business_type_templates row was hand-edited via
    // src/scripts/updateCabBookingFields.js to store vehicleType with
    // fieldType 'vehicle_carousel' directly, and business.service.js's
    // createBusiness copies that template verbatim into business_flows on
    // signup — so a 'cab' business created after that script ran can have it
    // baked into stored data. Editing over that risks freezing/corrupting a
    // field meant to be computed at runtime, so refuse outright.
    if ((flow.booking_fields || []).some(f => f && f.fieldType === 'vehicle_carousel')) {
      return errorResponse(res, 400, "This business's booking flow contains a vehicle_carousel field, which is generated dynamically at runtime from route fares/distance estimates and cannot be edited through this endpoint. Contact support.");
    }

    const seenFieldKeys = new Set();
    const seenOrders = new Set();

    for (const field of bookingFields) {
      if (!field || typeof field !== 'object') {
        return errorResponse(res, 400, 'Each booking field must be an object');
      }

      if (!field.fieldKey || typeof field.fieldKey !== 'string') {
        return errorResponse(res, 400, 'Every field needs a non-empty fieldKey');
      }
      if (seenFieldKeys.has(field.fieldKey)) {
        return errorResponse(res, 400, `Duplicate fieldKey "${field.fieldKey}" — every field needs a unique fieldKey`);
      }
      seenFieldKeys.add(field.fieldKey);

      if (!Number.isInteger(field.order)) {
        return errorResponse(res, 400, `Field "${field.fieldKey}" order must be an integer`);
      }
      if (seenOrders.has(field.order)) {
        return errorResponse(res, 400, `Duplicate order value ${field.order} — order values must be unique`);
      }
      seenOrders.add(field.order);

      if (!VALID_BOOKING_FIELD_TYPES.includes(field.fieldType)) {
        return errorResponse(res, 400, field.fieldType === 'vehicle_carousel'
          ? `Field "${field.fieldKey}" cannot use fieldType "vehicle_carousel" — that type is generated dynamically at runtime from route fares/distance estimates and can't be hand-edited or saved with static options.`
          : `Field "${field.fieldKey}" fieldType must be one of: ${VALID_BOOKING_FIELD_TYPES.join(', ')}`);
      }

      const fieldErr = validateLabelTranslations(
        field.labelTranslations, `Field "${field.fieldKey}" labelTranslations`
      );
      if (fieldErr) return errorResponse(res, 400, fieldErr);

      if ((field.fieldType === 'buttons' || field.fieldType === 'list') &&
          (!Array.isArray(field.options) || field.options.length === 0)) {
        return errorResponse(res, 400, `Field "${field.fieldKey}" must have at least one option (fieldType "${field.fieldType}")`);
      }

      for (const opt of field.options || []) {
        if (opt && typeof opt === 'object') {
          const optErr = validateLabelTranslations(
            opt.labelTranslations, `Field "${field.fieldKey}" option "${opt.value}" labelTranslations`
          );
          if (optErr) return errorResponse(res, 400, optErr);
        }
      }
    }

    // Travels/cab businesses: refuse to rename or remove any reserved
    // fieldKey booking.service.js's processBookingStep depends on by literal
    // string match. Only the key itself is locked — label, options, order,
    // required, and translations on that field can still change freely.
    const businessCategory = flow.business && flow.business.business_category;
    if (TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(businessCategory)) {
      const currentFieldKeys = new Set((flow.booking_fields || []).map(f => f && f.fieldKey));
      const missingReservedKeys = RESERVED_TRAVEL_FIELD_KEYS.filter(
        key => currentFieldKeys.has(key) && !seenFieldKeys.has(key)
      );
      if (missingReservedKeys.length > 0) {
        return errorResponse(res, 400,
          `Cannot rename or remove fieldKey(s): ${missingReservedKeys.join(', ')}. Special booking-flow behavior depends on these exact keys ` +
          '(tripType drives Round Trip/Local Rental branching and fare calculation; pickupLocation/dropLocation drive route-fare pricing lookups; ' +
          'travelDate/pickupTime drive the "Other" quick-reply sub-questions) — renaming or removing them would silently break that behavior with no error. ' +
          'Label, options, order, required, and translations on these fields can still be changed freely.'
        );
      }
    }

    // Drop any disabledBookingFields entries whose fieldKey no longer exists
    // in the new set, so removing a field can't leave an orphaned disable
    // entry behind.
    const { data: business, error: bizErr } = await supabase
      .from('businesses').select('disabled_booking_fields').eq('id', businessId).maybeSingle();
    if (bizErr) throw bizErr;
    const currentDisabled = business?.disabled_booking_fields || [];
    const survivingDisabled = currentDisabled.filter(fieldKey => seenFieldKeys.has(fieldKey));

    const { data: updatedFlow, error: updateErr } = await supabase
      .from('business_flows')
      .update({ booking_fields: bookingFields })
      .eq('business_id', businessId)
      .select('booking_fields')
      .single();
    if (updateErr) throw updateErr;

    if (survivingDisabled.length !== currentDisabled.length) {
      await businessService.updateBusiness(businessId, { disabledBookingFields: survivingDisabled });
    }

    // No cache to flush here: unlike business_type_templates (shared across a
    // whole category, hence updateTemplate's flushAllTenantCache), this is a
    // per-business business_flows row. The tenant:{phoneNumberId} cache never
    // stores booking_fields (see tenant.service.js), and every booking-field
    // read (startBookingSession, getAllBookingFields, etc. in
    // booking.service.js) queries business_flows directly with no cache in
    // front of it — so the update is immediately live with nothing to flush.
    logger.info(`Business ${businessId} updated its own booking_fields (${bookingFields.length} field(s))`);
    return successResponse(res, 200, { bookingFields: updatedFlow.booking_fields }, 'Booking fields updated successfully');
  } catch (error) {
    logger.error('Error in updateBookingFields:', error);
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
    const { code, wabaId } = req.body;
    let { phoneNumberId } = req.body;

    logger.info('connectWhatsapp: endpoint hit', {
      businessId: req.user.businessId,
      wabaId,
      codePrefix: typeof code === 'string' ? code.slice(0, 10) : code,
      phoneNumberIdPresent: !!phoneNumberId
    });

    // Validate required fields
    if (!code) {
      return errorResponse(res, 400, 'Authorization code is required');
    }

    if (!wabaId) {
      return errorResponse(res, 400, 'WhatsApp Business Account ID is required');
    }

    // If the frontend already has phoneNumberId (the normal "production
    // setup" / fresh-number path), keep the early duplicate check before
    // hitting Meta at all.
    if (phoneNumberId) {
      const existingBusiness = await businessService.getBusinessByPhoneNumberId(phoneNumberId);
      if (existingBusiness && existingBusiness.id !== req.user.businessId) {
        return errorResponse(res, 409, 'This WhatsApp number is already connected to another business.');
      }
    }

    // Exchange the OAuth code for an access token server-side (never trust a
    // client-supplied token)
    let accessToken;
    try {
      logger.info('connectWhatsapp: exchanging code for access token with Meta', {
        businessId: req.user.businessId,
        wabaId
      });

      const tokenResponse = await axios.get(`${META_GRAPH_BASE}/oauth/access_token`, {
        params: {
          client_id: config.META_APP_ID,
          client_secret: config.META_APP_SECRET,
          code
        }
      });
      accessToken = tokenResponse.data.access_token;

      logger.info('connectWhatsapp: access token received from Meta', {
        businessId: req.user.businessId,
        wabaId,
        tokenReceived: !!accessToken
      });
    } catch (error) {
      logger.error('Error exchanging WhatsApp signup code:', {
        businessId: req.user.businessId,
        wabaId,
        error: error.response?.data || error.message
      });
      return errorResponse(res, 400, 'Failed to exchange authorization code with Meta');
    }

    if (!accessToken) {
      return errorResponse(res, 400, 'Meta did not return an access token');
    }

    // phoneNumberId is missing: this is the "connect existing WhatsApp
    // Business app" (QR migration) path, where Meta's FINISH postMessage
    // often fires before the number migration has finished server-side.
    // Fetch it from the WABA directly now that we have an access token.
    if (!phoneNumberId) {
      logger.info('connectWhatsapp: phoneNumberId missing, resolving via resolvePhoneNumberIdForWaba', {
        businessId: req.user.businessId,
        wabaId
      });

      try {
        phoneNumberId = await resolvePhoneNumberIdForWaba(wabaId, accessToken);
      } catch (error) {
        if (error.message === 'MULTIPLE_PHONE_NUMBERS') {
          logger.error(`Multiple phone numbers found for WABA ${wabaId} while connecting business ${req.user.businessId}; refusing to auto-select.`, {
            businessId: req.user.businessId,
            wabaId
          });
          return errorResponse(res, 400, 'This WhatsApp Business Account has more than one phone number. Please contact support to complete this connection.');
        }
        logger.error('Error fetching phone numbers for WABA:', {
          businessId: req.user.businessId,
          wabaId,
          error: error.response?.data || error.message
        });
        return errorResponse(res, 400, 'Failed to fetch WhatsApp phone number details from Meta');
      }

      logger.info('connectWhatsapp: resolvePhoneNumberIdForWaba returned', {
        businessId: req.user.businessId,
        wabaId,
        phoneNumberId
      });

      if (!phoneNumberId) {
        return errorResponse(res, 400, "WhatsApp number registration is still processing on Meta's side - please try reconnecting in a minute.");
      }

      const existingBusiness = await businessService.getBusinessByPhoneNumberId(phoneNumberId);
      if (existingBusiness && existingBusiness.id !== req.user.businessId) {
        return errorResponse(res, 409, 'This WhatsApp number is already connected to another business.');
      }
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
      logger.error('Error fetching WhatsApp phone number details:', {
        businessId: req.user.businessId,
        wabaId,
        phoneNumberId,
        error: error.response?.data || error.message
      });
      return errorResponse(res, 400, 'Failed to fetch WhatsApp phone number details from Meta');
    }

    // Validate WhatsApp number format (10-15 digits, no + sign)
    const whatsappRegex = /^[0-9]{10,15}$/;
    if (!whatsappRegex.test(whatsappNumber)) {
      return errorResponse(res, 400, 'Could not determine a valid WhatsApp number for this phone number ID');
    }

    // Connect WhatsApp (service encrypts the access token before saving)
    logger.info('connectWhatsapp: saving connection via businessService.connectWhatsapp', {
      businessId: req.user.businessId,
      wabaId,
      phoneNumberId
    });

    const business = await businessService.connectWhatsapp(req.user.businessId, {
      phoneNumberId,
      wabaId,
      whatsappNumber,
      accessToken,
      displayName
    });

    // Subscribe the app to this WABA's webhook events. This is a separate,
    // per-WABA opt-in Meta requires in addition to the app-level webhook
    // fields configured in the Meta App Dashboard - without it, Meta never
    // sends webhook POSTs for messages on this number even though the
    // connection itself succeeds. Not fatal: a business should still be
    // considered connected even if this call fails, but it must be visible
    // in logs since it silently breaks inbound messaging otherwise.
    try {
      logger.info('connectWhatsapp: subscribing app to WABA webhook events', {
        businessId: req.user.businessId,
        wabaId
      });

      await axios.post(`${META_GRAPH_BASE}/${wabaId}/subscribed_apps`, null, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      logger.info('connectWhatsapp: subscribed app to WABA webhook events', {
        businessId: req.user.businessId,
        wabaId
      });
    } catch (error) {
      logger.error('connectWhatsapp: failed to subscribe app to WABA webhook events - inbound messages will not be received until this is fixed', {
        businessId: req.user.businessId,
        wabaId,
        error: error.response?.data || error.message
      });
    }

    // Invalidate caches after connecting so the new connection takes effect immediately
    await subscriptionService.invalidateSubscriptionCache(req.user.businessId.toString());
    await tenantService.invalidateTenantCache(phoneNumberId);

    // Remove accessToken from response
    const businessData = { ...business, _id: business.id };
    delete businessData.accessToken;

    logger.info('connectWhatsapp: connection saved, returning success', {
      businessId: req.user.businessId,
      wabaId,
      phoneNumberId
    });

    return successResponse(res, 200, { business: businessData }, 'WhatsApp connected successfully');
  } catch (error) {
    logger.error('Error in connectWhatsapp:', {
      businessId: req.user.businessId,
      wabaId: req.body?.wabaId,
      phoneNumberId: req.body?.phoneNumberId,
      error: error.response?.data || error.message || error
    });
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
  updateBookingFields,
  getServedCities,
  updateServedCities,
  getServedCitySuggestions,
  connectWhatsapp,
  disconnectWhatsapp,
  getDashboardStats,
  uploadProfileImage
};
