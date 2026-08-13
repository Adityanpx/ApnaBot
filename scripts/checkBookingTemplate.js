/**
 * scripts/checkBookingTemplate.js
 *
 * Read-only diagnostic to check whether the SG Travels test business's
 * businessCategory has a matching BusinessTypeTemplate with bookingFields
 * configured. Written to debug why the booking flow may not be finding
 * fields for that business.
 *
 * Does not modify any data.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/checkBookingTemplate.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Business = require('../src/models/Business');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const MONGODB_URI = process.env.MONGODB_URI;
const PHONE_NUMBER_ID = '1296101703578157'; // SG Travels test business

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const business = await Business.findOne({ phoneNumberId: PHONE_NUMBER_ID }).select('businessCategory name');

  if (!business) {
    console.log('No business found for phoneNumberId', PHONE_NUMBER_ID);
    await mongoose.disconnect();
    return;
  }

  console.log(`Business name: "${business.name}"`);
  console.log(`Business businessCategory: "${business.businessCategory}"`);

  const templates = await BusinessTypeTemplate.find({});
  console.log(`\nFound ${templates.length} BusinessTypeTemplate document(s):`);
  templates.forEach((t) => {
    console.log(`  businessCategory: "${t.businessCategory}" - bookingFields: ${t.bookingFields.length}`);
  });

  const match = await BusinessTypeTemplate.findOne({ businessCategory: business.businessCategory });

  console.log(`\nLookup BusinessTypeTemplate.findOne({ businessCategory: "${business.businessCategory}" }):`);
  if (!match) {
    console.log('  No matching template found.');
  } else {
    console.log(`  Matched template for businessCategory: "${match.businessCategory}"`);
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
