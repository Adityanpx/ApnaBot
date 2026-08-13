const RouteFare = require('../models/RouteFare');
const Vehicle = require('../models/Vehicle');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/route-fares
 * List all route fares for business
 */
const getRouteFares = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const routeFares = await RouteFare.find({ businessId })
      .populate({
        path: 'vehicleId',
        select: 'customName catalogId',
        populate: { path: 'catalogId', select: 'name' }
      })
      .sort({ fromCity: 1, toCity: 1 });

    return successResponse(res, 200, { routeFares });
  } catch (error) {
    logger.error('Error in getRouteFares:', error);
    next(error);
  }
};

/**
 * POST /api/route-fares
 * Create (or update, if the route+vehicle+tripType combo already exists) a route fare
 */
const createRouteFare = async (req, res, next) => {
  try {
    const { fromCity, toCity, tripType = 'oneway', vehicleId, fare } = req.body;
    const businessId = req.user.businessId;

    if (!fromCity || !toCity || !vehicleId || fare === undefined) {
      return errorResponse(res, 400, 'fromCity, toCity, vehicleId, and fare are required');
    }

    const vehicle = await Vehicle.findOne({ _id: vehicleId, businessId });
    if (!vehicle) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    const normalizedFromCity = fromCity.toLowerCase().trim();
    const normalizedToCity = toCity.toLowerCase().trim();

    const routeFare = await RouteFare.findOneAndUpdate(
      { businessId, fromCity: normalizedFromCity, toCity: normalizedToCity, tripType, vehicleId },
      { fare, isActive: true },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return successResponse(res, 201, routeFare, 'Route fare saved successfully');
  } catch (error) {
    logger.error('Error in createRouteFare:', error);
    next(error);
  }
};

/**
 * PUT /api/route-fares/:id
 * Update a route fare
 */
const updateRouteFare = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const routeFare = await RouteFare.findOne({ _id: id, businessId });
    if (!routeFare) {
      return errorResponse(res, 404, 'Route fare not found');
    }

    const { fromCity, toCity, tripType, vehicleId, fare, isActive } = req.body;

    if (vehicleId !== undefined) {
      const vehicle = await Vehicle.findOne({ _id: vehicleId, businessId });
      if (!vehicle) {
        return errorResponse(res, 404, 'Vehicle not found');
      }
      routeFare.vehicleId = vehicleId;
    }

    if (fromCity !== undefined) routeFare.fromCity = fromCity.toLowerCase().trim();
    if (toCity !== undefined) routeFare.toCity = toCity.toLowerCase().trim();
    if (tripType !== undefined) routeFare.tripType = tripType;
    if (fare !== undefined) routeFare.fare = fare;
    if (isActive !== undefined) routeFare.isActive = isActive;

    await routeFare.save();

    return successResponse(res, 200, routeFare, 'Route fare updated successfully');
  } catch (error) {
    logger.error('Error in updateRouteFare:', error);
    next(error);
  }
};

/**
 * DELETE /api/route-fares/:id
 * Delete a route fare
 */
const deleteRouteFare = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const routeFare = await RouteFare.findOne({ _id: id, businessId });
    if (!routeFare) {
      return errorResponse(res, 404, 'Route fare not found');
    }

    await RouteFare.findByIdAndDelete(id);

    return successResponse(res, 200, null, 'Route fare deleted successfully');
  } catch (error) {
    logger.error('Error in deleteRouteFare:', error);
    next(error);
  }
};

module.exports = {
  getRouteFares,
  createRouteFare,
  updateRouteFare,
  deleteRouteFare
};
