// src/controllers/admin.controller.js — CREATE THIS FILE

const Business = require('../models/Business');
const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const Customer = require('../models/Customer');
const Booking = require('../models/Booking');
const subscriptionService = require('../services/subscription.service');
const tenantService = require('../services/tenant.service');
const adminService = require('../services/admin.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/admin/shops
 * List all businesses — paginated + searchable
 */
const getShops = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isActive, businessCategory } = req.query;

    const filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { city: { $regex: search, $options: 'i' } }
      ];
    }
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (businessCategory) filter.businessCategory = businessCategory;

    const [total, shops] = await Promise.all([
      Business.countDocuments(filter),
      Business.find(filter)
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
 * Get full business detail — includes subscription + usage + users + stats
 */
const getShopById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const business = await Business.findById(id)
      .populate('ownerUserId', 'name email lastLoginAt')
      .select('-accessToken');

    if (!business) return errorResponse(res, 404, 'Business not found');

    const subscription = await Subscription.findOne({
      businessId: id,
      status: { $in: ['active', 'trial'] }
    }).populate('planId');

    // Get all users (owner + staff)
    const [owner, staff] = await Promise.all([
      User.findById(business.ownerUserId).select('name email role lastLoginAt isActive'),
      User.find({ businessId: id, role: 'staff' }).select('name email role lastLoginAt isActive')
    ]);

    const users = owner ? [owner, ...staff] : staff;
    const userCount = users.length;

    // Get customer and booking counts
    const [customerCount, bookingCount] = await Promise.all([
      Customer.countDocuments({ businessId: id }),
      Booking.countDocuments({ businessId: id })
    ]);

    return successResponse(res, 200, {
      shop: business,
      subscription: subscription || null,
      plan: subscription?.planId || null,
      users,
      userCount,
      customerCount,
      bookingCount
    });
  } catch (error) {
    logger.error('Error in getShopById:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/toggle
 * Activate or deactivate a business
 */
const toggleShop = async (req, res, next) => {
  try {
    const { id } = req.params;

    const business = await Business.findById(id);
    if (!business) return errorResponse(res, 404, 'Business not found');

    business.isActive = !business.isActive;
    await business.save();

    const action = business.isActive ? 'activated' : 'deactivated';
    logger.info(`Business ${id} ${action} by superadmin`);

    return successResponse(res, 200, { isActive: business.isActive }, `Business ${action} successfully`);
  } catch (error) {
    logger.error('Error in toggleShop:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/plan
 * Manually change a business's subscription plan
 */
const changeShopPlan = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { planId } = req.body;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const business = await Business.findById(id);
    if (!business) return errorResponse(res, 404, 'Business not found');

    const plan = await Plan.findById(planId);
    if (!plan || !plan.isActive) return errorResponse(res, 404, 'Plan not found');

    const subscription = await subscriptionService.createSubscription(id, planId, {
      status: 'active'
    });

    const populated = await Subscription.findById(subscription._id).populate('planId');

    // Clear cached subscription status so the new plan takes effect immediately
    await subscriptionService.invalidateSubscriptionCache(id);
    // Also clear the webhook's tenant cache, which stores its own subscription snapshot
    if (business.phoneNumberId) {
      await tenantService.invalidateTenantCache(business.phoneNumberId);
    }

    logger.info(`Business ${id} plan changed to ${plan.name} by superadmin`);
    return successResponse(res, 200, { subscription: populated }, 'Plan changed successfully');
  } catch (error) {
    logger.error('Error in changeShopPlan:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/extend
 * Extend a business's subscription expiry by N days
 */
const extendSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { days = 30 } = req.body;

    const subscription = await Subscription.findOne({
      businessId: id,
      status: { $in: ['active', 'expired'] }
    });

    if (!subscription) return errorResponse(res, 404, 'No subscription found for this business');

    const currentEnd = subscription.endDate > new Date() ? subscription.endDate : new Date();
    subscription.endDate = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000);
    subscription.status = 'active';
    await subscription.save();

    // Reactivate business if it was deactivated
    const updatedBusiness = await Business.findByIdAndUpdate(id, { isActive: true });

    // Clear Redis cache
    await subscriptionService.invalidateSubscriptionCache(id);
    // Also clear the webhook's tenant cache, which stores its own subscription snapshot
    if (updatedBusiness?.phoneNumberId) {
      await tenantService.invalidateTenantCache(updatedBusiness.phoneNumberId);
    }

    logger.info(`Business ${id} subscription extended by ${days} days by superadmin`);
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
    const { data: plans, error } = await supabase
      .from('plans').select('*').order('price', { ascending: true });
    if (error) throw error;
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

    const { data: existing } = await supabase
      .from('plans').select('id').eq('name', name).maybeSingle();
    if (existing) return errorResponse(res, 409, 'A plan with this name already exists');

    const { data: plan, error } = await supabase.from('plans').insert({
      name, display_name: displayName, price,
      msg_limit: msgLimit ?? 500,
      rule_limit: ruleLimit ?? 10,
      customer_limit: customerLimit ?? 100,
      booking_enabled: bookingEnabled ?? true,
      payment_link_enabled: paymentLinkEnabled ?? false,
      staff_enabled: staffEnabled ?? false,
      max_staff: maxStaff ?? 0,
      is_active: true
    }).select().single();
    if (error) throw error;

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

    const { data: existingPlan } = await supabase.from('plans').select('id').eq('id', id).maybeSingle();
    if (!existingPlan) return errorResponse(res, 404, 'Plan not found');

    const allowedFields = [
      'displayName', 'price', 'msgLimit', 'ruleLimit', 'customerLimit',
      'bookingEnabled', 'paymentLinkEnabled', 'staffEnabled', 'maxStaff', 'isActive'
    ];
    const fieldMap = {
      displayName: 'display_name', msgLimit: 'msg_limit', ruleLimit: 'rule_limit',
      customerLimit: 'customer_limit', bookingEnabled: 'booking_enabled',
      paymentLinkEnabled: 'payment_link_enabled', staffEnabled: 'staff_enabled',
      maxStaff: 'max_staff', isActive: 'is_active', price: 'price'
    };

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[fieldMap[field]] = req.body[field];
    }

    const { data: plan, error } = await supabase
      .from('plans').update(updates).eq('id', id).select().single();
    if (error) throw error;

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

    const { data: plan } = await supabase.from('plans').select('id').eq('id', id).maybeSingle();
    if (!plan) return errorResponse(res, 404, 'Plan not found');

    const { count: activeCount, error: countErr } = await supabase
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', id).eq('status', 'active');
    if (countErr) throw countErr;

    if (activeCount > 0) {
      return errorResponse(res, 400, `Cannot delete — ${activeCount} active subscriptions use this plan`);
    }

    const { error } = await supabase.from('plans').update({ is_active: false }).eq('id', id);
    if (error) throw error;

    logger.info(`Plan ${id} deactivated by superadmin`);
    return successResponse(res, 200, null, 'Plan deactivated');
  } catch (error) {
    logger.error('Error in deletePlan:', error);
    next(error);
  }
};

/**
 * GET /api/admin/templates
 * List all business category templates
 */
const getTemplates = async (req, res, next) => {
  try {
    const templates = await BusinessTypeTemplate.find().sort({ businessCategory: 1 });
    return successResponse(res, 200, { templates });
  } catch (error) {
    logger.error('Error in getTemplates:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/templates/:id
 * Update a business category template's default rules and booking fields
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
