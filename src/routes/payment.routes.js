const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireBusiness } = require('../middleware/business.middleware');

// ─── PUBLIC ROUTE — No auth (Razorpay calls this directly) ───────────────────
// MUST be declared BEFORE the protect middleware is applied
router.post('/webhook', paymentController.razorpayWebhook);

// ─── PROTECTED ROUTES — require auth + business ──────────────────────────────────
router.use(protect, requireBusiness);

// Create Razorpay payment link for a booking
router.post('/create-razorpay-link', paymentController.createRazorpayLink);

// Create UPI payment link
router.post('/create-upi-link', paymentController.createUPILink);

// Send payment link to customer via WhatsApp
router.post('/send-to-customer', paymentController.sendToCustomer);

// Get payment history — FIX: was pointing to getPaymentStatus before
router.get('/history', paymentController.getPaymentHistory);

// Get payment status for a specific booking
router.get('/status/:bookingId', paymentController.getPaymentStatus);

module.exports = router;
