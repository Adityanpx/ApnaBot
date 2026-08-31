const redis = require('../config/redis');
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { getLocalizedText } = require('../utils/localization');
const businessService = require('./business.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const distanceMatrixService = require('./distanceMatrix.service');
const logger = require('../utils/logger');

const tripTypeMap = { 'One Way': 'oneway', 'Round Trip': 'round_trip', 'Local Rental': 'local' };

/**
 * Normalize a 'buttons'/'list' field's option entry to a {value, label,
 * labelTranslations} shape. Plain strings (every seeded row today) become
 * their own value and label. VALUE is what gets written into
 * session.collected (and so must stay English — tripTypeMap and the other
 * 'Other'/'Other date'/'Other time' sentinel checks key off it); LABEL is
 * what gets rendered into buttons/list rows shown to the customer.
 */
const normalizeOption = (opt) =>
  typeof opt === 'string'
    ? { value: opt, label: opt, labelTranslations: null }
    : { value: opt.value, label: opt.label ?? opt.value,
        labelTranslations: opt.labelTranslations ?? null };

/**
 * Build the customer-facing copy of a field, with label/option labels
 * resolved to the customer's language. Only 'buttons'/'list' fields are
 * translated (decided on runtime fieldType, not fieldKey, since
 * applyServedCitiesFields turns pickupLocation/dropLocation into 'list'
 * fields for businesses with servedCities configured) — free-text fields
 * are returned untouched. session.fields itself is never mutated: matching
 * a later reply needs the raw options (value + labelTranslations), so this
 * always returns a new object rather than localizing in place.
 * @param {Object} field
 * @param {string|null|undefined} languageCode
 * @returns {Object}
 */
const localizeField = (field, languageCode) => {
  if (!field || (field.fieldType !== 'buttons' && field.fieldType !== 'list')) {
    return field;
  }
  return {
    ...field,
    label: getLocalizedText(field, 'label', languageCode),
    options: (field.options || []).map(opt => {
      const normalized = normalizeOption(opt);
      return { ...normalized, label: getLocalizedText(normalized, 'label', languageCode) };
    })
  };
};

/**
 * Format a Date as DD/MM/YYYY, matching the format customers are asked to
 * type manually when they answer the travelDate question with free text.
 */
const formatDateDDMMYYYY = (date) => {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
};

/**
 * Resolve a travelDate quick-reply option ("Today"/"Tomorrow") to the actual
 * calendar date, in the same DD/MM/YYYY format as manual entry.
 */
const resolveTravelDateOption = (option) => {
  const date = new Date();
  if (option === 'Tomorrow') {
    date.setDate(date.getDate() + 1);
  }
  return formatDateDDMMYYYY(date);
};

const BOOKING_SESSION_TTL = 1800; // 30 minutes in seconds

const FREE_MONTHLY_PREVIEW_CREDITS = 20;

/**
 * Find active route-fare based vehicle options for a pickup/drop pair.
 * @returns {Promise<Array>} Populated RouteFare docs (vehicleId + catalogId populated), or [] if none/invalid input
 */
const findMatchingVehicleOptions = async (businessId, pickupLocation, dropLocation, tripType) => {
  const mappedTripType = tripTypeMap[tripType] || 'oneway';
  const fromCity = (pickupLocation || '').toLowerCase().trim();
  const toCity = (dropLocation || '').toLowerCase().trim();
  if (!fromCity || !toCity) return [];
  try {
    const { data, error } = await supabase
      .from('route_fares')
      .select('*, vehicle:vehicles(id, custom_name, custom_photo_url, is_active, catalog:vehicle_type_catalog(name, photo_url, seats))')
      .eq('business_id', businessId).eq('from_city', fromCity).eq('to_city', toCity)
      .eq('trip_type', mappedTripType).eq('is_active', true);
    if (error) throw error;
    const result = (data || []).filter(rf => rf.vehicle && rf.vehicle.is_active);
    logger.info('Route fare lookup', { businessId, fromCity, toCity, tripType: mappedTripType, matchCount: result.length });
    return result;
  } catch (error) {
    logger.error('Error finding matching vehicle options:', error);
    return [];
  }
};

/**
 * Map joined route_fares rows to the option shape stored on a vehicle_carousel field.
 */
const buildVehicleCarouselOptions = (routeFares) => routeFares.map((rf, idx) => ({
  index: idx,
  routeFareId: rf.id,
  vehicleId: rf.vehicle.id,
  name: rf.vehicle.custom_name || rf.vehicle.catalog.name,
  photoUrl: rf.vehicle.custom_photo_url || rf.vehicle.catalog.photo_url || null,
  seats: rf.vehicle.catalog.seats || null,
  fare: rf.fare,
  source: 'route_fare'
}));

/**
 * Find distance-estimated vehicle options for a pickup/drop pair, for businesses
 * that have opted in via Business.enableDistanceFares. Falls back to [] on any
 * "can't compute" condition (opt-out, no Google result, no priced vehicles)
 * so the caller can fall through to the next tier without special-casing.
 *
 * For round trips where numberOfDays is known, distance is estimated as
 * numberOfDays * business.roundTripPerDayKm instead of doubling the one-way
 * distance, and the Google/cache one-way lookup is skipped entirely since
 * it isn't needed for that calculation.
 * @param {string|number} [numberOfDays] - customer-provided day count for round trips
 * @returns {Promise<Array>} Carousel-shaped options with source: 'distance_estimate', or []
 */
const findDistanceBasedVehicleOptions = async (businessId, pickupLocation, dropLocation, tripType, numberOfDays) => {
  const business = await businessService.getBusinessById(businessId);
  if (!business || business.enableDistanceFares !== true) {
    logger.warn('Distance fares lookup skipped: not enabled or business not found', { businessId, enableDistanceFares: business?.enableDistanceFares });
    return [];
  }

  const mappedTripType = tripTypeMap[tripType] || 'oneway';
  const days = Number(numberOfDays);
  const useDayBasedEstimate = mappedTripType === 'round_trip' && Number.isFinite(days) && days > 0;

  let distanceKm;
  if (useDayBasedEstimate) {
    const perDayKm = business.roundTripPerDayKm || 250;
    distanceKm = days * perDayKm;
  } else {
    const fromCity = (pickupLocation || '').toLowerCase().trim();
    const toCity = (dropLocation || '').toLowerCase().trim();
    if (!fromCity || !toCity) {
      logger.warn('Distance fares lookup skipped: empty pickup/drop location', { businessId, pickupLocation, dropLocation });
      return [];
    }

    const cacheKey = `distance:${businessId}:${fromCity}:${toCity}`;
    let oneWayDistanceKm = null;
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null && cached !== undefined) {
        oneWayDistanceKm = Number(cached);
      }
    } catch (error) {
      logger.error('Error reading distance cache:', error);
    }

    if (oneWayDistanceKm === null) {
      oneWayDistanceKm = await distanceMatrixService.getDistanceKm(pickupLocation, dropLocation);
      if (oneWayDistanceKm === null) {
        logger.warn('Distance fares lookup skipped: distance lookup failed', { businessId, fromCity, toCity });
        return [];
      }
      try {
        await redis.set(cacheKey, oneWayDistanceKm, 'EX', 604800);
      } catch (error) {
        logger.error('Error writing distance cache:', error);
      }
    }

    distanceKm = mappedTripType === 'round_trip' ? oneWayDistanceKm * 2 : oneWayDistanceKm;
  }

  let vehicles;
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('*, catalog:vehicle_type_catalog(name, photo_url, seats)')
      .eq('business_id', businessId).eq('is_active', true).not('per_km_rate', 'is', null);
    if (error) throw error;
    vehicles = data || [];
  } catch (error) {
    logger.error('Error finding distance-based vehicle options:', error);
    return [];
  }

  if (vehicles.length === 0) {
    logger.warn('Distance fares lookup skipped: no active/priced vehicles found', { businessId });
    return [];
  }

  const driverDaTotal = (useDayBasedEstimate && business.roundTripDriverDaEnabled)
    ? business.roundTripDriverDaAmount * days
    : 0;

  const options = vehicles.map((vehicle, idx) => {
    const baseFare = Math.round((distanceKm * vehicle.per_km_rate) / 10) * 10;
    const option = {
      index: idx,
      vehicleId: vehicle.id,
      name: vehicle.custom_name || vehicle.catalog.name,
      photoUrl: vehicle.custom_photo_url || vehicle.catalog.photo_url || null,
      seats: vehicle.catalog.seats || null,
      fare: baseFare + driverDaTotal,
      source: 'distance_estimate',
      distanceKm: Math.round(distanceKm * 10) / 10
    };
    if (driverDaTotal > 0) {
      option.driverDaIncluded = true;
      option.driverDaTotal = driverDaTotal;
      option.driverDaPerDay = business.roundTripDriverDaAmount;
      option.driverDaDays = days;
    }
    return option;
  });

  logger.info('Distance-based fares computed', { businessId, fromCity: pickupLocation, toCity: dropLocation, distanceKm, vehicleCount: vehicles.length });
  return options;
};

