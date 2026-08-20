const supabase = require('../config/supabase');
const businessService = require('../services/business.service');
const subscriptionService = require('../services/subscription.service');
const { invalidateRulesCache } = require('../services/chatbot.service');
const r2 = require('../services/r2.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

/**
 * GET /api/rules
 * List all rules for business (paginated)
 */
const getRules = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, isActive } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = supabase.from('rules').select('*', { count: 'exact' }).eq('business_id', businessId);
    if (isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);

    return successResponse(res, 200, { rules: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error in getRules:', error);
    next(error);
  }
};

/**
 * POST /api/rules
 * Create a new rule
 */
const createRule = async (req, res, next) => {
  try {
    const { keyword, matchType = 'contains', replyType = 'text',
            replyImageUrl = null, buttons = [], listOptions = [], hindiAliases = [] } = req.body;
    let { reply } = req.body;
    const businessId = req.user.businessId;

    // Validate required fields
    if (!keyword) {
      return errorResponse(res, 400, 'Keyword is required');
    }
    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return errorResponse(res, 400, 'hindiAliases must be an array of strings.');
    }
    if (Array.isArray(buttons)) {
      if (buttons.length > 3) {
        return errorResponse(res, 400, 'A rule can have at most 3 buttons.');
      }
      for (const b of buttons) {
        if (!b.title || !b.nextKeyword) {
          return errorResponse(res, 400, 'Each button needs a title and a nextKeyword.');
        }
        if (b.title.length > 20) {
          return errorResponse(res, 400, 'Button titles must be 20 characters or less.');
        }
      }
    }
    if (Array.isArray(listOptions)) {
      if (listOptions.length > 10) {
        return errorResponse(res, 400, 'A rule can have at most 10 list options.');
      }
      for (const o of listOptions) {
        if (!o.label || !o.nextKeyword) {
          return errorResponse(res, 400, 'Each list option needs a label and a nextKeyword.');
        }
        if (o.label.length > 24) {
          return errorResponse(res, 400, 'List option labels must be 24 characters or less.');
        }
        if (o.description && o.description.length > 72) {
          return errorResponse(res, 400, 'List option descriptions must be 72 characters or less.');
        }
      }
    }
    if (buttons.length > 0 && listOptions.length > 0) {
      return errorResponse(res, 400, 'A rule can have buttons or list options, not both.');
    }
    // An image or buttons alone is valid content for a text rule (reply optional then).
    if (replyType === 'text' && !reply && !replyImageUrl && (!buttons || buttons.length === 0)) {
      return errorResponse(res, 400, 'Reply is required');
    }
    if (replyType === 'text' && !reply) {
      reply = '';
    }
    if (replyType === 'payment_trigger' && !reply) {
      reply = 'Please complete your payment.';
    }
    if (replyType === 'booking_trigger' && !reply) {
      reply = 'Great! Let me collect your details.';
    }

    // Normalize keyword
    const normalizedKeyword = keyword.toLowerCase().trim();

    // Check plan rule limit
    const subscription = await subscriptionService.getActiveSubscription(businessId);
    if (subscription && subscription.plan && subscription.plan.rule_limit !== -1) {
      const { count: ruleCount, error: countErr } = await supabase
        .from('rules').select('*', { count: 'exact', head: true }).eq('business_id', businessId);
      if (countErr) throw countErr;
      if (ruleCount >= subscription.plan.rule_limit) {
        return errorResponse(res, 403, 'Rule limit reached for your plan. Please upgrade.');
      }
    }

    // Check for duplicate keyword
    const { data: existingRule, error: existingErr } = await supabase
      .from('rules').select('id').eq('business_id', businessId).eq('keyword', normalizedKeyword).maybeSingle();
    if (existingErr) throw existingErr;
    if (existingRule) {
      return errorResponse(res, 409, 'A rule with this keyword already exists.');
    }

    // Create rule
    const { data: rule, error } = await supabase.from('rules').insert({
      business_id: businessId,
      keyword: normalizedKeyword,
      match_type: matchType,
      reply,
      reply_type: replyType,
      reply_image_url: replyImageUrl || null,
      buttons: (buttons || []).map(b => ({
        title: b.title.trim(),
        nextKeyword: b.nextKeyword.toLowerCase().trim()
      })),
      list_options: (listOptions || []).map(o => ({
        label: o.label.trim(),
        description: (o.description || '').trim(),
        nextKeyword: o.nextKeyword.toLowerCase().trim()
      })),
      hindi_aliases: (hindiAliases || []).map(a => a.trim()).filter(Boolean),
      is_active: true,
      trigger_count: 0
    }).select().single();
    if (error) throw error;

    // Invalidate cache
    await invalidateRulesCache(businessId);

    return successResponse(res, 201, toCamelCase(rule));
  } catch (error) {
    logger.error('Error in createRule:', error);
    next(error);
  }
};

