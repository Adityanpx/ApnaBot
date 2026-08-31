// src/scripts/fixSgTravelsTripTypeRouting.js
//
// One-time cutover: fixes the SG Travels (business_id
// b92113c1-8692-46d5-b377-998c6541486f) live "book" keyword entry node,
// which currently skips the tripType question entirely (routes straight to
// pickupLocation), silently pricing every real booking as One Way. See
// [[sg_travels_booking_trigger_bug]] memory / investigation done
// 2026-09-01 against real flow_nodes/flow_edges data.
//
// Two changes, both direct writes to real, live rows:
//   1. Retarget flow_edges row 85d5fdd5-cf50-4e72-a2e2-f4dfb130c801
//      (the entry node's only outgoing edge) from pickupLocation to
//      tripType. tripType's own two outgoing edges (already confirmed
//      correctly conditioned: One Way -> pickupLocation, Round Trip ->
//      numberOfDays) then take over routing from there.
//   2. Replace the entry node's placeholder label
//      ("what should i enter here??", no translations) with real
//      customer-facing copy + hi/mr translations.
// Then flushes the rules:{businessId} and tenant:{phoneNumberId} Redis
// caches (pattern verified against setAverixGraphEngine.js), since direct
// writes bypass the app's normal cache invalidation.
//
// Dry-run by default (prints current state, writes nothing). Pass
// --confirm to execute. Precondition-checked: aborts instead of writing if
// live state has drifted from what was confirmed via dry-run in chat on
// 2026-09-01, rather than blindly overwriting.
//
// Usage:
//   node src/scripts/fixSgTravelsTripTypeRouting.js            (dry run)
//   node src/scripts/fixSgTravelsTripTypeRouting.js --confirm   (executes)

require('dotenv').config();
const supabase = require('../config/supabase');
const redis = require('../config/redis');

const BUSINESS_ID = 'b92113c1-8692-46d5-b377-998c6541486f';
const ENTRY_NODE_ID = '07711d12-af9f-4723-ab0b-07e1a12c034f';
const ENTRY_EDGE_ID = '85d5fdd5-cf50-4e72-a2e2-f4dfb130c801';
const TRIPTYPE_NODE_ID = 'c2eeb6cc-5b3e-42ac-b530-38ab30692281';
const OLD_PICKUP_NODE_ID = '36f1d0c0-7bc3-4133-9665-893ea582eac3';

const NEW_LABEL = "Great! Let's get your ride booked. Is this a One Way or Round Trip?";
const NEW_LABEL_TRANSLATIONS = {
  hi: 'बढ़िया! चलिए आपकी बुकिंग शुरू करते हैं। यह वन वे है या राउंड ट्रिप?',
  mr: 'छान! चला तुमची बुकिंग सुरू करूया। ही वन वे आहे की राउंड ट्रिप?'
};

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { data: business, error: bizErr } = await supabase
    .from('businesses').select('id, name, phone_number_id').eq('id', BUSINESS_ID).maybeSingle();
  if (bizErr) throw bizErr;
  if (!business) throw new Error(`No business found with id ${BUSINESS_ID}.`);

  const { data: edge, error: edgeErr } = await supabase
    .from('flow_edges').select('id, from_node_id, to_node_id').eq('id', ENTRY_EDGE_ID).maybeSingle();
  if (edgeErr) throw edgeErr;
  if (!edge) throw new Error(`No flow_edges row found with id ${ENTRY_EDGE_ID}.`);

  const { data: node, error: nodeErr } = await supabase
    .from('flow_nodes').select('id, label, label_translations').eq('id', ENTRY_NODE_ID).maybeSingle();
  if (nodeErr) throw nodeErr;
  if (!node) throw new Error(`No flow_nodes row found with id ${ENTRY_NODE_ID}.`);

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`phone_number_id: ${business.phone_number_id || '(none)'}`);
  console.log('\nCurrent edge:', JSON.stringify(edge));
  console.log('Current node:', JSON.stringify(node));

  if (edge.from_node_id !== ENTRY_NODE_ID || edge.to_node_id !== OLD_PICKUP_NODE_ID) {
    console.error('\nEdge state has drifted from what was confirmed via dry-run — aborting without writing.');
    process.exit(1);
  }
  if (node.label !== 'what should i enter here??' || node.label_translations !== null) {
    console.error('\nNode state has drifted from what was confirmed via dry-run — aborting without writing.');
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    console.log('\nWould set edge.to_node_id ->', TRIPTYPE_NODE_ID);
    console.log('Would set node.label ->', NEW_LABEL);
    console.log('Would set node.label_translations ->', JSON.stringify(NEW_LABEL_TRANSLATIONS));
    process.exit(0);
  }

  const { error: edgeUpdateErr } = await supabase
    .from('flow_edges').update({ to_node_id: TRIPTYPE_NODE_ID }).eq('id', ENTRY_EDGE_ID);
  if (edgeUpdateErr) throw edgeUpdateErr;
  console.log('\nEdge retargeted to tripType.');

  const { error: nodeUpdateErr } = await supabase
    .from('flow_nodes')
    .update({ label: NEW_LABEL, label_translations: NEW_LABEL_TRANSLATIONS })
    .eq('id', ENTRY_NODE_ID);
  if (nodeUpdateErr) throw nodeUpdateErr;
  console.log('Node label + label_translations updated.');

  await redis.del(`rules:${BUSINESS_ID}`);
  console.log(`Flushed rules:${BUSINESS_ID}`);
  if (business.phone_number_id) {
    await redis.del(`tenant:${business.phone_number_id}`);
    console.log(`Flushed tenant:${business.phone_number_id}`);
  } else {
    console.log('No phone_number_id on this business — skipped tenant:* cache flush.');
  }

  console.log('\n=== Verification ===');
  const { data: afterEdge, error: afterEdgeErr } = await supabase
    .from('flow_edges').select('id, from_node_id, to_node_id').eq('id', ENTRY_EDGE_ID).maybeSingle();
  if (afterEdgeErr) throw afterEdgeErr;
  console.log('flow_edges after:', JSON.stringify(afterEdge, null, 2));

  const { data: afterNode, error: afterNodeErr } = await supabase
    .from('flow_nodes').select('id, label, label_translations').eq('id', ENTRY_NODE_ID).maybeSingle();
  if (afterNodeErr) throw afterNodeErr;
  console.log('flow_nodes after:', JSON.stringify(afterNode, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error('Script crashed:', err);
  process.exit(1);
});
