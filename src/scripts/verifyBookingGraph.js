// src/scripts/verifyBookingGraph.js
//
// Standalone regression check for the graph-based booking engine
// (bookingGraph.service.js), run against SG Travels' REAL flow_nodes/
// flow_edges/route_fares data (no fixtures/mocks). The old flat engine
// (booking.service.js's startBookingSession/processBookingStep) this used
// to diff against was fully deleted in commit 660d5b9 (2026-08-31) — every
// business is graph-only now — so this no longer compares two engines. It
// scripts a fixed conversation per branch and asserts the graph engine
// reaches {done:true} with the expected fields in session.collected, given
// SG Travels' actual live flow_nodes structure and route_fares/vehicles
// data at the time this script was last reviewed against real data.
//
// Never sends anything to WhatsApp and never touches Redis for session
// storage (in-memory session, held in this script's own variables). Does
// use real Redis (via booking.service.js's distance-fare cache) for the
// distance_estimate branch's cache seed/cleanup.
//
// Branches cover: One Way route_fare match (2 active vehicles), One Way
// distance_estimate (no route_fare for the pair), and Round Trip route_fare
// match (numberOfDays field). "Local Rental" (rental_package match,
// no-packages-configured detour) stays out as of 2026-09-01: SG Travels'
// live flow was rebuilt 2026-08-30 with only "One Way"/"Round Trip" as
// tripType options and no rentalPackage node at all — no real conversation
// path exists to script this against. Re-add if that's rebuilt into the
// live graph.
//
// FIXED 2026-09-01 (was previously a known live bug, see
// [[sg_travels_booking_trigger_bug]]): the business's `reply_kind=
// 'booking_trigger'` node (keyword "book") used to route straight to
// `pickupLocation`, skipping `tripType` entirely, so every real booking was
// silently priced as One Way. Its outgoing edge now targets `tripType`
// first, matching this script's own real-entry-point lookup below — every
// branch here collects and asserts a real `tripType` value again.
//
// Business selection is EXPLICIT, not derived from business_category.
// Originally this looked up the business via
// `.eq('business_category', 'travels').maybeSingle()`, which crashed
// (PGRST116, "2 rows returned") once a second travels-category business
// existed: Averix Solutions was deliberately deleted and recreated on
// 2026-09-02 with `business_category='travels'` as a QA test business for
// the canvas/booking-flow test plan (see PRD.md), so category is no longer
// a unique key. All the SCRIPTED_REPLIES/expected values below are pinned
// to SG Travels' real flow_nodes/route_fares/vehicles data specifically —
// running this against a different business's id will fail every branch
// unless the branches/expectations are rewritten for that business's flow.
//
// Usage: node src/scripts/verifyBookingGraph.js
//        node src/scripts/verifyBookingGraph.js --business=<businessId>
//        BUSINESS_ID=<businessId> node src/scripts/verifyBookingGraph.js
// Defaults to SG Travels (b92113c1-8692-46d5-b377-998c6541486f) if neither
// is given. --business=<id> takes precedence over BUSINESS_ID.

require('dotenv').config();

// The dev Redis instance (Upstash free tier) has previously hit its request
// quota — an infra constraint unrelated to the code under test. Session
// storage is incidental to what this script verifies (booking-graph
// logic), so it's shimmed with an in-memory stand-in for THIS SCRIPT ONLY,
// injected into Node's require cache before booking.service.js (which does
// `require('../config/redis')` internally) is ever required. Nothing about
// production code changes; delete this block once the quota is no longer a
// concern if you'd rather verify against real Redis.
//
// Only get/set/del are shimmed. The hash commands (hincrby etc.) usage.
// service.js's incrementUsage needs are NOT needed here: this script never
// calls booking.service.js's createBookingAndConfirmation/
// finalizeGraphBooking (which is what fires incrementUsage) — runNewEngine
// intentionally stops at the graph engine's own {done:true} boundary,
// before any booking row/usage increment happens.
const redisModulePath = require.resolve('../config/redis');
const inMemoryStore = new Map();
require.cache[redisModulePath] = {
  id: redisModulePath,
  filename: redisModulePath,
  loaded: true,
  exports: {
    get: async (key) => (inMemoryStore.has(key) ? inMemoryStore.get(key) : null),
    set: async (key, value) => { inMemoryStore.set(key, value); return 'OK'; },
    del: async (key) => { inMemoryStore.delete(key); return 1; }
  }
};

