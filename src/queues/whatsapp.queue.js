const { Queue, QueueEvents } = require('bullmq');
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
// match the prefix used by whatsapp.worker.js and the QueueEvents below.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const whatsappQueue = new Queue('whatsapp-outbound', {
  connection,
  prefix,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

whatsappQueue.on('error', (err) => {
  logger.error(`WhatsApp queue error: ${err.message}`);
});

// connection's retryStrategy gives up after 10 attempts, which makes
// ioredis emit 'end' on its underlying client instead of retrying further.
// There's no automatic recovery from that state, so exit and let pm2 (see
// deploy.yml) restart the process and reconnect from scratch.
whatsappQueue.client.then((client) => {
  client.on('end', () => {
    logger.error('CRITICAL: Redis connection for whatsapp queue permanently closed (retries exhausted); exiting to trigger process restart');
    process.exit(1);
  });
}).catch(() => {});

// Only instantiated lazily because it opens its own blocking Redis
// connection; most callers (single-message replies) never need it.
// Cache the readiness promise (not just the instance) so concurrent
// callers all await the same initialization instead of racing to create
// multiple QueueEvents instances.
let whatsappQueueEventsReady = null;
const getQueueEvents = () => {
  if (!whatsappQueueEventsReady) {
    const startedAt = Date.now();
    const queueEvents = new QueueEvents('whatsapp-outbound', { connection, prefix });
    queueEvents.on('error', (err) => {
      logger.error('WhatsApp QueueEvents connection error', { error: err.message });
    });
    whatsappQueueEventsReady = queueEvents.waitUntilReady().then(() => {
      logger.info('QueueEvents ready for whatsapp-outbound', { readyMs: Date.now() - startedAt });
      return queueEvents;
    });
  }
  return whatsappQueueEventsReady;
};

const withTimeout = (promise, ms, message) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
};

const addToWhatsappQueue = async (jobData) => {
  return whatsappQueue.add('send-message', jobData);
};

// Standard bullmq (unlike bullmq-pro) has no job "groups" for per-key FIFO
// ordering under shared concurrency, so ordering-sensitive callers (e.g. the
// vehicle carousel loop) use this instead: it waits for the job to actually
// finish sending before resolving, so the caller can await each message
// before enqueueing the next and guarantee WhatsApp delivery order within
// that one customer's sequence. Concurrency: 5 on the worker is unaffected -
// other customers' jobs still process in parallel.
//
// The wait is best-effort: if QueueEvents never becomes ready or the
// 'completed' event is missed, we log and return the already-enqueued job
// rather than hang or throw - the worker will still send it, we just lose
// the ordering guarantee for that one message.
const addToWhatsappQueueAndWait = async (jobData) => {
  let queueEvents = null;
  try {
    queueEvents = await withTimeout(
      getQueueEvents(),
      20000,
      'Timed out waiting for WhatsApp QueueEvents connection to become ready'
    );
  } catch (err) {
    logger.warn('QueueEvents not ready; enqueueing without ordering guarantee', { reason: err.message });
  }

  const job = await whatsappQueue.add('send-message', jobData);

  if (queueEvents) {
    try {
      await job.waitUntilFinished(queueEvents, 20000);
    } catch (err) {
      logger.warn('Timed out waiting for WhatsApp job to finish; continuing without ordering guarantee', {
        jobId: job.id,
        reason: err.message
      });
    }
  }

  return job;
};

module.exports = {
  whatsappQueue,
  addToWhatsappQueue,
  addToWhatsappQueueAndWait
};
