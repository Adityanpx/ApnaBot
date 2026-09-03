const businessCategoryService = require('../services/businessCategory.service');
const { successResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/business-categories
 * Public (protected, but no requireBusiness) — apnabot-web's onboarding
 * step calls this before a business exists, to populate the signup list.
 */
const getEnabledCategories = async (req, res, next) => {
  try {
    const categories = await businessCategoryService.getEnabledCategories();
    return successResponse(res, 200, { categories });
  } catch (error) {
    logger.error('Error in getEnabledCategories:', error);
    next(error);
  }
};

module.exports = { getEnabledCategories };
