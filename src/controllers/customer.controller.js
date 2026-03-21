const Customer = require('../models/Customer');
const Message = require('../models/Message');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/customers
 * List all customers for shop — paginated + searchable by name or number
 */
const getCustomers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isBlocked } = req.query;
    const shopId = req.user.shopId;

    const filter = { shopId };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { whatsappNumber: { $regex: search, $options: 'i' } }
      ];
    }

    if (isBlocked !== undefined) {
      filter.isBlocked = isBlocked === 'true';
    }

    const [total, customers] = await Promise.all([
      Customer.countDocuments(filter),
      Customer.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
    ]);

    const pagination = getPagination(total, page, limit);
    return successResponse(res, 200, { customers, pagination });
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
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    const messages = await Message.find({ shopId, customerId: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return successResponse(res, 200, { customer, messages: messages.reverse() });
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
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    if (name !== undefined) customer.name = name.trim();
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return errorResponse(res, 400, 'Tags must be an array');
      customer.tags = tags.map(t => t.trim()).filter(Boolean);
    }
    if (notes !== undefined) customer.notes = notes;

    await customer.save();
    return successResponse(res, 200, customer);
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
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');
    if (customer.isBlocked) return errorResponse(res, 400, 'Customer is already blocked');

    customer.isBlocked = true;
    await customer.save();

    logger.info(`Customer ${id} blocked for shop ${shopId}`);
    return successResponse(res, 200, customer, 'Customer blocked successfully');
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
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');
    if (!customer.isBlocked) return errorResponse(res, 400, 'Customer is not blocked');

    customer.isBlocked = false;
    await customer.save();

    logger.info(`Customer ${id} unblocked for shop ${shopId}`);
    return successResponse(res, 200, customer, 'Customer unblocked successfully');
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
