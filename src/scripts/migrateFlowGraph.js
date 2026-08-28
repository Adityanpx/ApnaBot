// src/scripts/migrateFlowGraph.js
//
// One-time data migration: reads the travels business's CURRENT `rules`
// rows and business_flows.booking_fields, and produces the equivalent
// flow_nodes/flow_edges rows for the new graph engine (see migration
// 20260829140000_flow_nodes_edges.sql for the schema and its node_type/
// is_computed/id-scheme documentation — read that file's header before
// touching this script).
//
// Scope: the single 'travels'-category business (found the same
// "refuse to guess" way as resetSgTravelsFlow.js, but keyed off
// business_category rather than name — the real business's name doesn't
// actually contain "SG Travels"). Does NOT touch `rules` or
// `business_flows` — those stay as-is until the engine and CRUD surface
// are migrated over and everything is confirmed working end-to-end.
//
// What gets built, and why:
//   - One 'reply' node per `rules` row, carrying its keyword/matchType/
//     hindiAliases/reply/replyImageUrl/replyType/isActive/triggerCount.
//     Each button/list-option becomes its own flow_edge (edge.id is what
//     Meta will echo back on tap, per the migration's WhatsApp-id-scheme
//     comment) rather than living on the node.
//   - One edge from every replyType='booking_trigger' reply node to the
//     first booking question node (lowest `order`), replacing the
//     implicit "start booking at fields[0]" behavior in
//     booking.service.js#startBookingSession.
//   - One 'question' node per booking_fields entry, PLUS:
//       - a 'numberOfDays' node, which today only exists as a hardcoded
//         object spliced into session.fields at runtime
//         (processBookingStep, on tripType === 'Round Trip') — it never
//         appears in booking_fields itself.
//       - a is_computed 'vehicle_carousel' node (field_key 'vehicleType',
//         sharing that field_key with the static 'vehicleType' list node
//         per the migration's shared-field_key documentation).
//       - a is_computed 'rentalPackage' node (field_key 'rentalPackage'),
//         reached only on the Local Rental branch.
//       - manual free-text fallback siblings for travelDate, pickupTime,
//         and — only because this business currently has servedCities
//         configured — pickupLocation/dropLocation, matching the "Other
//         date"/"Other time"/"Other" sentinel handling in
//         processBookingStep today. A business with no servedCities would
//         get plain-text pickupLocation/dropLocation and no such sibling;
//         this script handles both shapes, driven by the live data.
//   - Sequence edges wiring the above into the same shape
//     processBookingStep produces via its splice/swap logic today: the
//     tripType branch (pickupLocation -> dropLocation | rentalPackage),
//     the round-trip branch (travelDate -> numberOfDays -> pickupTime,
//     vs. travelDate -> pickupTime directly), then a straight chain
//     through every remaining booking_fields entry in `order`, ending at
//     the vehicle_carousel node. Manual-fallback siblings get the SAME
//     outgoing edges as their authored counterpart (duplicated, not
//     shared) so the traversal engine can walk from either without
//     needing field_key-based edge lookup — see inline comments below.
//   - No edge targets the static 'vehicleType' fallback node, or a manual
//     text sibling — those are found by the engine at runtime via
//     (business_id, field_key, content_type/is_computed), same as the
//     migration file's shared-field_key documentation describes. This
//     script does not attempt to encode "is_computed query came back
//     empty" fallback behavior; that's an engine concern for the
//     booking.service.js rewrite (step 3b), not a data-shape concern.
//   - is_active on question nodes mirrors filterActiveBookingFields:
//     false when the field is in business.disabled_booking_fields AND
//     not required, true otherwise. Every node is still created —
//     dropping disabled fields from the sequence entirely is the
//     traversal engine's job, not this script's.
//
// Dry-run by default (prints what it would create). Pass --confirm to
// execute. Re-running with --confirm replaces this business's existing
// flow_nodes/flow_edges (delete-then-insert), same pattern as
// resetSgTravelsFlow.js.
//
// Usage:
//   node src/scripts/migrateFlowGraph.js            (dry run)
//   node src/scripts/migrateFlowGraph.js --confirm   (executes)
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see src/config/env.js).

