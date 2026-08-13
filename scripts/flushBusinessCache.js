/**
 * scripts/flushBusinessCache.js
 *
 * Clears every Redis cache key tied to a business: rules:{businessId} and
 * tenant:{phoneNumberId}. Looks the business up in MongoDB to get its
 * phoneNumberId automatically, so you only need to pass BUSINESS_ID.
 *
 * Run this after ANY script that writes to Business or Rule documents
 * directly in MongoDB (seed scripts, token rotation, manual fixes) —
 * those bypass the app's normal invalidateRulesCache() /
 * invalidateTenantCache() calls, and the stale cache wins for up to an
 * hour otherwise.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   $env:REDIS_URL = 'your-redis-url'
 *   $env:BUSINESS_ID = '6a734e742125d36f293501d7'
 *   node scripts/flushBusinessCache.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Redis } = require('ioredis');

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
const BUSINESS_ID = process.env.BUSINESS_ID;

if (!MONGODB_URI || !REDIS_URL || !BUSINESS_ID) {
  console.error('Missing MONGODB_URI, REDIS_URL, or BUSINESS_ID env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const Business = mongoose.connection.collection('businesses');
  const business = await Business.findOne({ _id: new mongoose.Types.ObjectId(BUSINESS_ID) });

  if (!business) {
    console.error(`No business found with _id ${BUSINESS_ID}`);
    process.exit(1);
  }

  const redis = new Redis(REDIS_URL, {
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });

  const keysToDelete = [`rules:${BUSINESS_ID}`];
  if (business.phoneNumberId) {
    keysToDelete.push(`tenant:${business.phoneNumberId}`);
  }

  console.log(`Business: "${business.name}"`);
  console.log(`Clearing: ${keysToDelete.join(', ')}`);

  const deleted = await redis.del(...keysToDelete);
  console.log(`Deleted ${deleted} key(s).`);

  redis.disconnect();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