/**
 * Three-tier vehicle carousel lookup: real route fares first, then a
 * distance-based estimate for opted-in businesses. Returns [] if neither source
 * has anything to offer, so callers fall through to the generic vehicleType list.
 * @param {string|number} [numberOfDays] - passed through to the distance-estimate tier for round trips
 */
const findBestVehicleCarouselOptions = async (businessId, pickupLocation, dropLocation, tripType, numberOfDays) => {
  const matchedRouteFares = await findMatchingVehicleOptions(businessId, pickupLocation, dropLocation, tripType);
  if (matchedRouteFares.length > 0) {
    return buildVehicleCarouselOptions(matchedRouteFares);
  }
  return findDistanceBasedVehicleOptions(businessId, pickupLocation, dropLocation, tripType, numberOfDays);
};

/**
 * Group a business's active rental packages by packageKey, deduplicating across
 * vehicles (per-vehicle price differences are resolved later, at the
 * vehicleType/carousel step). Returns a Map<packageKey, label> so callers
 * can build both the display option list and a label->packageKey lookup.
 */
const groupRentalPackagesByKey = async (businessId) => {
  const byKey = new Map();
  try {
    const { data, error } = await supabase
      .from('rental_packages').select('package_key, label').eq('business_id', businessId).eq('is_active', true);
    if (error) throw error;
    for (const pkg of data || []) {
      if (!byKey.has(pkg.package_key)) {
        byKey.set(pkg.package_key, pkg.label || pkg.package_key);
      }
    }
  } catch (error) {
    logger.error('Error grouping rental packages:', error);
  }
  return byKey;
};

/**
 * Unique, customer-facing rental package labels for a business (deduplicated
 * across vehicles), for populating the dynamically-inserted 'rentalPackage'
 * list field.
 * @returns {Promise<Array<string>>}
 */
const findRentalPackageOptions = async (businessId) => {
  const byKey = await groupRentalPackagesByKey(businessId);
  return Array.from(byKey.values());
};

/**
 * Build carousel-shaped vehicle options for a specific rental package key,
 * one per vehicle offering that package. Mirrors buildVehicleCarouselOptions'
 * shape (source: 'rental_package' instead of 'route_fare').
 * @returns {Promise<Array>}
 */
const findRentalVehicleCarouselOptions = async (businessId, packageKey) => {
  try {
    const { data, error } = await supabase
      .from('rental_packages')
      .select('*, vehicle:vehicles(id, custom_name, custom_photo_url, is_active, catalog:vehicle_type_catalog(name, photo_url, seats))')
      .eq('business_id', businessId).eq('package_key', packageKey).eq('is_active', true);
    if (error) throw error;

    return (data || [])
      .filter(rp => rp.vehicle && rp.vehicle.is_active)
      .map((rp, idx) => ({
        index: idx,
        rentalPackageId: rp.id,
        vehicleId: rp.vehicle.id,
        name: rp.vehicle.custom_name || rp.vehicle.catalog.name,
        photoUrl: rp.vehicle.custom_photo_url || rp.vehicle.catalog.photo_url || null,
        seats: rp.vehicle.catalog.seats || null,
        fare: rp.price,
        source: 'rental_package',
        extraKmRate: rp.extra_km_rate,
        extraHrRate: rp.extra_hr_rate
      }));
  } catch (error) {
    logger.error('Error finding rental vehicle carousel options:', error);
    return [];
  }
};

