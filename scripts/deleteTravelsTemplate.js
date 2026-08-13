/**
 * deleteTravelsTemplate.js
 * -----------------------------------------------------------------------------
 * Deletes the existing 'travels' BusinessTypeTemplate document so that
 * running the real project seed (src/seeds/index.js) recreates it fresh
 * from the updated src/seeds/businessTypeSeed.js (with fieldType/options).
 *
 * Does NOT touch the test shop's Rule documents (1/2/3/4) — those are
 * unaffected by this schema change, only the template's bookingFields are.
 *
 * REQUIRED env var: MONGODB_URI
 *
 * Run (PowerShell):
 *   $env:MONGODB_URI="..."; node scripts/deleteTravelsTemplate.js
 * -----------------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const { MONGODB_URI } = process.env;

if (!MONGODB_URI) {
  console.error('\n❌ MONGODB_URI is required.\n');
  process.exit(1);
}

async function main() {
  console.log('\n🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('   ✓ connected');

  const result = await BusinessTypeTemplate.deleteOne({ businessCategory: 'travels' });

  if (result.deletedCount > 0) {
    console.log('\n🗑️  Deleted stale "travels" BusinessTypeTemplate.');
    console.log('   Now run the real project seed to recreate it with the');
    console.log('   updated fieldType/options fields:');
    console.log('   node src/seeds/index.js\n');
  } else {
    console.log('\n(No "travels" template found — nothing to delete. Safe to proceed.)\n');
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n❌ Failed:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
