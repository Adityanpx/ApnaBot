// scripts/seedTestBusinessSupabase.js
// Run locally: node scripts/seedTestBusinessSupabase.js
// Requires .env to have: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY

require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

// --- Same encrypt() as src/utils/crypto.js ---
const ALGO = 'aes-256-cbc';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'utf-8');
const IV_LENGTH = 16;
function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// --- CONFIG — fill these in ---
const TEST_PHONE_NUMBER_ID = '1296101703578157';
const TEST_WABA_ID = '1604422161284563';
const TEST_ACCESS_TOKEN = 'EAATCsSuyV4gBSKoywTyqTsRp6Weu8JTfeUnAivq7beb0aaviKmeSfxXLkzukiWZCKGvZClhmf927g8JyeZBRBiQIUgS0eiNbENOznA5iBYDsZAdzlTBxf7Wje8vDMp1xwBJZBvHSt9Lirk4JcaFM6PgsBnNWjnwH1OPguRyZANKs9OjLgkpsJdATJFZCQ4zDAZDZD'; // from WhatsApp -> API Setup
const TEST_WHATSAPP_NUMBER = '15556724377';
const OWNER_EMAIL = 'suresh.gvl2009@gmail.com';
const TEST_KEYWORD = 'hi';

async function main() {
  if (Buffer.from(process.env.ENCRYPTION_KEY, 'utf-8').length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 bytes — must match Render exactly');
  }
  if (TEST_ACCESS_TOKEN.startsWith('PASTE_')) {
    throw new Error('Set TEST_ACCESS_TOKEN before running');
  }

  // 1. Owner user
  const passwordHash = await bcrypt.hash('TestOwner@123', 12);
  const { data: owner, error: ownerErr } = await supabase.from('users').insert({
    name: 'Test Owner',
    email: OWNER_EMAIL,
    password_hash: passwordHash,
    role: 'owner',
    is_verified: true,
    can_view_chats: true, can_manage_rules: true, can_manage_bookings: true,
    can_view_customers: true, can_manage_billing: true,
    is_active: true
  }).select().single();
  if (ownerErr) throw ownerErr;
  console.log('Owner created:', owner.id);

  // 2. Business
  const { data: business, error: bizErr } = await supabase.from('businesses').insert({
    name: 'ApnaBot Test Business',
    owner_user_id: owner.id,
    business_category: 'travels',
    whatsapp_number: TEST_WHATSAPP_NUMBER,
    phone_number_id: TEST_PHONE_NUMBER_ID,
    waba_id: TEST_WABA_ID,
    access_token: encrypt(TEST_ACCESS_TOKEN),
    display_name: 'ApnaBot Test',
    is_active: true,
    is_whatsapp_connected: true
  }).select().single();
  if (bizErr) throw bizErr;
  console.log('Business created:', business.id);

  // Link owner -> business
  await supabase.from('users').update({ business_id: business.id }).eq('id', owner.id);

  // 3. Plan (reuse existing 'business' plan, unlimited-ish, or your seeded plans)
  const { data: plan } = await supabase.from('plans').select('id').eq('name', 'business').maybeSingle();
  if (!plan) throw new Error('No "business" plan found — check your plans table');

  // 4. Subscription
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const { error: subErr } = await supabase.from('subscriptions').insert({
    business_id: business.id,
    plan_id: plan.id,
    status: 'active',
    start_date: now.toISOString(),
    end_date: oneYear.toISOString(),
    auto_renew: false
  });
  if (subErr) throw subErr;
  console.log('Subscription created');

  // 5. Keyword rule
  const { error: ruleErr } = await supabase.from('rules').insert({
    business_id: business.id,
    keyword: TEST_KEYWORD,
    match_type: 'contains',
    reply: 'Hello! 👋 This is a test reply — everything is working.',
    reply_type: 'text',
    is_active: true,
    trigger_count: 0
  });
  if (ruleErr) throw ruleErr;
  console.log('Rule created for keyword:', TEST_KEYWORD);

  console.log('\n✅ Done. Send "hi" to your test WhatsApp number now.');
}

main().catch(err => { console.error('❌ Seed failed:', err); process.exit(1); });