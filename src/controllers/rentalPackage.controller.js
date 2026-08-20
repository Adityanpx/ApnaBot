const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// apnabot-web sends/expects `package`; the model/internal booking flow uses `packageKey`.
const serializeRentalPackage = (row) => {
  const obj = toCamelCase(row);
  return { ...obj, package: obj.packageKey };
};

/**
 * GET /api/rental-packages
 * List all rental packages for business
 */
const getRentalPackages = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('rental_packages')
      .select('*, vehicle:vehicles(id, custom_name, catalog:vehicle_type_catalog(id, name))')
      .eq('business_id', businessId)
      .order('package_key', { ascending: true });
    if (error) throw error;

    const rentalPackages = (data || []).map(({ vehicle, ...rentalPackage }) => {
      const serialized = serializeRentalPackage(rentalPackage);
      serialized.vehicleId = vehicle ? {
        _id: vehicle.id,
        customName: vehicle.custom_name,
        catalogId: vehicle.catalog ? { _id: vehicle.catalog.id, name: vehicle.catalog.name } : null
      } : null;
      return serialized;
    });

    return successResponse(res, 200, { rentalPackages });
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
    const businessId = req.user.businessId;

    if (!vehicleId || !packageKey || price === undefined) {
      return errorResponse(res, 400, 'vehicleId, package, and price are required');
    }

    const { data: vehicle } = await supabase
      .from('vehicles').select('id').eq('id', vehicleId).eq('business_id', businessId).maybeSingle();
    if (!vehicle) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    const { data: rentalPackage, error } = await supabase.from('rental_packages').insert({
      business_id: businessId,
      vehicle_id: vehicleId,
      package_key: packageKey,
      label,
      price,
      extra_km_rate: extraKmRate,
      extra_hr_rate: extraHrRate
    }).select().single();
    if (error) throw error;

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
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('rental_packages').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Rental package not found');
    }

    const { vehicleId, label, price, extraKmRate, extraHrRate, isActive } = req.body;
    const packageKey = req.body.packageKey !== undefined ? req.body.packageKey : req.body.package;
    const updates = {};

    if (vehicleId !== undefined) {
      const { data: vehicle } = await supabase
        .from('vehicles').select('id').eq('id', vehicleId).eq('business_id', businessId).maybeSingle();
      if (!vehicle) {
        return errorResponse(res, 404, 'Vehicle not found');
      }
      updates.vehicle_id = vehicleId;
    }

    if (packageKey !== undefined) updates.package_key = packageKey;
    if (label !== undefined) updates.label = label;
    if (price !== undefined) updates.price = price;
    if (extraKmRate !== undefined) updates.extra_km_rate = extraKmRate;
    if (extraHrRate !== undefined) updates.extra_hr_rate = extraHrRate;
    if (isActive !== undefined) updates.is_active = isActive;

    const { data: rentalPackage, error } = await supabase
      .from('rental_packages').update(updates).eq('id', id).select().single();
    if (error) throw error;

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
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('rental_packages').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Rental package not found');
    }

    const { error } = await supabase.from('rental_packages').delete().eq('id', id);
    if (error) throw error;

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
