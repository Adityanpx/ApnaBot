/**
 * seedTestShop.js
 * -----------------------------------------------------------------------------
 * Wires the WhatsApp "API Setup" TEST number to a fully-active test shop so the
 * inbound -> rule-match -> auto-reply flow works end to end in Development Mode.
 *
 * Use this to (a) confirm the new app's credentials and (b) produce the
 * `whatsapp_business_messaging` App Review video.
 *
 * It creates/updates (idempotent — safe to re-run):
 *   - a Plan  (unlimited, so usage limits never block the test)
 *   - a User  (the shop owner)
 *   - a Shop  bound to your test phoneNumberId, with the access token ENCRYPTED
 *   - an active Subscription for that shop
 *   - one keyword Rule that triggers a text auto-reply
 *
 * -----------------------------------------------------------------------------
 * REQUIRED env vars (set these before running):
 *   MONGODB_URI            your production MongoDB connection string
 *   ENCRYPTION_KEY         MUST be the SAME 32-char key that is set on Render.
 *                          The token is encrypted with this key; if it differs
 *                          from Render's, the worker cannot decrypt it and the
 *                          reply send will fail.
 *   TEST_PHONE_NUMBER_ID   the test number's "Phone number ID" from
 *                          WhatsApp -> API Setup (NOT the phone number itself)
 *   TEST_ACCESS_TOKEN      the temporary access token from API Setup
 *                          (note: it expires in ~24h — test/record same day,
 *                           or use a System User token for a long-lived one)
 *
 * OPTIONAL env vars:
 *   TEST_WHATSAPP_NUMBER   display number, e.g. 15550001234 (default placeholder)
 *   TEST_BUSINESS_TYPE     default 'general'
 *   TEST_KEYWORD           default 'hi'
 *   TEST_REPLY             default a friendly confirmation message
 *   OWNER_EMAIL            default 'test-owner@apnabot.local'
 *   REDIS_URL              if set, the stale tenant cache for this phoneNumberId
 *                          is cleared (optional; ignored if it fails)
 *
 * -----------------------------------------------------------------------------
 * Run (PowerShell):
 *   $env:MONGODB_URI="...";
 *   $env:ENCRYPTION_KEY="<same-32-char-key-as-render>";
 *   $env:TEST_PHONE_NUMBER_ID="<from api setup>";
 *   $env:TEST_ACCESS_TOKEN="<from api setup>";
 *   node scripts/seedTestShop.js
 *
 * Run (bash):
 *   MONGODB_URI="..." ENCRYPTION_KEY="..." TEST_PHONE_NUMBER_ID="..." \
 *   TEST_ACCESS_TOKEN="..." node scripts/seedTestShop.js
 * -----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

// Models (these only pull in mongoose, not your env config)
const Shop = require('../src/models/Shop');
const User = require('../src/models/User');
const Plan = require('../src/models/Plan');
const Subscription = require('../src/models/Subscription');
const Rule = require('../src/models/Rule');

// --- Config from env -------------------------------------------------------
const {
  MONGODB_URI,
  ENCRYPTION_KEY,
  TEST_PHONE_NUMBER_ID,
  TEST_ACCESS_TOKEN,
  TEST_WHATSAPP_NUMBER = '15550000000',
  TEST_BUSINESS_TYPE = 'general',
  TEST_KEYWORD = 'hi',
  TEST_REPLY = 'Hello! 👋 Thanks for messaging ApnaBot. This is an automated test reply — everything is working.',
  OWNER_EMAIL = 'test-owner@apnabot.local',
  REDIS_URL,
} = process.env;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!MONGODB_URI) fail('MONGODB_URI is required.');
if (!ENCRYPTION_KEY) fail('ENCRYPTION_KEY is required (must match Render exactly).');
if (Buffer.from(ENCRYPTION_KEY, 'utf-8').length !== 32) {
  fail(`ENCRYPTION_KEY must be exactly 32 bytes; got ${Buffer.from(ENCRYPTION_KEY, 'utf-8').length}.`);
}
if (!TEST_PHONE_NUMBER_ID) fail('TEST_PHONE_NUMBER_ID is required (from WhatsApp -> API Setup).');
if (!TEST_ACCESS_TOKEN) fail('TEST_ACCESS_TOKEN is required (from WhatsApp -> API Setup).');

// --- encrypt(): byte-for-byte identical to src/utils/crypto.js -------------
// Inlined so this script needs only MONGODB_URI + ENCRYPTION_KEY, not env.js.
const ALGO = 'aes-256-cbc';
const KEY = Buffer.from(ENCRYPTION_KEY, 'utf-8');
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// Sanity check: prove the encrypt/decrypt round-trips before we store anything.
function assertRoundTrip(token) {
  const enc = encrypt(token);
  const [ivHex, data] = enc.split(':');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  let dec = decipher.update(data, 'hex', 'utf8');
  dec += decipher.final('utf8');
  if (dec !== token) fail('Encrypt/decrypt round-trip failed — check ENCRYPTION_KEY.');
  return enc;
}

async function clearTenantCache() {
  if (!REDIS_URL) return;
  try {
    const IORedis = require('ioredis');
    const r = new IORedis(REDIS_URL);
    await r.del(`tenant:${TEST_PHONE_NUMBER_ID}`);
    await r.quit();
    console.log(`   • cleared Redis tenant cache for ${TEST_PHONE_NUMBER_ID}`);
  } catch (e) {
    console.log(`   • (skipped Redis cache clear: ${e.message})`);
  }
}

async function main() {
  console.log('\n🔌 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('   ✓ connected');

  // 1) Plan — unlimited so usage limits never block the test
  let plan = await Plan.findOne({ name: 'test-unlimited' });
  if (!plan) {
    plan = await Plan.create({
      name: 'test-unlimited',
      displayName: 'Test Unlimited',
      price: 0,
      msgLimit: -1,
      ruleLimit: -1,
      customerLimit: -1,
      bookingEnabled: true,
      paymentLinkEnabled: true,
      staffEnabled: true,
      maxStaff: 5,
      isActive: true,
    });
    console.log(`\n📦 Plan created: ${plan.name} (${plan._id})`);
  } else {
    console.log(`\n📦 Plan reused: ${plan.name} (${plan._id})`);
  }

  // 2) Owner user — create if missing (save() triggers the password hash hook)
  let owner = await User.findOne({ email: OWNER_EMAIL.toLowerCase() });
  if (!owner) {
    owner = new User({
      name: 'Test Owner',
      email: OWNER_EMAIL,
      passwordHash: 'TestOwner@123', // hashed by the pre-save hook
      role: 'owner',
    });
    await owner.save();
    console.log(`👤 Owner created: ${owner.email} (${owner._id})`);
  } else {
    console.log(`👤 Owner reused: ${owner.email} (${owner._id})`);
  }

  // 3) Shop — bound to the test phoneNumberId, token ENCRYPTED
  const encryptedToken = assertRoundTrip(TEST_ACCESS_TOKEN);
  const shop = await Shop.findOneAndUpdate(
    { phoneNumberId: TEST_PHONE_NUMBER_ID },
    {
      $set: {
        name: 'ApnaBot Test Shop',
        ownerUserId: owner._id,
        businessType: TEST_BUSINESS_TYPE,
        whatsappNumber: TEST_WHATSAPP_NUMBER,
        phoneNumberId: TEST_PHONE_NUMBER_ID,
        accessToken: encryptedToken,
        displayName: 'ApnaBot Test',
        isActive: true,
        isWhatsappConnected: true,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  console.log(`🏪 Shop ready: ${shop.name} (${shop._id})`);
  console.log(`   • phoneNumberId: ${shop.phoneNumberId}`);
  console.log(`   • accessToken:   stored ENCRYPTED (decryptable by Render)`);

  // Link owner -> shop
  if (String(owner.shopId) !== String(shop._id)) {
    owner.shopId = shop._id;
    await owner.save();
  }

  // 4) Active subscription
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const sub = await Subscription.findOneAndUpdate(
    { shopId: shop._id },
    {
      $set: {
        shopId: shop._id,
        planId: plan._id,
        status: 'active',
        startDate: now,
        endDate: oneYear,
        autoRenew: false,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  console.log(`💳 Subscription ready: status=${sub.status}, ends ${sub.endDate.toISOString().slice(0, 10)}`);

  // 5) Keyword rule -> text reply
  const rule = await Rule.findOneAndUpdate(
    { shopId: shop._id, keyword: TEST_KEYWORD.toLowerCase() },
    {
      $set: {
        shopId: shop._id,
        keyword: TEST_KEYWORD.toLowerCase(),
        matchType: 'contains',
        reply: TEST_REPLY,
        replyType: 'text',
        isActive: true,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  console.log(`💬 Rule ready: keyword="${rule.keyword}" (contains) -> text reply`);

  // 6) Clear any stale tenant cache
  await clearTenantCache();

  console.log('\n✅ Done. Test the flow:');
  console.log(`   1. In WhatsApp -> API Setup, add YOUR phone as an allowed recipient.`);
  console.log(`   2. From your personal WhatsApp, send "${TEST_KEYWORD}" to the test number.`);
  console.log(`   3. Watch Render logs: WEBHOOK POST hit -> tenant resolved -> reply sent.`);
  console.log(`   4. You should receive the auto-reply. Screen-record this for Video 1.\n`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n❌ Seed failed:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
