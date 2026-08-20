const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('../services/chatbot.service');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/flow-packs
 * List active flow packs for business owners, optionally filtered by category
 */
const getFlowPacks = async (req, res, next) => {
  try {
    const { category } = req.query;

    let query = supabase.from('flow_packs').select('*').eq('is_active', true);
    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query.order('order', { ascending: true }).order('name', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { packs: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getFlowPacks (public):', error);
    next(error);
  }
};

/**
 * POST /api/flow-packs/:id/import
 * Replace all of the business's existing rules with a flow pack's rules
 */
const importFlowPack = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: pack, error: fetchErr } = await supabase
      .from('flow_packs').select('*').eq('id', id).eq('is_active', true).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!pack) return errorResponse(res, 404, 'Flow pack not found');

    const packRules = Array.isArray(pack.rules) ? pack.rules : [];

    const { error: deleteErr } = await supabase.from('rules').delete().eq('business_id', businessId);
    if (deleteErr) throw deleteErr;

    let createdRules = [];
    if (packRules.length > 0) {
      const { data: inserted, error: insertErr } = await supabase.from('rules').insert(
        packRules.map((rule) => ({
          business_id: businessId,
          keyword: rule.keyword,
          match_type: rule.matchType || 'contains',
          reply: rule.reply || '',
          reply_type: rule.replyType || 'text',
          reply_image_url: rule.replyImageUrl || null,
          buttons: (rule.buttons || []).map(b => ({
            title: b.title,
            nextKeyword: b.nextKeyword
          })),
          list_options: (rule.listOptions || []).map(o => ({
            label: o.label,
            description: o.description || '',
            nextKeyword: o.nextKeyword
          })),
          hindi_aliases: rule.hindiAliases || [],
          is_active: true,
          trigger_count: 0
        }))
      ).select();
      if (insertErr) {
        logger.error(
          `Flow pack import: rules for business ${businessId} were deleted but re-insert from pack ${id} failed — manual recovery needed`,
          insertErr
        );
        throw insertErr;
      }
      createdRules = inserted || [];
    }

    await invalidateRulesCache(businessId);

    return successResponse(
      res,
      200,
      { rules: createdRules.map(toCamelCase) },
      `Replaced your existing keyword replies with the '${pack.name}' flow`
    );
  } catch (error) {
    logger.error('Error in importFlowPack:', error);
    next(error);
  }
};

module.exports = {
  getFlowPacks,
  importFlowPack
};
