const { Queue } = require('bullmq');

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

const addToWhatsappQueue = async (jobData) => {
  return whatsappQueue.add('send-message', jobData);
};

module.exports = {
  whatsappQueue,
  addToWhatsappQueue
};
