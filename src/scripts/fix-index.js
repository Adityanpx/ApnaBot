require('dotenv').config();
const mongoose = require('mongoose');

async function fixIndex() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const collection = mongoose.connection.db.collection('shops');

  try {
    await collection.dropIndex('phoneNumberId_1');
    console.log('Old index dropped');
  } catch (e) {
    console.log('No old index found, skipping drop');
  }

  await collection.createIndex(
    { phoneNumberId: 1 },
    { unique: true, partialFilterExpression: { phoneNumberId: { $type: 'string' } } }
  );
  console.log('Partial index created successfully');

  await mongoose.disconnect();
  console.log('Done');
}

fixIndex().catch(console.error);
