const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');
const paymentService = require('../services/payment.service');
const socketService = require('../services/socket.service');

/**
 * Create Razorpay payment link for a booking
 * POST /api/payments/create-razorpay-link
 */
const createRazorpayLink = async (req, res, next) => {
  try {
    const { bookingId, amount, description } = req.body;
    const shopId = req.user.shopId;

    if (!bookingId || !amount) {
      return errorResponse(res, 400, 'Booking ID and amount are required');
    }

    // Find booking and verify ownership
    const booking = await Booking.findOne({ _id: bookingId, shopId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    // Get customer details
    const customer = await Customer.findById(booking.customerId);

    if (!customer) {
      return errorResponse(res, 404, 'Customer not found');
    }

    // Create payment link
    const paymentLink = await paymentService.createRazorpayPaymentLink(
      bookingId,
      amount * 100, // Convert to paise
      customer.name,
      customer.whatsappNumber,
      description || 'Payment for booking'
    );

    // Emit socket event
    socketService.emitToShop(shopId, 'payment_link_created', {
      bookingId,
      paymentLink: paymentLink.short_url
    });

    logger.info('Payment link created for booking:', bookingId);

    return successResponse(res, 200, {
      paymentLink: paymentLink.short_url,
      paymentId: paymentLink.id,
      bookingId
    }, 'Payment link created successfully');
  } catch (error) {
    logger.error('Error creating Razorpay payment link:', error);
    next(error);
  }
};

/**
 * Create UPI payment link for a booking
 * POST /api/payments/create-upi-link
 */
const createUPILink = async (req, res, next) => {
  try {
    const { bookingId, amount, vpa, payeeName } = req.body;
    const shopId = req.user.shopId;

    if (!bookingId || !amount || !vpa || !payeeName) {
      return errorResponse(res, 400, 'Booking ID, amount, VPA, and payee name are required');
    }

    // Find booking and verify ownership
    const booking = await Booking.findOne({ _id: bookingId, shopId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    // Generate UPI link
    const upiDetails = await paymentService.generateUPILink(
      bookingId,
      amount,
      vpa,
      payeeName
    );

    // Emit socket event
    socketService.emitToShop(shopId, 'upi_link_created', {
      bookingId,
      upiLink: upiDetails.upiLink
    });

    logger.info('UPI link generated for booking:', bookingId);

    return successResponse(res, 200, {
      upiLink: upiDetails.upiLink,
      vpa: upiDetails.vpa,
      amount: upiDetails.amount,
      payeeName: upiDetails.payeeName,
      bookingId
    }, 'UPI link generated successfully');
  } catch (error) {
    logger.error('Error generating UPI link:', error);
    next(error);
  }
};

/**
 * Send payment link to customer via WhatsApp
 * POST /api/payments/send-to-customer
 */
const sendToCustomer = async (req, res, next) => {
  try {
    const { bookingId, paymentLink } = req.body;
    const shopId = req.user.shopId;

    if (!bookingId || !paymentLink) {
      return errorResponse(res, 400, 'Booking ID and payment link are required');
    }

    // Find booking and verify ownership
    const booking = await Booking.findOne({ _id: bookingId, shopId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    // Get customer phone
    const customer = await Customer.findById(booking.customerId);

    if (!customer) {
      return errorResponse(res, 404, 'Customer not found');
    }

    // Load shop to get WhatsApp credentials — REQUIRED for queue
    const Shop = require('../models/Shop');
    const shop = await Shop.findById(shopId);
    if (!shop || !shop.isWhatsappConnected || !shop.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this shop');
    }

    const { addToWhatsappQueue } = require('../queues/whatsapp.queue');

    const message = `Your payment link: ${paymentLink}\n\nPlease complete your payment to confirm your booking.`;

    // Queue with all required fields including shop WhatsApp credentials
    await addToWhatsappQueue({
      shopId: shopId.toString(),
      phoneNumberId: shop.phoneNumberId,
      encryptedAccessToken: shop.accessToken,
      to: customer.whatsappNumber,
      message,
      type: 'text'
    });

    logger.info('Payment link queued to customer:', customer.whatsappNumber);

    return successResponse(res, 200, null, 'Payment link sent to customer successfully');
  } catch (error) {
    logger.error('Error sending payment link to customer:', error);
    next(error);
  }
};

/**
 * Get payment history for a shop
 * GET /api/payments/history
 */
const getPaymentHistory = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;
    const { page = 1, limit = 20, status, startDate, endDate } = req.query;

    // Build filter
    const filter = { shopId };
    
    // Add payment status filter
    if (status) {
      filter.paymentStatus = status;
    }

    // Add date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }

    // Only get bookings with payment
    filter.paymentStatus = { $ne: 'not_required' };

    // Execute query
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [bookings, total] = await Promise.all([
      Booking.find(filter)
        .populate('customerId', 'name whatsappNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Booking.countDocuments(filter)
    ]);

    return successResponse(res, 200, {
      bookings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }, 'Payment history retrieved successfully');
  } catch (error) {
    logger.error('Error getting payment history:', error);
    next(error);
  }
};

/**
 * Handle Razorpay webhook
 * POST /api/payments/webhook
 */
const razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const payload = JSON.stringify(req.body);

    // Verify signature
    const isValid = paymentService.verifyRazorpayWebhookSignature(payload, signature);

    if (!isValid) {
      logger.warn('Invalid Razorpay webhook signature');
      return errorResponse(res, 400, 'Invalid signature');
    }

    // Handle webhook event
    await paymentService.handleRazorpayWebhook(req.body);

    return successResponse(res, 200, 'Webhook processed successfully');
  } catch (error) {
    logger.error('Error processing Razorpay webhook:', error);
    next(error);
  }
};

/**
 * Get payment status for a booking
 * GET /api/payments/status/:bookingId
 */
const getPaymentStatus = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const shopId = req.user.shopId;

    // Find booking and verify ownership
    const booking = await Booking.findOne({ _id: bookingId, shopId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    const paymentStatus = {
      bookingId: booking._id,
      paymentStatus: booking.paymentStatus,
      paymentAmount: booking.paymentAmount,
      paymentLink: booking.paymentLink,
      upiLink: booking.upiLink,
      paymentId: booking.paymentId,
      paymentDetails: booking.paymentDetails
    };

    return successResponse(res, 200, paymentStatus, 'Payment status retrieved successfully');
  } catch (error) {
    logger.error('Error getting payment status:', error);
    next(error);
  }
};

module.exports = {
  createRazorpayLink,
  createUPILink,
  sendToCustomer,
  getPaymentHistory,
  razorpayWebhook,
  getPaymentStatus
};
