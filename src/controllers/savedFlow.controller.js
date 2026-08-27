const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('../services/chatbot.service');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * POST /api/saved-flows
 * Snapshot the business's current rules into a new named saved flow
 */
const createSavedFlow = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const name = (req.body.name || '').trim();
    if (!name) return errorResponse(res, 400, 'Name is required');

    const { data: existing, error: existingErr } = await supabase
      .from('business_saved_flows').select('id').eq('business_id', businessId).eq('name', name).maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) return errorResponse(res, 409, `A saved flow named '${name}' already exists`);

    const { data: rules, error: rulesErr } = await supabase
      .from('rules').select('*').eq('business_id', businessId);
    if (rulesErr) throw rulesErr;

    const snapshotRules = (rules || []).map((rule) => ({
      keyword: rule.keyword,
      matchType: rule.match_type,
      reply: rule.reply,
      replyType: rule.reply_type,
      replyImageUrl: rule.reply_image_url,
      replyTranslations: rule.reply_translations || null,
      buttons: rule.buttons || [],
      listOptions: rule.list_options || [],
      hindiAliases: rule.hindi_aliases || []
    }));

    const { data: saved, error: insertErr } = await supabase
      .from('business_saved_flows')
      .insert({ business_id: businessId, name, rules: snapshotRules })
      .select()
      .single();
    if (insertErr) throw insertErr;

    const { error: businessUpdateErr } = await supabase
      .from('businesses').update({ active_saved_flow_id: saved.id, active_flow_pack_id: null }).eq('id', businessId);
    if (businessUpdateErr) throw businessUpdateErr;

    return successResponse(res, 201, toCamelCase(saved), `Saved current rules as '${name}'`);
  } catch (error) {
    logger.error('Error in createSavedFlow:', error);
    next(error);
  }
};

/**
 * GET /api/saved-flows
 * List this business's saved flows, newest first
 */
const getSavedFlows = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('business_saved_flows').select('*').eq('business_id', businessId).order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { savedFlows: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getSavedFlows:', error);
    next(error);
  }
};

/**
 * POST /api/saved-flows/:id/restore
 * Replace all of the business's existing rules with a saved flow's rules
 */
const restoreSavedFlow = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: saved, error: fetchErr } = await supabase
      .from('business_saved_flows').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!saved) return errorResponse(res, 404, 'Saved flow not found');

    const savedRules = Array.isArray(saved.rules) ? saved.rules : [];

    const { error: deleteErr } = await supabase.from('rules').delete().eq('business_id', businessId);
    if (deleteErr) throw deleteErr;

    let createdRules = [];
    if (savedRules.length > 0) {
      const { data: inserted, error: insertErr } = await supabase.from('rules').insert(
        savedRules.map((rule) => ({
          business_id: businessId,
          keyword: rule.keyword,
          match_type: rule.matchType || 'contains',
          reply: rule.reply || '',
          reply_type: rule.replyType || 'text',
          reply_image_url: rule.replyImageUrl || null,
          reply_translations: rule.replyTranslations || null,
          buttons: (rule.buttons || []).map(b => ({
            title: b.title,
            nextKeyword: b.nextKeyword,
            titleTranslations: b.titleTranslations || null
          })),
          list_options: (rule.listOptions || []).map(o => ({
            label: o.label,
            description: o.description || '',
            nextKeyword: o.nextKeyword,
            labelTranslations: o.labelTranslations || null,
            descriptionTranslations: o.descriptionTranslations || null
          })),
          hindi_aliases: rule.hindiAliases || [],
          is_active: true,
          trigger_count: 0
        }))
      ).select();
      if (insertErr) {
        logger.error(
          `Saved flow restore: rules for business ${businessId} were deleted but re-insert from saved flow ${id} failed — manual recovery needed`,
          insertErr
        );
        throw insertErr;
      }
      createdRules = inserted || [];
    }

    const { error: businessUpdateErr } = await supabase
      .from('businesses').update({ active_saved_flow_id: saved.id, active_flow_pack_id: null }).eq('id', businessId);
    if (businessUpdateErr) throw businessUpdateErr;

    await invalidateRulesCache(businessId);

    return successResponse(
      res,
      200,
      { rules: createdRules.map(toCamelCase) },
      `Restored your saved '${saved.name}' flow`
    );
  } catch (error) {
    logger.error('Error in restoreSavedFlow:', error);
    next(error);
  }
};

/**
 * DELETE /api/saved-flows/:id
 */
const deleteSavedFlow = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: saved, error: fetchErr } = await supabase
      .from('business_saved_flows').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!saved) return errorResponse(res, 404, 'Saved flow not found');

    const { error: deleteErr } = await supabase.from('business_saved_flows').delete().eq('id', id);
    if (deleteErr) throw deleteErr;

    const { error: clearErr } = await supabase
      .from('businesses').update({ active_saved_flow_id: null }).eq('id', businessId).eq('active_saved_flow_id', id);
    if (clearErr) throw clearErr;

    return successResponse(res, 200, null, 'Saved flow deleted successfully');
  } catch (error) {
    logger.error('Error in deleteSavedFlow:', error);
    next(error);
  }
};

module.exports = {
  createSavedFlow,
  getSavedFlows,
  restoreSavedFlow,
  deleteSavedFlow
};
