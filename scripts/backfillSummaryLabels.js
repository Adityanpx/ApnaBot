/**
 * scripts/backfillSummaryLabels.js
 *
 * Backfills `summaryLabel` onto the live 'travels' BusinessTypeTemplate
 * document. summaryLabel was added to the seed data after this template
 * was first created, and seedBusinessTypes() never backfills existing
 * documents, so the live document is missing (or has stale) summaryLabel
 * values on its bookingFields.
 *
 * Only `summaryLabel` is touched — order, fieldType, options, label, and
 * required are left untouched.
 *
 * No Redis cache flush needed — BusinessTypeTemplate is read fresh from
 * Mongo at the start of every booking session (see startBookingSession
 * in src/services/booking.service.js), it isn't cached in Redis.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/backfillSummaryLabels.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

const SUMMARY_LABELS = {
  tripType: 'Trip type',
  pickupLocation: 'Pickup',
  dropLocation: 'Drop',
  travelDate: 'Date',
  pickupTime: 'Pick Up Time',
  acRequired: 'AC',
  carrierRequired: 'Carrier for luggage',
  vehicleType: 'Vehicle preference'
};

async function main() {
  await mongoose.connect(MONGODB_URI);

  const template = await BusinessTypeTemplate.findOne({ businessType: 'travels' });

  if (!template) {
    console.error('No "travels" BusinessTypeTemplate found.');
    process.exit(1);
  }

  console.log('Before:');
  template.bookingFields.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(SUMMARY_LABELS, f.fieldKey)) {
      console.log(`  ${f.fieldKey}: summaryLabel=${JSON.stringify(f.summaryLabel)} -> ${JSON.stringify(SUMMARY_LABELS[f.fieldKey])}`);
    }
  });

  template.bookingFields.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(SUMMARY_LABELS, f.fieldKey)) {
      f.summaryLabel = SUMMARY_LABELS[f.fieldKey];
    }
  });

  template.markModified('bookingFields');
  await template.save();

  const after = [...template.bookingFields]
    .sort((a, b) => a.order - b.order)
    .map(f => `${f.fieldKey}: ${JSON.stringify(f.summaryLabel)}`);
  console.log('After:');
  after.forEach(line => console.log(`  ${line}`));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
