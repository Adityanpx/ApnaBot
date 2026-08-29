// Graph-based booking engine — replacement for booking.service.js's
// session.step/session.fields (splice-array) model, walking flow_nodes/
// flow_edges instead. See the planning conversation this was built from
// (findings + step-by-step plan) for the full design rationale; the short
// version:
//   - session state is { currentNodeId, collected, ... }, NOT a
//     materialized array of upcoming fields — conditional edges (tripType
//     branch) and is_computed nodes (vehicle_carousel/rentalPackage) can't
//     be resolved until the fields they depend on are answered, so there's
//     no full path to materialize up front.
//   - servedCities/disabledBookingFields are applied as a LIVE overlay at
//     read time (decision: preserve today's live-from-businesses-row
//     behavior rather than requiring a new flow_nodes sync mechanism as a
//     prerequisite — see migrateFlowGraph.js's baked-in snapshot, which is
//     display-only under this design, never authoritative at runtime for
//     pickupLocation/dropLocation options or is_active).
//   - "advance one step" is a walk, not a single edge hop: an edge can
//     target an inactive node, which must be skipped forward through.
//   - is_computed nodes (vehicle_carousel/rentalPackage) need their live,
//     per-turn generated options remembered in session state between
//     question-sent and answer-received — session.currentNodeComputedOptions
//     — the same role session.fields[session.step].options played before.
//
// SCOPE OF THIS PASS: full generic traversal mechanics (edge-condition
// evaluation, inactive-node skip-forward, servedCities overlay, the
// "Other date"/"Other time"/"Other city" manual-sibling swap, and all three
// vehicle_carousel tap-verification sources — route_fare, distance_estimate,
// rental_package, each with its own stale-reverify + fallback) are
// implemented and verified against real SG Travels data across all four
// scripted branches in verifyBookingGraph.js: One Way (route_fare),
// Local Rental (rental_package), Round Trip (route_fare + the dynamically
// inserted numberOfDays field), and One Way/Pune->Satara (distance_estimate,
// via a business with no route_fare for that pair — enableDistanceFares
// flipped on for the run's duration, distance looked up from a seeded
// Redis cache entry since no GOOGLE_MAPS_API_KEY is configured in dev; both
// reverted/cleaned up after). All four PASS byte-for-byte against the old
// engine, including the fare recompute against live per_km_rate.
//
// Local Rental / no-rental-packages-configured case: the OLD engine still
// asks dropLocation for this sub-case (see booking.service.js's
// processBookingStep, tripType branch — session.fields is left untouched
// when findRentalPackageOptions comes back empty). The migrated graph's
// pickupLocation -> rentalPackage edge is unconditional once tripType
// matches Local Rental, with no edge condition that can express "and no
// packages exist" (edge conditions only test session.collected, never a
// live DB query). Handled at the engine level instead, in
// advanceGraphSession's is_computed branch: when a live rentalPackage
// lookup comes back empty, the session is redirected to the primary
// dropLocation node (resolvePrimarySibling) rather than skipped forward.
// This works generically (not just for SG Travels) because
// migrateFlowGraph.js always gives dropLocation an unconditional edge to
// travelDate regardless of servedCities/rental-package configuration, so
// no separate "resume after detour" bookkeeping is needed — answering
// dropLocation naturally continues the sequence. Verified against real
// data by verifyBookingGraph.js's 5th branch (Local Rental, packages
// temporarily deactivated) — PASSES, dropLocation is collected.

const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { getLocalizedText } = require('../utils/localization');
const logger = require('../utils/logger');
const businessService = require('./business.service');
const bookingService = require('./booking.service');

const MAX_HOPS = 25; // cycle guard for pickNextNodeId's skip-forward walk

// fieldKey -> the literal option value that means "let me type my own
// answer instead", matching processBookingStep's sentinel checks today.
// Kept as a literal map (not a naming convention) per the reviewed plan:
// generalizing this is a legitimate future cleanup, not something to fold
// into a rewrite that's already touching this much surface.
const OTHER_SENTINELS = {
  travelDate: 'Other date',
  pickupTime: 'Other time',
  pickupLocation: 'Other',
  dropLocation: 'Other'
};

