// src/scripts/setAverixGraphEngine.js
//
// One-time cutover: flips Averix Solutions (business_id =
// 6e918384-2a7e-4342-8ab4-2b9cecbe791d) from booking_engine = 'legacy' to
// 'graph'. Direct write to a real business row.
//
// Dry-run by default (prints current state + counts, writes nothing).
// Pass --confirm to execute the update and flush the relevant Redis caches
// (rules:{businessId}, tenant:{phoneNumberId}).
//
// Usage:
//   node src/scripts/setAverixGraphEngine.js            (dry run)
//   node src/scripts/setAverixGraphEngine.js --confirm   (executes)

require('dotenv').config();
const supabase = require('../config/supabase');
const redis = require('../config/redis');

const BUSINESS_ID = '6e918384-2a7e-4342-8ab4-2b9cecbe791d';
const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { data: business, error: bizErr } = await supabase
    .from('businesses')
    .select('id, name, booking_engine, business_category, phone_number_id')
    .eq('id', BUSINESS_ID)
    .maybeSingle();
  if (bizErr) throw bizErr;
  if (!business) {
    console.error(`No business found with id ${BUSINESS_ID}. Aborting.`);
    process.exit(1);
  }

  console.log('Current row:');
  console.log(`  id:               ${business.id}`);
  console.log(`  name:             ${business.name}`);
  console.log(`  booking_engine:   ${business.booking_engine}`);
  console.log(`  business_category:${business.business_category}`);
  console.log(`  phone_number_id:  ${business.phone_number_id || '(none)'}`);

  const { count: nodeCount, error: nodeErr } = await supabase
    .from('flow_nodes').select('id', { count: 'exact', head: true }).eq('business_id', BUSINESS_ID);
  if (nodeErr) throw nodeErr;
  const { count: edgeCount, error: edgeErr } = await supabase
    .from('flow_edges').select('id', { count: 'exact', head: true }).eq('business_id', BUSINESS_ID);
  if (edgeErr) throw edgeErr;
  const { data: flowRow, error: flowErr } = await supabase
    .from('business_flows').select('business_id').eq('business_id', BUSINESS_ID).maybeSingle();
  if (flowErr) throw flowErr;

  console.log(`\nflow_nodes count:      ${nodeCount || 0}`);
  console.log(`flow_edges count:      ${edgeCount || 0}`);
  console.log(`business_flows row exists: ${flowRow ? 'yes' : 'no'} (informational only)`);

  if ((nodeCount || 0) !== 0 || (edgeCount || 0) !== 0) {
    console.error('\nflow_nodes/flow_edges are NOT empty for this business — stopping. This changes the situation; do not proceed without review.');
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    process.exit(0);
  }

  const { error: updateErr } = await supabase
    .from('businesses')
    .update({ booking_engine: 'graph' })
    .eq('id', BUSINESS_ID);
  if (updateErr) throw updateErr;
  console.log("\nUpdated booking_engine to 'graph'.");

  await redis.del(`rules:${BUSINESS_ID}`);
  console.log(`Flushed rules:${BUSINESS_ID}`);
  if (business.phone_number_id) {
    await redis.del(`tenant:${business.phone_number_id}`);
    console.log(`Flushed tenant:${business.phone_number_id}`);
  } else {
    console.log('No phone_number_id — skipped tenant:* cache flush.');
  }

  const { data: after, error: afterErr } = await supabase
    .from('businesses')
    .select('id, name, booking_engine, business_category')
    .eq('id', BUSINESS_ID)
    .maybeSingle();
  if (afterErr) throw afterErr;
  console.log('\nVerification — row after update:');
  console.log(`  booking_engine: ${after.booking_engine}`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
