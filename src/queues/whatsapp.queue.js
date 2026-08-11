const { Queue, QueueEvents } = require('bullmq');

const redisUrl = new URL(process.env.REDIS_URL);

const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port),
  password: redisUrl.password,
  username: redisUrl.username || 'default',
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined
};

const whatsappQueue = new Queue('whatsapp-outbound', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

// Only instantiated lazily because it opens its own blocking Redis
// connection; most callers (single-message replies) never need it.
let whatsappQueueEvents = null;
const getQueueEvents = () => {
  if (!whatsappQueueEvents) {
    whatsappQueueEvents = new QueueEvents('whatsapp-outbound', { connection });
  }
  return whatsappQueueEvents;
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
const addToWhatsappQueueAndWait = async (jobData) => {
  const job = await whatsappQueue.add('send-message', jobData);
  await job.waitUntilFinished(getQueueEvents());
  return job;
};

module.exports = {
  whatsappQueue,
  addToWhatsappQueue,
  addToWhatsappQueueAndWait
};