/**
 * Load a business's full booking-relevant graph (all flow_nodes/flow_edges
 * rows — reply nodes included; they're simply never referenced by
 * pickNextNodeId's walk except as the fixed entry point in
 * startGraphSession).
 * @param {string} businessId
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
const loadGraph = async (businessId) => {
  const { data: nodeRows, error: nodesErr } = await supabase
    .from('flow_nodes').select('*').eq('business_id', businessId);
  if (nodesErr) throw nodesErr;
  const { data: edgeRows, error: edgesErr } = await supabase
    .from('flow_edges').select('*').eq('business_id', businessId);
  if (edgesErr) throw edgesErr;
  return { nodes: (nodeRows || []).map(toCamelCase), edges: (edgeRows || []).map(toCamelCase) };
};

/**
 * Evaluate a flow_edges.condition against session.collected. null condition
 * always matches (unconditional edge).
 */
const evaluateCondition = (condition, collected) => {
  if (!condition) return true;
  const value = collected[condition.field];
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.in !== undefined) return condition.in.includes(value);
  return false;
};

/**
 * Live disabledBookingFields overlay (decision a) — node.isActive (the
 * migration-time snapshot) is intentionally NOT consulted here. Required
 * fields can never be disabled, mirroring filterActiveBookingFields's
 * defensive required-field guard. Non-'question' nodes (vehicle_carousel/
 * rentalPackage) are always active — disabling only ever applies to
 * authored booking_fields entries.
 */
const isNodeEffectivelyActive = (node, disabledFieldKeys) => {
  if (node.nodeType !== 'question') return true;
  if (!node.fieldKey || !disabledFieldKeys.includes(node.fieldKey)) return true;
  if (node.required === true) return true;
  return false;
};

/**
 * Walk from fromNodeId along the first outgoing edge whose condition
 * matches session.collected, skipping forward through any landed node
 * that's effectively inactive (per the live disabledBookingFields
 * overlay), until an active node is reached or the chain ends (no edge
 * has a matching condition — a terminal node, e.g. vehicle_carousel).
 * @returns {string|null} next node id, or null if the sequence has ended
 */
const pickNextNodeId = (nodes, edges, fromNodeId, collected, disabledFieldKeys) => {
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  let currentId = fromNodeId;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const outgoing = edges
      .filter(e => e.fromNodeId === currentId)
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
    const matched = outgoing.find(e => evaluateCondition(e.condition, collected));
    if (!matched) return null;

    const targetNode = nodeById.get(matched.toNodeId);
    if (!targetNode) {
      logger.error('bookingGraph: flow_edges row references a missing node', { edgeId: matched.id, toNodeId: matched.toNodeId });
      return null;
    }
    if (!isNodeEffectivelyActive(targetNode, disabledFieldKeys)) {
      currentId = targetNode.id;
      continue;
    }
    return targetNode.id;
  }
  logger.error('bookingGraph: pickNextNodeId exceeded MAX_HOPS — possible cycle in flow_edges', { fromNodeId });
  return null;
};

/**
 * A 'question' node's effective fieldType, matching the vocabulary
 * booking.service.js's normalizeOption/localizeField/output contract
 * already expects ('text'/'buttons'/'list'/'vehicle_carousel').
 */
const effectiveFieldType = (node) => (node.nodeType === 'vehicle_carousel' ? 'vehicle_carousel' : node.contentType);

/**
 * Resolve a node's rendered options: live servedCities overlay for
 * pickupLocation/dropLocation (decision a), the live-computed array for
 * is_computed nodes (passed in, never node.options — enforced by the DB
 * check constraint too, but the app-layer must not read node.options for
 * these regardless), otherwise the node's authored options as-is.
 */
