const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

const redis = new Redis(config.REDIS_URL, {
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 50, 2000);
  },
  maxRetriesPerRequest: 3
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error('Redis connection error:', err);
});

// retryStrategy above returns null after 10 attempts, which makes ioredis
// give up and emit 'end' instead of retrying further. There's no automatic
// recovery from that state, so exit and let pm2 (see deploy.yml) restart
// the process and reconnect from scratch.
redis.on('end', () => {
  logger.error('CRITICAL: Redis connection permanently closed (retries exhausted); exiting to trigger process restart');
  process.exit(1);
});

module.exports = redis;
