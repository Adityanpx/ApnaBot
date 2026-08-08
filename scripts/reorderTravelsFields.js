/**
 * scripts/reorderTravelsFields.js
 *
 * Re-sequences the bookingFields `order` on the 'travels'
 * BusinessTypeTemplate so the vehicle carousel is asked after
 * carrierRequired instead of right after dropLocation:
 *
 *   tripType(1), pickupLocation(2), dropLocation(3), travelDate(4),
 *   pickupTime(5), acRequired(6), carrierRequired(7), vehicleType(8)
 *
 * Also removes 'tollParkingIncluded' as a safety net if it's somehow
 * still present (it should already be gone from an earlier migration —
 * see removeTollParkingQuestion.js).
 *
 * No Redis cache flush needed — BusinessTypeTemplate is read fresh from
 * Mongo at the start of every booking session (see startBookingSession
 * in src/services/booking.service.js), it isn't cached in Redis.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/reorderTravelsFields.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

const NEW_ORDER = {
  tripType: 1,
  pickupLocation: 2,
  dropLocation: 3,
  travelDate: 4,
  pickupTime: 5,
  acRequired: 6,
  carrierRequired: 7,
  vehicleType: 8
};

async function main() {
  await mongoose.connect(MONGODB_URI);

  const template = await BusinessTypeTemplate.findOne({ businessType: 'travels' });

  if (!template) {
    console.error('No "travels" BusinessTypeTemplate found.');
    process.exit(1);
  }

  const before = [...template.bookingFields]
    .sort((a, b) => a.order - b.order)
    .map(f => `${f.fieldKey}(${f.order})`);
  console.log('Before:', before.join(', '));

  const beforeCount = template.bookingFields.length;
  template.bookingFields = template.bookingFields.filter(
    f => f.fieldKey !== 'tollParkingIncluded'
  );
  const afterCount = template.bookingFields.length;
  if (afterCount < beforeCount) {
    console.log('Removed leftover "tollParkingIncluded" field as a safety net.');
  }

  template.bookingFields.forEach(f => {
    if (Object.prototype.hasOwnProperty.call(NEW_ORDER, f.fieldKey)) {
      f.order = NEW_ORDER[f.fieldKey];
    }
  });

  template.markModified('bookingFields');
  await template.save();

  const after = [...template.bookingFields]
    .sort((a, b) => a.order - b.order)
    .map(f => `${f.fieldKey}(${f.order})`);
  console.log('After:', after.join(', '));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
