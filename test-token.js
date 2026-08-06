// test-token.js — run once, then delete
require('dotenv').config();
const mongoose = require('mongoose');
const { decrypt } = require('./src/utils/crypto');
const Shop = require('./src/models/Shop');

(async () => {
  await mongoose.connect(process.env.MONGO_URI); // use your actual env var name
  const shop = await Shop.findById('6a734e742125d36f293501d7'); // the shopId from your logs
  const token = decrypt(shop.accessToken);
  console.log('TOKEN:', token);
  console.log('phoneNumberId:', shop.phoneNumberId);
  await mongoose.disconnect();
})();