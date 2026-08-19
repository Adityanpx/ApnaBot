require('dotenv').config();
const mongoose = require('mongoose');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');

// Matches the 'travels' template's pickupTime field in src/seeds/businessTypeSeed.js
const NEW_PICKUP_TIME_FIELD = {
  fieldType: 'buttons',
  options: ['Morning (8-11 AM)', 'Afternoon (12-4 PM)', 'Other time']
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const template = await BusinessTypeTemplate.findOne({ businessCategory: 'travels' });
  if (!template) {
    console.error('No travels BusinessTypeTemplate found.');
    process.exit(1);
  }

  const pickupTimeField = template.bookingFields.find(f => f.fieldKey === 'pickupTime');
  if (!pickupTimeField) {
    console.error('No pickupTime field found on travels BusinessTypeTemplate.');
    process.exit(1);
  }

  console.log('Before:', { fieldType: pickupTimeField.fieldType, options: pickupTimeField.options });

  pickupTimeField.fieldType = NEW_PICKUP_TIME_FIELD.fieldType;
  pickupTimeField.options = NEW_PICKUP_TIME_FIELD.options;

  await template.save();

  console.log('After:', { fieldType: pickupTimeField.fieldType, options: pickupTimeField.options });

  await mongoose.disconnect();
  console.log('Done');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
