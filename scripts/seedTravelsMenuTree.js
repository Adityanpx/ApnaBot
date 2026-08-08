/**
 * scripts/seedTravelsMenuTree.js
 *
 * Creates (or updates, if already present) the full travels Main Menu tree
 * for one shop, using the listOptions chaining added in the 5 backend
 * prompts. Upserts by {shopId, keyword}, so it's safe to re-run.
 *
 * Usage (PowerShell):
 *   $env:MONGODB_URI = 'your-connection-string'
 *   $env:SHOP_PHONE_NUMBER_ID = '1296101703578157'   # optional, this is the default
 *   node scripts/seedTravelsMenuTree.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const PHONE_NUMBER_ID = process.env.SHOP_PHONE_NUMBER_ID || '1296101703578157';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI env var.');
  process.exit(1);
}

// Each entry: keyword, matchType, reply, replyType, listOptions (label/description/nextKeyword)
function buildTree(shopName) {
  return [
    // Entry points — all three lead to the same Main Menu
    ...['hi', 'hello', 'menu'].map((keyword) => ({
      keyword,
      matchType: 'exact',
      reply: `Hi there! 👋 Welcome to ${shopName}.\n\nPlease choose what you'd like to do 👇`,
      replyType: 'text',
      listOptions: [
        { label: 'Book a Trip', description: 'One way, round trip, outstation & local', nextKeyword: 'menu_trip_type' },
        { label: 'Fare & Packages', description: 'Check rates and current offers', nextKeyword: 'menu_fare' },
        { label: 'Track My Booking', description: 'See status of an existing booking', nextKeyword: 'menu_track' },
        { label: 'Contact & Support', description: 'Talk to us or file a complaint', nextKeyword: 'menu_support' },
      ],
    })),

    // Trip type submenu
    {
      keyword: 'menu_trip_type',
      matchType: 'exact',
      reply: 'Great! What kind of trip are you planning? 🚕',
      replyType: 'text',
      listOptions: [
        { label: 'One Way', description: 'Single drop, one direction', nextKeyword: 'menu_trip_oneway' },
        { label: 'Round Trip', description: "We'll bring you back too", nextKeyword: 'menu_trip_round' },
        { label: 'Outstation', description: 'Multi-day trips out of town', nextKeyword: 'menu_trip_outstation' },
        { label: 'Local / Hourly', description: 'Within city, by the hour', nextKeyword: 'menu_trip_local' },
      ],
    },
    // Trip type leaves -> each starts the existing booking flow
    ...['menu_trip_oneway', 'menu_trip_round', 'menu_trip_outstation', 'menu_trip_local'].map((keyword) => ({
      keyword,
      matchType: 'exact',
      reply: "Sure! Let's get your trip booked. 🧳",
      replyType: 'booking_trigger',
      listOptions: [],
    })),

    // Fare submenu
    {
      keyword: 'menu_fare',
      matchType: 'exact',
      reply: 'Here are our current rates and packages 💰',
      replyType: 'text',
      listOptions: [
        { label: 'Fare Enquiry', description: 'Per-km and per-hour rates', nextKeyword: 'menu_fare_enquiry' },
        { label: 'Package Rates', description: 'Outstation trip packages', nextKeyword: 'menu_fare_packages' },
        { label: 'Current Offers', description: "This month's discounts", nextKeyword: 'menu_fare_offers' },
      ],
    },
    {
      keyword: 'menu_fare_enquiry',
      matchType: 'exact',
      reply: 'Our standard rates:\n\n🚗 Sedan — ₹12/km\n🚙 SUV — ₹16/km\n\n(Edit this from your Replies page with your real rates.)',
      replyType: 'text',
      listOptions: [],
    },
    {
      keyword: 'menu_fare_packages',
      matchType: 'exact',
      reply: 'Outstation packages start at ₹2,500 for up to 250km/day. Reply BOOK to check availability for your route.',
      replyType: 'text',
      listOptions: [],
    },
    {
      keyword: 'menu_fare_offers',
      matchType: 'exact',
      reply: 'No active offers right now — check back soon! 🎉',
      replyType: 'text',
      listOptions: [],
    },

    // Track (leaf, no submenu)
    {
      keyword: 'menu_track',
      matchType: 'exact',
      reply: "Please share your booking ID and we'll check the status for you.",
      replyType: 'text',
      listOptions: [],
    },

    // Support submenu
    {
      keyword: 'menu_support',
      matchType: 'exact',
      reply: 'How can we help? 👇',
      replyType: 'text',
      listOptions: [
        { label: 'File a Complaint', description: "We'll get back to you shortly", nextKeyword: 'menu_support_complaint' },
        { label: 'Call Our Office', description: 'Direct phone number', nextKeyword: 'menu_support_call' },
      ],
    },
    {
      keyword: 'menu_support_complaint',
      matchType: 'exact',
      reply: 'Please describe the issue and our team will call you shortly.',
      replyType: 'text',
      listOptions: [],
    },
    {
      keyword: 'menu_support_call',
      matchType: 'exact',
      reply: 'You can reach our office at +91-XXXXXXXXXX (Mon–Sat, 9am–7pm).',
      replyType: 'text',
      listOptions: [],
    },
  ];
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const Shop = mongoose.connection.collection('shops');
  const Rule = mongoose.connection.collection('rules');

  const shop = await Shop.findOne({ phoneNumberId: PHONE_NUMBER_ID });
  if (!shop) {
    console.error(`No shop found with phoneNumberId ${PHONE_NUMBER_ID}`);
    process.exit(1);
  }

  const shopName = shop.displayName || shop.name || 'our shop';
  const tree = buildTree(shopName);

  console.log(`Seeding ${tree.length} rule(s) for shop "${shop.name}" (${shop._id})...\n`);

  for (const rule of tree) {
    await Rule.updateOne(
      { shopId: shop._id, keyword: rule.keyword },
      {
        $set: {
          shopId: shop._id,
          keyword: rule.keyword,
          matchType: rule.matchType,
          reply: rule.reply,
          replyType: rule.replyType,
          replyImageUrl: null,
          buttons: [],
          listOptions: rule.listOptions,
          isActive: true,
        },
        $setOnInsert: { triggerCount: 0 },
      },
      { upsert: true }
    );
    console.log(`✔ ${rule.keyword}`);
  }

  console.log('\nDone. The tree is live immediately — no cache to clear for new rules.');
  console.log('Message "hi" to your test number to try it.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
