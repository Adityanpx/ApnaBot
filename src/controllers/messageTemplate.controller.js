const axios = require('axios');
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const { decrypt } = require('../utils/crypto');
const { META_API_BASE } = require('../services/whatsapp.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Meta requires template names to be lowercase, alphanumeric + underscores only
const TEMPLATE_NAME_REGEX = /^[a-z0-9_]+$/;

const countTemplateVariables = (bodyText) => {
  const matches = (bodyText || '').match(/\{\{\s*\d+\s*\}\}/g) || [];
  const numbers = new Set(matches.map((m) => m.replace(/\D/g, '')));
  return numbers.size;
};

/**
 * GET /api/message-templates
 * List business's message templates
 */
const getMessageTemplates = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('message_templates').select('*').eq('business_id', businessId).order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { templates: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getMessageTemplates:', error);
    next(error);
  }
};

/**
 * POST /api/message-templates
 * Create a message template as draft
 */
const createMessageTemplate = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { name, category, language, bodyText } = req.body;

    if (!name || !bodyText) {
      return errorResponse(res, 400, 'name and bodyText are required');
    }

    if (!TEMPLATE_NAME_REGEX.test(name)) {
      return errorResponse(res, 400, 'name must be lowercase_snake_case, alphanumeric characters and underscores only');
    }

    const { data: template, error } = await supabase.from('message_templates').insert({
      business_id: businessId,
      name,
      category: category || 'MARKETING',
      language: language || 'en',
      body_text: bodyText,
      variable_count: countTemplateVariables(bodyText)
    }).select().single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(template), 'Message template created successfully');
  } catch (error) {
    logger.error('Error in createMessageTemplate:', error);
    next(error);
  }
};

/**
 * POST /api/message-templates/:id/submit
 * Submit a draft template to Meta's Template Management API for review
 */
const submitMessageTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: templateRow, error: fetchErr } = await supabase
      .from('message_templates').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!templateRow) {
      return errorResponse(res, 404, 'Message template not found');
    }
    const template = toCamelCase(templateRow);

    if (template.status !== 'draft' && template.status !== 'rejected') {
      return errorResponse(res, 400, 'Only draft or rejected templates can be submitted');
    }

    const business = await businessService.getBusinessById(businessId);
    if (!business || !business.wabaId || !business.accessToken) {
      return errorResponse(res, 400, 'Business is not connected to WhatsApp. Please connect WhatsApp first.');
    }

    const accessToken = decrypt(business.accessToken);

    let metaResponse;
    try {
      const response = await axios.post(
        `${META_API_BASE}/${business.wabaId}/message_templates`,
        {
          name: template.name,
          category: template.category,
          language: template.language,
          components: [
            { type: 'BODY', text: template.bodyText }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      metaResponse = response.data;
    } catch (error) {
      logger.error('Error submitting message template to Meta:', {
        businessId,
        templateId: id,
        error: error.response?.data || error.message
      });
      return errorResponse(res, 400, 'Failed to submit template to Meta', error.response?.data || error.message);
    }

    const { data: updatedTemplate, error: updateErr } = await supabase.from('message_templates').update({
      meta_template_id: metaResponse.id,
      status: 'pending',
      submitted_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (updateErr) throw updateErr;

    logger.info('Message template submitted to Meta successfully', {
      businessId,
      templateId: id,
      metaTemplateId: metaResponse.id
    });

    return successResponse(res, 200, toCamelCase(updatedTemplate), 'Template submitted to Meta for review');
  } catch (error) {
    logger.error('Error in submitMessageTemplate:', error);
    next(error);
  }
};

/**
 * DELETE /api/message-templates/:id
 * Delete a template. Only allowed while draft or rejected (not yet registered
 * with Meta, or Meta already rejected it) - pending/approved templates are
 * registered with Meta and require contacting support to remove.
 */
const deleteMessageTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: template, error: fetchErr } = await supabase
      .from('message_templates').select('status').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!template) {
      return errorResponse(res, 404, 'Message template not found');
    }

    if (template.status === 'pending' || template.status === 'approved') {
      return errorResponse(res, 400, 'This template is registered with Meta. Please contact support to remove it.');
    }

    const { error } = await supabase.from('message_templates').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Message template deleted successfully');
  } catch (error) {
    logger.error('Error in deleteMessageTemplate:', error);
    next(error);
  }
};

module.exports = {
  getMessageTemplates,
  createMessageTemplate,
  submitMessageTemplate,
  deleteMessageTemplate
};
