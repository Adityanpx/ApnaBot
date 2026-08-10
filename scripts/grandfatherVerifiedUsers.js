/**
 * scripts/grandfatherVerifiedUsers.js
 *
 * One-time migration to grandfather existing users past the new email OTP
 * verification requirement (see auth.controller.js). Sets isVerified: true
 * on every User document that isn't already verified, so pre-existing
 * accounts aren't locked out of login by the new check.
 *
 * Only touches isVerified — no other field on any User document is read
 * or written.
 *
 * Usage:
 *   $env:MONGODB_URI = 'your-connection-string'
 *   node scripts/grandfatherVerifiedUsers.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const User = mongoose.connection.collection('users');

  const result = await User.updateMany(
    { isVerified: { $ne: true } },
    { $set: { isVerified: true } }
  );

  console.log(`Matched ${result.matchedCount} document(s).`);
  console.log(`Modified ${result.modifiedCount} document(s).`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Migration failed to run:', err);
  process.exit(1);
});
