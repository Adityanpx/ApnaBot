const express = require('express');
const router = express.Router();
const reportsController = require('../controllers/reports.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');

// GET /summary - Reports: leads, bookings, revenue, conversion rate with period-over-period growth
router.get('/summary', protect, requireBusiness, reportsController.getSummary);

module.exports = router;
