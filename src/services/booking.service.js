const redis = require('../config/redis');
const Booking = require('../models/Booking');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const Customer = require('../models/Customer');
const RouteFare = require('../models/RouteFare');
const Shop = require('../models/Shop');
const Vehicle = require('../models/Vehicle');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const distanceMatrixService = require('./distanceMatrix.service');
const logger = require('../utils/logger');

const tripTypeMap = { 'One Way': 'oneway', 'Round Trip': 'round_trip', 'Local Rental': 'local' };

const BOOKING_SESSION_TTL = 1800; // 30 minutes in seconds

/**
 * Find active route-fare based vehicle options for a pickup/drop pair.
 * @returns {Promise<Array>} Populated RouteFare docs (vehicleId + catalogId populated), or [] if none/invalid input
 */
const findMatchingVehicleOptions = async (shopId, pickupLocation, dropLocation, tripType) => {
  const mappedTripType = tripTypeMap[tripType] || 'oneway';
  const fromCity = (pickupLocation || '').toLowerCase().trim();
  const toCity = (dropLocation || '').toLowerCase().trim();
  if (!fromCity || !toCity) return [];
  try {
    const routeFares = await RouteFare.find({ shopId, fromCity, toCity, tripType: mappedTripType, isActive: true })
      .populate({ path: 'vehicleId', match: { isActive: true }, populate: { path: 'catalogId', select: 'name photoUrl seats' } });
    return routeFares.filter(rf => rf.vehicleId);
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
 * Find distance-estimated vehicle options for a pickup/drop pair, for shops
 * that have opted in via Shop.enableDistanceFares. Falls back to [] on any
 * "can't compute" condition (opt-out, no Google result, no priced vehicles)
 * so the caller can fall through to the next tier without special-casing.
 * @returns {Promise<Array>} Carousel-shaped options with source: 'distance_estimate', or []
 */
const findDistanceBasedVehicleOptions = async (shopId, pickupLocation, dropLocation, tripType) => {
  const shop = await Shop.findById(shopId).select('enableDistanceFares');
  if (!shop || shop.enableDistanceFares !== true) {
    return [];
  }

  const fromCity = (pickupLocation || '').toLowerCase().trim();
  const toCity = (dropLocation || '').toLowerCase().trim();
  if (!fromCity || !toCity) return [];

  const cacheKey = `distance:${shopId}:${fromCity}:${toCity}`;
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
      return [];
    }
    try {
      await redis.set(cacheKey, oneWayDistanceKm, 'EX', 604800);
    } catch (error) {
      logger.error('Error writing distance cache:', error);
    }
  }

  const mappedTripType = tripTypeMap[tripType] || 'oneway';
  const distanceKm = mappedTripType === 'round_trip' ? oneWayDistanceKm * 2 : oneWayDistanceKm;

  let vehicles;
  try {
    vehicles = await Vehicle.find({ shopId, isActive: true, perKmRate: { $ne: null } })
      .populate({ path: 'catalogId', select: 'name photoUrl seats' });
  } catch (error) {
    logger.error('Error finding distance-based vehicle options:', error);
    return [];
  }

  if (vehicles.length === 0) {
    return [];
  }

  return vehicles.map((vehicle, idx) => ({
    index: idx,
    vehicleId: vehicle._id.toString(),
    name: vehicle.customName || vehicle.catalogId.name,
    photoUrl: vehicle.customPhotoUrl || vehicle.catalogId.photoUrl || null,
    seats: vehicle.catalogId.seats || null,
    fare: Math.round((distanceKm * vehicle.perKmRate) / 10) * 10,
    source: 'distance_estimate',
    distanceKm: Math.round(distanceKm * 10) / 10
  }));
};

/**
 * Three-tier vehicle carousel lookup: real route fares first, then a
 * distance-based estimate for opted-in shops. Returns [] if neither source
 * has anything to offer, so callers fall through to the generic vehicleType list.
 */
const findBestVehicleCarouselOptions = async (shopId, pickupLocation, dropLocation, tripType) => {
  const matchedRouteFares = await findMatchingVehicleOptions(shopId, pickupLocation, dropLocation, tripType);
  if (matchedRouteFares.length > 0) {
    return buildVehicleCarouselOptions(matchedRouteFares);
  }
  return findDistanceBasedVehicleOptions(shopId, pickupLocation, dropLocation, tripType);
};

