require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const NEW_ADMIN_PASSWORD = process.env.NEW_ADMIN_PASSWORD;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}
if (!NEW_ADMIN_PASSWORD || NEW_ADMIN_PASSWORD.length < 8) {
  console.error('Missing NEW_ADMIN_PASSWORD env var, or it is under 8 characters.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const query = ADMIN_EMAIL
    ? { role: 'superadmin', email: ADMIN_EMAIL.toLowerCase() }
    : { role: 'superadmin' };

  console.log('Looking up superadmin with:', JSON.stringify(query));

  const user = await User.findOne(query);
  if (!user) {
    console.error('No matching superadmin user found.');
    process.exit(1);
  }

  user.passwordHash = NEW_ADMIN_PASSWORD;
  await user.save();

  console.log(`Password reset for superadmin: ${user.email}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});