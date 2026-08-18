require('dotenv').config();
const mongoose = require('mongoose');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');

const NEW_ORDER = {
  tripType: 1,
  pickupLocation: 2,
  dropLocation: 3,
  travelDate: 4,
  pickupTime: 5,
  acRequired: 6,
  carrierRequired: 7,
  tollParkingIncluded: 8,
  vehicleType: 9
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const template = await BusinessTypeTemplate.findOne({ businessCategory: 'travels' });
  if (!template) {
    console.error('No travels BusinessTypeTemplate found.');
    process.exit(1);
  }

  console.log('Before:');
  template.bookingFields.forEach(f => console.log(`  ${f.fieldKey}: order ${f.order}`));

  for (const field of template.bookingFields) {
    if (Object.prototype.hasOwnProperty.call(NEW_ORDER, field.fieldKey)) {
      field.order = NEW_ORDER[field.fieldKey];
    }
  }

  await template.save();

  console.log('After:');
  template.bookingFields.forEach(f => console.log(`  ${f.fieldKey}: order ${f.order}`));

  await mongoose.disconnect();
  console.log('Done');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