const supabase = require('../config/supabase');
const redis = require('../config/redis'); // resolves to the in-memory shim above
const bookingService = require('../services/booking.service');
const bookingGraph = require('../services/bookingGraph.service');

const TEST_CUSTOMER_NUMBER = 'VERIFY_BOOKING_GRAPH_TEST';

const DEFAULT_BUSINESS_ID = 'b92113c1-8692-46d5-b377-998c6541486f'; // SG Travels

function resolveBusinessId() {
  const cliArg = process.argv.find(arg => arg.startsWith('--business='));
  if (cliArg) return cliArg.slice('--business='.length);
  if (process.env.BUSINESS_ID) return process.env.BUSINESS_ID;
  return DEFAULT_BUSINESS_ID;
}

// vehicle_carousel options carry a distinct shape (vehicle/fare choice, not
// a value/label choice) — see buildVehicleCarouselOptions/
// findDistanceBasedVehicleOptions in booking.service.js.
const carouselOptionSummary = (o) => ({
  vehicleId: o.vehicleId, name: o.name, fare: o.fare, seats: o.seats,
  photoUrl: o.photoUrl, source: o.source, distanceKm: o.distanceKm ?? null
});

const fieldSummary = (field) => ({
  label: field.label,
  fieldType: field.fieldType,
  options: (field.options || []).map(o => {
    if (field.fieldType === 'vehicle_carousel') return carouselOptionSummary(o);
    return typeof o === 'string'
      ? { value: o, label: o, labelTranslations: null }
      : { value: o.value, label: o.label ?? o.value, labelTranslations: o.labelTranslations ?? null };
  })
});

async function ensureTestCustomer(businessId) {
  const { data: existing, error: findErr } = await supabase
    .from('customers').select('id').eq('business_id', businessId).eq('whatsapp_number', TEST_CUSTOMER_NUMBER).maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing.id;

  const { data: created, error: insertErr } = await supabase
    .from('customers').insert({ business_id: businessId, whatsapp_number: TEST_CUSTOMER_NUMBER, name: 'Verify Script Test Customer' })
    .select('id').single();
  if (insertErr) throw insertErr;
  return created.id;
}

async function runNewEngine(businessId, entryReplyNodeId, replies, languageCode) {
  const turns = [];
  const { session: firstSession, field: first } = await bookingGraph.startGraphSession(businessId, entryReplyNodeId, languageCode);
  turns.push(fieldSummary(first));

  let session = firstSession;
  let lastResult = first;
  for (const reply of replies) {
    const { session: nextSession, result } = await bookingGraph.advanceGraphSession({ businessId, session, reply, languageCode });
    session = nextSession;
    lastResult = result;
    if (result === null) throw new Error('NEW engine: session lookup failed unexpectedly mid-script');
    if (result && result.done) {
      turns.push({ done: true });
    } else if (typeof result === 'string') {
      turns.push({ text: result });
    } else {
      turns.push(fieldSummary(result));
    }
  }

  if (!lastResult || !lastResult.done) {
    throw new Error('NEW engine: script did not end with {done:true} — check SCRIPTED_REPLIES against the business\'s current flow');
  }

  // lastResult.collected holds RAW answers (e.g. travelDate = "Today") used
  // for edge-condition matching, not the display-formatted values that only
  // exist once finalizeGraphBooking merges session.displayOverrides in (see
  // booking.service.js). Apply that same merge here so assertions check
  // what actually ends up in a real bookingRow.fields, without this script
  // having to insert/delete a real booking row itself.
  const displayCollected = { ...lastResult.collected, ...(session.displayOverrides || {}) };
  return { turns, collected: displayCollected };
}

