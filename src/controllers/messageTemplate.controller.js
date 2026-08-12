const axios = require('axios');
const MessageTemplate = require('../models/MessageTemplate');
const Shop = require('../models/Shop');
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
 * List shop's message templates
 */
const getMessageTemplates = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const templates = await MessageTemplate.find({ shopId }).sort({ createdAt: -1 });

    return successResponse(res, 200, { templates });
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
    const shopId = req.user.shopId;
    const { name, category, language, bodyText } = req.body;

    if (!name || !bodyText) {
      return errorResponse(res, 400, 'name and bodyText are required');
    }

    if (!TEMPLATE_NAME_REGEX.test(name)) {
      return errorResponse(res, 400, 'name must be lowercase_snake_case, alphanumeric characters and underscores only');
    }

    const template = await MessageTemplate.create({
      shopId,
      name,
      category: category || 'MARKETING',
      language: language || 'en',
      bodyText,
      variableCount: countTemplateVariables(bodyText)
    });

    return successResponse(res, 201, template, 'Message template created successfully');
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
    const shopId = req.user.shopId;

    const template = await MessageTemplate.findOne({ _id: id, shopId });
    if (!template) {
      return errorResponse(res, 404, 'Message template not found');
    }

    if (template.status !== 'draft' && template.status !== 'rejected') {
      return errorResponse(res, 400, 'Only draft or rejected templates can be submitted');
    }

    const shop = await Shop.findById(shopId);
    if (!shop || !shop.wabaId || !shop.accessToken) {
      return errorResponse(res, 400, 'Shop is not connected to WhatsApp. Please connect WhatsApp first.');
    }

    const accessToken = decrypt(shop.accessToken);

    let metaResponse;
    try {
      const response = await axios.post(
        `${META_API_BASE}/${shop.wabaId}/message_templates`,
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
        shopId,
        templateId: id,
        error: error.response?.data || error.message
      });
      return errorResponse(res, 400, 'Failed to submit template to Meta', error.response?.data || error.message);
    }

    template.metaTemplateId = metaResponse.id;
    template.status = 'pending';
    template.submittedAt = new Date();
    await template.save();

    logger.info('Message template submitted to Meta successfully', {
      shopId,
      templateId: id,
      metaTemplateId: metaResponse.id
    });

    return successResponse(res, 200, template, 'Template submitted to Meta for review');
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
    const shopId = req.user.shopId;

    const template = await MessageTemplate.findOne({ _id: id, shopId });
    if (!template) {
      return errorResponse(res, 404, 'Message template not found');
    }

    if (template.status === 'pending' || template.status === 'approved') {
      return errorResponse(res, 400, 'This template is registered with Meta. Please contact support to remove it.');
    }

    await MessageTemplate.findByIdAndDelete(id);

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
