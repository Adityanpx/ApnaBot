const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const Message = require('../models/Message');
const logger = require('../utils/logger');

const redisUrl = new URL(process.env.REDIS_URL);

const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port),
  password: redisUrl.password,
  username: redisUrl.username || 'default',
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined
};

const worker = new Worker('whatsapp-outbound', async (job) => {
  const { shopId, phoneNumberId, encryptedAccessToken, to, message, messageId } = job.data;

  try {
    await whatsappService.sendTextMessage(phoneNumberId, encryptedAccessToken, to, message);

    if (messageId) {
      await Message.findByIdAndUpdate(messageId, { status: 'sent' });
    }

    logger.info(`Message sent successfully to ${to} for shop ${shopId}`);
    return { success: true };
  } catch (error) {
    logger.error(`Failed to send message to ${to} for shop ${shopId}:`, {
      error: error.message
    });

    if (messageId && job.attemptsMade >= 2) {
      await Message.findByIdAndUpdate(messageId, { status: 'failed' });
    }

    throw error;
  }
}, {
  connection,
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
