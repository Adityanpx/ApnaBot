const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const subscriptionService = require('../services/subscription.service');
const tenantService = require('../services/tenant.service');
const adminService = require('../services/admin.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

const toCamelCaseDeep = (row, nestedKeys = []) => {
  if (!row) return row;
  const result = toCamelCase(row);
  for (const key of nestedKeys) {
    if (result[key]) result[key] = toCamelCase(result[key]);
  }
  return result;
};

/**
 * GET /api/admin/shops
 * List all businesses — paginated + searchable
 */
const getShops = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isActive, businessCategory } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    let query = supabase.from('businesses').select('*', { count: 'exact' });

    if (search) query = query.or(`name.ilike.%${search}%,city.ilike.%${search}%`);
    if (isActive !== undefined) query = query.eq('is_active', isActive === 'true');
    if (businessCategory) query = query.eq('business_category', businessCategory);

    const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to);
    if (error) throw error;

    const rows = data || [];
    const ownerIds = [...new Set(rows.map((b) => b.owner_user_id).filter(Boolean))];
    let ownersById = {};
    if (ownerIds.length > 0) {
      const { data: owners, error: ownersErr } = await supabase
        .from('users').select('id, name, email').in('id', ownerIds);
      if (ownersErr) throw ownersErr;
      ownersById = Object.fromEntries((owners || []).map((o) => [o.id, o]));
    }

    const shops = rows.map((b) => {
      const { access_token, ...safeRow } = b; // never expose encrypted token
      const owner = ownersById[b.owner_user_id];
      return { ...toCamelCase(safeRow), ownerUserId: owner ? toCamelCase(owner) : b.owner_user_id };
    });

    const pagination = getPagination(count || 0, pageNum, limitNum);
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

    const { data: businessRow, error: bizErr } = await supabase
      .from('businesses').select('*').eq('id', id).maybeSingle();
    if (bizErr) throw bizErr;
    if (!businessRow) return errorResponse(res, 404, 'Business not found');
    const { access_token, ...safeBusinessRow } = businessRow;

    const [ownerRes, staffRes, subRes, customerCountRes, bookingCountRes] = await Promise.all([
      supabase.from('users').select('id, name, email, role, last_login_at, is_active')
        .eq('id', businessRow.owner_user_id).maybeSingle(),
      supabase.from('users').select('id, name, email, role, last_login_at, is_active')
        .eq('business_id', id).eq('role', 'staff'),
      supabase.from('subscriptions').select('*, plan:plans(*)')
        .eq('business_id', id).in('status', ['active', 'trial'])
        .order('created_at', { ascending: false }).limit(1),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', id),
      supabase.from('bookings').select('*', { count: 'exact', head: true }).eq('business_id', id)
    ]);
    if (ownerRes.error) throw ownerRes.error;
    if (staffRes.error) throw staffRes.error;
    if (subRes.error) throw subRes.error;
    if (customerCountRes.error) throw customerCountRes.error;
    if (bookingCountRes.error) throw bookingCountRes.error;

    const owner = ownerRes.data ? toCamelCase(ownerRes.data) : null;
    const staff = (staffRes.data || []).map(toCamelCase);
    const users = owner ? [owner, ...staff] : staff;

    const subscriptionRow = (subRes.data || [])[0] || null;
    const subscription = subscriptionRow ? toCamelCaseDeep(subscriptionRow, ['plan']) : null;

    return successResponse(res, 200, {
      shop: toCamelCase(safeBusinessRow),
      subscription,
      plan: subscription?.plan || null,
      users,
      userCount: users.length,
      customerCount: customerCountRes.count || 0,
      bookingCount: bookingCountRes.count || 0
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

    const { data: business, error: fetchErr } = await supabase
      .from('businesses').select('id, is_active').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const newIsActive = !business.is_active;
    const { error: updateErr } = await supabase
      .from('businesses').update({ is_active: newIsActive }).eq('id', id);
    if (updateErr) throw updateErr;

    const action = newIsActive ? 'activated' : 'deactivated';
    logger.info(`Business ${id} ${action} by superadmin`);

    return successResponse(res, 200, { isActive: newIsActive }, `Business ${action} successfully`);
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

    const { data: business, error: bizErr } = await supabase
      .from('businesses').select('id, phone_number_id').eq('id', id).maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const { data: plan, error: planErr } = await supabase
      .from('plans').select('*').eq('id', planId).maybeSingle();
    if (planErr) throw planErr;
    if (!plan || !plan.is_active) return errorResponse(res, 404, 'Plan not found');

    const subscription = await subscriptionService.createSubscription(id, planId, {
      status: 'active'
    });

    const { data: populated, error: popErr } = await supabase
      .from('subscriptions').select('*, plan:plans(*)').eq('id', subscription.id).maybeSingle();
    if (popErr) throw popErr;

    // Clear cached subscription status so the new plan takes effect immediately
    await subscriptionService.invalidateSubscriptionCache(id);
    // Also clear the webhook's tenant cache, which stores its own subscription snapshot
    if (business.phone_number_id) {
      await tenantService.invalidateTenantCache(business.phone_number_id);
    }

    logger.info(`Business ${id} plan changed to ${plan.name} by superadmin`);
    return successResponse(res, 200, { subscription: toCamelCaseDeep(populated, ['plan']) }, 'Plan changed successfully');
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

    const { data: subs, error: subErr } = await supabase
      .from('subscriptions').select('*').eq('business_id', id).in('status', ['active', 'expired'])
      .order('created_at', { ascending: false }).limit(1);
    if (subErr) throw subErr;
    const sub = (subs || [])[0];

    if (!sub) return errorResponse(res, 404, 'No subscription found for this business');

    const currentEnd = new Date(sub.end_date) > new Date() ? new Date(sub.end_date) : new Date();
    const newEndDate = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000);

    const { data: updatedSub, error: updateErr } = await supabase
      .from('subscriptions').update({ end_date: newEndDate.toISOString(), status: 'active' })
      .eq('id', sub.id).select().single();
    if (updateErr) throw updateErr;

    // Reactivate business if it was deactivated
    const { data: updatedBusiness, error: bizErr } = await supabase
      .from('businesses').update({ is_active: true }).eq('id', id).select('phone_number_id').single();
    if (bizErr) throw bizErr;

    // Clear Redis cache
    await subscriptionService.invalidateSubscriptionCache(id);
    // Also clear the webhook's tenant cache, which stores its own subscription snapshot
    if (updatedBusiness?.phone_number_id) {
      await tenantService.invalidateTenantCache(updatedBusiness.phone_number_id);
    }

    logger.info(`Business ${id} subscription extended by ${days} days by superadmin`);
    return successResponse(res, 200, toCamelCase(updatedSub), `Subscription extended by ${days} days`);
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
    const { data: templates, error } = await supabase
      .from('business_type_templates')
      .select('*')
      .order('business_category', { ascending: true });
    if (error) throw error;
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

    const { data: existing } = await supabase
      .from('business_type_templates').select('id').eq('id', id).maybeSingle();
    if (!existing) return errorResponse(res, 404, 'Template not found');

    const updates = {};
    if (defaultRules !== undefined) updates.default_rules = defaultRules;
    if (bookingFields !== undefined) updates.booking_fields = bookingFields;

    const { data: template, error } = await supabase
      .from('business_type_templates').update(updates).eq('id', id).select().single();
    if (error) throw error;

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
