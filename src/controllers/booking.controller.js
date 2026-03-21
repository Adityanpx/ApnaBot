const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');
const { paginateResponse } = require('../utils/pagination');
const socketService = require('../services/socket.service');

// GET /api/bookings - List bookings for shop with filters
const getBookings = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, date, customerNumber } = req.query;
    const shopId = req.user.shopId;

    // Build filter
    const filter = { shopId };

    // Add status filter if provided
    if (status) {
      filter.status = status;
    }

    // Add date filter if provided
    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      filter.createdAt = {
        $gte: startOfDay,
        $lte: endOfDay
      };
    }

    // Add customerNumber filter if provided
    if (customerNumber) {
      filter.customerNumber = { $regex: customerNumber, $options: 'i' };
    }

    // Run count and paginated query
    const total = await Booking.countDocuments(filter);
    const bookings = await Booking.find(filter)
      .populate('customerId', 'name whatsappNumber')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const pagination = paginateResponse(total, page, limit);

    return successResponse(res, { bookings, pagination });
  } catch (error) {
    logger.error('Error fetching bookings:', error);
    return errorResponse(res, 'Failed to fetch bookings');
  }
};

// GET /api/bookings/:id - Get single booking detail
const getBookingById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const booking = await Booking.findOne({ _id: id, shopId }).populate('customerId');

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    return successResponse(res, booking);
  } catch (error) {
    logger.error('Error fetching booking:', error);
    return errorResponse(res, 'Failed to fetch booking');
  }
};

// PUT /api/bookings/:id/status - Update booking status
const updateBookingStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const shopId = req.user.shopId;

    // Validate status value
    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return errorResponse(res, 'Invalid status. Must be one of: pending, confirmed, completed, cancelled');
    }

    const booking = await Booking.findOne({ _id: id, shopId });

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    // Update status
    booking.status = status;
    await booking.save();

    // Emit socket event
    try {
      socketService.emitToShop(shopId.toString(), 'booking_updated', {
        bookingId: id,
        status
      });
    } catch (socketError) {
      logger.error('Error emitting socket event:', socketError);
    }

    return successResponse(res, booking, 200);
  } catch (error) {
    logger.error('Error updating booking status:', error);
    return errorResponse(res, 'Failed to update booking status');
  }
};

// PUT /api/bookings/:id/notes - Add or update internal notes on booking
const addBookingNotes = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const shopId = req.user.shopId;

    // Validate notes
    if (!notes || typeof notes !== 'string') {
      return errorResponse(res, 'Notes is required');
    }

    const booking = await Booking.findOne({ _id: id, shopId });

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    // Update booking notes field
    booking.fields = booking.fields || {};
    booking.fields.internalNotes = notes;
    booking.markModified('fields');
    await booking.save();

    return successResponse(res, booking, 200);
  } catch (error) {
    logger.error('Error adding booking notes:', error);
    return errorResponse(res, 'Failed to add booking notes');
  }
};

// DELETE /api/bookings/:id - Delete booking
const deleteBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const booking = await Booking.findOne({ _id: id, shopId });

    if (!booking) {
      return errorResponse(res, 'Booking not found', 404);
    }

    await Booking.deleteOne({ _id: id });

    return successResponse(res, 'Booking deleted', 200);
  } catch (error) {
    logger.error('Error deleting booking:', error);
    return errorResponse(res, 'Failed to delete booking');
  }
};

module.exports = {
  getBookings,
  getBookingById,
  updateBookingStatus,
  addBookingNotes,
  deleteBooking
};
