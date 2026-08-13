/**
 * scripts/restoreSgTravelsWhatsapp.js
 *
 * One-time fix to restore SG Travels' WhatsApp connection using a freshly
 * generated Meta System User access token. The old token stored on the shop
 * had expired/been revoked; this rotates in the new one.
 *
 * Only touches the SG Travels shop (phoneNumberId '1296101703578157') and
 * only the accessToken, wabaId, isWhatsappConnected fields.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   Create ./temp_token.txt containing the new system-user token
 *   node scripts/restoreSgTravelsWhatsapp.js
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Shop = require('../src/models/Shop');
const { encrypt } = require('../src/utils/crypto');

const MONGODB_URI = process.env.MONGODB_URI;

const PHONE_NUMBER_ID = '1296101703578157';
const WABA_ID = '1604422161284563';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

const tokenPath = './temp_token.txt';
if (!fs.existsSync(tokenPath)) {
  console.error(`Token file not found at ${tokenPath}. Create it with the token, then re-run.`);
  process.exit(1);
}
const rawToken = fs.readFileSync(tokenPath, 'utf8');
const token = rawToken.trim();
if (!token) {
  console.error('Token file is empty. Aborting without touching the database.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const shop = await Shop.findOne({ phoneNumberId: PHONE_NUMBER_ID });

  if (!shop) {
    console.error(`No shop found with phoneNumberId ${PHONE_NUMBER_ID}.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  shop.accessToken = encrypt(token);
  shop.wabaId = WABA_ID;
  shop.isWhatsappConnected = true;

  await shop.save();

  console.log('SG Travels WhatsApp connection restored:');
  console.log(`  name: ${shop.name}`);
  console.log(`  phoneNumberId: ${shop.phoneNumberId}`);
  console.log(`  wabaId: ${shop.wabaId}`);
  console.log('  accessToken updated');

  await mongoose.disconnect();

  fs.unlinkSync(tokenPath);
  console.log(`Deleted ${tokenPath}.`);

  console.log('Done.');
}

main().catch((err) => {
  console.error('Restore failed to run:', err);
  process.exit(1);
});