/**
 * Resolve the right carousel-options source for the session's trip type:
 * rental packages for Local Rental (using the packageKey resolved from the
 * label the customer picked), otherwise the route-fare/distance-estimate
 * two-tier lookup (with numberOfDays passed through for round trips).
 */
const getCarouselOptionsForSession = async (businessId, session) => {
  const mappedTripType = tripTypeMap[session.collected.tripType] || 'oneway';
  if (mappedTripType === 'local') {
    if (session.localRentalUnconfigured) {
      // No RentalPackage configured for this business — skip pricing entirely
      // and let the generic vehicleType list field stand, same as the
      // "no route fare exists" case.
      logger.info('Carousel options resolved', { businessId, tripType: mappedTripType, branch: 'local_rental_unconfigured', optionCount: 0 });
      return [];
    }
    const packageKey = session.rentalPackageKeyByLabel && session.rentalPackageKeyByLabel[session.collected.rentalPackage];
    const result = packageKey ? await findRentalVehicleCarouselOptions(businessId, packageKey) : [];
    logger.info('Carousel options resolved', { businessId, tripType: mappedTripType, branch: 'local_rental', optionCount: result.length });
    return result;
  }
  const result = await findBestVehicleCarouselOptions(
    businessId,
    session.collected.pickupLocation,
    session.collected.dropLocation,
    session.collected.tripType,
    session.collected.numberOfDays
  );
  const branch = result.length > 0 ? result[0].source : 'none';
  logger.info('Carousel options resolved', { businessId, tripType: mappedTripType, branch, optionCount: result.length });
  return result;
};

/**
 * Shared "carousel gone stale" recovery: re-run the appropriate lookup and
 * either refresh the carousel in place or drop to the generic vehicleType
 * list if nothing is left to offer.
 */
const rebuildCarouselOrFallback = async (businessId, customerNumber, session, currentField, languageCode) => {
  const freshOptions = await getCarouselOptionsForSession(businessId, session);

  if (freshOptions.length > 0) {
    session.fields[session.step] = { ...currentField, options: freshOptions };
    await saveBookingSession(businessId, customerNumber, session);
    return 'Sorry, that vehicle is no longer available for this route. Here are the current options:';
  }

  const genericVehicleField = await fallbackToGenericVehicleField(businessId, session);
  await saveBookingSession(businessId, customerNumber, session);
  return localizeField(genericVehicleField, languageCode);
};

/**
 * Swap the current step's field for the generic, free-choice 'vehicleType'
 * list field from the template (Hatchback/Sedan/SUV/etc), without advancing
 * session.step. Used both when a route has no fares left to offer and when
 * the customer explicitly asks to see options outside the carousel.
 */
const fallbackToGenericVehicleField = async (businessId, session) => {
  const { data: flow } = await supabase
    .from('business_flows').select('booking_fields').eq('business_id', businessId).maybeSingle();
  const genericVehicleField = flow.booking_fields.find(f => f.fieldKey === 'vehicleType');
  session.fields[session.step] = genericVehicleField;
  return genericVehicleField;
};

/**
 * Get Redis key for booking session
 */
const getSessionKey = (businessId, customerNumber) => {
  return `booking_session:${businessId}:${customerNumber}`;
};

/**
 * Get booking session from Redis
 * @param {string} businessId
 * @param {string} customerNumber
 * @returns {Promise<Object|null>}
 */
const getBookingSession = async (businessId, customerNumber) => {
  try {
    const sessionKey = getSessionKey(businessId, customerNumber);
    const sessionData = await redis.get(sessionKey);
    if (!sessionData) {
      return null;
    }
    return JSON.parse(sessionData);
  } catch (error) {
    logger.error('Error getting booking session:', error);
    return null;
  }
};

/**
 * Save booking session to Redis
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {Object} sessionData
 */
const saveBookingSession = async (businessId, customerNumber, sessionData) => {
  try {
    const sessionKey = getSessionKey(businessId, customerNumber);
    await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', BOOKING_SESSION_TTL);
  } catch (error) {
    logger.error('Error saving booking session:', error);
    throw error;
  }
};

/**
 * Delete booking session from Redis
 * @param {string} businessId
 * @param {string} customerNumber
 */
const deleteBookingSession = async (businessId, customerNumber) => {
  try {
    const sessionKey = getSessionKey(businessId, customerNumber);
    await redis.del(sessionKey);
  } catch (error) {
    logger.error('Error deleting booking session:', error);
    throw error;
  }
};

/**
 * Drop fields the business has opted to skip. Required fields can never be
 * disabled (enforced server-side on PUT /api/business), so this is a
 * defensive check, not the primary guard — if one somehow slips through,
 * keep it in the sequence rather than silently dropping a required answer.
 * @param {Array} sortedFields
 * @param {Array<string>} disabledFieldKeys
 * @param {string} businessId - only used for the warn log below
 * @returns {Array}
 */
const filterActiveBookingFields = (sortedFields, disabledFieldKeys, businessId) => {
  return sortedFields.filter(field => {
    if (!disabledFieldKeys.includes(field.fieldKey)) {
      return true;
    }
    if (field.required === true) {
      logger.warn('Ignoring disabledBookingFields entry for a required field', { businessId, fieldKey: field.fieldKey });
      return true;
    }
    return false;
  });
};

