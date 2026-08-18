require('dotenv').config();
const mongoose = require('mongoose');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');

// Exact copy of the 'travels' bookingFields array from src/seeds/businessTypeSeed.js
const NEW_BOOKING_FIELDS = [
  { fieldKey: 'tripType', label: 'What type of trip? Reply: One Way / Round Trip / Local Rental', summaryLabel: 'Trip', required: true, order: 1, fieldType: 'buttons', options: ['One Way', 'Round Trip', 'Local Rental'] },
  { fieldKey: 'pickupLocation', label: 'Pickup location?', summaryLabel: 'Pick Up Location', required: true, order: 2 },
  { fieldKey: 'dropLocation', label: 'Drop location?', summaryLabel: 'Drop Location', required: true, order: 3 },
  { fieldKey: 'travelDate', label: 'When do you need the vehicle?', summaryLabel: 'Date', required: true, order: 4, fieldType: 'buttons', options: ['Today', 'Tomorrow', 'Other date'] },
  { fieldKey: 'pickupTime', label: 'What time should we pick you up?', summaryLabel: 'Time', required: true, order: 5 },
  { fieldKey: 'acRequired', label: 'Do you need AC? Reply Yes or No', summaryLabel: 'AC', required: false, order: 6, fieldType: 'buttons', options: ['Yes', 'No'] },
  { fieldKey: 'carrierRequired', label: 'Do you need a carrier for luggage? Reply Yes or No', summaryLabel: 'Carrier', required: false, order: 7, fieldType: 'buttons', options: ['Yes', 'No'] },
  { fieldKey: 'tollParkingIncluded', label: 'Should toll & parking be included in the fare? Reply Yes or No', summaryLabel: 'Toll & Parking', required: false, order: 8, fieldType: 'buttons', options: ['Yes', 'No'] },
  { fieldKey: 'vehicleType', label: "Vehicle preference? Hatchback / Sedan / SUV / Luxury / Tempo / Mini Bus / Bus (or say 'any')", summaryLabel: 'Vehicle', required: true, order: 9, fieldType: 'list', options: ['Hatchback', 'Sedan', 'SUV', 'Luxury', 'Tempo', 'Mini Bus', 'Bus'] }
];

function logBookingFields(label, fields) {
  console.log(label);
  fields.forEach(f => {
    console.log(`  ${f.fieldKey}: fieldType=${f.fieldType}, options=${JSON.stringify(f.options)}, summaryLabel=${f.summaryLabel}, order=${f.order}`);
  });
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const template = await BusinessTypeTemplate.findOne({ businessCategory: 'travels' });
  if (!template) {
    console.error('No travels BusinessTypeTemplate found.');
    process.exit(1);
  }

  logBookingFields('Before:', template.bookingFields);

  template.bookingFields = NEW_BOOKING_FIELDS;

  await template.save();

  logBookingFields('After:', template.bookingFields);

  await mongoose.disconnect();
  console.log('Done');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
