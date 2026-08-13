const Vehicle = require('../models/Vehicle');
const VehicleTypeCatalog = require('../models/VehicleTypeCatalog');
const r2 = require('../services/r2.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/vehicles/catalog
 * List active vehicle type catalog entries for business owners to pick from
 */
const getVehicleCatalogForBusiness = async (req, res, next) => {
  try {
    const catalog = await VehicleTypeCatalog.find({ isActive: true }).sort({ order: 1 });
    return successResponse(res, 200, { catalog });
  } catch (error) {
    logger.error('Error in getVehicleCatalogForBusiness:', error);
    next(error);
  }
};

/**
 * GET /api/vehicles
 * List all vehicles for business
 */
const getVehicles = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const vehicles = await Vehicle.find({ businessId })
      .populate('catalogId', 'name type photoUrl seats')
      .sort({ order: 1 });

    return successResponse(res, 200, { vehicles });
  } catch (error) {
    logger.error('Error in getVehicles:', error);
    next(error);
  }
};

/**
 * POST /api/vehicles
 * Create a new vehicle
 */
const createVehicle = async (req, res, next) => {
  try {
    const { catalogId, customName = null, customPhotoUrl = null, perKmRate = null, order = 0 } = req.body;
    const businessId = req.user.businessId;

    if (!catalogId) {
      return errorResponse(res, 400, 'catalogId is required');
    }

    const catalogEntry = await VehicleTypeCatalog.findById(catalogId);
    if (!catalogEntry) {
      return errorResponse(res, 404, 'Vehicle catalog entry not found');
    }

    const vehicle = await Vehicle.create({
      businessId,
      catalogId,
      customName,
      customPhotoUrl,
      perKmRate,
      order,
      isActive: true
    });

    return successResponse(res, 201, vehicle, 'Vehicle created successfully');
  } catch (error) {
    logger.error('Error in createVehicle:', error);
    next(error);
  }
};

/**
 * PUT /api/vehicles/:id
 * Update a vehicle
 */
const updateVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const vehicle = await Vehicle.findOne({ _id: id, businessId });
    if (!vehicle) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    if (req.body.catalogId !== undefined) {
      const catalogEntry = await VehicleTypeCatalog.findById(req.body.catalogId);
      if (!catalogEntry) {
        return errorResponse(res, 404, 'Vehicle catalog entry not found');
      }
    }

    const allowedFields = ['catalogId', 'customName', 'customPhotoUrl', 'perKmRate', 'isActive', 'order'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        vehicle[field] = req.body[field];
      }
    }

    await vehicle.save();

    return successResponse(res, 200, vehicle, 'Vehicle updated successfully');
  } catch (error) {
    logger.error('Error in updateVehicle:', error);
    next(error);
  }
};

/**
 * DELETE /api/vehicles/:id
 * Delete a vehicle
 */
const deleteVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const vehicle = await Vehicle.findOne({ _id: id, businessId });
    if (!vehicle) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    await Vehicle.findByIdAndDelete(id);

    return successResponse(res, 200, null, 'Vehicle deleted successfully');
  } catch (error) {
    logger.error('Error in deleteVehicle:', error);
    next(error);
  }
};

/**
 * PUT /api/vehicles/:id/toggle
 * Toggle vehicle isActive
 */
const toggleVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const vehicle = await Vehicle.findOne({ _id: id, businessId });
    if (!vehicle) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    vehicle.isActive = !vehicle.isActive;
    await vehicle.save();

    return successResponse(res, 200, vehicle);
  } catch (error) {
    logger.error('Error in toggleVehicle:', error);
    next(error);
  }
};

/**
 * POST /api/vehicles/upload-image
 * Upload a vehicle photo to R2
 */
const uploadVehicleImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }

    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const result = await r2.uploadImage(
      req.file.buffer,
      'vehicle-photos',
      `vehicle-${businessId}-${Date.now()}`,
      req.file.mimetype
    );

    return successResponse(res, 200, { imageUrl: result.url });
  } catch (error) {
    logger.error('Error in uploadVehicleImage:', error);
    next(error);
  }
};

module.exports = {
  getVehicleCatalogForBusiness,
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  toggleVehicle,
  uploadVehicleImage
};