const resolveOptionsForNode = (node, servedCities, computedOptions) => {
  if (node.isComputed) {
    return computedOptions || [];
  }
  if ((node.fieldKey === 'pickupLocation' || node.fieldKey === 'dropLocation') &&
      node.contentType === 'list' && servedCities && servedCities.length > 0) {
    return [...servedCities, 'Other'];
  }
  return node.options || [];
};

const nodeToField = (node, servedCities, computedOptions) => ({
  nodeId: node.id,
  fieldKey: node.fieldKey,
  fieldType: effectiveFieldType(node),
  label: node.label,
  labelTranslations: node.labelTranslations,
  summaryLabel: node.summaryLabel,
  required: node.required,
  options: resolveOptionsForNode(node, servedCities, computedOptions)
});

const nodeToFieldLocalized = (node, servedCities, computedOptions, languageCode) =>
  bookingService.localizeField(nodeToField(node, servedCities, computedOptions), languageCode);

/** (business_id, field_key, content_type='text', is_computed=false) sibling lookup. */
const resolveManualSibling = (nodes, fieldKey) =>
  nodes.find(n => n.nodeType === 'question' && n.fieldKey === fieldKey && n.contentType === 'text' && !n.isComputed) || null;

/** (business_id, field_key, is_computed=false, node_type='question') static fallback lookup — used for vehicleType today. */
const resolveStaticFallback = (nodes, fieldKey) =>
  nodes.find(n => n.nodeType === 'question' && n.fieldKey === fieldKey && !n.isComputed) || null;

/**
 * The primary (non-manual-sibling) node for fieldKey — whatever contentType
 * pickupLocation/dropLocation normally render as for this business (list
 * when servedCities is configured, plain text otherwise; see
 * migrateFlowGraph.js's buildLocationNodes). This is the complement of
 * resolveManualSibling: when both a primary and a manual/"Other" sibling
 * exist for fieldKey, this returns the primary one specifically, not
 * whichever non-computed node happens to be found first (resolveStaticFallback
 * would be ambiguous here since dropLocation can have two non-computed
 * siblings). Used for the Local Rental/no-packages detour below.
 */
const resolvePrimarySibling = (nodes, fieldKey) => {
  const candidates = nodes.filter(n => n.nodeType === 'question' && n.fieldKey === fieldKey && !n.isComputed);
  if (candidates.length === 0) return null;
  return candidates.find(n => n.contentType !== 'text') || candidates[0];
};

/**
 * Live options for an is_computed node, for the current collected state.
 * Delegates entirely to booking.service.js's proven fare/rental lookups —
 * no fare math is duplicated here.
 */
const computeLiveOptionsForNode = async (businessId, node, session) => {
  if (node.nodeType === 'vehicle_carousel') {
    if (session.collected.tripType === 'Local Rental') {
      if (session.localRentalUnconfigured) return [];
      const packageKey = session.rentalPackageKeyByLabel && session.rentalPackageKeyByLabel[session.collected.rentalPackage];
      return packageKey ? bookingService.findRentalVehicleCarouselOptions(businessId, packageKey) : [];
    }
    return bookingService.findBestVehicleCarouselOptions(
      businessId,
      session.collected.pickupLocation,
      session.collected.dropLocation,
      session.collected.tripType,
      session.collected.numberOfDays
    );
  }
  if (node.nodeType === 'rentalPackage') {
    const byKey = await bookingService.groupRentalPackagesByKey(businessId);
    return Array.from(byKey.values());
  }
  return [];
};

const buildRentalPackageKeyByLabel = async (businessId) => {
  const byKey = await bookingService.groupRentalPackagesByKey(businessId);
  const labelToKey = {};
  for (const [key, label] of byKey) labelToKey[label] = key;
  return labelToKey;
};

/**
 * Redirect to the static non-computed sibling for fieldKey without walking
 * any edge (mirrors fallbackToGenericVehicleField's in-place swap).
 */
