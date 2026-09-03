const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const { readBusinessGraphRows } = require('../services/flowSnapshot.service');
const businessCategoryService = require('../services/businessCategory.service');
const logger = require('../utils/logger');

/**
 * GET /api/admin/category-templates
 * List all category-template rows. One per category is expected (enforced
 * at the application layer by cloneFromBusiness's delete-then-insert below,
 * not by a DB uniqueness constraint — no existing precedent for that kind
 * of DB-level uniqueness in this table elsewhere).
 */
const getCategoryTemplates = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('flow_snapshots')
      .select('id, category, name, created_at, updated_at')
      .eq('is_category_template', true)
      .order('category', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { templates: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getCategoryTemplates:', error);
    next(error);
  }
};

/**
 * POST /api/admin/category-templates/clone-from-business
 * Body: { businessId, category, name }. Reads businessId's CURRENT
 * flow_nodes/flow_edges (same read helper createSnapshot uses) and stores
 * them as a category-template row. If a template already exists for
 * category, it's replaced (delete then insert) rather than allowed to
 * duplicate — matches the "one per category" expectation from getCategoryTemplates.
 */
const cloneFromBusiness = async (req, res, next) => {
  try {
    const { businessId, category, name } = req.body;

    if (!businessId || typeof businessId !== 'string') {
      return errorResponse(res, 400, 'businessId is required');
    }
    if (!category || !(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorResponse(res, 400, 'name is required');
    }

    const { data: business, error: businessErr } = await supabase
      .from('businesses').select('id').eq('id', businessId).maybeSingle();
    if (businessErr) throw businessErr;
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    const { nodes, edges } = await readBusinessGraphRows(businessId);

    const { error: deleteErr } = await supabase
      .from('flow_snapshots').delete().eq('is_category_template', true).eq('category', category);
    if (deleteErr) throw deleteErr;

    const { data: template, error: insertErr } = await supabase.from('flow_snapshots').insert({
      business_id: null,
      category,
      name: name.trim(),
      nodes,
      edges,
      is_category_template: true,
      is_active: true
    }).select('id, category, name, created_at, updated_at').single();
    if (insertErr) throw insertErr;

    return successResponse(res, 201, toCamelCase(template));
  } catch (error) {
    logger.error('Error in cloneFromBusiness:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/category-templates/:id
 */
const deleteCategoryTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: template, error: findErr } = await supabase
      .from('flow_snapshots').select('id').eq('id', id).eq('is_category_template', true).maybeSingle();
    if (findErr) throw findErr;
    if (!template) {
      return errorResponse(res, 404, 'Category template not found');
    }

    const { error } = await supabase.from('flow_snapshots').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Category template deleted successfully');
  } catch (error) {
    logger.error('Error in deleteCategoryTemplate:', error);
    next(error);
  }
};

module.exports = {
  getCategoryTemplates,
  cloneFromBusiness,
  deleteCategoryTemplate
};
