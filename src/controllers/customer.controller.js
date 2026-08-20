const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

/**
 * GET /api/customers
 * List all customers for business — paginated + searchable by name or number
 */
const getCustomers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isBlocked } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = supabase.from('customers').select('*', { count: 'exact' }).eq('business_id', businessId);

    if (search) {
      // PostgREST's .or() parses commas/parens as filter syntax — strip them
      // so the search term can't break out of these two conditions.
      const safeSearch = search.replace(/[,()%*]/g, '');
      query = query.or(`name.ilike.%${safeSearch}%,whatsapp_number.ilike.%${safeSearch}%`);
    }
    if (isBlocked !== undefined) {
      query = query.eq('is_blocked', isBlocked === 'true');
    }

    const { data, error, count } = await query
      .order('last_message_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);
    return successResponse(res, 200, { customers: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error in getCustomers:', error);
    next(error);
  }
};

/**
 * GET /api/customers/:id
 * Customer detail + last 50 messages
 */
const getCustomerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: customer, error: custErr } = await supabase
      .from('customers').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (custErr) throw custErr;
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    const { data: messages, error: msgErr } = await supabase
      .from('messages').select('*').eq('business_id', businessId).eq('customer_id', id)
      .order('created_at', { ascending: false }).limit(50);
    if (msgErr) throw msgErr;

    return successResponse(res, 200, {
      customer: toCamelCase(customer),
      messages: (messages || []).map(toCamelCase).reverse()
    });
  } catch (error) {
    logger.error('Error in getCustomerById:', error);
    next(error);
  }
};

/**
 * PUT /api/customers/:id
 * Update customer name, tags, notes
 */
const updateCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, tags, notes } = req.body;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');

    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return errorResponse(res, 400, 'Tags must be an array');
      updateData.tags = tags.map(t => t.trim()).filter(Boolean);
    }
    if (notes !== undefined) updateData.notes = notes;

    const { data: customer, error } = await supabase
      .from('customers').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(customer));
  } catch (error) {
    logger.error('Error in updateCustomer:', error);
    next(error);
  }
};

/**
 * POST /api/customers/:id/block
 * Block customer — bot stops replying to them
 */
const blockCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('is_blocked').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');
    if (existing.is_blocked) return errorResponse(res, 400, 'Customer is already blocked');

    const { data: customer, error } = await supabase
      .from('customers').update({ is_blocked: true }).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Customer ${id} blocked for business ${businessId}`);
    return successResponse(res, 200, toCamelCase(customer), 'Customer blocked successfully');
  } catch (error) {
    logger.error('Error in blockCustomer:', error);
    next(error);
  }
};

/**
 * POST /api/customers/:id/unblock
 * Unblock a customer
 */
const unblockCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('is_blocked').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');
    if (!existing.is_blocked) return errorResponse(res, 400, 'Customer is not blocked');

    const { data: customer, error } = await supabase
      .from('customers').update({ is_blocked: false }).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Customer ${id} unblocked for business ${businessId}`);
    return successResponse(res, 200, toCamelCase(customer), 'Customer unblocked successfully');
  } catch (error) {
    logger.error('Error in unblockCustomer:', error);
    next(error);
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  updateCustomer,
  blockCustomer,
  unblockCustomer
};