/**
 * Shared "carousel gone stale" recovery: re-run the two-tier lookup and
 * either refresh the carousel in place or drop to the generic vehicleType
 * list if nothing is left to offer for this route.
 */
const rebuildCarouselOrFallback = async (shopId, customerNumber, session, currentField) => {
  const freshOptions = await findBestVehicleCarouselOptions(
    shopId,
    session.collected.pickupLocation,
    session.collected.dropLocation,
    session.collected.tripType
  );

  if (freshOptions.length > 0) {
    session.fields[session.step] = { ...currentField, options: freshOptions };
    await saveBookingSession(shopId, customerNumber, session);
    return 'Sorry, that vehicle is no longer available for this route. Here are the current options:';
  }

  const genericVehicleField = await fallbackToGenericVehicleField(shopId, session);
  await saveBookingSession(shopId, customerNumber, session);
  return genericVehicleField;
};

/**
 * Swap the current step's field for the generic, free-choice 'vehicleType'
 * list field from the template (Hatchback/Sedan/SUV/etc), without advancing
 * session.step. Used both when a route has no fares left to offer and when
 * the customer explicitly asks to see options outside the carousel.
 */
const fallbackToGenericVehicleField = async (shopId, session) => {
  const shop = await Shop.findById(shopId).select('businessType');
  const template = await BusinessTypeTemplate.findOne({ businessType: shop.businessType });
  const genericVehicleField = template.bookingFields.find(f => f.fieldKey === 'vehicleType');
  session.fields[session.step] = genericVehicleField;
  return genericVehicleField;
};

/**
 * Get Redis key for booking session
 */
const getSessionKey = (shopId, customerNumber) => {
  return `booking_session:${shopId}:${customerNumber}`;
};

/**
 * Get booking session from Redis
 * @param {string} shopId 
 * @param {string} customerNumber 
 * @returns {Promise<Object|null>}
 */
