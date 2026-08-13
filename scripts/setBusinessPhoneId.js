require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const PHONE_NUMBER_ID = process.env.TEST_PHONE_NUMBER_ID || '1296101703578157';
const WABA_ID = process.env.TEST_WABA_ID || '1604422161284563';
const BUSINESS_NAME = process.env.TEST_BUSINESS_NAME || 'SG Travels';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');
  const Business = mongoose.connection.collection('businesses');

  const business = await Business.findOne({ name: BUSINESS_NAME });
  if (!business) {
    console.error(`No business named "${BUSINESS_NAME}". Existing businesses:`);
    const all = await Business.find({}, { projection: { name: 1, phoneNumberId: 1 } }).toArray();
    console.log(all);
    process.exit(1);
  }

  await Business.updateOne(
    { _id: business._id },
    { $set: { phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID } }
  );
  console.log(`Set phoneNumberId=${PHONE_NUMBER_ID}, waba=${WABA_ID} on "${business.name}" (${business._id}).`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });
