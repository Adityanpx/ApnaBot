/**
 * seedTravelsTestShop.js
 * -----------------------------------------------------------------------------
 * Converts your existing test shop into a 'travels' business so you can test
 * yesterday's trip-fare rules and 9-question booking flow end to end.
 *
 * What it does (idempotent — safe to re-run):
 *   1. Ensures a BusinessTypeTemplate for 'travels' exists in Mongo
 *      (creates it from the canonical seed data if missing).
 *   2. Sets the existing test shop's businessType -> 'travels'.
 *   3. Replaces that shop's Rule documents with the 4 numbered travels rules
 *      (1 = packages info, 2 = start booking, 3 = availability, 4 = routes).
 *   4. Clears the Redis rules cache (`rules:{shopId}`) AND tenant cache
 *      (`tenant:{phoneNumberId}`) for this shop, so the change is picked up
 *      on the very next message — not after the 1-hour TTL.
 *
 * Does NOT touch the BusinessTypeTemplate's bookingFields (the 9-question
 * flow) — those are read live by businessType at booking time, so once the
 * template exists, they just work for any shop of that type.
 *
 * -----------------------------------------------------------------------------
 * REQUIRED env vars (same as seedTestShop.js):
 *   MONGODB_URI
 *   TEST_PHONE_NUMBER_ID   (the shop is looked up by this, must already exist —
 *                            run seedTestShop.js first if you haven't)
 * OPTIONAL:
 *   REDIS_URL              (clears stale caches; strongly recommended)
 *
 * Run (PowerShell):
 *   $env:MONGODB_URI="..."; $env:TEST_PHONE_NUMBER_ID="1296101703578157";
 *   $env:REDIS_URL="..."; node scripts/seedTravelsTestShop.js
 * -----------------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Shop = require('../src/models/Shop');
const Rule = require('../src/models/Rule');
const BusinessTypeTemplate = require('../src/models/BusinessTypeTemplate');

const { MONGODB_URI, TEST_PHONE_NUMBER_ID, REDIS_URL } = process.env;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('MONGODB_URI is required.');
if (!TEST_PHONE_NUMBER_ID) fail('TEST_PHONE_NUMBER_ID is required.');

// Canonical travels template — matches src/seeds/businessTypeSeed.js exactly.
const TRAVELS_TEMPLATE = {
  businessType: 'travels',
  defaultRules: [
    { keyword: '1', matchType: 'exact', reply: "We offer One Way, Round Trip, and Local Rental packages to all major cities. Reply '2' to get a quote for your trip!", replyType: 'text' },
    { keyword: '2', matchType: 'exact', reply: "Let's get your trip details!", replyType: 'booking_trigger' },
    { keyword: '3', matchType: 'exact', reply: "We're available 24/7 for bookings. Advance booking recommended for outstation trips.", replyType: 'text' },
    { keyword: '4', matchType: 'exact', reply: "We serve [cities/routes]. Contact us to confirm your route.", replyType: 'text' }
  ],
  bookingFields: [
    { fieldKey: 'tripType', label: 'What type of trip? Reply: One Way / Round Trip / Local Rental', required: true, order: 1 },
    { fieldKey: 'pickupLocation', label: 'Pickup location?', required: true, order: 2 },
    { fieldKey: 'dropLocation', label: 'Drop location?', required: true, order: 3 },
    { fieldKey: 'travelDate', label: 'What date do you need the vehicle? (DD/MM/YYYY)', required: true, order: 4 },
    { fieldKey: 'pickupTime', label: 'What time should we pick you up?', required: true, order: 5 },
    { fieldKey: 'vehicleType', label: "Vehicle preference? Hatchback / Sedan / SUV / Luxury / Tempo / Mini Bus / Bus (or say 'any')", required: true, order: 6 },
    { fieldKey: 'acRequired', label: 'Do you need AC? Reply Yes or No', required: false, order: 7 },
    { fieldKey: 'carrierRequired', label: 'Do you need a carrier for luggage? Reply Yes or No', required: false, order: 8 },
    { fieldKey: 'tollParkingIncluded', label: 'Should toll & parking be included in the fare? Reply Yes or No', required: false, order: 9 }
  ]
};

async function clearCaches(shopId, phoneNumberId) {
  if (!REDIS_URL) {
    console.log('   • (REDIS_URL not set — skipping cache clear; caches self-expire after 1h)');
    return;
  }
  try {
    const IORedis = require('ioredis');
    const r = new IORedis(REDIS_URL);
    await r.del(`rules:${shopId}`);
    await r.del(`tenant:${phoneNumberId}`);
    await r.quit();
    console.log(`   • cleared Redis rules cache for shop ${shopId}`);
    console.log(`   • cleared Redis tenant cache for ${phoneNumberId}`);
  } catch (e) {
    console.log(`   • (skipped Redis cache clear: ${e.message})`);
  }
}

async function main() {
  console.log('\n🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('   ✓ connected');

  // 1) Ensure the travels template exists
  let template = await BusinessTypeTemplate.findOne({ businessType: 'travels' });
  if (!template) {
    template = await BusinessTypeTemplate.create(TRAVELS_TEMPLATE);
    console.log(`\n📋 BusinessTypeTemplate 'travels' CREATED (${template._id})`);
  } else {
    console.log(`\n📋 BusinessTypeTemplate 'travels' already exists (${template._id})`);
  }
  console.log(`   • ${template.defaultRules.length} default rules, ${template.bookingFields.length} booking questions`);

  // 2) Find the existing test shop and switch it to 'travels'
  const shop = await Shop.findOneAndUpdate(
    { phoneNumberId: TEST_PHONE_NUMBER_ID },
    { $set: { businessType: 'travels' } },
    { new: true }
  );
  if (!shop) {
    fail(`No shop found for phoneNumberId ${TEST_PHONE_NUMBER_ID}. Run seedTestShop.js first.`);
  }
  console.log(`\n🚕 Shop "${shop.name}" (${shop._id}) businessType -> travels`);

  // 3) Replace this shop's rules with the 4 travels rules
  await Rule.deleteMany({ shopId: shop._id });
  const rulesToCreate = TRAVELS_TEMPLATE.defaultRules.map((rule) => ({
    shopId: shop._id,
    keyword: rule.keyword,
    matchType: rule.matchType,
    reply: rule.reply,
    replyType: rule.replyType,
    isActive: true
  }));
  await Rule.insertMany(rulesToCreate);
  console.log(`💬 Seeded ${rulesToCreate.length} travels rules for this shop:`);
  rulesToCreate.forEach(r => console.log(`   • "${r.keyword}" (${r.matchType}) -> ${r.replyType}`));

  // 4) Clear stale caches so this takes effect on the very next message
  await clearCaches(shop._id.toString(), TEST_PHONE_NUMBER_ID);

  console.log('\n✅ Done. Test it on WhatsApp (send to +1 555 672-4377):');
  console.log('   1  -> package info + prompt to reply 2');
  console.log('   2  -> starts the 9-question trip-fare booking flow');
  console.log('        (answer each question as it comes; optional ones can be skipped per your booking.service logic)');
  console.log('   3  -> availability info');
  console.log('   4  -> routes info\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n❌ Failed:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