/**
 * If the business has a non-empty servedCities list, turn pickupLocation and
 * dropLocation into 'list' fields offering those cities (plus a trailing
 * 'Other' escape hatch) instead of the template's default plain-text field.
 * servedCities is per-business, not part of the shared BusinessTypeTemplate,
 * so this has to run dynamically against session.fields rather than being
 * baked into the static template — same idea as the tripType branching in
 * processBookingStep, just sourced from Business.servedCities instead of an
 * earlier answer. Businesses with no servedCities configured get back the
 * exact same fields, unchanged, matching today's plain-text behavior.
 * @param {Array} fields
 * @param {Array<string>} servedCities
 * @returns {Array}
 */
const applyServedCitiesFields = (fields, servedCities) => {
  if (!servedCities || servedCities.length === 0) {
    return fields;
  }
  const cityOptions = [...servedCities, 'Other'];
  return fields.map(field => {
    if (field.fieldKey !== 'pickupLocation' && field.fieldKey !== 'dropLocation') {
      return field;
    }
    return {
      ...field,
      fieldType: 'list',
      options: cityOptions
    };
  });
};

/**
 * Start a new booking session
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {string} ruleId
 * @param {string} [languageCode] - customer.preferredLanguage; when set, the returned
 *   field's label/option labels are resolved to this language (buttons/list fields only)
 * @returns {Promise<Object>} First field object (fieldKey, label, required, order, fieldType, options)
 */
const startBookingSession = async (businessId, customerNumber, ruleId, languageCode) => {
  try {
    // Step 1: Load booking fields for business's businessCategory
    const business = await businessService.getBusinessById(businessId);
    if (!business) {
      throw new Error('Business not found');
    }

    const { data: flow } = await supabase
      .from('business_flows').select('booking_fields').eq('business_id', businessId).maybeSingle();
    if (!flow || !flow.booking_fields || flow.booking_fields.length === 0) {
      throw new Error('No booking fields configured for this business type');
    }

    // Sort booking fields by order field
    const sortedFields = [...flow.booking_fields].sort((a, b) => a.order - b.order);

    const disabledFieldKeys = business.disabledBookingFields || [];
    let activeFields = filterActiveBookingFields(sortedFields, disabledFieldKeys, businessId);
    activeFields = applyServedCitiesFields(activeFields, business.servedCities);

    // Step 2: Create session object
    const sessionData = {
      step: 0,
      fields: activeFields,
      collected: {},
      ruleId: ruleId,
      startedAt: new Date().toISOString()
    };

    // Step 3: Save session to Redis
    await saveBookingSession(businessId, customerNumber, sessionData);

    // Step 4: Return first question field
    return localizeField(activeFields[0], languageCode);
  } catch (error) {
    logger.error('Error starting booking session:', error);
    throw error;
  }
};

/**
 * Process a booking step - called when customer replies during active booking session
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {string} customerReply
 * @param {Object} tenant - business info from tenant service
 * @param {string} [languageCode] - customer.preferredLanguage; when set, any field returned
 *   below has its label/option labels resolved to this language (buttons/list fields only)
 * @returns {Promise<Object|string|null>} Next question field object, or a plain string
 *   (re-prompt on invalid choice, or final confirmation text), or null if session expired
 */
