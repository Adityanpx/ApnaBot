/**
 * scripts/checkBookingTemplate.js
 *
 * Read-only diagnostic to check whether the SG Travels test shop's
 * businessType has a matching BusinessTypeTemplate with bookingFields
 * configured. Written to debug why the booking flow may not be finding
 * fields for that shop.
 *
 * Does not modify any data.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/checkBookingTemplate.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Shop = require('../src/models/Shop');
const Business = require('../src/models/Business');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const MONGODB_URI = process.env.MONGODB_URI;
const PHONE_NUMBER_ID = '1296101703578157'; // SG Travels test shop

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  let shop = await Shop.findOne({ phoneNumberId: PHONE_NUMBER_ID }).select('businessType name');

  if (!shop) {
    console.log('Shop not found via Shop model, trying Business model...');
    shop = await Business.findOne({ phoneNumberId: PHONE_NUMBER_ID }).select('businessType name');
  }

  if (!shop) {
    console.log('No shop/business found for phoneNumberId', PHONE_NUMBER_ID);
    await mongoose.disconnect();
    return;
  }

  console.log(`Shop name: "${shop.name}"`);
  console.log(`Shop businessType: "${shop.businessType}"`);

  const templates = await BusinessTypeTemplate.find({});
  console.log(`\nFound ${templates.length} BusinessTypeTemplate document(s):`);
  templates.forEach((t) => {
    console.log(`  businessType: "${t.businessType}" - bookingFields: ${t.bookingFields.length}`);
  });

  const match = await BusinessTypeTemplate.findOne({ businessType: shop.businessType });

  console.log(`\nLookup BusinessTypeTemplate.findOne({ businessType: "${shop.businessType}" }):`);
  if (!match) {
    console.log('  No matching template found.');
  } else {
    console.log(`  Matched template for businessType: "${match.businessType}"`);
    console.log(`  bookingFields length: ${match.bookingFields.length}`);
    console.log('  fieldKeys in order:', match.bookingFields.map((f) => f.fieldKey));
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Diagnostic failed to run:', err);
  process.exit(1);
});