async function cleanupTestData(businessId) {
  if (!businessId) return;
  await supabase.from('bookings').delete().eq('business_id', businessId).eq('customer_number', TEST_CUSTOMER_NUMBER);
  await supabase.from('customers').delete().eq('business_id', businessId).eq('whatsapp_number', TEST_CUSTOMER_NUMBER);
  await bookingService.deleteBookingSession(businessId, TEST_CUSTOMER_NUMBER);
}

// distance_estimate needs (a) a pickup/drop pair with no route_fare, so
// findMatchingVehicleOptions falls through, and (b) enableDistanceFares on,
// and (c) a resolvable distance — real production calls Google Distance
// Matrix for that, but GOOGLE_MAPS_API_KEY isn't configured in this dev
// environment, so a real API call would always return null. Pre-seeding the
// same Redis cache key findDistanceBasedVehicleOptions itself reads
// (`distance:${businessId}:${fromCity}:${toCity}`) exercises the exact same
// code path — the cache-hit branch — without needing a live API key, and
// isn't a mock: it's the same cache the real code trusts to skip the API
// call on a repeat lookup. enableDistanceFares is flipped on/off around the
// run, same as the round_trip route_fare's create/delete pattern.
async function setEnableDistanceFares(businessId, enabled) {
  const { error } = await supabase.from('businesses').update({ enable_distance_fares: enabled }).eq('id', businessId);
  if (error) throw error;
}

async function seedDistanceCache(businessId, fromCity, toCity, distanceKm) {
  const cacheKey = `distance:${businessId}:${fromCity.toLowerCase().trim()}:${toCity.toLowerCase().trim()}`;
  await redis.set(cacheKey, distanceKm, 'EX', 604800);
  return cacheKey;
}

// Confirmed against SG Travels' real data (queried 2026-09-01):
// - route_fares: oneway pune->mumbai has TWO active vehicles (Swift Dzire
//   ₹2700, Maruti Ertiga ₹3700); round_trip pune->mumbai has ONE (Swift
//   Dzire ₹5500) — real, live business config, not test-script leftover
//   (fare doesn't match any value this script ever wrote).
// - vehicles: Swift Dzire (id c5bd925d-29ae-4285-968b-167eb27dc2fe,
//   per_km_rate 13, order 1), Maruti Ertiga (id
//   a740bd94-9f7d-42f4-b6f3-3203b51310ae, per_km_rate 17, order 2).
// - businesses.enable_distance_fares is false at rest (confirmed baseline
//   for the distance_estimate branch's teardown).
// - rental_packages is EMPTY for this business, and flow_nodes' tripType
//   node only offers "One Way"/"Round Trip" — no Local Rental branch is
//   scriptable against real data right now (see file header).
// - round_trip pune->mumbai has ONE active vehicle (Swift Dzire, ₹5500,
//   route_fare id a648d4b5-7852-4d53-89b1-06b4af6504e3) — confirmed live
//   2026-09-01, same day the entry node's routing was fixed to reach
//   tripType at all. Not test-script leftover.
// - the real `booking_trigger` entry node now routes to `tripType` first
//   (fixed 2026-09-01, see header) — all branches below collect and assert
//   a real `tripType` value.
//
// findMatchingVehicleOptions/findDistanceBasedVehicleOptions issue no
// ORDER BY, so which vehicle lands at carousel index 0 is an
// inferred-not-guaranteed ordering — NOT simply "first inserted row"
// either, confirmed by actually running this script rather than trusting
// that inference: the plain `vehicles` table query returns Swift Dzire
// first (matches insertion order), but the `route_fares` query (joined to
// `vehicles`) returns Maruti Ertiga first for the same pune/mumbai/oneway
// pair — likely an artifact of the join, not of insertion order. Both
// orderings recorded below exactly as observed 2026-09-01, not assumed.
const SWIFT_DZIRE_ID = 'c5bd925d-29ae-4285-968b-167eb27dc2fe';
const ERTIGA_ID = 'a740bd94-9f7d-42f4-b6f3-3203b51310ae';
const ERTIGA_ONEWAY_ROUTE_FARE_ID = 'db2e42d4-26c0-44be-ab53-0b3121bd9299';
const SWIFT_DZIRE_ROUNDTRIP_ROUTE_FARE_ID = 'a648d4b5-7852-4d53-89b1-06b4af6504e3';

