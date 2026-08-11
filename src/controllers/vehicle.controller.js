const Vehicle = require('../models/Vehicle');
const VehicleTypeCatalog = require('../models/VehicleTypeCatalog');
const r2 = require('../services/r2.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/vehicles/catalog
 * List active vehicle type catalog entries for shop owners to pick from
 */
const getVehicleCatalogForShop = async (req, res, next) => {
  try {
    const catalog = await VehicleTypeCatalog.find({ isActive: true }).sort({ order: 1 });
    return successResponse(res, 200, { catalog });
  } catch (error) {
    logger.error('Error in getVehicleCatalogForShop:', error);
    next(error);
  }
};

/**
 * GET /api/vehicles
 * List all vehicles for shop
 */
const getVehicles = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const vehicles = await Vehicle.find({ shopId })
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
    const shopId = req.user.shopId;

    if (!catalogId) {
      return errorResponse(res, 400, 'catalogId is required');
    }

    const catalogEntry = await VehicleTypeCatalog.findById(catalogId);
    if (!catalogEntry) {
      return errorResponse(res, 404, 'Vehicle catalog entry not found');
    }

    const vehicle = await Vehicle.create({
      shopId,
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
    const shopId = req.user.shopId;

    const vehicle = await Vehicle.findOne({ _id: id, shopId });
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
    const shopId = req.user.shopId;

    const vehicle = await Vehicle.findOne({ _id: id, shopId });
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
    const shopId = req.user.shopId;

    const vehicle = await Vehicle.findOne({ _id: id, shopId });
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

    const shopId = req.user.shopId;
    if (!shopId) {
      return errorResponse(res, 404, 'No shop found');
    }

    const result = await r2.uploadImage(
      req.file.buffer,
      'vehicle-photos',
      `vehicle-${shopId}-${Date.now()}`,
      req.file.mimetype
    );

    return successResponse(res, 200, { imageUrl: result.url });
  } catch (error) {
    logger.error('Error in uploadVehicleImage:', error);
    next(error);
  }
};

module.exports = {
  getVehicleCatalogForShop,
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  toggleVehicle,
  uploadVehicleImage
};
