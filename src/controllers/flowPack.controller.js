const FlowPack = require('../models/FlowPack');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/admin/flow-packs
 * List all flow packs — superadmin
 */
const getFlowPacks = async (req, res, next) => {
  try {
    const packs = await FlowPack.find().sort({ order: 1, name: 1 });
    return successResponse(res, 200, { packs });
  } catch (error) {
    logger.error('Error in getFlowPacks:', error);
    next(error);
  }
};

/**
 * GET /api/admin/flow-packs/:id
 * Get a single flow pack
 */
const getFlowPack = async (req, res, next) => {
  try {
    const { id } = req.params;

    const pack = await FlowPack.findById(id);
    if (!pack) return errorResponse(res, 404, 'Flow pack not found');

    return successResponse(res, 200, pack);
  } catch (error) {
    logger.error('Error in getFlowPack:', error);
    next(error);
  }
};

/**
 * POST /api/admin/flow-packs
 * Create a new flow pack
 */
const createFlowPack = async (req, res, next) => {
  try {
    const allowedFields = ['name', 'description', 'category', 'isActive', 'rules', 'order'];
    const data = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    }

    if (!data.name) {
      return errorResponse(res, 400, 'name is required');
    }
    if (!data.category) {
      return errorResponse(res, 400, 'category is required');
    }

    const pack = await FlowPack.create(data);

    logger.info(`Flow pack ${pack._id} created by superadmin`);
    return successResponse(res, 201, pack, 'Flow pack created successfully');
  } catch (error) {
    logger.error('Error in createFlowPack:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/flow-packs/:id
 * Update a flow pack
 */
const updateFlowPack = async (req, res, next) => {
  try {
    const { id } = req.params;

    const pack = await FlowPack.findById(id);
    if (!pack) return errorResponse(res, 404, 'Flow pack not found');

    const allowedFields = ['name', 'description', 'category', 'isActive', 'rules', 'order'];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        pack[field] = req.body[field];
      }
    }

    await pack.save();

    logger.info(`Flow pack ${id} updated by superadmin`);
    return successResponse(res, 200, pack, 'Flow pack updated successfully');
  } catch (error) {
    logger.error('Error in updateFlowPack:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/flow-packs/:id
 * Delete a flow pack
 */
const deleteFlowPack = async (req, res, next) => {
  try {
    const { id } = req.params;

    const pack = await FlowPack.findById(id);
    if (!pack) return errorResponse(res, 404, 'Flow pack not found');

    await FlowPack.findByIdAndDelete(id);

    logger.info(`Flow pack ${id} deleted by superadmin`);
    return successResponse(res, 200, null, 'Flow pack deleted successfully');
  } catch (error) {
    logger.error('Error in deleteFlowPack:', error);
    next(error);
  }
};

module.exports = {
  getFlowPacks,
  getFlowPack,
  createFlowPack,
  updateFlowPack,
  deleteFlowPack
};
