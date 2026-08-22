const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const redisUrl = new URL(process.env.REDIS_URL);

const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port),
  password: redisUrl.password,
  username: redisUrl.username || 'default',
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined
};

// Resolves a recipient's own {{1}}, {{2}}... values from variableMapping
// (see broadcast.controller.js createBroadcast) instead of the shared,
// broadcast-wide components array. 'customer.name' pulls from that
// recipient's own data; 'static' uses the fixed value from the mapping.
const resolveRecipientComponents = (variableMapping, recipient) => {
  const parameters = [...variableMapping]
    .sort((a, b) => a.position - b.position)
    .map((entry) => {
      const text = entry.source === 'customer.name'
        ? recipient.customer?.name
        : entry.value;
      return { type: 'text', text: String(text || '') };
    });

  return parameters.length > 0 ? [{ type: 'body', parameters }] : [];
};

const worker = new Worker('broadcast-outbound', async (job) => {
  const { broadcastId, businessId, phoneNumberId, encryptedAccessToken, templateName, language, components, variableMapping, recipients } = job.data;

  let sent = 0;
  let failed = 0;

  // Per-recipient failures (e.g. a single bad number) must not fail the
  // whole job - attempts:1 on this queue means a thrown job error loses
  // progress tracking for the batch, not just a retry.
  for (const recipient of recipients) {
    try {
      const recipientComponents = variableMapping
        ? resolveRecipientComponents(variableMapping, recipient)
        : components;
      await whatsappService.sendTemplateMessage(phoneNumberId, encryptedAccessToken, recipient.whatsappNumber, templateName, language, recipientComponents);
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.error(`Broadcast ${broadcastId}: failed to send to ${recipient.whatsappNumber}`, {
        error: error.response?.data || error.message
      });
    }
  }

  const { error: rpcErr } = await supabase.rpc('increment_broadcast_progress', {
    p_broadcast_id: broadcastId,
    p_sent_delta: sent,
    p_failed_delta: failed
  });
  if (rpcErr) logger.error(`Broadcast ${broadcastId}: failed to update progress`, rpcErr);

  logger.info(`Broadcast batch processed for business ${businessId}: ${sent} sent, ${failed} failed`, { broadcastId });
  return { sent, failed };
}, {
  connection,
  concurrency: 5
});

worker.on('completed', (job) => {
  logger.info(`Broadcast job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  logger.error(`Broadcast job failed: ${job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Broadcast worker error: ${err.message}`);
});

module.exports = worker;
