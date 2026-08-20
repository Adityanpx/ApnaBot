require('dotenv').config();
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;
const BUSINESS_ID = process.env.BUSINESS_ID;

if (!REDIS_URL || !BUSINESS_ID) {
  console.error('Missing REDIS_URL or BUSINESS_ID env var.');
  process.exit(1);
}

async function main() {
  const redis = new Redis(REDIS_URL);
  const key = `subscription:${BUSINESS_ID}`;
  const deleted = await redis.del(key);
  console.log(`Deleted ${deleted} key(s) for ${key}`);
  redis.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});