const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const config = require('../config/env');

const redisUrl = new URL(process.env.REDIS_URL);

const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port),
  password: redisUrl.password,
  username: redisUrl.username || 'default',
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined
};

// Must match the prefix used by whatsapp.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const worker = new Worker('whatsapp-outbound', async (job) => {
  const { businessId, phoneNumberId, encryptedAccessToken, to, message, messageId,
          type = 'text', imageUrl = null, buttons = [], listOptions = [],
          interactiveButtons = null, interactiveList = null, listButtonLabel = 'Choose',
          step = null } = job.data;

  try {
    if (Array.isArray(interactiveList) && interactiveList.length > 0) {
      // Booking-field choice question rendered as a tappable list (Part C/D/E).
      await whatsappService.sendListMessage(phoneNumberId, encryptedAccessToken, to, message, listButtonLabel, interactiveList, step);
    } else if (Array.isArray(interactiveButtons) && interactiveButtons.length > 0) {
      // Booking-field choice question rendered as reply buttons. Each id is
      // "{step}:{index}" (not just the index) so a stale tap from an earlier
      // question can't be silently misresolved against whatever booking
      // field is currently active — see webhook.controller.js's inbound
      // resolution.
      const mappedButtons = interactiveButtons.map((opt, index) => ({ title: opt, nextKeyword: `${step}:${index}` }));
      await whatsappService.sendInteractiveButtons(phoneNumberId, encryptedAccessToken, to, message, mappedButtons, imageUrl);
    } else if (Array.isArray(buttons) && buttons.length > 0) {
      await whatsappService.sendInteractiveButtons(phoneNumberId, encryptedAccessToken, to, message, buttons, imageUrl);
    } else if (Array.isArray(listOptions) && listOptions.length > 0) {
      await whatsappService.sendRuleListMessage(phoneNumberId, encryptedAccessToken, to, message, 'Choose', listOptions);
    } else if (imageUrl) {
      await whatsappService.sendImageMessage(phoneNumberId, encryptedAccessToken, to, imageUrl, message);
    } else {
      await whatsappService.sendTextMessage(phoneNumberId, encryptedAccessToken, to, message);
    }

    if (messageId) {
      const { error: updateErr } = await supabase.from('messages').update({ status: 'sent' }).eq('id', messageId);
      if (updateErr) logger.error('Error marking message sent:', updateErr);
    }

    logger.info(`Message sent successfully to ${to} for business ${businessId}`);
    return { success: true };
  } catch (error) {
    logger.error(`Failed to send message to ${to} for business ${businessId}:`, {
      error: error.message
    });

    if (messageId && job.attemptsMade >= 2) {
      const { error: updateErr } = await supabase.from('messages').update({ status: 'failed' }).eq('id', messageId);
      if (updateErr) logger.error('Error marking message failed:', updateErr);
    }

    throw error;
  }
}, {
  connection,
  prefix,
  concurrency: 5
});

worker.on('completed', (job) => {
  logger.info(`Job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  logger.error(`Job failed: ${job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Worker error: ${err.message}`);
});

module.exports = worker;
