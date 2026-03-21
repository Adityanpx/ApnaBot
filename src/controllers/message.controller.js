const mongoose = require('mongoose');
const Message = require('../models/Message');
const Customer = require('../models/Customer');
const Shop = require('../models/Shop');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/messages
 * List conversations grouped by customer.
 * Returns latest message per customer + unread count.
 */
const getConversations = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const shopId = req.user.shopId;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const conversations = await Message.aggregate([
      { $match: { shopId: new mongoose.Types.ObjectId(shopId.toString()) } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$customerId',
          customerNumber: { $first: '$customerNumber' },
          lastMessage: { $first: '$content' },
          lastMessageAt: { $first: '$createdAt' },
          lastDirection: { $first: '$direction' },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$direction', 'inbound'] },
                  { $eq: ['$isRead', false] }
                ]},
                1, 0
              ]
            }
          }
        }
      },
      { $sort: { lastMessageAt: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
      {
        $lookup: {
          from: 'customers',
          localField: '_id',
          foreignField: '_id',
          as: 'customer'
        }
      },
      { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } }
    ]);

    const totalResult = await Message.aggregate([
      { $match: { shopId: new mongoose.Types.ObjectId(shopId.toString()) } },
      { $group: { _id: '$customerId' } },
      { $count: 'total' }
    ]);

    const total = totalResult[0]?.total || 0;
    const pagination = getPagination(total, page, limit);

    return successResponse(res, 200, { conversations, pagination });
  } catch (error) {
    logger.error('Error in getConversations:', error);
    next(error);
  }
};

/**
 * GET /api/messages/:customerId
 * Full paginated chat history with a specific customer
 */
const getChatHistory = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: customerId, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    const filter = { shopId, customerId };
    const [total, messages] = await Promise.all([
      Message.countDocuments(filter),
      Message.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean()
    ]);

    const pagination = getPagination(total, page, limit);
    return successResponse(res, 200, {
      customer,
      messages: messages.reverse(), // return in chronological order
      pagination
    });
  } catch (error) {
    logger.error('Error in getChatHistory:', error);
    next(error);
  }
};

/**
 * PUT /api/messages/:id/read
 * Mark an inbound message as read
 */
const markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const message = await Message.findOneAndUpdate(
      { _id: id, shopId, direction: 'inbound' },
      { isRead: true },
      { new: true }
    );

    if (!message) return errorResponse(res, 404, 'Message not found');
    return successResponse(res, 200, message, 'Message marked as read');
  } catch (error) {
    logger.error('Error in markAsRead:', error);
    next(error);
  }
};

/**
 * POST /api/messages/send
 * Manually send a WhatsApp message to a customer.
 * ALWAYS goes through BullMQ — never calls Meta API directly.
 */
const sendMessage = async (req, res, next) => {
  try {
    const { customerNumber, message } = req.body;
    const shopId = req.user.shopId;

    if (!customerNumber || !message) {
      return errorResponse(res, 400, 'customerNumber and message are required');
    }
    if (message.trim().length === 0) {
      return errorResponse(res, 400, 'Message cannot be empty');
    }

    // Verify shop has WhatsApp connected
    const shop = await Shop.findById(shopId);
    if (!shop) return errorResponse(res, 404, 'Shop not found');
    if (!shop.isWhatsappConnected || !shop.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this shop');
    }

    // Upsert customer record
    const customer = await Customer.findOneAndUpdate(
      { shopId, whatsappNumber: customerNumber },
      {
        $setOnInsert: { firstSeenAt: new Date() },
        $set: { lastMessageAt: new Date() }
      },
      { upsert: true, new: true }
    );

    // Save outbound message to DB
    const outboundMsg = await Message.create({
      shopId,
      customerId: customer._id,
      customerNumber,
      direction: 'outbound',
      type: 'text',
      content: message.trim(),
      status: 'sent',
      isRead: true
    });

    // Queue via BullMQ — NEVER call Meta API directly from controller
    await addToWhatsappQueue({
      shopId: shopId.toString(),
      phoneNumberId: shop.phoneNumberId,
      encryptedAccessToken: shop.accessToken,
      to: customerNumber,
      message: message.trim(),
      type: 'text',
      messageId: outboundMsg._id.toString()
    });

    logger.info(`Manual message queued to ${customerNumber} for shop ${shopId}`);
    return successResponse(res, 201, outboundMsg, 'Message queued for delivery');
  } catch (error) {
    logger.error('Error in sendMessage:', error);
    next(error);
  }
};

module.exports = {
  getConversations,
  getChatHistory,
  markAsRead,
  sendMessage
};
