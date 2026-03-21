// src/controllers/admin.controller.js — CREATE THIS FILE

const Shop = require('../models/Shop');
const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const subscriptionService = require('../services/subscription.service');
const adminService = require('../services/admin.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/admin/shops
 * List all shops — paginated + searchable
 */
const getShops = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isActive, businessType } = req.query;

    const filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { city: { $regex: search, $options: 'i' } }
      ];
    }
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (businessType) filter.businessType = businessType;

    const [total, shops] = await Promise.all([
      Shop.countDocuments(filter),
      Shop.find(filter)
        .populate('ownerUserId', 'name email')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .select('-accessToken') // never expose encrypted token
    ]);

    const pagination = getPagination(total, page, limit);
    return successResponse(res, 200, { shops, pagination });
  } catch (error) {
    logger.error('Error in getShops:', error);
    next(error);
  }
};

/**
 * GET /api/admin/shops/:id
 * Get full shop detail — includes subscription + usage
 */
const getShopById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const shop = await Shop.findById(id)
      .populate('ownerUserId', 'name email lastLoginAt')
      .select('-accessToken');

    if (!shop) return errorResponse(res, 404, 'Shop not found');

    const subscription = await Subscription.findOne({
      shopId: id,
      status: { $in: ['active', 'trial'] }
    }).populate('planId');

    const staffCount = await User.countDocuments({ shopId: id, role: 'staff' });

    return successResponse(res, 200, {
      shop,
      subscription: subscription || null,
      plan: subscription?.planId || null,
      staffCount
    });
  } catch (error) {
    logger.error('Error in getShopById:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/toggle
 * Activate or deactivate a shop
 */
const toggleShop = async (req, res, next) => {
  try {
    const { id } = req.params;

    const shop = await Shop.findById(id);
    if (!shop) return errorResponse(res, 404, 'Shop not found');

    shop.isActive = !shop.isActive;
    await shop.save();

    const action = shop.isActive ? 'activated' : 'deactivated';
    logger.info(`Shop ${id} ${action} by superadmin`);

    return successResponse(res, 200, { isActive: shop.isActive }, `Shop ${action} successfully`);
  } catch (error) {
    logger.error('Error in toggleShop:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/plan
 * Manually change a shop's subscription plan
 */
const changeShopPlan = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { planId } = req.body;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const shop = await Shop.findById(id);
    if (!shop) return errorResponse(res, 404, 'Shop not found');

    const plan = await Plan.findById(planId);
    if (!plan || !plan.isActive) return errorResponse(res, 404, 'Plan not found');

    const subscription = await subscriptionService.createSubscription(id, planId, {
      status: 'active'
    });

    const populated = await Subscription.findById(subscription._id).populate('planId');

    logger.info(`Shop ${id} plan changed to ${plan.name} by superadmin`);
    return successResponse(res, 200, { subscription: populated }, 'Plan changed successfully');
  } catch (error) {
    logger.error('Error in changeShopPlan:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/extend
 * Extend a shop's subscription expiry by N days
 */
const extendSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { days = 30 } = req.body;

    const subscription = await Subscription.findOne({
      shopId: id,
      status: { $in: ['active', 'expired'] }
    });

    if (!subscription) return errorResponse(res, 404, 'No subscription found for this shop');

    const currentEnd = subscription.endDate > new Date() ? subscription.endDate : new Date();
    subscription.endDate = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000);
    subscription.status = 'active';
    await subscription.save();

    // Reactivate shop if it was deactivated
    await Shop.findByIdAndUpdate(id, { isActive: true });

    // Clear Redis cache
    await subscriptionService.invalidateSubscriptionCache(id);

    logger.info(`Shop ${id} subscription extended by ${days} days by superadmin`);
    return successResponse(res, 200, subscription, `Subscription extended by ${days} days`);
  } catch (error) {
    logger.error('Error in extendSubscription:', error);
    next(error);
  }
};

/**
 * GET /api/admin/stats
 * Platform-wide statistics
 */
const getPlatformStats = async (req, res, next) => {
  try {
    const stats = await adminService.getPlatformStats();
    return successResponse(res, 200, stats);
  } catch (error) {
    logger.error('Error in getPlatformStats:', error);
    next(error);
  }
};

/**
 * GET /api/admin/revenue
 * Monthly revenue report (last 6 months by default)
 */
const getRevenueReport = async (req, res, next) => {
  try {
    const { months = 6 } = req.query;
    const report = await adminService.getRevenueReport(parseInt(months));
    return successResponse(res, 200, { report });
  } catch (error) {
    logger.error('Error in getRevenueReport:', error);
    next(error);
  }
};

/**
 * GET /api/admin/plans
 * List all plans (including inactive)
 */
const getPlans = async (req, res, next) => {
  try {
    const plans = await Plan.find().sort({ price: 1 });
    return successResponse(res, 200, { plans });
  } catch (error) {
    logger.error('Error in getPlans:', error);
    next(error);
  }
};

/**
 * POST /api/admin/plans
 * Create a new plan
 */
const createPlan = async (req, res, next) => {
  try {
    const {
      name, displayName, price, msgLimit, ruleLimit,
      customerLimit, bookingEnabled, paymentLinkEnabled,
      staffEnabled, maxStaff
    } = req.body;

    if (!name || !displayName || price === undefined) {
      return errorResponse(res, 400, 'name, displayName, and price are required');
    }

    const existing = await Plan.findOne({ name });
    if (existing) return errorResponse(res, 409, 'A plan with this name already exists');

    const plan = await Plan.create({
      name,
      displayName,
      price,
      msgLimit: msgLimit ?? 500,
      ruleLimit: ruleLimit ?? 10,
      customerLimit: customerLimit ?? 100,
      bookingEnabled: bookingEnabled ?? true,
      paymentLinkEnabled: paymentLinkEnabled ?? false,
      staffEnabled: staffEnabled ?? false,
      maxStaff: maxStaff ?? 0,
      isActive: true
    });

    logger.info(`Plan ${plan.name} created by superadmin`);
    return successResponse(res, 201, plan, 'Plan created successfully');
  } catch (error) {
    logger.error('Error in createPlan:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/plans/:id
 * Update an existing plan
 */
const updatePlan = async (req, res, next) => {
  try {
    const { id } = req.params;

    const plan = await Plan.findById(id);
    if (!plan) return errorResponse(res, 404, 'Plan not found');

    const allowedFields = [
      'displayName', 'price', 'msgLimit', 'ruleLimit', 'customerLimit',
      'bookingEnabled', 'paymentLinkEnabled', 'staffEnabled', 'maxStaff', 'isActive'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        plan[field] = req.body[field];
      }
    }

    await plan.save();

    logger.info(`Plan ${id} updated by superadmin`);
    return successResponse(res, 200, plan, 'Plan updated successfully');
  } catch (error) {
    logger.error('Error in updatePlan:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/plans/:id
 * Soft delete — marks plan as inactive
 */
const deletePlan = async (req, res, next) => {
  try {
    const { id } = req.params;

    const plan = await Plan.findById(id);
    if (!plan) return errorResponse(res, 404, 'Plan not found');

    // Check if any active subscriptions use this plan
    const activeCount = await Subscription.countDocuments({ planId: id, status: 'active' });
    if (activeCount > 0) {
      return errorResponse(res, 400, `Cannot delete — ${activeCount} active subscriptions use this plan`);
    }

    plan.isActive = false;
    await plan.save();

    logger.info(`Plan ${id} deactivated by superadmin`);
    return successResponse(res, 200, null, 'Plan deactivated successfully');
  } catch (error) {
    logger.error('Error in deletePlan:', error);
    next(error);
  }
};

/**
 * GET /api/admin/templates
 * List all business type templates
 */
const getTemplates = async (req, res, next) => {
  try {
    const templates = await BusinessTypeTemplate.find().sort({ businessType: 1 });
    return successResponse(res, 200, { templates });
  } catch (error) {
    logger.error('Error in getTemplates:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/templates/:id
 * Update a business type template's default rules and booking fields
 */
const updateTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { defaultRules, bookingFields } = req.body;

    const template = await BusinessTypeTemplate.findById(id);
    if (!template) return errorResponse(res, 404, 'Template not found');

    if (defaultRules !== undefined) template.defaultRules = defaultRules;
    if (bookingFields !== undefined) template.bookingFields = bookingFields;

    await template.save();

    logger.info(`Template ${id} updated by superadmin`);
    return successResponse(res, 200, template, 'Template updated successfully');
  } catch (error) {
    logger.error('Error in updateTemplate:', error);
    next(error);
  }
};

module.exports = {
  getShops,
  getShopById,
  toggleShop,
  changeShopPlan,
  extendSubscription,
  getPlatformStats,
  getRevenueReport,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getTemplates,
  updateTemplate
};
