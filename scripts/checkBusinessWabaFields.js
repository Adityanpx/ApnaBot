/**
 * scripts/checkBusinessWabaFields.js
 *
 * One-off diagnostic to check what WhatsApp-connection fields are actually
 * stored on the SG Travels Business document (phoneNumberId '1296101703578157').
 *
 * Read-only. Does not modify any data.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/checkBusinessWabaFields.js
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

  const Business = mongoose.connection.collection('businesses');

  const business = await Business.findOne({ phoneNumberId: PHONE_NUMBER_ID });

  if (!business) {
    console.error(`No business found with phoneNumberId "${PHONE_NUMBER_ID}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`name: "${business.name}"`);
  console.log(`phoneNumberId: "${business.phoneNumberId}"`);
  console.log(`wabaId: "${business.wabaId}"`);
  console.log(`accessToken: ${business.accessToken ? 'present' : 'missing'}`);
  console.log(`isWhatsappConnected: "${business.isWhatsappConnected}"`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Diagnostic failed to run:', err);
  process.exit(1);
});