const processBookingStep = async (businessId, customerNumber, customerReply, tenant, languageCode) => {
  try {
    // Step 1: Get current session
    const session = await getBookingSession(businessId, customerNumber);
    if (!session) {
      // Session expired
      return null;
    }

    // Step 2: Get current field definition
    const currentField = session.fields[session.step];
    if (!currentField) {
      logger.error('No current field found for step:', session.step);
      return null;
    }

    // Step 3: Store customer reply in collected
    const fieldType = currentField.fieldType || 'text';
    if (fieldType === 'vehicle_carousel') {
      const options = currentField.options || [];
      const trimmedReply = (customerReply || '').trim();

      if (trimmedReply.toLowerCase() === 'other') {
        // Customer opted out of the carousel via the "Other options" button —
        // drop them into the free-choice vehicleType list instead of trying
        // (and failing) to parse "other" as a numeric index.
        const genericVehicleField = await fallbackToGenericVehicleField(businessId, session);
        await saveBookingSession(businessId, customerNumber, session);
        return localizeField(genericVehicleField, languageCode);
      }

      const asNumber = Number(trimmedReply);
      const tappedOption = Number.isInteger(asNumber)
        ? options.find(opt => opt.index === asNumber)
        : null;

      if (!tappedOption) {
        // No match - re-prompt without advancing the step
        await saveBookingSession(businessId, customerNumber, session);
        return 'Please tap one of the vehicle options above.';
      }

      // Tap-time re-verification: never trust the cached option, the fare
      // or vehicle may have changed/been removed since the carousel was sent.
      // The two sources are re-verified independently (RouteFare lookup vs
      // Vehicle + cached-distance recompute) since they have nothing in common.
      if (tappedOption.source === 'distance_estimate') {
        const { data: freshVehicle } = await supabase
          .from('vehicles')
          .select('*, catalog:vehicle_type_catalog(name, photo_url, seats)')
          .eq('id', tappedOption.vehicleId).maybeSingle();

        const isStale = !freshVehicle || !freshVehicle.is_active ||
          freshVehicle.per_km_rate === null || freshVehicle.per_km_rate === undefined;

        if (isStale) {
          const result = await rebuildCarouselOrFallback(businessId, customerNumber, session, currentField, languageCode);
          return result;
        }

        // Still valid — recompute against the CURRENT perKmRate using the
        // cached distance from the option; the distance itself doesn't
        // change, only the rate might, so no need to re-call Google. The
        // driver DA total (if any) was already computed against the
        // customer's day count when the carousel was built, so it's carried
        // over from the cached option rather than recomputed here.
        const daTotal = tappedOption.driverDaIncluded ? tappedOption.driverDaTotal : 0;
        session.collected.vehicleId = freshVehicle.id;
        session.collected.vehicleName = freshVehicle.custom_name || freshVehicle.catalog.name;
        session.collected.vehicleFare = Math.round((tappedOption.distanceKm * freshVehicle.per_km_rate) / 10) * 10 + daTotal;
        session.collected.fareSource = 'distance_estimate';
        session.collected.distanceKm = Math.round(tappedOption.distanceKm * 10) / 10;
        if (daTotal > 0) {
          session.collected.driverDaTotal = daTotal;
          session.collected.driverDaPerDay = tappedOption.driverDaPerDay;
          session.collected.driverDaDays = tappedOption.driverDaDays;
        }
        session.collected[currentField.fieldKey] = session.collected.vehicleName;
      } else if (tappedOption.source === 'rental_package') {
        const { data: freshRentalPackage } = await supabase
          .from('rental_packages')
          .select('*, vehicle:vehicles(id, custom_name, is_active, catalog:vehicle_type_catalog(name))')
          .eq('id', tappedOption.rentalPackageId).maybeSingle();

        const isStale = !freshRentalPackage || !freshRentalPackage.is_active ||
          !freshRentalPackage.vehicle || !freshRentalPackage.vehicle.is_active;

        if (isStale) {
          const result = await rebuildCarouselOrFallback(businessId, customerNumber, session, currentField, languageCode);
          return result;
        }

        // Still valid — always trust the fresh read for fare/name, not the cache.
        session.collected.vehicleId = freshRentalPackage.vehicle.id;
        session.collected.vehicleName = freshRentalPackage.vehicle.custom_name || freshRentalPackage.vehicle.catalog.name;
        session.collected.vehicleFare = freshRentalPackage.price;
        session.collected.rentalPackageId = freshRentalPackage.id;
        session.collected.fareSource = 'rental_package';
        session.collected.extraKmRate = freshRentalPackage.extra_km_rate;
        session.collected.extraHrRate = freshRentalPackage.extra_hr_rate;
        session.collected[currentField.fieldKey] = session.collected.vehicleName;
      } else {
        const { data: freshRouteFare } = await supabase
          .from('route_fares')
          .select('*, vehicle:vehicles(id, custom_name, is_active, catalog:vehicle_type_catalog(name))')
          .eq('id', tappedOption.routeFareId).maybeSingle();

        const isStale = !freshRouteFare || !freshRouteFare.is_active ||
          !freshRouteFare.vehicle || !freshRouteFare.vehicle.is_active;

        if (isStale) {
          const result = await rebuildCarouselOrFallback(businessId, customerNumber, session, currentField, languageCode);
          return result;
        }

        // Still valid — always trust the fresh read for fare/name, not the cache.
        session.collected.vehicleId = freshRouteFare.vehicle.id;
        session.collected.vehicleName = freshRouteFare.vehicle.custom_name || freshRouteFare.vehicle.catalog.name;
        session.collected.vehicleFare = freshRouteFare.fare;
        session.collected.routeFareId = freshRouteFare.id;
        session.collected.fareSource = 'route_fare';
        session.collected[currentField.fieldKey] = session.collected.vehicleName;
      }
    } else if (fieldType === 'buttons' || fieldType === 'list') {
      const options = (currentField.options || []).map(normalizeOption);
      const trimmedReply = (customerReply || '').trim();

      // (a) typed number matching an option's 1-based position
      let resolvedOption = null;
      const asNumber = Number(trimmedReply);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
        resolvedOption = options[asNumber - 1];
      }

      // (b) text matching an option's label OR value case-insensitively —
      // English label covers the customer typing what they were shown pre-
      // translation, value covers (c) interactive selections (since
      // webhook.controller.js resolves those to the option's value before
      // calling this function), and every labelTranslations entry covers a
      // customer typing the localized label they were actually shown — they
      // may type in either script, so all languages are checked, not just
      // the active one.
      if (!resolvedOption) {
        resolvedOption = options.find(opt =>
          opt.label.toLowerCase() === trimmedReply.toLowerCase() ||
          opt.value.toLowerCase() === trimmedReply.toLowerCase() ||
          Object.values(opt.labelTranslations || {}).some(
            translated => (translated || '').toLowerCase() === trimmedReply.toLowerCase()
          )
        ) || null;
      }

      if (!resolvedOption) {
        // No match - re-prompt without advancing the step, using the labels
        // the customer was actually shown.
        await saveBookingSession(businessId, customerNumber, session);
        const localizedLabels = options.map(opt => getLocalizedText(opt, 'label', languageCode));
        return 'Please choose one of: ' + localizedLabels.join(', ');
      }

      if (currentField.fieldKey === 'travelDate' && resolvedOption.value === 'Other date') {
        // Customer wants to type their own date — swap this step's field for
        // a plain-text sub-question in place, without advancing session.step,
        // so their next reply is captured as free text (same pattern as
        // fallbackToGenericVehicleField's vehicle_carousel "other" swap).
        const otherDateField = {
          ...currentField,
          fieldType: 'text',
          options: [],
          label: 'Please enter the date (DD/MM/YYYY):'
        };
        session.fields[session.step] = otherDateField;
        await saveBookingSession(businessId, customerNumber, session);
        return otherDateField;
      }

      if ((currentField.fieldKey === 'pickupLocation' || currentField.fieldKey === 'dropLocation') && resolvedOption.value === 'Other') {
        // Customer's city isn't in the servedCities list — swap this step's
        // field for a plain-text sub-question in place, without advancing
        // session.step, so their next reply is captured as free text (same
        // pattern as the travelDate "Other date" swap above).
        const otherLocationField = {
          ...currentField,
          fieldType: 'text',
          options: [],
          label: currentField.fieldKey === 'pickupLocation'
            ? 'Please enter your full pickup address:'
            : 'Please enter your full drop address:'
        };
        session.fields[session.step] = otherLocationField;
        await saveBookingSession(businessId, customerNumber, session);
        return otherLocationField;
      }

      if (currentField.fieldKey === 'pickupTime' && resolvedOption.value === 'Other time') {
        // Customer wants to type their own time — swap this step's field for
        // a plain-text sub-question in place, without advancing session.step
        // (same pattern as the travelDate "Other date" swap above).
        const otherTimeField = {
          ...currentField,
          fieldType: 'text',
          options: [],
          label: 'Please enter the pickup time:'
        };
        session.fields[session.step] = otherTimeField;
        await saveBookingSession(businessId, customerNumber, session);
        return otherTimeField;
      }

      session.collected[currentField.fieldKey] = currentField.fieldKey === 'travelDate'
        ? resolveTravelDateOption(resolvedOption.value)
        : resolvedOption.value;
    } else {
      session.collected[currentField.fieldKey] = customerReply.trim();
    }

    // Branch the remaining field sequence by trip type, right after tripType
    // is answered. One Way is left untouched (session.fields exactly as the
    // template provided). Round Trip inserts a numberOfDays question after
    // travelDate. Local Rental swaps dropLocation for a rentalPackage
    // question, populated immediately with this business's package options.
    if (currentField.fieldKey === 'tripType') {
      const mappedTripType = tripTypeMap[session.collected.tripType] || 'oneway';

      if (mappedTripType === 'round_trip') {
        const travelDateIndex = session.fields.findIndex(f => f.fieldKey === 'travelDate');
        if (travelDateIndex !== -1) {
          session.fields.splice(travelDateIndex + 1, 0, {
            fieldKey: 'numberOfDays',
            label: 'How many days is this round trip?',
            summaryLabel: 'Days',
            required: true,
            order: session.fields[travelDateIndex].order + 0.5,
            fieldType: 'text',
            options: []
          });
        }
      } else if (mappedTripType === 'local') {
        const dropLocationIndex = session.fields.findIndex(f => f.fieldKey === 'dropLocation');
        if (dropLocationIndex !== -1) {
          const rentalPackageOptions = await findRentalPackageOptions(businessId);

          if (rentalPackageOptions.length === 0) {
            // No RentalPackage configured for this business — leave session.fields
            // untouched (dropLocation stays) so the rest of the flow falls
            // back to the same shape as One Way. The confirmation builder
            // checks this flag to show a "team will confirm pricing" note
            // instead of a fare, and the carousel swap (triggered right before
            // vehicleType) is skipped for local rental below (getCarouselOptionsForSession).
            session.localRentalUnconfigured = true;
          } else {
            const packagesByKey = await groupRentalPackagesByKey(businessId);
            const labelToKey = {};
            for (const [key, label] of packagesByKey) {
              labelToKey[label] = key;
            }
            session.rentalPackageKeyByLabel = labelToKey;

            session.fields.splice(dropLocationIndex, 1, {
              fieldKey: 'rentalPackage',
              label: 'Choose your rental package:',
              summaryLabel: 'Package',
              required: true,
              order: session.fields[dropLocationIndex].order,
              fieldType: 'list',
              options: rentalPackageOptions
            });
          }
        }
      }
    }

    // Once the field right before vehicleType is answered, pickup/drop/package
    // are all known — try to find a priced carousel (route fare, distance
    // estimate, or rental package, per trip type) and swap the generic
    // vehicleType field for it. Businesses with no matching pricing are
    // unaffected — session.fields is left untouched and the generic flow
    // proceeds exactly as before.
    //
    // Triggered dynamically off "is vehicleType the next field" rather than a
    // fixed fieldKey, since businesses can disable optional fields (e.g.
    // tollParkingIncluded) via disabledBookingFields, which removes them from
    // session.fields entirely at session creation — a hardcoded fieldKey check
    // would silently never match for those businesses.
    const nextField = session.fields[session.step + 1];
    if (nextField && nextField.fieldKey === 'vehicleType') {
      const carouselOptions = await getCarouselOptionsForSession(businessId, session);

      if (carouselOptions.length > 0) {
        const vehicleFieldIndex = session.fields.findIndex(f => f.fieldKey === 'vehicleType');
        if (vehicleFieldIndex !== -1) {
          session.fields[vehicleFieldIndex] = {
            fieldKey: 'vehicleType',
            label: 'Choose your vehicle:',
            summaryLabel: 'Vehicle',
            required: true,
            order: session.fields[vehicleFieldIndex].order,
            fieldType: 'vehicle_carousel',
            options: carouselOptions
          };
        }
      }
    }

    // Step 4: Advance step
    session.step = session.step + 1;

    // Step 5: Check if more fields remain
    if (session.step < session.fields.length) {
      // Save updated session to Redis (resets TTL)
      await saveBookingSession(businessId, customerNumber, session);

      // Return next question field
      return localizeField(session.fields[session.step], languageCode);
    }

    // Step 6: All fields collected - create booking
    return await createBookingAndConfirmation(businessId, customerNumber, session.collected, session.fields, session.localRentalUnconfigured);
  } catch (error) {
    logger.error('Error processing booking step:', error);
    throw error;
  }
};

