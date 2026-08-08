require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const PHONE_NUMBER_ID = process.env.TEST_PHONE_NUMBER_ID || '1296101703578157';
const WABA_ID = process.env.TEST_WABA_ID || '1604422161284563';
const SHOP_NAME = process.env.TEST_SHOP_NAME || 'SG Travels';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');
  const Shop = mongoose.connection.collection('shops');

  const shop = await Shop.findOne({ name: SHOP_NAME });
  if (!shop) {
    console.error(`No shop named "${SHOP_NAME}". Existing shops:`);
    const all = await Shop.find({}, { projection: { name: 1, phoneNumberId: 1 } }).toArray();
    console.log(all);
    process.exit(1);
  }

  await Shop.updateOne(
    { _id: shop._id },
    { $set: { phoneNumberId: PHONE_NUMBER_ID, whatsappBusinessAccountId: WABA_ID } }
  );
  console.log(`Set phoneNumberId=${PHONE_NUMBER_ID}, waba=${WABA_ID} on "${shop.name}" (${shop._id}).`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });