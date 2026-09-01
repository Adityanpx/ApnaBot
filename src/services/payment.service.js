const Razorpay = require('razorpay');
const config = require('../config/env');
const supabase = require('../config/supabase');
const businessService = require('./business.service');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { toCamelCase } = require('../utils/caseConvert');
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

    if (bookingId) {
      const { error } = await supabase.from('bookings').update({
        payment_link: paymentLink.short_url,
        payment_id: paymentLink.id,
        payment_status: 'pending'
      }).eq('id', bookingId);
      if (error) throw error;
    }

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
      tn: bookingId ? `Payment for booking ${bookingId}` : 'Payment'
    });

    // Generate UPI payment link
    const upiLink = `upi://pay?${upiParams.toString()}`;

    if (bookingId) {
      const { error } = await supabase.from('bookings').update({
        upi_link: upiLink,
        payment_status: 'pending'
      }).eq('id', bookingId);
      if (error) throw error;
    }

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

  const { data: booking, error } = await supabase
    .from('bookings').select('id, business_id, customer_id, customer_number, booking_code')
    .eq('payment_id', paymentLinkId).maybeSingle();
  if (error) throw error;

  if (booking) {
    // Auto-confirm on payment — a deliberate choice (not an oversight): an
    // advance-payment booking has no other "confirmed" trigger today, so
    // without this it would sit at status='pending' forever even once paid.
    // Revisit if a business ever wants a manual confirm-after-payment step.
    const { error: updateErr } = await supabase.from('bookings').update({
      status: 'confirmed',
      payment_status: 'paid',
      payment_details: {
        paymentId: paymentLinkId,
        amount: paymentLink.amount / 100, // Convert from paise
        paidAt: new Date(),
        status: 'completed'
      }
    }).eq('id', booking.id);
    if (updateErr) throw updateErr;

    logger.info('Payment completed for booking:', booking.id);

    try {
      socketService.emitToBusiness(booking.business_id.toString(), 'booking_updated', {
        bookingId: booking.id,
        status: 'confirmed'
      });
    } catch (socketError) {
      logger.error('Error emitting booking_updated socket event:', socketError);
    }

    try {
      const business = await businessService.getBusinessById(booking.business_id);
      if (!business) {
        logger.error('Cannot send advance-paid confirmation: business not found', { businessId: booking.business_id, bookingId: booking.id });
        return;
      }

      const { data: customerRow, error: customerErr } = await supabase
        .from('customers').select('*').eq('id', booking.customer_id).maybeSingle();
      if (customerErr) throw customerErr;

      const confirmationText = `✅ Advance received! Your booking ${booking.booking_code} is confirmed. Our team will contact you shortly.`;

      const { data: messageRow, error: msgErr } = await supabase.from('messages').insert({
        business_id: booking.business_id,
        customer_id: booking.customer_id,
        customer_number: booking.customer_number,
        direction: 'outbound',
        type: 'text',
        content: confirmationText,
        status: 'sent',
        is_read: true
      }).select().single();
      if (msgErr) throw msgErr;
      const message = toCamelCase(messageRow);

      await addToWhatsappQueue({
        businessId: booking.business_id,
        phoneNumberId: business.phoneNumberId,
        encryptedAccessToken: business.accessToken,
        to: booking.customer_number,
        message: confirmationText,
        type: 'text',
        messageId: message.id
      });

      usageService.incrementUsage(booking.business_id, 'outbound').catch(err =>
        logger.error('Error incrementing outbound usage:', err)
      );

      try {
        socketService.emitToBusiness(booking.business_id.toString(), 'new_message', {
          customer: toCamelCase(customerRow),
          message,
          customerNumber: booking.customer_number
        });
      } catch (socketError) {
        logger.error('Error emitting new_message socket event:', socketError);
      }
    } catch (sendError) {
      logger.error('Error sending advance-paid WhatsApp confirmation:', sendError);
    }
  }
};

/**
 * Handle payment link expired event
 *
 * bookings.payment_status only supports pending/paid/not_required (no
 * dedicated "expired" state), so this reverts to 'pending' — the business
 * can issue a new link.
 */
const handlePaymentLinkExpired = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  const { data: booking, error } = await supabase
    .from('bookings').select('id').eq('payment_id', paymentLinkId).maybeSingle();
  if (error) throw error;

  if (booking) {
    const { error: updateErr } = await supabase.from('bookings')
      .update({ payment_status: 'pending' }).eq('id', booking.id);
    if (updateErr) throw updateErr;

    logger.info('Payment expired for booking:', booking.id);
  }
};

/**
 * Handle payment link closed event
 *
 * Same payment_status limitation as handlePaymentLinkExpired — reverts to
 * 'pending' rather than a dedicated "cancelled" state.
 */
const handlePaymentLinkClosed = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  const { data: booking, error } = await supabase
    .from('bookings').select('id').eq('payment_id', paymentLinkId).maybeSingle();
  if (error) throw error;

  if (booking) {
    const { error: updateErr } = await supabase.from('bookings')
      .update({ payment_status: 'pending' }).eq('id', booking.id);
    if (updateErr) throw updateErr;

    logger.info('Payment cancelled for booking:', booking.id);
  }
};

module.exports = {
  createRazorpayPaymentLink,
  generateUPILink,
  verifyRazorpayWebhookSignature,
  handleRazorpayWebhook
};
