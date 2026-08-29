const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const config = require('../config/env');

const redisUrl = new URL(process.env.REDIS_URL);

const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port),
  password: redisUrl.password,
  username: redisUrl.username || 'default',
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 50, 2000);
  }
};

// Namespaces queue keys per environment so a local dev run can never join
// the production queue, even if REDIS_URL is accidentally shared. Must
// match the prefix used by broadcast.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const broadcastQueue = new Queue('broadcast-outbound', {
  connection,
  prefix,
  defaultJobOptions: {
    // No retries: each job fans a template send out to up to 50 recipients,
    // tracked per-recipient inside the worker (see broadcast.worker.js). A
    // BullMQ retry would re-run the whole batch and re-send to recipients
    // who already succeeded on the first attempt.
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

broadcastQueue.on('error', (err) => {
  logger.error(`Broadcast queue error: ${err.message}`);
});

// connection's retryStrategy gives up after 10 attempts, which makes
// ioredis emit 'end' on its underlying client instead of retrying further.
// There's no automatic recovery from that state, so exit and let pm2 (see
// deploy.yml) restart the process and reconnect from scratch.
broadcastQueue.client.then((client) => {
  client.on('end', () => {
    logger.error('CRITICAL: Redis connection for broadcast queue permanently closed (retries exhausted); exiting to trigger process restart');
    process.exit(1);
  });
}).catch(() => {});

const addToBroadcastQueue = async (jobData) => {
  return broadcastQueue.add('send-broadcast-batch', jobData);
};

module.exports = {
  broadcastQueue,
  addToBroadcastQueue
};
