const supabase = require('../../config/supabase');
const r2 = require('../../services/r2.service');
const { successResponse, errorResponse } = require('../../utils/response');
const logger = require('../../utils/logger');

/**
 * GET /api/admin/vehicle-catalog
 * List all vehicle catalog entries (active + inactive) — superadmin
 */
const getVehicleCatalog = async (req, res, next) => {
  try {
    const { data: catalog, error } = await supabase
      .from('vehicle_type_catalog')
      .select('*')
      .order('order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    return successResponse(res, 200, { catalog });
  } catch (error) {
    logger.error('Error in getVehicleCatalog:', error);
    next(error);
  }
};

/**
 * POST /api/admin/vehicle-catalog
 * Create a new vehicle catalog entry
 */
const createVehicleCatalogEntry = async (req, res, next) => {
  try {
    const { name, type = 'sedan', photoUrl = null, seats = null, order = 0 } = req.body;

    if (!name) {
      return errorResponse(res, 400, 'name is required');
    }

    const { data: entry, error } = await supabase
      .from('vehicle_type_catalog')
      .insert({
        name: name.trim(),
        type,
        photo_url: photoUrl,
        seats,
        order,
        is_active: true
      })
      .select()
      .single();
    if (error) throw error;

    logger.info(`Vehicle catalog entry ${entry.id} created by superadmin`);
    return successResponse(res, 201, entry, 'Vehicle catalog entry created successfully');
  } catch (error) {
    logger.error('Error in createVehicleCatalogEntry:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/vehicle-catalog/:id
 * Update a vehicle catalog entry
 */
const updateVehicleCatalogEntry = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: existing } = await supabase
      .from('vehicle_type_catalog').select('id').eq('id', id).maybeSingle();
    if (!existing) return errorResponse(res, 404, 'Vehicle catalog entry not found');

    const allowedFields = ['name', 'type', 'photoUrl', 'seats', 'isActive', 'order'];
    const fieldMap = {
      name: 'name', type: 'type', photoUrl: 'photo_url',
      seats: 'seats', isActive: 'is_active', order: 'order'
    };

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[fieldMap[field]] = req.body[field];
    }

    const { data: entry, error } = await supabase
      .from('vehicle_type_catalog').update(updates).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Vehicle catalog entry ${id} updated by superadmin`);
    return successResponse(res, 200, entry, 'Vehicle catalog entry updated successfully');
  } catch (error) {
    logger.error('Error in updateVehicleCatalogEntry:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/vehicle-catalog/:id
 * Delete a vehicle catalog entry
 */
const deleteVehicleCatalogEntry = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: entry } = await supabase
      .from('vehicle_type_catalog').select('id').eq('id', id).maybeSingle();
    if (!entry) return errorResponse(res, 404, 'Vehicle catalog entry not found');

    const { error } = await supabase.from('vehicle_type_catalog').delete().eq('id', id);
    if (error) throw error;

    logger.info(`Vehicle catalog entry ${id} deleted by superadmin`);
    return successResponse(res, 200, null, 'Vehicle catalog entry deleted successfully');
  } catch (error) {
    logger.error('Error in deleteVehicleCatalogEntry:', error);
    next(error);
  }
};

/**
 * POST /api/admin/vehicle-catalog/upload-image
 * Upload a vehicle catalog image to R2
 */
const uploadVehicleCatalogImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }

    const result = await r2.uploadImage(
      req.file.buffer,
      'vehicle-catalog',
      `catalog-${Date.now()}`,
      req.file.mimetype
    );

    return successResponse(res, 200, { imageUrl: result.url });
  } catch (error) {
    logger.error('Error in uploadVehicleCatalogImage:', error);
    next(error);
  }
};

module.exports = {
  getVehicleCatalog,
  createVehicleCatalogEntry,
  updateVehicleCatalogEntry,
  deleteVehicleCatalogEntry,
  uploadVehicleCatalogImage
};
