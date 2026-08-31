require('dotenv').config();
const supabase = require('../config/supabase');
const tenantService = require('../services/tenant.service');
const subscriptionService = require('../services/subscription.service');

// One-off fix for the SG Travels outage on 2026-08-31: a superadmin manual
// grant (admin.controller.js's grantSubscription) inserted a second 'active'
// subscriptions row without cancelling the pre-existing one, so any query
// doing .eq('status','active').maybeSingle() on this business_id throws
// PGRST116 (2 rows). This cancels the older duplicate so exactly one active
// row remains, then invalidates the caches that read subscription/tenant
// state so the fix takes effect immediately.
//
// Dry-run by default (prints what it would do). Pass --confirm to execute.
//   node src/scripts/fixDuplicateActiveSubscription.js            (dry run)
//   node src/scripts/fixDuplicateActiveSubscription.js --confirm  (executes)

const BUSINESS_ID = 'b92113c1-8692-46d5-b377-998c6541486f';
const KEEP_ACTIVE_ID = 'bee0a3fb-8274-4c99-b15f-85a5acff0fb5';
const CANCEL_ID = '73b2a2ea-3215-4977-833a-167140c73fbc';

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { data: rows, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('business_id', BUSINESS_ID);
  if (error) throw error;

  console.log(`Found ${rows.length} subscription row(s) for business ${BUSINESS_ID}:`);
  rows.forEach(r => console.log(`  ${r.id}  status=${r.status}  start=${r.start_date}  end=${r.end_date}`));

  const activeRows = rows.filter(r => r.status === 'active');
  if (activeRows.length !== 2 || !activeRows.some(r => r.id === KEEP_ACTIVE_ID) || !activeRows.some(r => r.id === CANCEL_ID)) {
    console.error('State no longer matches expectations (expected exactly rows', KEEP_ACTIVE_ID, 'and', CANCEL_ID, 'both active). Aborting — re-check manually.');
    process.exit(1);
  }

  console.log(`\nPlan: set subscriptions.status = 'cancelled' for ${CANCEL_ID}, keep ${KEEP_ACTIVE_ID} active.`);

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    process.exit(0);
  }

  const { error: updateErr } = await supabase
    .from('subscriptions')
    .update({ status: 'cancelled' })
    .eq('id', CANCEL_ID);
  if (updateErr) throw updateErr;
  console.log(`Updated ${CANCEL_ID} -> cancelled`);

  await subscriptionService.invalidateSubscriptionCache(BUSINESS_ID);

  const { data: business, error: bizErr } = await supabase
    .from('businesses').select('phone_number_id').eq('id', BUSINESS_ID).maybeSingle();
  if (bizErr) throw bizErr;
  if (business?.phone_number_id) {
    await tenantService.invalidateTenantCache(business.phone_number_id);
    console.log(`Invalidated tenant cache for phoneNumberId ${business.phone_number_id}`);
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
