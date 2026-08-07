const redis = require('../config/redis');
const Booking = require('../models/Booking');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const Customer = require('../models/Customer');
const Shop = require('../models/Shop');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const logger = require('../utils/logger');

const BOOKING_SESSION_TTL = 1800; // 30 minutes in seconds

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
    if (fieldType === 'buttons' || fieldType === 'list') {
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

    const confirmationText = '✅ *Booking request received!*\n' +
      'Booking ID: *' + bookingCode + '*\n\n' +
      fieldLines +
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
  processBookingStep
};
