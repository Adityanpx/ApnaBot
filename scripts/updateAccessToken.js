/**
 * scripts/updateAccessToken.js
 *
 * Rotates the stored WhatsApp access token for a business, using the same
 * AES-256-CBC scheme as utils/crypto.js. Idempotent — safe to re-run.
 *
 * Usage (PowerShell):
 *   $env:MONGODB_URI = 'your-connection-string'
 *   $env:ENCRYPTION_KEY = 'your-32-char-key'
 *   $env:TEST_ACCESS_TOKEN = 'the-new-token-from-meta'
 *   $env:TEST_PHONE_NUMBER_ID = '1296101703578157'   # optional, this is the default
 *   node scripts/updateAccessToken.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');

const MONGODB_URI = process.env.MONGODB_URI;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const TEST_ACCESS_TOKEN = process.env.TEST_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.TEST_PHONE_NUMBER_ID || '1296101703578157';

if (!MONGODB_URI || !ENCRYPTION_KEY || !TEST_ACCESS_TOKEN) {
  console.error('Missing MONGODB_URI, ENCRYPTION_KEY, or TEST_ACCESS_TOKEN env var.');
  process.exit(1);
}

const algorithm = 'aes-256-cbc';
const key = Buffer.from(ENCRYPTION_KEY, 'utf-8');
const ivLength = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(ivLength);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const Business = mongoose.connection.collection('businesses');
  const business = await Business.findOne({ phoneNumberId: PHONE_NUMBER_ID });

  if (!business) {
    console.error(`No business found with phoneNumberId ${PHONE_NUMBER_ID}`);
    process.exit(1);
  }

  const encryptedToken = encrypt(TEST_ACCESS_TOKEN);
  await Business.updateOne({ _id: business._id }, { $set: { accessToken: encryptedToken } });

  console.log(`Updated accessToken for business "${business.name}" (${business._id}).`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
