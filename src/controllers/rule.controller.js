const supabase = require('../config/supabase');
const businessService = require('../services/business.service');
const subscriptionService = require('../services/subscription.service');
const { invalidateRulesCache } = require('../services/chatbot.service');
const r2 = require('../services/r2.service');
const translateService = require('../services/translate.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const { isValidLanguageCode } = require('../utils/languageCatalog');
const logger = require('../utils/logger');

/**
 * Validates a translations map ({ languageCode: text }) shared by
 * reply_translations and the buttons/list_options titleTranslations,
 * labelTranslations and descriptionTranslations keys. Returns an error
 * message naming the offending language code, or null if valid.
 */
const validateTranslationsMap = (translations, fieldLabel, maxLen) => {
  if (translations === null || translations === undefined) return null;
  if (typeof translations !== 'object' || Array.isArray(translations)) {
    return `${fieldLabel} must be an object.`;
  }
  for (const [code, value] of Object.entries(translations)) {
    if (!isValidLanguageCode(code)) {
      return `${fieldLabel} has an invalid language code "${code}".`;
    }
    if (typeof value !== 'string') {
      return `${fieldLabel} values must be strings.`;
    }
    if (maxLen !== undefined && value.length > maxLen) {
      return `${fieldLabel} for language "${code}" must be ${maxLen} characters or less.`;
    }
  }
  return null;
};

/**
 * Manual rule edits mean the business's rules have diverged from whatever
 * flow pack was last imported, so clear the marker. Fire-and-forget: never
 * block the CRUD response on this.
 */
const clearActiveFlowPack = (businessId) => {
  supabase
    .from('businesses').update({ active_flow_pack_id: null, active_saved_flow_id: null }).eq('id', businessId)
    .then(({ error }) => {
      if (error) {
        logger.error(`Failed to clear active_flow_pack_id/active_saved_flow_id for business ${businessId}:`, error);
      }
    });
};

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
            replyImageUrl = null, buttons = [], listOptions = [], hindiAliases = [],
            replyTranslations = null } = req.body;
    let { reply } = req.body;
    const businessId = req.user.businessId;

    // Validate required fields
    if (!keyword) {
      return errorResponse(res, 400, 'Keyword is required');
    }
    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return errorResponse(res, 400, 'hindiAliases must be an array of strings.');
    }
    const replyTranslationsError = validateTranslationsMap(replyTranslations, 'replyTranslations');
    if (replyTranslationsError) {
      return errorResponse(res, 400, replyTranslationsError);
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
        const titleTranslationsError = validateTranslationsMap(b.titleTranslations, 'Button titleTranslations', 20);
        if (titleTranslationsError) {
          return errorResponse(res, 400, titleTranslationsError);
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
        const labelTranslationsError = validateTranslationsMap(o.labelTranslations, 'List option labelTranslations', 24);
        if (labelTranslationsError) {
          return errorResponse(res, 400, labelTranslationsError);
        }
        const descriptionTranslationsError = validateTranslationsMap(o.descriptionTranslations, 'List option descriptionTranslations', 72);
        if (descriptionTranslationsError) {
          return errorResponse(res, 400, descriptionTranslationsError);
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
      reply_translations: replyTranslations || null,
      buttons: (buttons || []).map(b => ({
        title: b.title.trim(),
        nextKeyword: b.nextKeyword.toLowerCase().trim(),
        titleTranslations: b.titleTranslations || null
      })),
      list_options: (listOptions || []).map(o => ({
        label: o.label.trim(),
        description: (o.description || '').trim(),
        nextKeyword: o.nextKeyword.toLowerCase().trim(),
        labelTranslations: o.labelTranslations || null,
        descriptionTranslations: o.descriptionTranslations || null
      })),
      hindi_aliases: (hindiAliases || []).map(a => a.trim()).filter(Boolean),
      is_active: true,
      trigger_count: 0
    }).select().single();
    if (error) throw error;

    // Invalidate cache
    await invalidateRulesCache(businessId);
    clearActiveFlowPack(businessId);

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
    const { keyword, matchType, reply, replyType, isActive, replyImageUrl, buttons, listOptions, hindiAliases, replyTranslations } = req.body;
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

    const replyTranslationsError = validateTranslationsMap(replyTranslations, 'replyTranslations');
    if (replyTranslationsError) {
      return errorResponse(res, 400, replyTranslationsError);
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
        const titleTranslationsError = validateTranslationsMap(b.titleTranslations, 'Button titleTranslations', 20);
        if (titleTranslationsError) {
          return errorResponse(res, 400, titleTranslationsError);
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
        const labelTranslationsError = validateTranslationsMap(o.labelTranslations, 'List option labelTranslations', 24);
        if (labelTranslationsError) {
          return errorResponse(res, 400, labelTranslationsError);
        }
        const descriptionTranslationsError = validateTranslationsMap(o.descriptionTranslations, 'List option descriptionTranslations', 72);
        if (descriptionTranslationsError) {
          return errorResponse(res, 400, descriptionTranslationsError);
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
    if (replyTranslations !== undefined) updateData.reply_translations = replyTranslations || null;
    if (buttons !== undefined) {
      const existingButtons = rule.buttons || [];
      updateData.buttons = buttons.map((b, i) => ({
        title: b.title.trim(),
        nextKeyword: b.nextKeyword.toLowerCase().trim(),
        titleTranslations: b.titleTranslations !== undefined ? b.titleTranslations : (existingButtons[i]?.titleTranslations ?? null)
      }));
    }
    if (listOptions !== undefined) {
      const existingListOptions = rule.list_options || [];
      updateData.list_options = listOptions.map((o, i) => ({
        label: o.label.trim(),
        description: (o.description || '').trim(),
        nextKeyword: o.nextKeyword.toLowerCase().trim(),
        labelTranslations: o.labelTranslations !== undefined ? o.labelTranslations : (existingListOptions[i]?.labelTranslations ?? null),
        descriptionTranslations: o.descriptionTranslations !== undefined ? o.descriptionTranslations : (existingListOptions[i]?.descriptionTranslations ?? null)
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
    clearActiveFlowPack(businessId);

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
    clearActiveFlowPack(businessId);

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

/**
 * POST /api/rules/translate
 * Draft AI translations for rule reply/button/list text. Stateless - writes
 * nothing to the database; the owner reviews the result and saves through
 * the normal rule update paths.
 */
const translateRules = async (req, res, next) => {
  try {
    if (!translateService.isAvailable()) {
      return errorResponse(res, 503, 'Translation is not available right now.');
    }

    const { fields, targetLanguages } = req.body;

    if (!Array.isArray(fields) || fields.length === 0) {
      return errorResponse(res, 400, 'fields must be a non-empty array.');
    }
    if (fields.length > 30) {
      return errorResponse(res, 400, 'fields can contain at most 30 entries.');
    }
    for (const f of fields) {
      if (!f || typeof f.id !== 'string' || !f.id || typeof f.text !== 'string' || !f.text) {
        return errorResponse(res, 400, 'Each field needs an id and text.');
      }
      if (f.maxLength !== undefined && f.maxLength !== null && typeof f.maxLength !== 'number') {
        return errorResponse(res, 400, 'maxLength must be a number or null.');
      }
    }

    if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
      return errorResponse(res, 400, 'targetLanguages must be a non-empty array.');
    }
    for (const code of targetLanguages) {
      if (!isValidLanguageCode(code) || code === 'en') {
        return errorResponse(res, 400, `Invalid target language code "${code}".`);
      }
    }

    const businessId = req.user.businessId;
    const business = await businessService.getBusinessById(businessId);
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    let result;
    try {
      result = await translateService.translateFields({
        fields: fields.map(f => ({ id: f.id, text: f.text, maxLength: f.maxLength ?? null })),
        targetLanguages,
        businessName: business.name
      });
    } catch (error) {
      if (error instanceof translateService.TranslationUnavailableError) {
        return errorResponse(res, 503, error.message);
      }
      throw error;
    }

    return successResponse(res, 200, result);
  } catch (error) {
    logger.error('Error in translateRules:', error);
    next(error);
  }
};

module.exports = {
  getRules,
  createRule,
  updateRule,
  deleteRule,
  toggleRule,
  uploadRuleImage,
  translateRules
};