const fallbackToStaticSibling = (nodes, fieldKey, session, servedCities, languageCode) => {
  const fallbackNode = resolveStaticFallback(nodes, fieldKey);
  if (!fallbackNode) {
    throw new Error(`bookingGraph: no static fallback node found for field_key '${fieldKey}'`);
  }
  session.currentNodeId = fallbackNode.id;
  session.currentNodeComputedOptions = null;
  return { session, result: nodeToFieldLocalized(fallbackNode, servedCities, null, languageCode) };
};

/**
 * Stale-tap recovery for vehicle_carousel: re-run the live lookup; if it
 * still has options, refresh currentNodeComputedOptions in place (same
 * node, re-prompt, caller re-fetches session to resend); otherwise fall
 * back to the static sibling. Mirrors rebuildCarouselOrFallback.
 */
const rebuildOrFallback = async (businessId, nodes, currentNode, session, servedCities, languageCode) => {
  const fresh = await computeLiveOptionsForNode(businessId, currentNode, session);
  if (fresh.length > 0) {
    session.currentNodeComputedOptions = fresh;
    return { session, result: 'Sorry, that vehicle is no longer available for this route. Here are the current options:' };
  }
  return fallbackToStaticSibling(nodes, currentNode.fieldKey, session, servedCities, languageCode);
};

/**
 * Start a booking session by following the booking_trigger reply node's
 * single unconditional edge to the first question node.
 * @param {string} businessId
 * @param {string} replyNodeId - the matched reply node's id (today's ruleId)
 * @param {string} [languageCode]
 * @returns {Promise<{session: Object, field: Object}>}
 */
const startGraphSession = async (businessId, replyNodeId, languageCode) => {
  const { nodes, edges } = await loadGraph(businessId);
  const entryEdge = edges.find(e => e.fromNodeId === replyNodeId && !e.condition);
  if (!entryEdge) {
    throw new Error(`bookingGraph: no booking-trigger edge found from reply node ${replyNodeId}`);
  }
  const entryNode = nodes.find(n => n.id === entryEdge.toNodeId);
  if (!entryNode) {
    throw new Error(`bookingGraph: booking-trigger edge targets missing node ${entryEdge.toNodeId}`);
  }

  const business = await businessService.getBusinessById(businessId);
  if (!business) throw new Error('Business not found');

  const session = {
    currentNodeId: entryNode.id,
    collected: {},
    ruleId: replyNodeId,
    startedAt: new Date().toISOString(),
    localRentalUnconfigured: false,
    rentalPackageKeyByLabel: null,
    currentNodeComputedOptions: null
  };

  return { session, field: nodeToFieldLocalized(entryNode, business.servedCities || [], null, languageCode) };
};

/**
 * Process one booking-session turn against the graph.
 * @returns {Promise<{session: Object, result: Object|string|{done:true,collected:Object}}>}
 *   result is: the next field object, a re-prompt/status string (no state
 *   advance), or {done:true, collected} once the sequence terminates —
 *   booking-row creation/confirmation-text formatting is intentionally
 *   NOT done here (kept out of this pure-of-side-effects core), left to
 *   the caller, same split point as the verification script uses.
 */
