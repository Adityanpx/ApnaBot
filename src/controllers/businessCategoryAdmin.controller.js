const businessCategoryService = require('../services/businessCategory.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /api/admin/business-categories
 * All categories, enabled or not — SuperAdmin management UI.
 */
const getCategories = async (req, res, next) => {
  try {
    const categories = await businessCategoryService.getAllCategories();
    return successResponse(res, 200, { categories });
  } catch (error) {
    logger.error('Error in getCategories:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/business-categories/:value/toggle
 * Body: { isEnabled }
 */
const toggleCategory = async (req, res, next) => {
  try {
    const { value } = req.params;
    const { isEnabled } = req.body;

    if (typeof isEnabled !== 'boolean') {
      return errorResponse(res, 400, 'isEnabled must be a boolean');
    }

    const categories = await businessCategoryService.getAllCategories();
    const exists = categories.some((category) => category.value === value);
    if (!exists) {
      return errorResponse(res, 404, `Category "${value}" not found`);
    }

    const updated = await businessCategoryService.setCategoryEnabled(value, isEnabled);
    return successResponse(res, 200, updated, `Category "${value}" ${isEnabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    logger.error('Error in toggleCategory:', error);
    next(error);
  }
};

module.exports = { getCategories, toggleCategory };