/**
 * Shared booking-completion tail for both engines: insert the `bookings` row,
 * delete the Redis session, bump usage, build the WhatsApp confirmation text,
 * and emit the `new_booking` socket event. Extracted verbatim out of
 * processBookingStep's old inline tail so bookingGraph.service.js's
 * finalizeGraphBooking can reuse the exact same, already-proven formatting
 * logic instead of duplicating it — the two engines differ only in what
 * ordered-field-with-labels array they have (session.fields for the old
 * step/fields model, session.answeredFields for the graph model), which is
 * why that's a parameter here rather than read off a `session` shape neither
 * caller fully shares.
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {Object} collected - session.collected (field answers + fare/vehicle bookkeeping)
 * @param {Array<{fieldKey: string, label: string, summaryLabel: string}>} orderedFields -
 *   the fields actually answered, in answer order, for the fieldLines summary
 * @param {boolean} localRentalUnconfigured
 * @returns {Promise<string>} the confirmation text
 */
const createBookingAndConfirmation = async (businessId, customerNumber, collected, orderedFields, localRentalUnconfigured) => {
  const { data: customer, error: custErr } = await supabase
    .from('customers').select('id').eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
  if (custErr || !customer) {
    logger.error('Cannot create booking: no customer record found', {
      businessId, customerNumber, custErr, collected
    });
    throw new Error(`Cannot create booking: no customer record found for ${customerNumber} on business ${businessId}`);
  }

  const bookingCode = 'CAB' + Math.floor(1000 + Math.random() * 9000);

  const { data: bookingRow, error: bookingErr } = await supabase.from('bookings').insert({
    business_id: businessId,
    customer_id: customer.id,
    customer_number: customerNumber,
    status: 'pending',
    fields: collected,
    payment_status: 'not_required',
    booking_code: bookingCode
  }).select().single();
  if (bookingErr) throw bookingErr;
  const booking = toCamelCase(bookingRow);

  // Delete session from Redis
  await deleteBookingSession(businessId, customerNumber);

  // Increment booking usage (fire and forget)
  usageService.incrementUsage(businessId, 'booking').catch(err =>
    logger.error('Error incrementing booking usage:', err)
  );

  // Build confirmation message (WhatsApp bold = *value*)
  const fieldLines = orderedFields
    .map(f => {
      const value = collected[f.fieldKey];
      if (value === undefined || value === null || value === '') {
        return null;
      }
      const label = f.summaryLabel || f.label.replace('?', '');
      return label + ': *' + value + '*';
    })
    .filter(line => line !== null)
    .join('\n');

  const hasFare = collected.vehicleFare !== undefined && collected.vehicleFare !== null;
  const fareLine = !hasFare
    ? ''
    : collected.fareSource === 'distance_estimate'
      ? '\nFare: *₹' + collected.vehicleFare + ' (estimated, based on distance)*' +
        '\nDistance: *' + collected.distanceKm + ' km*'
      : '\nFare: *₹' + collected.vehicleFare + '*';

  const driverDaLine = collected.driverDaTotal
    ? '\nDriver DA: *₹' + collected.driverDaTotal + ' (' + collected.driverDaDays + ' days × ₹' + collected.driverDaPerDay + ')*'
    : '';

  const tollNoteLine = hasFare
    ? '\n\n_Note: Toll & parking charges are not included in this fare and will be collected separately._'
    : '';

  const extraRateNoteLine = (collected.fareSource === 'rental_package' &&
    collected.extraKmRate !== undefined && collected.extraKmRate !== null &&
    collected.extraHrRate !== undefined && collected.extraHrRate !== null)
    ? '\n\n_Extra km: ₹' + collected.extraKmRate + '/km, Extra hour: ₹' + collected.extraHrRate + '/hr beyond package limits._'
    : '';

  const localRentalUnconfiguredNoteLine = localRentalUnconfigured
    ? '\n\n_Note: this business hasn\'t set up rental packages yet — our team will call you to confirm pricing for this rental._'
    : '';

  const confirmationText = '✅ *Booking request received!*\n' +
    'Booking ID: *' + bookingCode + '*\n\n' +
    fieldLines +
    fareLine +
    driverDaLine +
    tollNoteLine +
    extraRateNoteLine +
    localRentalUnconfiguredNoteLine +
    '\n\nOur team will contact you shortly to confirm. 🚕';

  // Emit Socket.io event (wrap in try/catch)
  try {
    socketService.emitToBusiness(businessId.toString(), 'new_booking', {
      booking,
      customerNumber
    });
  } catch (socketError) {
    logger.error('Error emitting socket event:', socketError);
  }

  return confirmationText;
};

