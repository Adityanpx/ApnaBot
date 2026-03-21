const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes: protect, requireShop
// Owner and staff can access all booking routes
// Only owner can delete

// GET /api/bookings - List bookings with filters
router.get('/', protect, requireShop, bookingController.getBookings);

// PUT /:id/status - Update booking status (must be before /:id)
router.put('/:id/status', protect, requireShop, bookingController.updateBookingStatus);

// PUT /:id/notes - Add or update internal notes (must be before /:id)
router.put('/:id/notes', protect, requireShop, bookingController.addBookingNotes);

// GET /:id - Get single booking detail
router.get('/:id', protect, requireShop, bookingController.getBookingById);

// DELETE /:id - Delete booking (owner only)
router.delete('/:id', protect, requireShop, requireRole('owner'), bookingController.deleteBooking);

module.exports = router;
