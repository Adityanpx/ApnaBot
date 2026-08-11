const RentalPackage = require('../models/RentalPackage');
const Vehicle = require('../models/Vehicle');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// apnabot-web sends/expects `package`; the model/internal booking flow uses `packageKey`.
const serializeRentalPackage = (doc) => {
  const obj = doc.toObject ? doc.toObject() : doc;
  return { ...obj, package: obj.packageKey };
};

/**
 * GET /api/rental-packages
 * List all rental packages for shop
 */
const getRentalPackages = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const rentalPackages = await RentalPackage.find({ shopId })
      .populate({
        path: 'vehicleId',
        select: 'customName catalogId',
        populate: { path: 'catalogId', select: 'name' }
      })
      .sort({ packageKey: 1 });

    return successResponse(res, 200, { rentalPackages: rentalPackages.map(serializeRentalPackage) });
  } catch (error) {
    logger.error('Error in getRentalPackages:', error);
    next(error);
  }
};

/**
 * POST /api/rental-packages
 * Create a rental package
 */
const createRentalPackage = async (req, res, next) => {
  try {
    const { vehicleId, label, price, extraKmRate, extraHrRate } = req.body;
    const packageKey = req.body.packageKey || req.body.package;
    const shopId = req.user.shopId;

    if (!vehicleId || !packageKey || price === undefined) {
      return errorResponse(res, 400, 'vehicleId, package, and price are required');
    }

    const vehicle = await Vehicle.findOne({ _id: vehicleId, shopId });
    if (!vehicle) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    const rentalPackage = await RentalPackage.create({
      shopId,
      vehicleId,
      packageKey,
      label,
      price,
      extraKmRate,
      extraHrRate
    });

    return successResponse(res, 201, serializeRentalPackage(rentalPackage), 'Rental package saved successfully');
  } catch (error) {
    logger.error('Error in createRentalPackage:', error);
    next(error);
  }
};

/**
 * PUT /api/rental-packages/:id
 * Update a rental package
 */
const updateRentalPackage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const rentalPackage = await RentalPackage.findOne({ _id: id, shopId });
    if (!rentalPackage) {
      return errorResponse(res, 404, 'Rental package not found');
    }

    const { vehicleId, label, price, extraKmRate, extraHrRate, isActive } = req.body;
    const packageKey = req.body.packageKey !== undefined ? req.body.packageKey : req.body.package;

    if (vehicleId !== undefined) {
      const vehicle = await Vehicle.findOne({ _id: vehicleId, shopId });
      if (!vehicle) {
        return errorResponse(res, 404, 'Vehicle not found');
      }
      rentalPackage.vehicleId = vehicleId;
    }

    if (packageKey !== undefined) rentalPackage.packageKey = packageKey;
    if (label !== undefined) rentalPackage.label = label;
    if (price !== undefined) rentalPackage.price = price;
    if (extraKmRate !== undefined) rentalPackage.extraKmRate = extraKmRate;
    if (extraHrRate !== undefined) rentalPackage.extraHrRate = extraHrRate;
    if (isActive !== undefined) rentalPackage.isActive = isActive;

    await rentalPackage.save();

    return successResponse(res, 200, serializeRentalPackage(rentalPackage), 'Rental package updated successfully');
  } catch (error) {
    logger.error('Error in updateRentalPackage:', error);
    next(error);
  }
};

/**
 * DELETE /api/rental-packages/:id
 * Delete a rental package
 */
const deleteRentalPackage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const rentalPackage = await RentalPackage.findOne({ _id: id, shopId });
    if (!rentalPackage) {
      return errorResponse(res, 404, 'Rental package not found');
    }

    await RentalPackage.findByIdAndDelete(id);

    return successResponse(res, 200, null, 'Rental package deleted successfully');
  } catch (error) {
    logger.error('Error in deleteRentalPackage:', error);
    next(error);
  }
};

module.exports = {
  getRentalPackages,
  createRentalPackage,
  updateRentalPackage,
  deleteRentalPackage
};