const advanceGraphSession = async ({ businessId, session, reply, languageCode }) => {
  const { nodes, edges } = await loadGraph(businessId);
  const business = await businessService.getBusinessById(businessId);
  if (!business) throw new Error('Business not found');
  const servedCities = business.servedCities || [];
  const disabledFieldKeys = business.disabledBookingFields || [];

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const currentNode = nodeById.get(session.currentNodeId);
  if (!currentNode) {
    logger.error('bookingGraph: session.currentNodeId not found among flow_nodes', { businessId, currentNodeId: session.currentNodeId });
    return { session, result: null };
  }

  const fieldType = effectiveFieldType(currentNode);
  const trimmedReply = (reply || '').trim();

  if (fieldType === 'vehicle_carousel') {
    const options = session.currentNodeComputedOptions || [];

    if (trimmedReply.toLowerCase() === 'other') {
      return fallbackToStaticSibling(nodes, currentNode.fieldKey, session, servedCities, languageCode);
    }

    const asNumber = Number(trimmedReply);
    const tappedOption = Number.isInteger(asNumber) ? options.find(opt => opt.index === asNumber) : null;
    if (!tappedOption) {
      return { session, result: 'Please tap one of the vehicle options above.' };
    }

    if (tappedOption.source === 'route_fare') {
      const { data: freshRouteFare } = await supabase
        .from('route_fares')
        .select('*, vehicle:vehicles(id, custom_name, is_active, catalog:vehicle_type_catalog(name))')
        .eq('id', tappedOption.routeFareId).maybeSingle();

      const isStale = !freshRouteFare || !freshRouteFare.is_active ||
        !freshRouteFare.vehicle || !freshRouteFare.vehicle.is_active;

      if (isStale) {
        return rebuildOrFallback(businessId, nodes, currentNode, session, servedCities, languageCode);
      }

      session.collected.vehicleId = freshRouteFare.vehicle.id;
      session.collected.vehicleName = freshRouteFare.vehicle.custom_name || freshRouteFare.vehicle.catalog.name;
      session.collected.vehicleFare = freshRouteFare.fare;
      session.collected.routeFareId = freshRouteFare.id;
      session.collected.fareSource = 'route_fare';
      session.collected[currentNode.fieldKey] = session.collected.vehicleName;
    } else if (tappedOption.source === 'distance_estimate') {
      const { data: freshVehicle } = await supabase
        .from('vehicles')
        .select('*, catalog:vehicle_type_catalog(name, photo_url, seats)')
        .eq('id', tappedOption.vehicleId).maybeSingle();

      const isStale = !freshVehicle || !freshVehicle.is_active ||
        freshVehicle.per_km_rate === null || freshVehicle.per_km_rate === undefined;

      if (isStale) {
        return rebuildOrFallback(businessId, nodes, currentNode, session, servedCities, languageCode);
      }

      const daTotal = tappedOption.driverDaIncluded ? tappedOption.driverDaTotal : 0;
      session.collected.vehicleId = freshVehicle.id;
      session.collected.vehicleName = freshVehicle.custom_name || freshVehicle.catalog.name;
      session.collected.vehicleFare = Math.round((tappedOption.distanceKm * freshVehicle.per_km_rate) / 10) * 10 + daTotal;
      session.collected.fareSource = 'distance_estimate';
      session.collected.distanceKm = Math.round(tappedOption.distanceKm * 10) / 10;
      if (daTotal > 0) {
        session.collected.driverDaTotal = daTotal;
        session.collected.driverDaPerDay = tappedOption.driverDaPerDay;
        session.collected.driverDaDays = tappedOption.driverDaDays;
      }
      session.collected[currentNode.fieldKey] = session.collected.vehicleName;
    } else if (tappedOption.source === 'rental_package') {
      const { data: freshRentalPackage } = await supabase
        .from('rental_packages')
        .select('*, vehicle:vehicles(id, custom_name, is_active, catalog:vehicle_type_catalog(name))')
        .eq('id', tappedOption.rentalPackageId).maybeSingle();

      const isStale = !freshRentalPackage || !freshRentalPackage.is_active ||
        !freshRentalPackage.vehicle || !freshRentalPackage.vehicle.is_active;

      if (isStale) {
        return rebuildOrFallback(businessId, nodes, currentNode, session, servedCities, languageCode);
      }

      session.collected.vehicleId = freshRentalPackage.vehicle.id;
      session.collected.vehicleName = freshRentalPackage.vehicle.custom_name || freshRentalPackage.vehicle.catalog.name;
      session.collected.vehicleFare = freshRentalPackage.price;
      session.collected.rentalPackageId = freshRentalPackage.id;
      session.collected.fareSource = 'rental_package';
      session.collected.extraKmRate = freshRentalPackage.extra_km_rate;
      session.collected.extraHrRate = freshRentalPackage.extra_hr_rate;
      session.collected[currentNode.fieldKey] = session.collected.vehicleName;
    } else {
      throw new Error(`bookingGraph: unknown vehicle_carousel option source '${tappedOption.source}'`);
    }
  } else if (fieldType === 'buttons' || fieldType === 'list') {
    const rawOptions = resolveOptionsForNode(currentNode, servedCities, session.currentNodeComputedOptions);
    const options = rawOptions.map(bookingService.normalizeOption);

    let resolvedOption = null;
    const asNumber = Number(trimmedReply);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
      resolvedOption = options[asNumber - 1];
    }
    if (!resolvedOption) {
      resolvedOption = options.find(opt =>
        opt.label.toLowerCase() === trimmedReply.toLowerCase() ||
        opt.value.toLowerCase() === trimmedReply.toLowerCase() ||
        Object.values(opt.labelTranslations || {}).some(
          translated => (translated || '').toLowerCase() === trimmedReply.toLowerCase()
        )
      ) || null;
    }

    if (!resolvedOption) {
      const localizedLabels = options.map(opt => getLocalizedText(opt, 'label', languageCode));
      return { session, result: 'Please choose one of: ' + localizedLabels.join(', ') };
    }

    if (OTHER_SENTINELS[currentNode.fieldKey] === resolvedOption.value) {
      const siblingNode = resolveManualSibling(nodes, currentNode.fieldKey);
      if (!siblingNode) {
        logger.error('bookingGraph: sentinel option matched but no manual sibling node exists', { businessId, fieldKey: currentNode.fieldKey });
      } else {
        session.currentNodeId = siblingNode.id;
        session.currentNodeComputedOptions = null;
        return { session, result: nodeToFieldLocalized(siblingNode, servedCities, null, languageCode) };
      }
    }

    session.collected[currentNode.fieldKey] = currentNode.fieldKey === 'travelDate'
      ? bookingService.resolveTravelDateOption(resolvedOption.value)
      : resolvedOption.value;
  } else {
    session.collected[currentNode.fieldKey] = trimmedReply;
  }

  // ---- advance ----
  const nextNodeId = pickNextNodeId(nodes, edges, currentNode.id, session.collected, disabledFieldKeys);
  if (nextNodeId === null) {
    return { session, result: { done: true, collected: session.collected } };
  }

  let nextNode = nodeById.get(nextNodeId);

  if (nextNode.isComputed) {
    let computed = await computeLiveOptionsForNode(businessId, nextNode, session);

    if (computed.length === 0) {
      if (nextNode.nodeType === 'vehicle_carousel') {
        return fallbackToStaticSibling(nodes, nextNode.fieldKey, session, servedCities, languageCode);
      }
      // rentalPackage with no packages configured — the OLD engine leaves
      // dropLocation in session.fields untouched for this sub-case (see
      // booking.service.js's tripType branch), so this detours through the
      // primary dropLocation node before continuing, rather than skipping
      // it forward like an inactive node. dropLocation's own outgoing edge
      // (unconditional, per migrateFlowGraph.js) already carries the
      // session on to travelDate once answered — no separate "resume after
      // detour" bookkeeping needed.
      session.localRentalUnconfigured = true;
      const dropLocationNode = resolvePrimarySibling(nodes, 'dropLocation');
      if (!dropLocationNode) {
        throw new Error('bookingGraph: no dropLocation node found for Local Rental no-packages detour');
      }
      session.currentNodeId = dropLocationNode.id;
      session.currentNodeComputedOptions = null;
      return { session, result: nodeToFieldLocalized(dropLocationNode, servedCities, null, languageCode) };
    }

    session.currentNodeId = nextNode.id;
    session.currentNodeComputedOptions = computed;
    if (nextNode.nodeType === 'rentalPackage') {
      session.rentalPackageKeyByLabel = await buildRentalPackageKeyByLabel(businessId);
    }
    return { session, result: nodeToFieldLocalized(nextNode, servedCities, computed, languageCode) };
  }

  session.currentNodeId = nextNode.id;
  session.currentNodeComputedOptions = null;
  return { session, result: nodeToFieldLocalized(nextNode, servedCities, null, languageCode) };
};

module.exports = {
  loadGraph,
  pickNextNodeId,
  startGraphSession,
  advanceGraphSession
};
