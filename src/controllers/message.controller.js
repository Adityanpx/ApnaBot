const supabase = require('../config/supabase');
const businessService = require('../services/business.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

/**
 * GET /api/messages
 * List conversations grouped by customer.
 * Returns latest message per customer + unread count.
 *
 * Every customer row is only ever created alongside a message (webhook
 * upsert, sendMessage upsert below), so "customers with a conversation" and
 * "all customers for this business" are the same set — paginating customers
 * by lastMessageAt stands in for the old Message-grouped aggregation, without
 * needing a Postgres view/RPC for it.
 */
const getConversations = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const { data: customers, error, count } = await supabase
      .from('customers').select('*', { count: 'exact' }).eq('business_id', businessId)
      .order('last_message_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const conversations = await Promise.all((customers || []).map(async (customerRow) => {
      const customer = toCamelCase(customerRow);

      const [{ data: lastMsg }, { count: unreadCount }] = await Promise.all([
        supabase.from('messages').select('content, direction, created_at')
          .eq('customer_id', customer.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('messages').select('*', { count: 'exact', head: true })
          .eq('customer_id', customer.id).eq('direction', 'inbound').eq('is_read', false)
      ]);

      return {
        _id: customer.id,
        customerNumber: customer.whatsappNumber,
        lastMessage: lastMsg?.content ?? null,
        lastMessageAt: lastMsg?.created_at ?? customer.lastMessageAt,
        lastDirection: lastMsg?.direction ?? null,
        unreadCount: unreadCount || 0,
        customer
      };
    }));

    const pagination = getPagination(count, pageNum, limitNum);

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
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const { data: customerRow, error: custErr } = await supabase
      .from('customers').select('*').eq('id', customerId).eq('business_id', businessId).maybeSingle();
    if (custErr) throw custErr;
    if (!customerRow) return errorResponse(res, 404, 'Customer not found');

    const { data: messages, error, count } = await supabase
      .from('messages').select('*', { count: 'exact' })
      .eq('business_id', businessId).eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);
    return successResponse(res, 200, {
      customer: toCamelCase(customerRow),
      messages: (messages || []).map(toCamelCase).reverse(), // return in chronological order
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
    const businessId = req.user.businessId;

    const { data: message, error } = await supabase
      .from('messages').update({ is_read: true })
      .eq('id', id).eq('business_id', businessId).eq('direction', 'inbound')
      .select().maybeSingle();
    if (error) throw error;

    if (!message) return errorResponse(res, 404, 'Message not found');
    return successResponse(res, 200, toCamelCase(message), 'Message marked as read');
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
    const businessId = req.user.businessId;

    if (!customerNumber || !message) {
      return errorResponse(res, 400, 'customerNumber and message are required');
    }
    if (message.trim().length === 0) {
      return errorResponse(res, 400, 'Message cannot be empty');
    }

    // Verify business has WhatsApp connected
    const business = await businessService.getBusinessById(businessId);
    if (!business) return errorResponse(res, 404, 'Business not found');
    if (!business.isWhatsappConnected || !business.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this business');
    }

    // Upsert customer record (read-then-write — Supabase has no
    // upsert-with-$setOnInsert; a tiny race under concurrent sends is
    // acceptable at current traffic, same tradeoff as the webhook path)
    const { data: existingCustomer, error: findErr } = await supabase
      .from('customers').select('*').eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
    if (findErr) throw findErr;

    let customer;
    if (existingCustomer) {
      const { data, error } = await supabase.from('customers')
        .update({ last_message_at: new Date().toISOString() }).eq('id', existingCustomer.id).select().single();
      if (error) throw error;
      customer = toCamelCase(data);
    } else {
      const { data, error } = await supabase.from('customers').insert({
        business_id: businessId,
        whatsapp_number: customerNumber,
        first_seen_at: new Date().toISOString(),
        last_message_at: new Date().toISOString()
      }).select().single();
      if (error) throw error;
      customer = toCamelCase(data);
    }

    // Save outbound message to DB
    const { data: outboundMsgRow, error: msgErr } = await supabase.from('messages').insert({
      business_id: businessId,
      customer_id: customer.id,
      customer_number: customerNumber,
      direction: 'outbound',
      type: 'text',
      content: message.trim(),
      status: 'sent',
      is_read: true
    }).select().single();
    if (msgErr) throw msgErr;
    const outboundMsg = toCamelCase(outboundMsgRow);

    // Queue via BullMQ — NEVER call Meta API directly from controller
    await addToWhatsappQueue({
      businessId: businessId.toString(),
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      to: customerNumber,
      message: message.trim(),
      type: 'text',
      messageId: outboundMsg.id
    });

    logger.info(`Manual message queued to ${customerNumber} for business ${businessId}`);
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
