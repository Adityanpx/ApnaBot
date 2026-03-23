const Razorpay = require('razorpay');
const config = require('../config/env');
const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const logger = require('../utils/logger');

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * Create a Razorpay payment link for a booking
 * @param {string} bookingId - The booking ID
 * @param {number} amount - Amount in paise
 * @param {string} customerName - Customer name
 * @param {string} customerPhone - Customer phone number
 * @param {string} description - Payment description
 * @returns {Promise<Object>} Payment link details
 */
const createRazorpayPaymentLink = async (bookingId, amount, customerName, customerPhone, description) => {
  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(amount), // Amount in paise
      currency: 'INR',
      description: description || 'Payment for booking',
      customer: {
        name: customerName,
        contact: customerPhone
      },
      notify: {
        sms: true,
        email: true
      },
      callback_url: `${config.FRONTEND_URL}/payment/callback?bookingId=${bookingId}`,
      callback_method: 'get'
    });

    // Update booking with payment link
    await Booking.findByIdAndUpdate(bookingId, {
      paymentLink: paymentLink.short_url,
      paymentId: paymentLink.id,
      paymentStatus: 'pending'
    });

    logger.info('Payment link created:', paymentLink.id);
    return paymentLink;
  } catch (error) {
    logger.error('Error creating Razorpay payment link:', error);
    throw error;
  }
};

/**
 * Generate a UPI payment link
 * @param {string} bookingId - The booking ID
 * @param {number} amount - Amount in rupees
 * @param {string} vpa - Virtual Payment Address (UPI ID)
 * @param {string} payeeName - Payee name
 * @returns {Object} UPI payment link details
 */
const generateUPILink = async (bookingId, amount, vpa, payeeName) => {
  try {
    // Encode parameters for UPI deep link
    const upiParams = new URLSearchParams({
      pa: vpa,
      pn: payeeName,
      am: amount.toString(),
      tn: `Payment for booking ${bookingId}`
    });

    // Generate UPI payment link
    const upiLink = `upi://pay?${upiParams.toString()}`;

    // Update booking with UPI details
    await Booking.findByIdAndUpdate(bookingId, {
      upiLink: upiLink,
      paymentStatus: 'pending'
    });

    logger.info('UPI link generated for booking:', bookingId);
    return {
      upiLink,
      vpa,
      amount,
      payeeName
    };
  } catch (error) {
    logger.error('Error generating UPI link:', error);
    throw error;
  }
};

/**
 * Verify Razorpay webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - Razorpay signature header
 * @returns {boolean} True if signature is valid
 */
const verifyRazorpayWebhookSignature = (payload, signature) => {
  try {
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    return expectedSignature === signature;
  } catch (error) {
    logger.error('Error verifying webhook signature:', error);
    return false;
  }
};

/**
 * Handle Razorpay webhook events
 * @param {Object} event - Razorpay webhook event
 */
const handleRazorpayWebhook = async (event) => {
  try {
    const { event: eventType, payload } = event;

    switch (eventType) {
      case 'payment_link.paid':
        await handlePaymentLinkPaid(payload);
        break;
      case 'payment_link.expired':
        await handlePaymentLinkExpired(payload);
        break;
      case 'payment_link.closed':
        await handlePaymentLinkClosed(payload);
        break;
      default:
        logger.info('Unhandled Razorpay event:', eventType);
    }
  } catch (error) {
    logger.error('Error handling Razorpay webhook:', error);
    throw error;
  }
};

/**
 * Handle payment link paid event
 */
const handlePaymentLinkPaid = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  // Find booking by payment ID
  const booking = await Booking.findOne({ paymentId: paymentLinkId });

  if (booking) {
    booking.paymentStatus = 'completed';
    booking.paymentDetails = {
      paymentId: paymentLinkId,
      amount: paymentLink.amount / 100, // Convert from paise
      paidAt: new Date(),
      status: 'completed'
    };
    await booking.save();

    logger.info('Payment completed for booking:', booking._id);
  }
};

/**
 * Handle payment link expired event
 */
const handlePaymentLinkExpired = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  const booking = await Booking.findOne({ paymentId: paymentLinkId });

  if (booking) {
    booking.paymentStatus = 'expired';
    await booking.save();

    logger.info('Payment expired for booking:', booking._id);
  }
};

/**
 * Handle payment link closed event
 */
const handlePaymentLinkClosed = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  const booking = await Booking.findOne({ paymentId: paymentLinkId });

  if (booking) {
    booking.paymentStatus = 'cancelled';
    await booking.save();

    logger.info('Payment cancelled for booking:', booking._id);
  }
};

/**
 * Get payment status for a booking
 * @param {string} bookingId - The booking ID
 * @returns {Promise<Object>} Payment status details
 */
const getPaymentStatus = async (bookingId) => {
  try {
    const booking = await Booking.findById(bookingId);

    if (!booking) {
      throw new Error('Booking not found');
    }

    return {
      bookingId: booking._id,
      paymentStatus: booking.paymentStatus,
      paymentLink: booking.paymentLink,
      upiLink: booking.upiLink,
      paymentDetails: booking.paymentDetails
    };
  } catch (error) {
    logger.error('Error getting payment status:', error);
    throw error;
  }
};

/**
 * Send payment link to customer via WhatsApp
 * @param {string} bookingId - The booking ID
 * @param {string} customerPhone - Customer phone number
 * @param {string} paymentLink - Payment link URL
 * @param {Object} io - Socket.io instance
 */
const sendPaymentLinkToCustomer = async (bookingId, customerPhone, paymentLink, io) => {
  try {
    const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
    
    const message = `Your payment link: ${paymentLink}\n\nPlease complete your payment to confirm the booking.`;
    
    await addToWhatsappQueue({
      to: customerPhone,
      message: message,
      shopId: null // Will be extracted from booking
    });

    logger.info('Payment link sent to customer:', customerPhone);
  } catch (error) {
    logger.error('Error sending payment link:', error);
    throw error;
  }
};

module.exports = {
  createRazorpayPaymentLink,
  generateUPILink,
  verifyRazorpayWebhookSignature,
  handleRazorpayWebhook,
  getPaymentStatus,
  sendPaymentLinkToCustomer
};
