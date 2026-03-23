const Rule = require('../models/Rule');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const Shop = require('../models/Shop');
const Subscription = require('../models/Subscription');
const { invalidateRulesCache } = require('../services/chatbot.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/rules
 * List all rules for shop (paginated)
 */
const getRules = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, isActive } = req.query;
    const shopId = req.user.shopId;

    // Build filter
    const filter = { shopId };
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    // Get total count and paginated results
    const [total, rules] = await Promise.all([
      Rule.countDocuments(filter),
      Rule.find(filter)
        .sort({ priority: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
    ]);

    const pagination = getPagination(total, page, limit);

    return successResponse(res, 200, { rules, pagination });
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
    const { keyword, matchType = 'contains', reply, replyType = 'text' } = req.body;
    const shopId = req.user.shopId;

    // Validate required fields
    if (!keyword) {
      return errorResponse(res, 400, 'Keyword is required');
    }
    if (!reply) {
      return errorResponse(res, 400, 'Reply is required');
    }

    // Normalize keyword
    const normalizedKeyword = keyword.toLowerCase().trim();

    // Check plan rule limit
    const subscription = await Subscription.findOne({ shopId, status: 'active' }).populate('planId');
    if (subscription && subscription.planId && subscription.planId.ruleLimit !== -1) {
      const ruleCount = await Rule.countDocuments({ shopId });
      if (ruleCount >= subscription.planId.ruleLimit) {
        return errorResponse(res, 403, 'Rule limit reached for your plan. Please upgrade.');
      }
    }

    // Check for duplicate keyword
    const existingRule = await Rule.findOne({ shopId, keyword: normalizedKeyword });
    if (existingRule) {
      return errorResponse(res, 409, 'A rule with this keyword already exists.');
    }

    // Create rule
    const rule = await Rule.create({
      shopId,
      keyword: normalizedKeyword,
      matchType,
      reply,
      replyType,
      isActive: true,
      triggerCount: 0
    });

    // Invalidate cache
    await invalidateRulesCache(shopId);

    return successResponse(res, 201, rule);
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
    const { keyword, matchType, reply, replyType, isActive } = req.body;
    const shopId = req.user.shopId;

    // Find rule
    const rule = await Rule.findOne({ _id: id, shopId });
    if (!rule) {
      return errorResponse(res, 404, 'Rule not found');
    }

    // Check for duplicate keyword if being updated
    if (keyword) {
      const normalizedKeyword = keyword.toLowerCase().trim();
      const existingRule = await Rule.findOne({
        shopId,
        keyword: normalizedKeyword,
        _id: { $ne: id }
      });
      if (existingRule) {
        return errorResponse(res, 409, 'A rule with this keyword already exists.');
      }
      rule.keyword = normalizedKeyword;
    }

    // Update allowed fields
    if (matchType) rule.matchType = matchType;
    if (reply) rule.reply = reply;
    if (replyType) rule.replyType = replyType;
    if (isActive !== undefined) rule.isActive = isActive;

    await rule.save();

    // Invalidate cache
    await invalidateRulesCache(shopId);

    return successResponse(res, 200, rule);
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
    const shopId = req.user.shopId;

    // Find rule
    const rule = await Rule.findOne({ _id: id, shopId });
    if (!rule) {
      return errorResponse(res, 404, 'Rule not found');
    }

    // Delete rule
    await Rule.findByIdAndDelete(id);

    // Invalidate cache
    await invalidateRulesCache(shopId);

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
    const shopId = req.user.shopId;

    // Find rule
    const rule = await Rule.findOne({ _id: id, shopId });
    if (!rule) {
      return errorResponse(res, 404, 'Rule not found');
    }

    // Toggle isActive
    rule.isActive = !rule.isActive;
    await rule.save();

    // Invalidate cache
    await invalidateRulesCache(shopId);

    return successResponse(res, 200, rule);
  } catch (error) {
    logger.error('Error in toggleRule:', error);
    next(error);
  }
};

/**
 * GET /api/rules/templates
 * Get default rules for shop's business type
 */
const getTemplates = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    // Get shop to find business type
    const shop = await Shop.findById(shopId);
    if (!shop) {
      return errorResponse(res, 404, 'Shop not found');
    }

    // Find template
    const template = await BusinessTypeTemplate.findOne({ businessType: shop.businessType });
    if (!template) {
      return successResponse(res, 200, { defaultRules: [], bookingFields: [] });
    }

    return successResponse(res, 200, {
      defaultRules: template.defaultRules || [],
      bookingFields: template.bookingFields || []
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
    const shopId = req.user.shopId;

    // Get shop to find business type
    const shop = await Shop.findById(shopId);
    if (!shop) {
      return errorResponse(res, 404, 'Shop not found');
    }

    // Find template
    const template = await BusinessTypeTemplate.findOne({ businessType: shop.businessType });
    if (!template || !template.defaultRules) {
      return errorResponse(res, 404, 'No template found for this business type');
    }

    // If replaceExisting, delete all existing rules
    if (replaceExisting) {
      await Rule.deleteMany({ shopId });
    }

    // Import rules that don't already exist
    let createdCount = 0;
    for (const rule of template.defaultRules) {
      const existingRule = await Rule.findOne({ shopId, keyword: rule.keyword });
      if (!existingRule) {
        await Rule.create({
          shopId,
          keyword: rule.keyword,
          matchType: rule.matchType || 'contains',
          reply: rule.reply || '',
          replyType: rule.replyType || 'text',
          isActive: true,
          triggerCount: 0
        });
        createdCount++;
      }
    }

    // Invalidate cache
    await invalidateRulesCache(shopId);

    return successResponse(res, 200, { count: createdCount });
  } catch (error) {
    logger.error('Error in bulkImportRules:', error);
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
  bulkImportRules
};