/**
 * PUT /api/rules/:id
 * Update a rule
 */
const updateRule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { keyword, matchType, reply, replyType, isActive, replyImageUrl, buttons, listOptions, hindiAliases } = req.body;
    const businessId = req.user.businessId;

    // Find rule
    const { data: rule, error: findErr } = await supabase
      .from('rules').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!rule) {
      return errorResponse(res, 404, 'Rule not found');
    }

    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return errorResponse(res, 400, 'hindiAliases must be an array of strings.');
    }

    if (buttons !== undefined) {
      if (!Array.isArray(buttons)) {
        return errorResponse(res, 400, 'Buttons must be an array.');
      }
      if (buttons.length > 3) {
        return errorResponse(res, 400, 'A rule can have at most 3 buttons.');
      }
      for (const b of buttons) {
        if (!b.title || !b.nextKeyword) {
          return errorResponse(res, 400, 'Each button needs a title and a nextKeyword.');
        }
        if (b.title.length > 20) {
          return errorResponse(res, 400, 'Button titles must be 20 characters or less.');
        }
      }
    }

    if (listOptions !== undefined) {
      if (!Array.isArray(listOptions)) {
        return errorResponse(res, 400, 'List options must be an array.');
      }
      if (listOptions.length > 10) {
        return errorResponse(res, 400, 'A rule can have at most 10 list options.');
      }
      for (const o of listOptions) {
        if (!o.label || !o.nextKeyword) {
          return errorResponse(res, 400, 'Each list option needs a label and a nextKeyword.');
        }
        if (o.label.length > 24) {
          return errorResponse(res, 400, 'List option labels must be 24 characters or less.');
        }
        if (o.description && o.description.length > 72) {
          return errorResponse(res, 400, 'List option descriptions must be 72 characters or less.');
        }
      }
    }

    const effectiveButtons = buttons !== undefined ? buttons : (rule.buttons || []);
    const effectiveListOptions = listOptions !== undefined ? listOptions : (rule.list_options || []);
    if (effectiveButtons.length > 0 && effectiveListOptions.length > 0) {
      return errorResponse(res, 400, 'A rule can have buttons or list options, not both.');
    }

    const updateData = {};

    // Check for duplicate keyword if being updated
    if (keyword) {
      const normalizedKeyword = keyword.toLowerCase().trim();
      const { data: existingRule, error: existingErr } = await supabase
        .from('rules').select('id').eq('business_id', businessId).eq('keyword', normalizedKeyword).neq('id', id).maybeSingle();
      if (existingErr) throw existingErr;
      if (existingRule) {
        return errorResponse(res, 409, 'A rule with this keyword already exists.');
      }
      updateData.keyword = normalizedKeyword;
    }

    // Update allowed fields
    if (matchType) updateData.match_type = matchType;
    if (reply) updateData.reply = reply;
    if (replyType) updateData.reply_type = replyType;
    if (isActive !== undefined) updateData.is_active = isActive;
    if (replyImageUrl !== undefined) updateData.reply_image_url = replyImageUrl || null;
    if (buttons !== undefined) {
      updateData.buttons = buttons.map(b => ({
        title: b.title.trim(),
        nextKeyword: b.nextKeyword.toLowerCase().trim()
      }));
    }
    if (listOptions !== undefined) {
      updateData.list_options = listOptions.map(o => ({
        label: o.label.trim(),
        description: (o.description || '').trim(),
        nextKeyword: o.nextKeyword.toLowerCase().trim()
      }));
    }
    if (hindiAliases !== undefined) {
      updateData.hindi_aliases = hindiAliases.map(a => a.trim()).filter(Boolean);
    }

    const { data: updatedRule, error } = await supabase
      .from('rules').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    // Invalidate cache
    await invalidateRulesCache(businessId);

    return successResponse(res, 200, toCamelCase(updatedRule));
  } catch (error) {
    logger.error('Error in updateRule:', error);
    next(error);
  }
};

