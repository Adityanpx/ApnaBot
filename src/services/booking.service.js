const redis = require('../config/redis');
const Booking = require('../models/Booking');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const Customer = require('../models/Customer');
const RouteFare = require('../models/RouteFare');
const RentalPackage = require('../models/RentalPackage');
const Business = require('../models/Business');
const Vehicle = require('../models/Vehicle');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const distanceMatrixService = require('./distanceMatrix.service');
const logger = require('../utils/logger');

const tripTypeMap = { 'One Way': 'oneway', 'Round Trip': 'round_trip', 'Local Rental': 'local' };

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
    const routeFares = await RouteFare.find({ businessId, fromCity, toCity, tripType: mappedTripType, isActive: true })
      .populate({ path: 'vehicleId', match: { isActive: true }, populate: { path: 'catalogId', select: 'name photoUrl seats' } });
    const result = routeFares.filter(rf => rf.vehicleId);
    logger.info('Route fare lookup', { businessId, fromCity, toCity, tripType: mappedTripType, matchCount: result.length });
    return result;
  } catch (error) {
    logger.error('Error finding matching vehicle options:', error);
    return [];
  }
};

/**
 * Map populated RouteFare docs to the option shape stored on a vehicle_carousel field.
 */
const buildVehicleCarouselOptions = (routeFares) => routeFares.map((rf, idx) => ({
  index: idx,
  routeFareId: rf._id.toString(),
  vehicleId: rf.vehicleId._id.toString(),
  name: rf.vehicleId.customName || rf.vehicleId.catalogId.name,
  photoUrl: rf.vehicleId.customPhotoUrl || rf.vehicleId.catalogId.photoUrl || null,
  seats: rf.vehicleId.catalogId.seats || null,
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
  const business = await Business.findById(businessId).select('enableDistanceFares roundTripPerDayKm roundTripDriverDaEnabled roundTripDriverDaAmount');
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
    vehicles = await Vehicle.find({ businessId, isActive: true, perKmRate: { $ne: null } })
      .populate({ path: 'catalogId', select: 'name photoUrl seats' });
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
    const baseFare = Math.round((distanceKm * vehicle.perKmRate) / 10) * 10;
    const option = {
      index: idx,
      vehicleId: vehicle._id.toString(),
      name: vehicle.customName || vehicle.catalogId.name,
      photoUrl: vehicle.customPhotoUrl || vehicle.catalogId.photoUrl || null,
      seats: vehicle.catalogId.seats || null,
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
    const packages = await RentalPackage.find({ businessId, isActive: true }).populate('vehicleId');
    for (const pkg of packages) {
      if (!byKey.has(pkg.packageKey)) {
        byKey.set(pkg.packageKey, pkg.label || pkg.packageKey);
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
    const rentalPackages = await RentalPackage.find({ businessId, packageKey, isActive: true })
      .populate({ path: 'vehicleId', match: { isActive: true }, populate: { path: 'catalogId', select: 'name photoUrl seats' } });

    return rentalPackages
      .filter(rp => rp.vehicleId)
      .map((rp, idx) => ({
        index: idx,
        rentalPackageId: rp._id.toString(),
        vehicleId: rp.vehicleId._id.toString(),
        name: rp.vehicleId.customName || rp.vehicleId.catalogId.name,
        photoUrl: rp.vehicleId.customPhotoUrl || rp.vehicleId.catalogId.photoUrl || null,
        seats: rp.vehicleId.catalogId.seats || null,
        fare: rp.price,
        source: 'rental_package',
        extraKmRate: rp.extraKmRate,
        extraHrRate: rp.extraHrRate
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
const rebuildCarouselOrFallback = async (businessId, customerNumber, session, currentField) => {
  const freshOptions = await getCarouselOptionsForSession(businessId, session);

  if (freshOptions.length > 0) {
    session.fields[session.step] = { ...currentField, options: freshOptions };
    await saveBookingSession(businessId, customerNumber, session);
    return 'Sorry, that vehicle is no longer available for this route. Here are the current options:';
  }

  const genericVehicleField = await fallbackToGenericVehicleField(businessId, session);
  await saveBookingSession(businessId, customerNumber, session);
  return genericVehicleField;
};

/**
 * Swap the current step's field for the generic, free-choice 'vehicleType'
 * list field from the template (Hatchback/Sedan/SUV/etc), without advancing
 * session.step. Used both when a route has no fares left to offer and when
 * the customer explicitly asks to see options outside the carousel.
 */
const fallbackToGenericVehicleField = async (businessId, session) => {
  const business = await Business.findById(businessId).select('businessCategory');
  const template = await BusinessTypeTemplate.findOne({ businessCategory: business.businessCategory });
  const genericVehicleField = template.bookingFields.find(f => f.fieldKey === 'vehicleType');
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
      fieldKey: field.fieldKey,
      label: field.label,
      summaryLabel: field.summaryLabel,
      required: field.required,
      order: field.order,
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
 * @returns {Promise<Object>} First field object (fieldKey, label, required, order, fieldType, options)
 */
const startBookingSession = async (businessId, customerNumber, ruleId) => {
  try {
    // Step 1: Load booking fields for business's businessCategory
    const business = await Business.findById(businessId).select('businessCategory disabledBookingFields servedCities');
    if (!business) {
      throw new Error('Business not found');
    }

    const template = await BusinessTypeTemplate.findOne({ businessCategory: business.businessCategory });
    if (!template || !template.bookingFields || template.bookingFields.length === 0) {
      throw new Error('No booking fields configured for this business type');
    }

    // Sort booking fields by order field
    const sortedFields = [...template.bookingFields].sort((a, b) => a.order - b.order);

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
    return activeFields[0];
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
 * @returns {Promise<Object|string|null>} Next question field object, or a plain string
 *   (re-prompt on invalid choice, or final confirmation text), or null if session expired
 */
const processBookingStep = async (businessId, customerNumber, customerReply, tenant) => {
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
        return genericVehicleField;
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
        const freshVehicle = await Vehicle.findById(tappedOption.vehicleId)
          .populate({ path: 'catalogId', select: 'name photoUrl seats' });

        const isStale = !freshVehicle || !freshVehicle.isActive ||
          freshVehicle.perKmRate === null || freshVehicle.perKmRate === undefined;

        if (isStale) {
          const result = await rebuildCarouselOrFallback(businessId, customerNumber, session, currentField);
          return result;
        }

        // Still valid — recompute against the CURRENT perKmRate using the
        // cached distance from the option; the distance itself doesn't
        // change, only the rate might, so no need to re-call Google. The
        // driver DA total (if any) was already computed against the
        // customer's day count when the carousel was built, so it's carried
        // over from the cached option rather than recomputed here.
        const daTotal = tappedOption.driverDaIncluded ? tappedOption.driverDaTotal : 0;
        session.collected.vehicleId = freshVehicle._id.toString();
        session.collected.vehicleName = freshVehicle.customName || freshVehicle.catalogId.name;
        session.collected.vehicleFare = Math.round((tappedOption.distanceKm * freshVehicle.perKmRate) / 10) * 10 + daTotal;
        session.collected.fareSource = 'distance_estimate';
        session.collected.distanceKm = Math.round(tappedOption.distanceKm * 10) / 10;
        if (daTotal > 0) {
          session.collected.driverDaTotal = daTotal;
          session.collected.driverDaPerDay = tappedOption.driverDaPerDay;
          session.collected.driverDaDays = tappedOption.driverDaDays;
        }
        session.collected[currentField.fieldKey] = session.collected.vehicleName;
      } else if (tappedOption.source === 'rental_package') {
        const freshRentalPackage = await RentalPackage.findById(tappedOption.rentalPackageId)
          .populate({ path: 'vehicleId', populate: { path: 'catalogId', select: 'name photoUrl seats' } });

        const isStale = !freshRentalPackage || !freshRentalPackage.isActive ||
          !freshRentalPackage.vehicleId || !freshRentalPackage.vehicleId.isActive;

        if (isStale) {
          const result = await rebuildCarouselOrFallback(businessId, customerNumber, session, currentField);
          return result;
        }

        // Still valid — always trust the fresh read for fare/name, not the cache.
        session.collected.vehicleId = freshRentalPackage.vehicleId._id.toString();
        session.collected.vehicleName = freshRentalPackage.vehicleId.customName || freshRentalPackage.vehicleId.catalogId.name;
        session.collected.vehicleFare = freshRentalPackage.price;
        session.collected.rentalPackageId = freshRentalPackage._id.toString();
        session.collected.fareSource = 'rental_package';
        session.collected.extraKmRate = freshRentalPackage.extraKmRate;
        session.collected.extraHrRate = freshRentalPackage.extraHrRate;
        session.collected[currentField.fieldKey] = session.collected.vehicleName;
      } else {
        const freshRouteFare = await RouteFare.findById(tappedOption.routeFareId)
          .populate({ path: 'vehicleId', populate: { path: 'catalogId', select: 'name photoUrl seats' } });

        const isStale = !freshRouteFare || !freshRouteFare.isActive ||
          !freshRouteFare.vehicleId || !freshRouteFare.vehicleId.isActive;

        if (isStale) {
          const result = await rebuildCarouselOrFallback(businessId, customerNumber, session, currentField);
          return result;
        }

        // Still valid — always trust the fresh read for fare/name, not the cache.
        session.collected.vehicleId = freshRouteFare.vehicleId._id.toString();
        session.collected.vehicleName = freshRouteFare.vehicleId.customName || freshRouteFare.vehicleId.catalogId.name;
        session.collected.vehicleFare = freshRouteFare.fare;
        session.collected.routeFareId = freshRouteFare._id.toString();
        session.collected.fareSource = 'route_fare';
        session.collected[currentField.fieldKey] = session.collected.vehicleName;
      }
    } else if (fieldType === 'buttons' || fieldType === 'list') {
      const options = currentField.options || [];
      const trimmedReply = (customerReply || '').trim();

      // (a) typed number matching an option's 1-based position
      let resolvedOption = null;
      const asNumber = Number(trimmedReply);
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
        resolvedOption = options[asNumber - 1];
      }

      // (b) text matching an option case-insensitively — this also covers
      // (c) interactive selections, since webhook.controller.js resolves
      // those to the option text before calling this function.
      if (!resolvedOption) {
        resolvedOption = options.find(opt => opt.toLowerCase() === trimmedReply.toLowerCase()) || null;
      }

      if (!resolvedOption) {
        // No match - re-prompt without advancing the step
        await saveBookingSession(businessId, customerNumber, session);
        return 'Please choose one of: ' + options.join(', ');
      }

      if (currentField.fieldKey === 'travelDate' && resolvedOption === 'Other date') {
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

      if ((currentField.fieldKey === 'pickupLocation' || currentField.fieldKey === 'dropLocation') && resolvedOption === 'Other') {
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

      if (currentField.fieldKey === 'pickupTime' && resolvedOption === 'Other time') {
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
        ? resolveTravelDateOption(resolvedOption)
        : resolvedOption;
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
      return session.fields[session.step];
    }

    // Step 6: All fields collected - create booking
    const customer = await Customer.findOne({ businessId, whatsappNumber: customerNumber });

    const bookingCode = 'CAB' + Math.floor(1000 + Math.random() * 9000);

    const booking = await Booking.create({
      businessId,
      customerId: customer ? customer._id : null,
      customerNumber,
      status: 'pending',
      fields: session.collected,
      paymentStatus: 'not_required',
      bookingCode
    });

    // Delete session from Redis
    await deleteBookingSession(businessId, customerNumber);

    // Increment booking usage (fire and forget)
    usageService.incrementUsage(businessId, 'booking').catch(err =>
      logger.error('Error incrementing booking usage:', err)
    );

    // Build confirmation message (WhatsApp bold = *value*)
    const fieldLines = session.fields
      .map(f => {
        const value = session.collected[f.fieldKey];
        if (value === undefined || value === null || value === '') {
          return null;
        }
        const label = f.summaryLabel || f.label.replace('?', '');
        return label + ': *' + value + '*';
      })
      .filter(line => line !== null)
      .join('\n');

    const hasFare = session.collected.vehicleFare !== undefined && session.collected.vehicleFare !== null;
    const fareLine = !hasFare
      ? ''
      : session.collected.fareSource === 'distance_estimate'
        ? '\nFare: *₹' + session.collected.vehicleFare + ' (estimated, based on distance)*' +
          '\nDistance: *' + session.collected.distanceKm + ' km*'
        : '\nFare: *₹' + session.collected.vehicleFare + '*';

    const driverDaLine = session.collected.driverDaTotal
      ? '\nDriver DA: *₹' + session.collected.driverDaTotal + ' (' + session.collected.driverDaDays + ' days × ₹' + session.collected.driverDaPerDay + ')*'
      : '';

    const tollNoteLine = hasFare
      ? '\n\n_Note: Toll & parking charges are not included in this fare and will be collected separately._'
      : '';

    const extraRateNoteLine = (session.collected.fareSource === 'rental_package' &&
      session.collected.extraKmRate !== undefined && session.collected.extraKmRate !== null &&
      session.collected.extraHrRate !== undefined && session.collected.extraHrRate !== null)
      ? '\n\n_Extra km: ₹' + session.collected.extraKmRate + '/km, Extra hour: ₹' + session.collected.extraHrRate + '/hr beyond package limits._'
      : '';

    const localRentalUnconfiguredNoteLine = session.localRentalUnconfigured
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
  } catch (error) {
    logger.error('Error processing booking step:', error);
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
  const business = await Business.findById(businessId).select('businessCategory disabledBookingFields servedCities');
  if (!business) {
    throw new Error('Business not found');
  }

  const template = await BusinessTypeTemplate.findOne({ businessCategory: business.businessCategory });
  if (!template || !template.bookingFields || template.bookingFields.length === 0) {
    throw new Error('No booking fields configured for this business type');
  }

  const sortedFields = [...template.bookingFields].sort((a, b) => a.order - b.order);

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
  const business = await Business.findById(businessId).select('businessCategory');
  if (!business) {
    throw new Error('Business not found');
  }

  const template = await BusinessTypeTemplate.findOne({ businessCategory: business.businessCategory });
  if (!template || !template.bookingFields || template.bookingFields.length === 0) {
    throw new Error('No booking fields configured for this business type');
  }

  const sortedFields = [...template.bookingFields].sort((a, b) => a.order - b.order);

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
 * @param {Object} business - a Business doc/object with previewCreditsUsed, previewCreditsResetAt, previewCreditsPurchased
 * @returns {{ remaining: number, resetAt: Date }}
 */
const getPreviewCreditsStatus = (business) => {
  const now = new Date();
  const isDue = !business.previewCreditsResetAt || now >= business.previewCreditsResetAt;
  const used = isDue ? 0 : business.previewCreditsUsed;
  const resetAt = isDue ? getNextMonthStart(now) : business.previewCreditsResetAt;
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
  const business = await Business.findById(businessId).select('previewCreditsUsed previewCreditsResetAt previewCreditsPurchased');
  if (!business) {
    throw new Error('Business not found');
  }

  const now = new Date();
  if (!business.previewCreditsResetAt || now >= business.previewCreditsResetAt) {
    business.previewCreditsUsed = 0;
    business.previewCreditsResetAt = getNextMonthStart(now);
  }

  const remaining = Math.max(0, FREE_MONTHLY_PREVIEW_CREDITS - business.previewCreditsUsed) + business.previewCreditsPurchased;

  if (remaining <= 0) {
    await business.save();
    return { allowed: false, remaining: 0 };
  }

  if (business.previewCreditsUsed < FREE_MONTHLY_PREVIEW_CREDITS) {
    business.previewCreditsUsed += 1;
  } else {
    business.previewCreditsPurchased -= 1;
  }

  await business.save();
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
  checkAndConsumeManualPreviewCredit
};