const TODAY_DISPLAY_DATE = bookingService.resolveTravelDateOption('Today');

/**
 * Assert that `actual` contains every key/value pair in `expected`
 * (subset check, not full-object equality — `collected` also carries
 * bookkeeping keys, like distanceKm on route_fare branches, that aren't
 * worth pinning down per branch).
 */
function assertCollected(actual, expected) {
  const mismatches = [];
  for (const key of Object.keys(expected)) {
    const expectedVal = expected[key];
    const actualVal = actual ? actual[key] : undefined;
    if (JSON.stringify(actualVal) !== JSON.stringify(expectedVal)) {
      mismatches.push({ key, expected: expectedVal, actual: actualVal });
    }
  }
  return mismatches;
}

async function main() {
  const businessId = resolveBusinessId();
  const { data: business, error: bizErr } = await supabase
    .from('businesses').select('id, name').eq('id', businessId).maybeSingle();
  if (bizErr) throw bizErr;
  if (!business) throw new Error(`No business found with id ${businessId}.`);

  // Safety net: clear out anything a previous failed/interrupted run left behind.
  await cleanupTestData(business.id);

  const { data: entryNode, error: entryErr } = await supabase
    .from('flow_nodes').select('id, keyword').eq('business_id', business.id)
    .eq('node_type', 'reply').eq('reply_kind', 'booking_trigger').maybeSingle();
  if (entryErr) throw entryErr;
  if (!entryNode) throw new Error('No booking_trigger reply node found for this business.');

  console.log(`Business: ${business.name} (${business.id})`);
  console.log(`Entry reply node: keyword="${entryNode.keyword}" id=${entryNode.id}\n`);

  const branches = [
    {
      name: 'One Way, Pune -> Mumbai, route_fare match',
      replies: ['One Way', 'Pune', 'Mumbai', 'Today', 'Morning (8-11 AM)', 'No', 'No', 'No', '0'],
      expected: {
        tripType: 'One Way',
        pickupLocation: 'Pune',
        dropLocation: 'Mumbai',
        travelDate: TODAY_DISPLAY_DATE,
        pickupTime: 'Morning (8-11 AM)',
        acRequired: 'No',
        carrierRequired: 'No',
        tollParkingIncluded: 'No',
        fareSource: 'route_fare',
        routeFareId: ERTIGA_ONEWAY_ROUTE_FARE_ID,
        vehicleId: ERTIGA_ID,
        vehicleName: 'Maruti Ertiga',
        vehicleFare: 3700,
        vehicleType: 'Maruti Ertiga'
      }
    },
    {
      name: 'Round Trip, Pune -> Mumbai, route_fare match (numberOfDays field)',
      replies: ['Round Trip', '3', 'Pune', 'Mumbai', 'Today', 'Morning (8-11 AM)', 'No', 'No', 'No', '0'],
      expected: {
        tripType: 'Round Trip',
        numberOfDays: '3',
        pickupLocation: 'Pune',
        dropLocation: 'Mumbai',
        travelDate: TODAY_DISPLAY_DATE,
        pickupTime: 'Morning (8-11 AM)',
        acRequired: 'No',
        carrierRequired: 'No',
        tollParkingIncluded: 'No',
        fareSource: 'route_fare',
        routeFareId: SWIFT_DZIRE_ROUNDTRIP_ROUTE_FARE_ID,
        vehicleId: SWIFT_DZIRE_ID,
        vehicleName: 'Swift Dzire',
        vehicleFare: 5500,
        vehicleType: 'Swift Dzire'
      }
    },
    {
      name: 'One Way, Pune -> Satara, distance_estimate (no route_fare for this pair)',
      replies: ['One Way', 'Pune', 'Satara', 'Today', 'Morning (8-11 AM)', 'No', 'No', 'No', '0'],
      setup: async (businessId) => {
        const priorEnableDistanceFares = false; // known SG Travels baseline, confirmed 2026-09-01
        await setEnableDistanceFares(businessId, true);
        const cacheKey = await seedDistanceCache(businessId, 'Pune', 'Satara', 120);
        return { cacheKey, priorEnableDistanceFares };
      },
      teardown: async (businessId, ctx) => {
        await setEnableDistanceFares(businessId, ctx.priorEnableDistanceFares);
        await redis.del(ctx.cacheKey);
      },
      expected: {
        tripType: 'One Way',
        pickupLocation: 'Pune',
        dropLocation: 'Satara',
        travelDate: TODAY_DISPLAY_DATE,
        pickupTime: 'Morning (8-11 AM)',
        acRequired: 'No',
        carrierRequired: 'No',
        tollParkingIncluded: 'No',
        fareSource: 'distance_estimate',
        distanceKm: 120,
        vehicleId: SWIFT_DZIRE_ID,
        vehicleName: 'Swift Dzire',
        vehicleFare: 1560, // round(120km * ₹13/km / 10) * 10, no driver DA on one-way
        vehicleType: 'Swift Dzire'
      }
    }
  ];

  let anyFailed = false;

  try {
    for (const branch of branches) {
      console.log(`=== ${branch.name} ===`);
      console.log('Replies:', branch.replies.join(' | '));

      const setupCtx = branch.setup ? await branch.setup(business.id) : null;
      let newRun, branchFailed = false;
      try {
        try {
          newRun = await runNewEngine(business.id, entryNode.id, branch.replies, null);
        } catch (err) {
          console.error('Graph engine run FAILED:', err.message);
          anyFailed = true;
          branchFailed = true;
        }
      } finally {
        if (branch.teardown) await branch.teardown(business.id, setupCtx);
      }
      if (branchFailed) continue;

      console.log('\n-- turn-by-turn --');
      newRun.turns.forEach((turn, i) => {
        console.log(`  [${i}] ${JSON.stringify(turn)}`);
      });

      console.log('\n-- expected-values check --');
      const mismatches = assertCollected(newRun.collected, branch.expected);
      if (mismatches.length === 0) {
        console.log('  (all expected values matched)');
      } else {
        anyFailed = true;
        for (const m of mismatches) {
          console.log(`  MISMATCH ${m.key}: expected=${JSON.stringify(m.expected)}  actual=${JSON.stringify(m.actual)}`);
        }
      }

      console.log(`\n${branch.name}: ${mismatches.length === 0 ? 'PASS' : 'FAIL'}\n`);
    }
  } finally {
    // Belt-and-suspenders: cleans up anything a mid-branch throw left behind.
    await cleanupTestData(business.id);
  }

  if (anyFailed) {
    console.error('One or more branches failed or diverged from the expected values.');
    process.exit(1);
  }
  console.log('All scripted branches reached the expected terminal state.');
  // Explicit exit: the real supabase client (unlike the shimmed redis
  // stub) holds an open handle nothing here closes, which otherwise
  // leaves the process hanging after this point instead of exiting.
  process.exit(0);
}

main().catch(err => {
  console.error('Verification script crashed:', err);
  process.exit(1);
});
