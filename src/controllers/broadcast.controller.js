const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const { addToBroadcastQueue } = require('../queues/broadcast.queue');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// One BullMQ job per this many recipients (whatsapp.queue.js has no
// existing batching precedent to follow, so this is a new, conservative
// default for broadcast fan-out).
const BATCH_SIZE = 50;

const chunk = (arr, size) => {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
};

/**
 * GET /api/broadcasts
 * List business's broadcasts
 */
const getBroadcasts = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('broadcasts').select('*').eq('business_id', businessId).order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { broadcasts: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getBroadcasts:', error);
    next(error);
  }
};

/**
 * POST /api/broadcasts
 * Create a broadcast as draft
 */
const createBroadcast = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { name, templateId, templateVariables } = req.body;

    if (!name || !templateId) {
      return errorResponse(res, 400, 'name and templateId are required');
    }

    const { data: templateRow, error: templateErr } = await supabase
      .from('message_templates').select('*').eq('id', templateId).eq('business_id', businessId).maybeSingle();
    if (templateErr) throw templateErr;
    if (!templateRow) {
      return errorResponse(res, 404, 'Message template not found');
    }
    if (templateRow.status !== 'approved') {
      return errorResponse(res, 400, 'Only approved templates can be used for a broadcast');
    }

    const { data: broadcast, error } = await supabase.from('broadcasts').insert({
      business_id: businessId,
      template_id: templateId,
      name,
      template_variables: templateVariables || []
    }).select().single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(broadcast), 'Broadcast created successfully');
  } catch (error) {
    logger.error('Error in createBroadcast:', error);
    next(error);
  }
};

/**
 * POST /api/broadcasts/:id/send
 * Send a draft broadcast: snapshot the opted-in audience, mark the broadcast
 * as sending, and fan the recipient list out across BullMQ jobs. NEVER calls
 * Meta API directly from the controller - broadcast.worker.js does the send.
 */
const sendBroadcast = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: broadcastRow, error: fetchErr } = await supabase
      .from('broadcasts').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!broadcastRow) {
      return errorResponse(res, 404, 'Broadcast not found');
    }
    if (broadcastRow.status !== 'draft') {
      return errorResponse(res, 400, 'Only draft broadcasts can be sent');
    }

    const { data: templateRow, error: templateErr } = await supabase
      .from('message_templates').select('*').eq('id', broadcastRow.template_id).maybeSingle();
    if (templateErr) throw templateErr;
    if (!templateRow || templateRow.status !== 'approved') {
      return errorResponse(res, 400, 'This broadcast\'s template is no longer approved');
    }

    const business = await businessService.getBusinessById(businessId);
    if (!business || !business.isWhatsappConnected || !business.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this business');
    }

    const { data: customers, error: customersErr } = await supabase
      .from('customers').select('id, whatsapp_number')
      .eq('business_id', businessId).eq('opted_in', true).eq('is_blocked', false);
    if (customersErr) throw customersErr;

    if (!customers || customers.length === 0) {
      return errorResponse(res, 400, 'No opted-in customers to send this broadcast to');
    }

    const { data: updatedBroadcast, error: updateErr } = await supabase.from('broadcasts').update({
      total_recipients: customers.length,
      status: 'sending',
      started_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (updateErr) throw updateErr;

    const templateVariables = broadcastRow.template_variables || [];
    const components = templateVariables.length > 0
      ? [{ type: 'body', parameters: templateVariables.map((v) => ({ type: 'text', text: String(v) })) }]
      : [];

    const batches = chunk(customers, BATCH_SIZE);
    await Promise.all(batches.map((batch) => addToBroadcastQueue({
      broadcastId: id,
      businessId: businessId.toString(),
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      templateName: templateRow.name,
      language: templateRow.language,
      components,
      recipients: batch.map((c) => ({ customerId: c.id, whatsappNumber: c.whatsapp_number }))
    })));

    logger.info(`Broadcast ${id} queued: ${customers.length} recipients across ${batches.length} batches`);
    return successResponse(res, 200, toCamelCase(updatedBroadcast), 'Broadcast is sending');
  } catch (error) {
    logger.error('Error in sendBroadcast:', error);
    next(error);
  }
};

/**
 * GET /api/broadcasts/:id
 * Status + sent_count/failed_count for polling
 */
const getBroadcast = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: broadcast, error } = await supabase
      .from('broadcasts').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (error) throw error;
    if (!broadcast) {
      return errorResponse(res, 404, 'Broadcast not found');
    }

    return successResponse(res, 200, toCamelCase(broadcast));
  } catch (error) {
    logger.error('Error in getBroadcast:', error);
    next(error);
  }
};

module.exports = {
  getBroadcasts,
  createBroadcast,
  sendBroadcast,
  getBroadcast
};
