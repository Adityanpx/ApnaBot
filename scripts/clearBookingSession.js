/**
 * scripts/clearBookingSession.js
 *
 * Deletes a dangling booking session from Redis for one shop/customer pair.
 * Booking sessions are checked BEFORE rule matching in webhook.controller.js,
 * so a half-finished session can block new keyword rules (like "hi") from
 * ever being reached until it expires (30 min TTL) or is cleared.
 *
 * Usage:
 *   $env:REDIS_URL = 'your-redis-url'
 *   $env:SHOP_ID = '6a734e742125d36f293501d7'
 *   $env:CUSTOMER_NUMBER = '919049606115'
 *   node scripts/clearBookingSession.js
 */
require('dotenv').config();
const { Redis } = require('ioredis');

const REDIS_URL = process.env.REDIS_URL;
const SHOP_ID = process.env.SHOP_ID;
const CUSTOMER_NUMBER = process.env.CUSTOMER_NUMBER;

if (!REDIS_URL || !SHOP_ID || !CUSTOMER_NUMBER) {
  console.error('Missing REDIS_URL, SHOP_ID, or CUSTOMER_NUMBER env var.');
  process.exit(1);
}

async function main() {
  const redis = new Redis(REDIS_URL, {
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });

  const key = `booking_session:${SHOP_ID}:${CUSTOMER_NUMBER}`;
  const existing = await redis.get(key);

  if (!existing) {
    console.log(`No session found at ${key} — nothing to clear.`);
  } else {
    console.log(`Found session: ${existing}`);
    await redis.del(key);
    console.log(`Deleted ${key}.`);
  }

  redis.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
