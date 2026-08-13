/**
 * scripts/checkShopWabaFields.js
 *
 * One-off diagnostic to check what WhatsApp-connection fields are actually
 * stored on the SG Travels Shop document (phoneNumberId '1296101703578157').
 *
 * Read-only. Does not modify any data.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/checkShopWabaFields.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const PHONE_NUMBER_ID = '1296101703578157';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const Shop = mongoose.connection.collection('shops');

  const shop = await Shop.findOne({ phoneNumberId: PHONE_NUMBER_ID });

  if (!shop) {
    console.error(`No shop found with phoneNumberId "${PHONE_NUMBER_ID}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`name: "${shop.name}"`);
  console.log(`phoneNumberId: "${shop.phoneNumberId}"`);
  console.log(`wabaId: "${shop.wabaId}"`);
  console.log(`accessToken: ${shop.accessToken ? 'present' : 'missing'}`);
  console.log(`isWhatsappConnected: "${shop.isWhatsappConnected}"`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Diagnostic failed to run:', err);
  process.exit(1);
});
