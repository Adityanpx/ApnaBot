/**
 * scripts/flushShopCache.js
 *
 * Clears every Redis cache key tied to a shop: rules:{shopId} and
 * tenant:{phoneNumberId}. Looks the shop up in MongoDB to get its
 * phoneNumberId automatically, so you only need to pass SHOP_ID.
 *
 * Run this after ANY script that writes to Shop or Rule documents
 * directly in MongoDB (seed scripts, token rotation, manual fixes) —
 * those bypass the app's normal invalidateRulesCache() /
 * invalidateTenantCache() calls, and the stale cache wins for up to an
 * hour otherwise.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   $env:REDIS_URL = 'your-redis-url'
 *   $env:SHOP_ID = '6a734e742125d36f293501d7'
 *   node scripts/flushShopCache.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Redis } = require('ioredis');

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
const SHOP_ID = process.env.SHOP_ID;

if (!MONGODB_URI || !REDIS_URL || !SHOP_ID) {
  console.error('Missing MONGODB_URI, REDIS_URL, or SHOP_ID env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const Shop = mongoose.connection.collection('shops');
  const shop = await Shop.findOne({ _id: new mongoose.Types.ObjectId(SHOP_ID) });

  if (!shop) {
    console.error(`No shop found with _id ${SHOP_ID}`);
    process.exit(1);
  }

  const redis = new Redis(REDIS_URL, {
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });

  const keysToDelete = [`rules:${SHOP_ID}`];
  if (shop.phoneNumberId) {
    keysToDelete.push(`tenant:${shop.phoneNumberId}`);
  }

  console.log(`Shop: "${shop.name}"`);
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
