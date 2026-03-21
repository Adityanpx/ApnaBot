const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireShop } = require('../middleware/shop.middleware');

// All routes require authentication and shop context
router.use(protect);
router.use(requireShop);

// Create Razorpay payment link
router.post('/create-razorpay-link', paymentController.createRazorpayLink);

// Create UPI payment link
router.post('/create-upi-link', paymentController.createUPILink);

// Send payment link to customer via WhatsApp
router.post('/send-to-customer', paymentController.sendToCustomer);

// Get payment history
router.get('/history', paymentController.getPaymentStatus);

// Get payment status for a booking
router.get('/status/:bookingId', paymentController.getPaymentStatus);

// Razorpay webhook (no auth required - uses signature verification)
router.post('/webhook', paymentController.razorpayWebhook);

module.exports = router;
