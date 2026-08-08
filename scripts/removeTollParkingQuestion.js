/**
 * scripts/removeTollParkingQuestion.js
 *
 * Removes the 'tollParkingIncluded' bookingField from the 'travels'
 * BusinessTypeTemplate — it's being dropped from the customer-facing
 * booking flow (toll & parking is now just a caveat note on the
 * confirmation message instead of a yes/no question).
 *
 * Does NOT touch acRequired or carrierRequired, and does NOT touch any
 * other business type's bookingFields.
 *
 * No Redis cache flush needed — BusinessTypeTemplate is read fresh from
 * Mongo at the start of every booking session (see startBookingSession
 * in src/services/booking.service.js), it isn't cached in Redis.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/removeTollParkingQuestion.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  const template = await BusinessTypeTemplate.findOne({ businessType: 'travels' });

  if (!template) {
    console.error('No "travels" BusinessTypeTemplate found.');
    process.exit(1);
  }

  const beforeCount = template.bookingFields.length;

  template.bookingFields = template.bookingFields.filter(
    f => f.fieldKey !== 'tollParkingIncluded'
  );

  const afterCount = template.bookingFields.length;

  await template.save();

  console.log(`bookingFields count before: ${beforeCount}`);
  console.log(`bookingFields count after:  ${afterCount}`);
  console.log(
    afterCount < beforeCount
      ? 'Removed "tollParkingIncluded" field successfully.'
      : 'No "tollParkingIncluded" field was found — nothing removed.'
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
