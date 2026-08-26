// src/scripts/updateCabBookingFields.js
//
// Updates the 'cab' business_type_templates row's booking_fields column to the
// full travels-style flow (trip type -> pickup -> drop -> date -> time -> AC ->
// carrier -> toll/parking -> vehicle carousel), matching what's already live
// under the 'travels' category.
//
// businessTypeSeed.js's "skip if exists" logic means `npm run seed` will NOT
// touch an existing 'cab' template, so this direct update is required instead.
//
// Usage:
//   node src/scripts/updateCabBookingFields.js
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL (see src/config/env.js).

require('dotenv').config();
const supabase = require('../config/supabase');
const redis = require('../config/redis');

// Exact copy of the 'travels' bookingFields shape from src/seeds/businessTypeSeed.js,
// with vehicleType's fieldType set to 'vehicle_carousel' (booking.service.js resolves
// this dynamically from the Vehicle Catalog + route fares at runtime either way, but
// this matches what actually renders once fares are configured).
const NEW_BOOKING_FIELDS = [
  { fieldKey: 'tripType', label: 'What type of trip? Reply: One Way / Round Trip / Local Rental', summaryLabel: 'Trip', required: true, order: 1, fieldType: 'buttons', options: ['One Way', 'Round Trip', 'Local Rental'] },
  { fieldKey: 'pickupLocation', label: 'Pickup location?', summaryLabel: 'Pick Up Location', required: true, order: 2, fieldType: 'text', options: [] },
  { fieldKey: 'dropLocation', label: 'Drop location?', summaryLabel: 'Drop Location', required: true, order: 3, fieldType: 'text', options: [] },
  { fieldKey: 'travelDate', label: 'When do you need the vehicle?', summaryLabel: 'Date', required: true, order: 4, fieldType: 'buttons', options: ['Today', 'Tomorrow', 'Other date'] },
  { fieldKey: 'pickupTime', label: 'What time should we pick you up?', summaryLabel: 'Time', required: true, order: 5, fieldType: 'buttons', options: ['Morning (8-11 AM)', 'Afternoon (12-4 PM)', 'Other time'] },
  { fieldKey: 'acRequired', label: 'Do you need AC? Reply Yes or No', summaryLabel: 'AC', required: false, order: 6, fieldType: 'buttons', options: ['Yes', 'No'] },
  { fieldKey: 'carrierRequired', label: 'Do you need a carrier for luggage? Reply Yes or No', summaryLabel: 'Carrier', required: false, order: 7, fieldType: 'buttons', options: ['Yes', 'No'] },
  { fieldKey: 'tollParkingIncluded', label: 'Should toll & parking be included in the fare? Reply Yes or No', summaryLabel: 'Toll & Parking', required: false, order: 8, fieldType: 'buttons', options: ['Yes', 'No'] },
  { fieldKey: 'vehicleType', label: "Vehicle preference? Hatchback / Sedan / SUV / Luxury / Tempo / Mini Bus / Bus (or say 'any')", summaryLabel: 'Vehicle', required: true, order: 9, fieldType: 'vehicle_carousel', options: ['Hatchback', 'Sedan', 'SUV', 'Luxury', 'Tempo', 'Mini Bus', 'Bus'] },
];

function logBookingFields(label, fields) {
  console.log(label);
  (fields || []).forEach((f) => {
    console.log(`  ${f.fieldKey}: fieldType=${f.fieldType}, options=${JSON.stringify(f.options)}, summaryLabel=${f.summaryLabel}, order=${f.order}`);
  });
}

async function main() {
  const { data: template, error: findErr } = await supabase
    .from('business_type_templates')
    .select('id, booking_fields')
    .eq('business_category', 'cab')
    .maybeSingle();

  if (findErr) throw findErr;
  if (!template) {
    console.error("No 'cab' business_type_templates row found.");
    process.exit(1);
  }

  logBookingFields('Before:', template.booking_fields);

  const { error: updateErr } = await supabase
    .from('business_type_templates')
    .update({ booking_fields: NEW_BOOKING_FIELDS })
    .eq('id', template.id);

  if (updateErr) throw updateErr;

  logBookingFields('After:', NEW_BOOKING_FIELDS);

  // Direct writes bypass the app's normal cache-clearing path. Businesses on the
  // 'cab' template are cached under tenant:{phoneNumberId} for up to 1hr — we don't
  // know their phoneNumberIds here, so flush all tenant:* keys to be safe. In-flight
  // booking sessions are unaffected either way (session.fields is a snapshot taken
  // at startBookingSession time).
  console.log('\nFlushing tenant cache...');
  const keys = await redis.keys('tenant:*');
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`Flushed ${keys.length} tenant:* key(s).`);
  } else {
    console.log('No tenant:* keys to flush.');
  }

  console.log('\nDone. New businesses picking the "cab" type — and any existing "cab"');
  console.log('business whose tenant cache was just flushed — will get the full booking flow.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