/**
 * Booking-completion tail for the graph engine — the counterpart to
 * processBookingStep's now-shared createBookingAndConfirmation call.
 * bookingGraph.service.js's advanceGraphSession deliberately stops at
 * {done:true, collected} without inserting a row or building confirmation
 * text (kept out of that pure-of-side-effects core); the caller (Step 12's
 * webhook.controller.js wiring) calls this once it sees {done:true}.
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {Object} session - the graph session at completion (collected,
 *   answeredFields, localRentalUnconfigured, displayOverrides)
 * @returns {Promise<string>} the confirmation text
 */
const finalizeGraphBooking = async (businessId, customerNumber, session) => {
  try {
    // session.collected holds the RAW answers the graph engine matched edge
    // conditions against (e.g. travelDate = "Today", not a calendar date —
    // see bookingGraph.service.js's advanceGraphSession). displayOverrides
    // holds the handful of fields that need a different value once the
    // session is over and only display (confirmation text + the persisted
    // bookings.fields row) remains — merged in here, at the one point
    // both engines' completion paths funnel through, so it's never visible
    // to edge-condition matching.
    const displayCollected = { ...session.collected, ...(session.displayOverrides || {}) };
    return await createBookingAndConfirmation(businessId, customerNumber, displayCollected, session.answeredFields, session.localRentalUnconfigured);
  } catch (error) {
    logger.error('Error finalizing graph booking:', error);
    throw error;
  }
};

/**
 * Read-only preview of the booking field sequence for a business's business type,
 * for the dashboard's Conversation Preview. Same template lookup and field
 * ordering as startBookingSession, but no session is created and Redis is
 * never touched.
 * @param {string} businessId
 * @returns {Promise<Object>} { fields: [...] } - the ordered bookingFields
 */
const getBookingFieldsPreview = async (businessId) => {
  const business = await businessService.getBusinessById(businessId);
  if (!business) {
    throw new Error('Business not found');
  }

  const { data: flow } = await supabase
    .from('business_flows').select('booking_fields').eq('business_id', businessId).maybeSingle();
  if (!flow || !flow.booking_fields || flow.booking_fields.length === 0) {
    throw new Error('No booking fields configured for this business type');
  }

  const sortedFields = [...flow.booking_fields].sort((a, b) => a.order - b.order);

  const disabledFieldKeys = business.disabledBookingFields || [];
  let activeFields = filterActiveBookingFields(sortedFields, disabledFieldKeys, businessId);
  activeFields = applyServedCitiesFields(activeFields, business.servedCities);

  return { fields: activeFields };
};

