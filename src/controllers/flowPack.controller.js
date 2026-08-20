const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/admin/flow-packs
 * List all flow packs — superadmin
 */
const getFlowPacks = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('flow_packs').select('*').order('order', { ascending: true }).order('name', { ascending: true });
    if (error) throw error;
    return successResponse(res, 200, { packs: (data || []).map(toCamelCase) });
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

    const { data: pack, error } = await supabase.from('flow_packs').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!pack) return errorResponse(res, 404, 'Flow pack not found');

    return successResponse(res, 200, toCamelCase(pack));
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
    const { name, description, category, isActive, rules, order } = req.body;

    if (!name) {
      return errorResponse(res, 400, 'name is required');
    }
    if (!category) {
      return errorResponse(res, 400, 'category is required');
    }

    const data = { name, category };
    if (description !== undefined) data.description = description;
    if (isActive !== undefined) data.is_active = isActive;
    if (rules !== undefined) data.rules = rules;
    if (order !== undefined) data.order = order;

    const { data: pack, error } = await supabase.from('flow_packs').insert(data).select().single();
    if (error) throw error;

    logger.info(`Flow pack ${pack.id} created by superadmin`);
    return successResponse(res, 201, toCamelCase(pack), 'Flow pack created successfully');
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

    const { data: existing, error: fetchErr } = await supabase.from('flow_packs').select('id').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) return errorResponse(res, 404, 'Flow pack not found');

    const fieldMap = {
      name: 'name', description: 'description', category: 'category',
      isActive: 'is_active', rules: 'rules', order: 'order'
    };
    const updates = {};
    for (const [field, column] of Object.entries(fieldMap)) {
      if (req.body[field] !== undefined) updates[column] = req.body[field];
    }

    const { data: pack, error } = await supabase
      .from('flow_packs').update(updates).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Flow pack ${id} updated by superadmin`);
    return successResponse(res, 200, toCamelCase(pack), 'Flow pack updated successfully');
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

    const { data: pack, error: fetchErr } = await supabase.from('flow_packs').select('id').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!pack) return errorResponse(res, 404, 'Flow pack not found');

    const { error } = await supabase.from('flow_packs').delete().eq('id', id);
    if (error) throw error;

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