require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../config/supabase');

const CONFIRM = process.argv.includes('--confirm');

// Booking fields handled with bespoke branching logic; everything else in
// booking_fields is chained generically in `order`, between pickupTime and
// the vehicle step (today: acRequired, carrierRequired, tollParkingIncluded).
const SPECIAL_FIELD_KEYS = new Set(['tripType', 'pickupLocation', 'dropLocation', 'travelDate', 'pickupTime', 'vehicleType']);

const inferContentType = (field) => {
  if (field.fieldType === 'buttons') return 'buttons';
  if (field.fieldType === 'list') return 'list';
  return 'text';
};

const isFieldDisabled = (field, disabledFieldKeys) =>
  disabledFieldKeys.includes(field.fieldKey) && field.required !== true;

async function main() {
  const { data: candidates, error: findErr } = await supabase
    .from('businesses')
    .select('id, name, business_category, served_cities, disabled_booking_fields')
    .eq('business_category', 'travels');
  if (findErr) throw findErr;

  if (!candidates || candidates.length === 0) {
    console.error("No business found with business_category = 'travels'. Aborting.");
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error("Multiple businesses match business_category = 'travels' — refusing to guess. Candidates:");
    candidates.forEach(b => console.error(`  ${b.id}  ${b.name}`));
    process.exit(1);
  }

  const business = candidates[0];
  const servedCities = business.served_cities || [];
  const disabledFieldKeys = business.disabled_booking_fields || [];
  console.log(`Found business: ${business.name} (${business.id})`);
  console.log(`servedCities: ${JSON.stringify(servedCities)}`);
  console.log(`disabledBookingFields: ${JSON.stringify(disabledFieldKeys)}`);

  const { data: rules, error: rulesErr } = await supabase
    .from('rules').select('*').eq('business_id', business.id).order('created_at');
  if (rulesErr) throw rulesErr;

  const { data: flow, error: flowErr } = await supabase
    .from('business_flows').select('booking_fields').eq('business_id', business.id).maybeSingle();
  if (flowErr) throw flowErr;
  if (!flow || !flow.booking_fields || flow.booking_fields.length === 0) {
    console.error('No business_flows.booking_fields found for this business. Aborting.');
    process.exit(1);
  }
  const sortedFields = [...flow.booking_fields].sort((a, b) => a.order - b.order);

  // Only meaningful once the flow_nodes/flow_edges migration has actually
  // been applied — before that, this query errors (relation does not
  // exist), which is expected and just means "nothing to warn about yet".
  let existingNodeCount = 0;
  const { count: existingNodeCountResult, error: existingNodeCountErr } = await supabase
    .from('flow_nodes').select('id', { count: 'exact', head: true }).eq('business_id', business.id);
  if (!existingNodeCountErr) {
    existingNodeCount = existingNodeCountResult;
  }

  // ---- Build nodes in memory, keyed by a local key for edge-wiring below ----
  // Each node carries a `_key` (local only, stripped before insert) so edges
  // can be described declaratively before real uuids exist.
  const nodes = [];
  const nodeByKey = (key) => nodes.find(n => n._key === key);

  // -- reply nodes, one per rules row --
  const replyNodeByKeyword = new Map();
  for (const rule of rules) {
    const buttons = rule.buttons || [];
    const listOptions = rule.list_options || [];
    const contentType = buttons.length > 0 ? 'buttons' : (listOptions.length > 0 ? 'list' : 'text');
    const key = `reply:${rule.keyword}`;
    nodes.push({
      _key: key,
      business_id: business.id,
      node_type: 'reply',
      keyword: rule.keyword,
      match_type: rule.match_type,
      hindi_aliases: rule.hindi_aliases || [],
      reply_kind: rule.reply_type,
      trigger_count: rule.trigger_count || 0,
      content_type: contentType,
      label: rule.reply,
      label_translations: rule.reply_translations || null,
      image_url: rule.reply_image_url || null,
      is_active: rule.is_active,
      required: false,
      options: [],
      is_computed: false,
      _buttons: buttons,
      _listOptions: listOptions
    });
    replyNodeByKeyword.set(rule.keyword, key);
  }

  // -- question nodes --
  const questionNode = (overrides) => ({
    business_id: business.id,
    node_type: 'question',
    content_type: 'text',
    label_translations: null,
    image_url: null,
    summary_label: null,
    required: false,
    options: [],
    hindi_aliases: [],
    trigger_count: 0,
    is_computed: false,
    is_active: true,
    ...overrides
  });

  const tripTypeField = sortedFields.find(f => f.fieldKey === 'tripType');
  const pickupLocationField = sortedFields.find(f => f.fieldKey === 'pickupLocation');
  const dropLocationField = sortedFields.find(f => f.fieldKey === 'dropLocation');
  const travelDateField = sortedFields.find(f => f.fieldKey === 'travelDate');
  const pickupTimeField = sortedFields.find(f => f.fieldKey === 'pickupTime');
  const vehicleTypeField = sortedFields.find(f => f.fieldKey === 'vehicleType');

  if (!tripTypeField || !pickupLocationField || !dropLocationField || !travelDateField || !pickupTimeField || !vehicleTypeField) {
    console.error('booking_fields is missing one of the expected travels fields (tripType/pickupLocation/dropLocation/travelDate/pickupTime/vehicleType). Aborting — this script assumes the current travels template shape.');
    process.exit(1);
  }

  nodes.push(questionNode({
    _key: 'q:tripType',
    field_key: 'tripType',
    content_type: inferContentType(tripTypeField),
    label: tripTypeField.label,
    summary_label: tripTypeField.summaryLabel,
    required: tripTypeField.required === true,
    order: tripTypeField.order,
    options: tripTypeField.options || [],
    is_active: !isFieldDisabled(tripTypeField, disabledFieldKeys)
  }));

  // pickupLocation / dropLocation: list+Other (with manual sibling) when
  // servedCities is configured, plain text otherwise — matches
  // applyServedCitiesFields' runtime transform, now baked into the node
  // instead of computed per-session. updateServedCities (new engine) will
  // rewrite these nodes' `options` directly instead of this branch.
  const buildLocationNodes = (field, key) => {
    const hasServedCities = servedCities.length > 0;
    const authored = questionNode({
      _key: `q:${key}`,
      field_key: field.fieldKey,
      content_type: hasServedCities ? 'list' : 'text',
      label: field.label,
      summary_label: field.summaryLabel,
      required: field.required === true,
      order: field.order,
      options: hasServedCities ? [...servedCities, 'Other'] : [],
      is_active: !isFieldDisabled(field, disabledFieldKeys)
    });
    nodes.push(authored);
    if (hasServedCities) {
      nodes.push(questionNode({
        _key: `q:${key}_manual`,
        field_key: field.fieldKey,
        content_type: 'text',
        label: field.fieldKey === 'pickupLocation' ? 'Please enter your full pickup address:' : 'Please enter your full drop address:',
        summary_label: field.summaryLabel,
        required: field.required === true,
        order: field.order,
        is_active: !isFieldDisabled(field, disabledFieldKeys)
      }));
    }
  };
  buildLocationNodes(pickupLocationField, 'pickupLocation');
  buildLocationNodes(dropLocationField, 'dropLocation');

  nodes.push(questionNode({
    _key: 'q:travelDate',
    field_key: 'travelDate',
    content_type: inferContentType(travelDateField),
    label: travelDateField.label,
    summary_label: travelDateField.summaryLabel,
    required: travelDateField.required === true,
    order: travelDateField.order,
    options: travelDateField.options || [],
    is_active: !isFieldDisabled(travelDateField, disabledFieldKeys)
  }));
  nodes.push(questionNode({
    _key: 'q:travelDate_manual',
    field_key: 'travelDate',
    content_type: 'text',
    label: 'Please enter the date (DD/MM/YYYY):',
    summary_label: travelDateField.summaryLabel,
    required: travelDateField.required === true,
    order: travelDateField.order,
    is_active: !isFieldDisabled(travelDateField, disabledFieldKeys)
  }));

  // numberOfDays: never in booking_fields — only ever a hardcoded object
  // spliced in at runtime for Round Trip (see processBookingStep).
  nodes.push(questionNode({
    _key: 'q:numberOfDays',
    field_key: 'numberOfDays',
    content_type: 'text',
    label: 'How many days is this round trip?',
    summary_label: 'Days',
    required: true,
    order: travelDateField.order + 0.5,
    is_active: true
  }));

  nodes.push(questionNode({
    _key: 'q:pickupTime',
    field_key: 'pickupTime',
    content_type: inferContentType(pickupTimeField),
    label: pickupTimeField.label,
    summary_label: pickupTimeField.summaryLabel,
    required: pickupTimeField.required === true,
    order: pickupTimeField.order,
    options: pickupTimeField.options || [],
    is_active: !isFieldDisabled(pickupTimeField, disabledFieldKeys)
  }));
  nodes.push(questionNode({
    _key: 'q:pickupTime_manual',
    field_key: 'pickupTime',
    content_type: 'text',
    label: 'Please enter the pickup time:',
    summary_label: pickupTimeField.summaryLabel,
    required: pickupTimeField.required === true,
    order: pickupTimeField.order,
    is_active: !isFieldDisabled(pickupTimeField, disabledFieldKeys)
  }));

  // rentalPackage: is_computed, only reached on the Local Rental branch.
  nodes.push(questionNode({
    _key: 'q:rentalPackage',
    node_type: 'rentalPackage',
    field_key: 'rentalPackage',
    content_type: 'list',
    label: 'Choose your rental package:',
    summary_label: 'Package',
    required: true,
    order: dropLocationField.order,
    is_computed: true,
    is_active: true
  }));

  // Generic chain: every remaining booking_fields entry not special-cased
  // above (today: acRequired, carrierRequired, tollParkingIncluded), in order.
  const genericFields = sortedFields
    .filter(f => !SPECIAL_FIELD_KEYS.has(f.fieldKey))
    .sort((a, b) => a.order - b.order);
  for (const field of genericFields) {
    nodes.push(questionNode({
      _key: `q:${field.fieldKey}`,
      field_key: field.fieldKey,
      content_type: inferContentType(field),
      label: field.label,
      summary_label: field.summaryLabel,
      required: field.required === true,
      order: field.order,
      options: field.options || [],
      is_active: !isFieldDisabled(field, disabledFieldKeys)
    }));
  }

  // vehicleType: static authored fallback (no incoming edge — found via
  // field_key at runtime when vehicle_carousel's live query is empty).
  // NOT an orphan: when booking.service.js's graph traversal is rewritten
  // (step 3b), the vehicle_carousel handler must look this node up by
  // (business_id, field_key: 'vehicleType', is_computed: false) and use it
  // whenever the live route_fares/vehicles query comes back empty — same
  // convention as the manual-fallback siblings above. Cross-reference this
  // comment from that call site when it's written, so the connection is
  // visible from the engine code too, not only from here.
  nodes.push(questionNode({
    _key: 'q:vehicleType',
    field_key: 'vehicleType',
    content_type: inferContentType(vehicleTypeField),
    label: vehicleTypeField.label,
    summary_label: vehicleTypeField.summaryLabel,
    required: vehicleTypeField.required === true,
    order: vehicleTypeField.order,
    options: vehicleTypeField.options || [],
    is_active: !isFieldDisabled(vehicleTypeField, disabledFieldKeys)
  }));
  // vehicle_carousel: is_computed, shares field_key 'vehicleType' with the
  // node above — this IS the primary target (see edge wiring below).
  nodes.push(questionNode({
    _key: 'q:vehicle_carousel',
    node_type: 'vehicle_carousel',
    field_key: 'vehicleType',
    content_type: 'list',
    label: 'Choose your vehicle:',
    summary_label: 'Vehicle',
    required: true,
    order: vehicleTypeField.order,
    is_computed: true,
    is_active: true
  }));

  // ---- Build edges in memory (from-key, to-key, resolved to real ids after insert) ----
  const edges = [];

  // reply-node buttons/list -> edges
  for (const node of nodes.filter(n => n.node_type === 'reply')) {
    for (const button of node._buttons) {
      const targetKey = replyNodeByKeyword.get(button.nextKeyword);
      if (!targetKey) {
        console.warn(`  WARNING: rule "${node.keyword}" has a button targeting unknown keyword "${button.nextKeyword}" — skipping edge.`);
        continue;
      }
      edges.push({ from: node._key, to: targetKey, label: button.title, label_translations: button.titleTranslations || null, condition: null });
    }
    for (const opt of node._listOptions) {
      const targetKey = replyNodeByKeyword.get(opt.nextKeyword);
      if (!targetKey) {
        console.warn(`  WARNING: rule "${node.keyword}" has a list option targeting unknown keyword "${opt.nextKeyword}" — skipping edge.`);
        continue;
      }
      edges.push({ from: node._key, to: targetKey, label: opt.label, description: opt.description || null, condition: null });
    }
    if (node.reply_kind === 'booking_trigger') {
      edges.push({ from: node._key, to: 'q:tripType', condition: null });
    }
  }

  const pickupLocationManualExists = !!nodeByKey('q:pickupLocation_manual');
  const dropLocationManualExists = !!nodeByKey('q:dropLocation_manual');

  // tripType -> pickupLocation (unconditional)
  edges.push({ from: 'q:tripType', to: 'q:pickupLocation', condition: null });

  // pickupLocation (+ manual sibling) -> dropLocation | rentalPackage, by tripType
  const pickupLocationSources = ['q:pickupLocation', ...(pickupLocationManualExists ? ['q:pickupLocation_manual'] : [])];
  for (const src of pickupLocationSources) {
    edges.push({ from: src, to: 'q:dropLocation', condition: { field: 'tripType', in: ['One Way', 'Round Trip'] } });
    edges.push({ from: src, to: 'q:rentalPackage', condition: { field: 'tripType', equals: 'Local Rental' } });
  }

  // dropLocation (+ manual) and rentalPackage all converge on travelDate
  const dropLocationSources = ['q:dropLocation', ...(dropLocationManualExists ? ['q:dropLocation_manual'] : [])];
  for (const src of dropLocationSources) {
    edges.push({ from: src, to: 'q:travelDate', condition: null });
  }
  edges.push({ from: 'q:rentalPackage', to: 'q:travelDate', condition: null });

  // travelDate (+ manual) -> numberOfDays | pickupTime, by tripType
  for (const src of ['q:travelDate', 'q:travelDate_manual']) {
    edges.push({ from: src, to: 'q:numberOfDays', condition: { field: 'tripType', equals: 'Round Trip' } });
    edges.push({ from: src, to: 'q:pickupTime', condition: { field: 'tripType', in: ['One Way', 'Local Rental'] } });
  }
  edges.push({ from: 'q:numberOfDays', to: 'q:pickupTime', condition: null });

  // pickupTime (+ manual) -> first generic field (or straight to vehicle_carousel if none)
  const genericKeys = genericFields.map(f => `q:${f.fieldKey}`);
  const firstAfterPickupTime = genericKeys[0] || 'q:vehicle_carousel';
  for (const src of ['q:pickupTime', 'q:pickupTime_manual']) {
    edges.push({ from: src, to: firstAfterPickupTime, condition: null });
  }

  // chain the generic fields, ending at vehicle_carousel
  for (let i = 0; i < genericKeys.length; i++) {
    const next = genericKeys[i + 1] || 'q:vehicle_carousel';
    edges.push({ from: genericKeys[i], to: next, condition: null });
  }

  // ---- Report ----
  const replyCount = nodes.filter(n => n.node_type === 'reply').length;
  const questionCount = nodes.filter(n => n.node_type === 'question').length;
  const computedCount = nodes.filter(n => n.node_type === 'vehicle_carousel' || n.node_type === 'rentalPackage').length;
  console.log(`\nWould create ${nodes.length} flow_nodes (${replyCount} reply, ${questionCount} question, ${computedCount} computed) and ${edges.length} flow_edges.`);
  if (existingNodeCount > 0) {
    console.log(`NOTE: this business already has ${existingNodeCount} flow_nodes row(s) — --confirm will DELETE them first.`);
  }

  console.log('\n-- Nodes --');
  for (const n of nodes) {
    if (n.node_type === 'reply') {
      console.log(`  [reply] ${n._key}  keyword="${n.keyword}" matchType=${n.match_type} contentType=${n.content_type} replyKind=${n.reply_kind} active=${n.is_active}`);
    } else {
      console.log(`  [${n.node_type}] ${n._key}  field_key=${n.field_key} contentType=${n.content_type} order=${n.order} required=${n.required} isComputed=${n.is_computed} active=${n.is_active}`);
    }
  }

  console.log('\n-- Edges --');
  for (const e of edges) {
    const condStr = e.condition ? ` [if ${JSON.stringify(e.condition)}]` : '';
    const labelStr = e.label ? ` "${e.label}"` : '';
    console.log(`  ${e.from} --${labelStr}${condStr}--> ${e.to}`);
  }

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    process.exit(0);
  }

  // ---- Execute ----
  const { error: delEdgesErr } = await supabase.from('flow_edges').delete().eq('business_id', business.id);
  if (delEdgesErr) throw delEdgesErr;
  const { error: delNodesErr } = await supabase.from('flow_nodes').delete().eq('business_id', business.id);
  if (delNodesErr) throw delNodesErr;
  console.log('Cleared existing flow_nodes/flow_edges for this business (if any).');

  // Client-generated ids (rather than relying on the DB default + matching
  // insert response rows back to input order, which PostgREST does not
  // guarantee for bulk inserts) so edges can reference real ids directly.
  const idByKey = new Map(nodes.map(n => [n._key, crypto.randomUUID()]));
  const nodeRows = nodes.map(({ _key, _buttons, _listOptions, ...row }) => ({ id: idByKey.get(_key), ...row }));
  const { error: insertNodesErr } = await supabase.from('flow_nodes').insert(nodeRows);
  if (insertNodesErr) throw insertNodesErr;

  // display_order = the edge's position within its from_node's outgoing
  // edges, in the order this script already built them above (0-indexed) —
  // not a semantic ranking, just a stable persisted order so
  // getOutgoingEdges doesn't have to rely on created_at for rows inserted
  // in the same batch.
  const displayOrderByFromKey = new Map();
  const edgeRows = edges.map(e => {
    const displayOrder = displayOrderByFromKey.get(e.from) || 0;
    displayOrderByFromKey.set(e.from, displayOrder + 1);

    return {
      business_id: business.id,
      from_node_id: idByKey.get(e.from),
      to_node_id: idByKey.get(e.to),
      label: e.label || null,
      label_translations: e.label_translations || null,
      description: e.description || null,
      condition: e.condition || null,
      display_order: displayOrder
    };
  });
  const { error: insertEdgesErr } = await supabase.from('flow_edges').insert(edgeRows);
  if (insertEdgesErr) throw insertEdgesErr;

  console.log(`\nDone. Created ${nodeRows.length} flow_nodes and ${edgeRows.length} flow_edges for ${business.name}.`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