/**
 * Full, UNfiltered booking field sequence for a business's category — includes
 * fields currently in disabledBookingFields, unlike getBookingFieldsPreview.
 * Powers the dashboard's Booking Flow settings page, where the owner needs to
 * see (and toggle) every field the template defines, not just the active ones.
 * @param {string} businessId
 * @returns {Promise<Object>} { fields: [...] } - the ordered bookingFields, unfiltered
 */
const getAllBookingFields = async (businessId) => {
  const business = await businessService.getBusinessById(businessId);
  if (!business) {
    throw new Error('Business not found');
  }

  const { data: flow } = await supabase
    .from('business_flows').select('booking_fields').eq('business_id', businessId).maybeSingle();
  if (!flow || !flow.booking_fields || flow.booking_fields.length === 0) {
    throw new Error('No booking fields configured for this business type');
  }

  const sortedFields = [...flow.booking_fields].sort((a, b) => a.order - b.order);

  return { fields: sortedFields };
};

/**
 * Read-only preview of the vehicle carousel a customer would see for a given
 * pickup/drop/tripType, for the dashboard's Conversation Preview. Delegates
 * straight to the real fare-lookup logic (route fares first, then distance
 * estimate) so preview results match production - no session is touched.
 * @param {string} businessId
 * @param {string} pickupLocation
 * @param {string} dropLocation
 * @param {string} tripType
 * @returns {Promise<Array>} Carousel-shaped vehicle options, or []
 */
const getVehicleCarouselPreview = async (businessId, pickupLocation, dropLocation, tripType) => {
  return findBestVehicleCarouselOptions(businessId, pickupLocation, dropLocation, tripType);
};

/**
 * First-of-next-month, local midnight, relative to the given date.
 */
const getNextMonthStart = (from) => {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0);
};

/**
 * Read-only preview-credit status for a business (remaining count + next reset
 * date), for display on GET /business. Mirrors the lazy-reset math in
 * checkAndConsumeManualPreviewCredit but never mutates/persists, so it's
 * safe to call on every GET.
 * @param {Object} business - a business object with previewCreditsUsed, previewCreditsResetAt, previewCreditsPurchased
 * @returns {{ remaining: number, resetAt: Date }}
 */
const getPreviewCreditsStatus = (business) => {
  const now = new Date();
  // previewCreditsResetAt comes back as an ISO string from Supabase (unlike
  // the Date instance Mongoose used to hand back) — parse before comparing.
  const resetAtDate = business.previewCreditsResetAt ? new Date(business.previewCreditsResetAt) : null;
  const isDue = !resetAtDate || now >= resetAtDate;
  const used = isDue ? 0 : business.previewCreditsUsed;
  const resetAt = isDue ? getNextMonthStart(now) : resetAtDate;
  const remaining = Math.max(0, FREE_MONTHLY_PREVIEW_CREDITS - used) + (business.previewCreditsPurchased || 0);
  return { remaining, resetAt };
};

/**
 * Gate + consume one manual preview credit for the dashboard's Fleet page
 * "Preview as customer" button. Free monthly quota (FREE_MONTHLY_PREVIEW_CREDITS)
 * lazily resets on the first call past previewCreditsResetAt; purchased
 * credits (previewCreditsPurchased) only start decrementing once the free
 * quota for the month is exhausted. Self-contained: loads and saves the business
 * itself, so callers can invoke it directly.
 * @param {string} businessId
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
const checkAndConsumeManualPreviewCredit = async (businessId) => {
  const { data: business, error } = await supabase
    .from('businesses')
    .select('preview_credits_used, preview_credits_reset_at, preview_credits_purchased')
    .eq('id', businessId)
    .maybeSingle();
  if (error) throw error;
  if (!business) {
    throw new Error('Business not found');
  }

  const now = new Date();
  let used = business.preview_credits_used;
  let resetAt = business.preview_credits_reset_at ? new Date(business.preview_credits_reset_at) : null;
  const purchased = business.preview_credits_purchased;

  if (!resetAt || now >= resetAt) {
    used = 0;
    resetAt = getNextMonthStart(now);
  }

  const remaining = Math.max(0, FREE_MONTHLY_PREVIEW_CREDITS - used) + purchased;

  if (remaining <= 0) {
    const { error: saveErr } = await supabase.from('businesses').update({
      preview_credits_used: used,
      preview_credits_reset_at: resetAt.toISOString()
    }).eq('id', businessId);
    if (saveErr) throw saveErr;
    return { allowed: false, remaining: 0 };
  }

  let finalUsed = used;
  let finalPurchased = purchased;
  if (used < FREE_MONTHLY_PREVIEW_CREDITS) {
    finalUsed = used + 1;
  } else {
    finalPurchased = purchased - 1;
  }

  const { error: saveErr } = await supabase.from('businesses').update({
    preview_credits_used: finalUsed,
    preview_credits_reset_at: resetAt.toISOString(),
    preview_credits_purchased: finalPurchased
  }).eq('id', businessId);
  if (saveErr) throw saveErr;

  return { allowed: true, remaining: remaining - 1 };
};

module.exports = {
  getBookingSession,
  saveBookingSession,
  deleteBookingSession,
  startBookingSession,
  processBookingStep,
  findMatchingVehicleOptions,
  getBookingFieldsPreview,
  getAllBookingFields,
  getVehicleCarouselPreview,
  getPreviewCreditsStatus,
  checkAndConsumeManualPreviewCredit,
  normalizeOption,
  // Exported for bookingGraph.service.js (graph-engine rewrite in progress)
  // to reuse rather than duplicate — these are pure DB/fare lookups with no
  // dependency on the session.fields/session.step array model, so they're
  // shared as-is between the old and new engines.
  localizeField,
  findBestVehicleCarouselOptions,
  findRentalVehicleCarouselOptions,
  groupRentalPackagesByKey,
  resolveTravelDateOption,
  // Booking-completion tail for the graph engine (Step 12 wiring) — see the
  // function's own doc comment for why this lives here instead of in
  // bookingGraph.service.js or inline in webhook.controller.js.
  finalizeGraphBooking
};