const getBookingSession = async (shopId, customerNumber) => {
  try {
    const sessionKey = getSessionKey(shopId, customerNumber);
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
 * @param {string} shopId 
 * @param {string} customerNumber 
 * @param {Object} sessionData 
 */
const saveBookingSession = async (shopId, customerNumber, sessionData) => {
  try {
    const sessionKey = getSessionKey(shopId, customerNumber);
    await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', BOOKING_SESSION_TTL);
  } catch (error) {
    logger.error('Error saving booking session:', error);
    throw error;
  }
};

/**
 * Delete booking session from Redis
 * @param {string} shopId 
 * @param {string} customerNumber 
 */
const deleteBookingSession = async (shopId, customerNumber) => {
  try {
    const sessionKey = getSessionKey(shopId, customerNumber);
    await redis.del(sessionKey);
  } catch (error) {
    logger.error('Error deleting booking session:', error);
    throw error;
  }
};

/**
 * Start a new booking session
 * @param {string} shopId 
 * @param {string} customerNumber 
 * @param {string} ruleId
 * @returns {Promise<Object>} First field object (fieldKey, label, required, order, fieldType, options)
 */
const startBookingSession = async (shopId, customerNumber, ruleId) => {
  try {
    // Step 1: Load booking fields for shop's businessType
    const shop = await Shop.findById(shopId).select('businessType');
    if (!shop) {
      throw new Error('Shop not found');
    }

    const template = await BusinessTypeTemplate.findOne({ businessType: shop.businessType });
    if (!template || !template.bookingFields || template.bookingFields.length === 0) {
      throw new Error('No booking fields configured for this business type');
    }

    // Sort booking fields by order field
    const sortedFields = [...template.bookingFields].sort((a, b) => a.order - b.order);

    // Step 2: Create session object
    const sessionData = {
      step: 0,
      fields: sortedFields,
      collected: {},
      ruleId: ruleId,
      startedAt: new Date().toISOString()
    };

    // Step 3: Save session to Redis
    await saveBookingSession(shopId, customerNumber, sessionData);

    // Step 4: Return first question field
    return sortedFields[0];
  } catch (error) {
    logger.error('Error starting booking session:', error);
    throw error;
  }
};

/**
 * Process a booking step - called when customer replies during active booking session
 * @param {string} shopId 
 * @param {string} customerNumber 
 * @param {string} customerReply 
 * @param {Object} tenant - shop info from tenant service
 * @returns {Promise<Object|string|null>} Next question field object, or a plain string
 *   (re-prompt on invalid choice, or final confirmation text), or null if session expired
 */
const processBookingStep = async (shopId, customerNumber, customerReply, tenant) => {
  try {
    // Step 1: Get current session
    const session = await getBookingSession(shopId, customerNumber);
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
        const genericVehicleField = await fallbackToGenericVehicleField(shopId, session);
        await saveBookingSession(shopId, customerNumber, session);
        return genericVehicleField;
      }

      const asNumber = Number(trimmedReply);
      const tappedOption = Number.isInteger(asNumber)
        ? options.find(opt => opt.index === asNumber)
        : null;

      if (!tappedOption) {
        // No match - re-prompt without advancing the step
        await saveBookingSession(shopId, customerNumber, session);
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
          const result = await rebuildCarouselOrFallback(shopId, customerNumber, session, currentField);
          return result;
        }

        // Still valid — recompute against the CURRENT perKmRate using the
        // cached distance from the option; the distance itself doesn't
        // change, only the rate might, so no need to re-call Google.
        session.collected.vehicleId = freshVehicle._id.toString();
        session.collected.vehicleName = freshVehicle.customName || freshVehicle.catalogId.name;
        session.collected.vehicleFare = Math.round((tappedOption.distanceKm * freshVehicle.perKmRate) / 10) * 10;
        session.collected.fareSource = 'distance_estimate';
        session.collected[currentField.fieldKey] = session.collected.vehicleName;
      } else {
        const freshRouteFare = await RouteFare.findById(tappedOption.routeFareId)
          .populate({ path: 'vehicleId', populate: { path: 'catalogId', select: 'name photoUrl seats' } });

        const isStale = !freshRouteFare || !freshRouteFare.isActive ||
          !freshRouteFare.vehicleId || !freshRouteFare.vehicleId.isActive;

        if (isStale) {
          const result = await rebuildCarouselOrFallback(shopId, customerNumber, session, currentField);
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
        await saveBookingSession(shopId, customerNumber, session);
        return 'Please choose one of: ' + options.join(', ');
      }

      session.collected[currentField.fieldKey] = resolvedOption;
    } else {
      session.collected[currentField.fieldKey] = customerReply.trim();
    }

    // If pickup/drop are both known now, try to find route-specific vehicle
    // options and swap the generic vehicleType field for a carousel. Shops
    // with no matching (or no) RouteFares are unaffected — session.fields
    // is left untouched and the generic flow proceeds exactly as before.
    if (currentField.fieldKey === 'carrierRequired') {
      const carouselOptions = await findBestVehicleCarouselOptions(
        shopId,
        session.collected.pickupLocation,
        session.collected.dropLocation,
        session.collected.tripType
      );

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
      await saveBookingSession(shopId, customerNumber, session);

      // Return next question field
      return session.fields[session.step];
    }

    // Step 6: All fields collected - create booking
    const customer = await Customer.findOne({ shopId, whatsappNumber: customerNumber });

    const bookingCode = 'CAB' + Math.floor(1000 + Math.random() * 9000);

    const booking = await Booking.create({
      shopId,
      customerId: customer ? customer._id : null,
      customerNumber,
      status: 'pending',
      fields: session.collected,
      paymentStatus: 'not_required',
      bookingCode
    });

    // Delete session from Redis
    await deleteBookingSession(shopId, customerNumber);

    // Increment booking usage (fire and forget)
    usageService.incrementUsage(shopId, 'booking').catch(err =>
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
        ? '\nFare: *₹' + session.collected.vehicleFare + ' (estimated, based on distance)*'
        : '\nFare: *₹' + session.collected.vehicleFare + '*';

    const tollNoteLine = hasFare
      ? '\n\n_Note: Toll & parking charges are not included in this fare and will be collected separately._'
      : '';

    const confirmationText = '✅ *Booking request received!*\n' +
      'Booking ID: *' + bookingCode + '*\n\n' +
      fieldLines +
      fareLine +
      tollNoteLine +
      '\n\nOur team will contact you shortly to confirm. 🚕';

    // Emit Socket.io event (wrap in try/catch)
    try {
      socketService.emitToShop(shopId.toString(), 'new_booking', {
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

module.exports = {
  getBookingSession,
  saveBookingSession,
  deleteBookingSession,
  startBookingSession,
  processBookingStep,
  findMatchingVehicleOptions
};