/**
 * DELETE /api/rules/:id
 * Delete a rule
 */
const deleteRule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    // Find rule
    const { data: rule, error: findErr } = await supabase
      .from('rules').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!rule) {
      return errorResponse(res, 404, 'Rule not found');
    }

    // Delete rule
    const { error } = await supabase.from('rules').delete().eq('id', id);
    if (error) throw error;

    // Invalidate cache
    await invalidateRulesCache(businessId);

    return successResponse(res, 200, null, 'Rule deleted successfully');
  } catch (error) {
    logger.error('Error in deleteRule:', error);
    next(error);
  }
};

/**
 * PUT /api/rules/:id/toggle
 * Toggle rule isActive
 */
const toggleRule = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    // Find rule
    const { data: rule, error: findErr } = await supabase
      .from('rules').select('is_active').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!rule) {
      return errorResponse(res, 404, 'Rule not found');
    }

    // Toggle isActive
    const { data: updatedRule, error } = await supabase
      .from('rules').update({ is_active: !rule.is_active }).eq('id', id).select().single();
    if (error) throw error;

    // Invalidate cache
    await invalidateRulesCache(businessId);

    return successResponse(res, 200, toCamelCase(updatedRule));
  } catch (error) {
    logger.error('Error in toggleRule:', error);
    next(error);
  }
};

/**
 * GET /api/rules/templates
 * Get default rules for business's category
 */
const getTemplates = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    // Get business to find business category
    const business = await businessService.getBusinessById(businessId);
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    // Find template
    const { data: template } = await supabase
      .from('business_type_templates').select('default_rules, booking_fields').eq('business_category', business.businessCategory).maybeSingle();
    if (!template) {
      return successResponse(res, 200, { defaultRules: [], bookingFields: [] });
    }

    return successResponse(res, 200, {
      defaultRules: template.default_rules || [],
      bookingFields: template.booking_fields || []
    });
  } catch (error) {
    logger.error('Error in getTemplates:', error);
    next(error);
  }
};

/**
 * POST /api/rules/bulk-import
 * Import template rules
 */
const bulkImportRules = async (req, res, next) => {
  try {
    const { replaceExisting = false } = req.body;
    const businessId = req.user.businessId;

    // Get business to find business category
    const business = await businessService.getBusinessById(businessId);
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    // Find template
    const { data: template } = await supabase
      .from('business_type_templates').select('default_rules').eq('business_category', business.businessCategory).maybeSingle();
    if (!template || !template.default_rules) {
      return errorResponse(res, 404, 'No template found for this business type');
    }

    // If replaceExisting, delete all existing rules
    if (replaceExisting) {
      const { error: deleteErr } = await supabase.from('rules').delete().eq('business_id', businessId);
      if (deleteErr) throw deleteErr;
    }

    // Import rules that don't already exist
    let createdCount = 0;
    for (const rule of template.default_rules) {
      const { data: existingRule, error: existingErr } = await supabase
        .from('rules').select('id').eq('business_id', businessId).eq('keyword', rule.keyword).maybeSingle();
      if (existingErr) throw existingErr;
      if (!existingRule) {
        const { error: insertErr } = await supabase.from('rules').insert({
          business_id: businessId,
          keyword: rule.keyword,
          match_type: rule.matchType || 'contains',
          reply: rule.reply || '',
          reply_type: rule.replyType || 'text',
          is_active: true,
          trigger_count: 0
        });
        if (insertErr) throw insertErr;
        createdCount++;
      }
    }

    // Invalidate cache
    await invalidateRulesCache(businessId);

    return successResponse(res, 200, { count: createdCount });
  } catch (error) {
    logger.error('Error in bulkImportRules:', error);
    next(error);
  }
};

/**
 * POST /api/rules/upload-image
 * Upload a rule reply image to R2
 */
const uploadRuleImage = async (req, res, next) => {
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
      'rule-images',
      `rule-${businessId}-${Date.now()}`,
      req.file.mimetype
    );

    return successResponse(res, 200, { imageUrl: result.url });
  } catch (error) {
    logger.error('Error in uploadRuleImage:', error);
    next(error);
  }
};

module.exports = {
  getRules,
  createRule,
  updateRule,
  deleteRule,
  toggleRule,
  getTemplates,
  bulkImportRules,
  uploadRuleImage
};
