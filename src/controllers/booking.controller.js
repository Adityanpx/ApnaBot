const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');
const bookingService = require('../services/booking.service');

/**
 * GET /api/bookings
 * List bookings for business with filters
 */
const getBookings = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, date, customerNumber } = req.query;
    const businessId = req.user.businessId;

    const filter = { businessId };

    if (status) {
      filter.status = status;
    }

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    if (customerNumber) {
      filter.customerNumber = { $regex: customerNumber, $options: 'i' };
    }

    const [total, bookings] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .populate('customerId', 'name whatsappNumber')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
    ]);

    const pagination = getPagination(total, page, limit);

    return successResponse(res, 200, { bookings, pagination });
  } catch (error) {
    logger.error('Error fetching bookings:', error);
    next(error);
  }
};

/**
 * GET /api/bookings/:id
 * Get single booking detail
 */
const getBookingById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const booking = await Booking.findOne({ _id: id, businessId }).populate('customerId');

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    return successResponse(res, 200, booking);
  } catch (error) {
    logger.error('Error fetching booking:', error);
    next(error);
  }
};

/**
 * PUT /api/bookings/:id/status
 * Update booking status
 */
const updateBookingStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const businessId = req.user.businessId;

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return errorResponse(res, 400, 'Invalid status. Must be one of: pending, confirmed, completed, cancelled');
    }

    const booking = await Booking.findOne({ _id: id, businessId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    booking.status = status;
    await booking.save();

    try {
      socketService.emitToBusiness(businessId.toString(), 'booking_updated', {
        bookingId: id,
        status
      });
    } catch (socketError) {
      logger.error('Error emitting socket event:', socketError);
    }

    return successResponse(res, 200, booking, 'Booking status updated');
  } catch (error) {
    logger.error('Error updating booking status:', error);
    next(error);
  }
};

/**
 * PUT /api/bookings/:id/notes
 * Add or update internal notes on booking
 */
const addBookingNotes = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const businessId = req.user.businessId;

    if (!notes || typeof notes !== 'string') {
      return errorResponse(res, 400, 'Notes is required');
    }

    const booking = await Booking.findOne({ _id: id, businessId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    booking.fields = booking.fields || {};
    booking.fields.internalNotes = notes;
    booking.markModified('fields');
    await booking.save();

    return successResponse(res, 200, booking, 'Notes added successfully');
  } catch (error) {
    logger.error('Error adding booking notes:', error);
    next(error);
  }
};

/**
 * DELETE /api/bookings/:id
 * Delete booking
 */
const deleteBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const booking = await Booking.findOne({ _id: id, businessId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    await Booking.deleteOne({ _id: id });

    return successResponse(res, 200, null, 'Booking deleted successfully');
  } catch (error) {
    logger.error('Error deleting booking:', error);
    next(error);
  }
};

/**
 * GET /api/bookings/preview-fields
 * Read-only preview of the booking field sequence for the business's
 * type, for the dashboard's Conversation Preview. No session is created.
 */
const getBookingFieldsPreview = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { fields } = await bookingService.getBookingFieldsPreview(businessId);

    return successResponse(res, 200, { fields });
  } catch (error) {
    logger.error('Error fetching booking fields preview:', error);
    next(error);
  }
};

/**
 * GET /api/bookings/preview-vehicle-options
 * Read-only preview of the vehicle carousel for a given pickup/drop/tripType,
 * for the dashboard's Conversation Preview. No session is created.
 */
const getVehicleCarouselPreview = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { pickupLocation, dropLocation, tripType, source } = req.query;

    let previewCreditsRemaining;
    if (source === 'manual_preview') {
      const credit = await bookingService.checkAndConsumeManualPreviewCredit(businessId);
      if (!credit.allowed) {
        return errorResponse(res, 402, "You've used all your free previews this month.", { previewCreditsRemaining: 0 });
      }
      previewCreditsRemaining = credit.remaining;
    }

    const options = await bookingService.getVehicleCarouselPreview(businessId, pickupLocation, dropLocation, tripType);

    const data = { options };
    if (previewCreditsRemaining !== undefined) {
      data.previewCreditsRemaining = previewCreditsRemaining;
    }

    return successResponse(res, 200, data);
  } catch (error) {
    logger.error('Error fetching vehicle carousel preview:', error);
    next(error);
  }
};

module.exports = {
  getBookings,
  getBookingById,
  updateBookingStatus,
  addBookingNotes,
  deleteBooking,
  getBookingFieldsPreview,
  getVehicleCarouselPreview
};
