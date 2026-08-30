// src/scripts/verifyBookingGraph.js
//
// Standalone regression check for the graph-based booking engine
// (bookingGraph.service.js) against the OLD, proven-in-production engine
// (booking.service.js), for the SG Travels business's REAL flow_nodes/
// flow_edges/route_fares data (no fixtures/mocks) — per the reviewed plan:
// the old engine is the source of truth, and any divergence for identical
// scripted input is automatically suspicious rather than something this
// script has to have anticipated up front.
//
// Never sends anything to WhatsApp and never touches Redis for the new
// engine (in-memory session). The old engine DOES use a real Redis session
// and DOES insert a real `bookings` row on completion — both are cleaned
// up at the end (session key deleted, booking row read then deleted).
//
// Currently scripts ONE branch: One Way, Pune -> Mumbai, route_fare match
// (see bookingGraph.service.js's header comment for what's intentionally
// not yet ported — distance_estimate/rental_package tap-verification,
// Round Trip, Local Rental). More branches get added here as those land.
//
// Usage: node src/scripts/verifyBookingGraph.js

require('dotenv').config();

// The dev Redis instance (Upstash free tier) is currently over its request
// quota — an infra constraint unrelated to the code under test. Session
// storage is incidental to what this script verifies (booking-graph
// logic), so it's shimmed with an in-memory stand-in for THIS SCRIPT ONLY,
// injected into Node's require cache before booking.service.js (which
// does `require('../config/redis')` internally) is ever required. Nothing
// about production code changes; delete this block once the quota resets
// if you'd rather verify against real Redis.
//
// Covers both the string get/set/del session storage AND the hash commands
// usage.service.js's incrementUsage needs (hincrby/hget/hgetall/ttl/expire)
// — booking.service.js's processBookingStep fires incrementUsage on every
// completed booking, so the shim has to support it too or every OLD-engine
// run logs a spurious "redis.hincrby is not a function" (caught and
// swallowed by incrementUsage's own try/catch, so it doesn't affect
// verification results, but it's noise worth not generating).
const redisModulePath = require.resolve('../config/redis');
const inMemoryStore = new Map();
const inMemoryHashStore = new Map();
require.cache[redisModulePath] = {
  id: redisModulePath,
  filename: redisModulePath,
  loaded: true,
  exports: {
    get: async (key) => (inMemoryStore.has(key) ? inMemoryStore.get(key) : null),
    set: async (key, value) => { inMemoryStore.set(key, value); return 'OK'; },
    del: async (key) => { inMemoryStore.delete(key); return 1; },
    hincrby: async (key, field, increment) => {
      const hash = inMemoryHashStore.get(key) || {};
      hash[field] = (hash[field] || 0) + increment;
      inMemoryHashStore.set(key, hash);
      return hash[field];
    },
    hget: async (key, field) => {
      const hash = inMemoryHashStore.get(key);
      return hash && hash[field] !== undefined ? String(hash[field]) : null;
    },
    hgetall: async (key) => {
      const hash = inMemoryHashStore.get(key) || {};
      const out = {};
      for (const field of Object.keys(hash)) out[field] = String(hash[field]);
      return out;
    },
    ttl: async () => -1,
    expire: async () => 1
  }
};

const supabase = require('../config/supabase');
const redis = require('../config/redis'); // resolves to the in-memory shim above
const bookingService = require('../services/booking.service');
const bookingGraph = require('../services/bookingGraph.service');

const TEST_CUSTOMER_NUMBER = 'VERIFY_BOOKING_GRAPH_TEST';

// vehicle_carousel options carry a distinct shape (vehicle/fare choice, not
// a value/label choice) — see buildVehicleCarouselOptions/
// findDistanceBasedVehicleOptions in booking.service.js. Comparing those
// fields matters most here since they're the money-critical branch (fare
// amount, vehicle identity, display order shown to the customer).
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

async function runOldEngine(businessId, replies, languageCode) {
  await bookingService.deleteBookingSession(businessId, TEST_CUSTOMER_NUMBER);
  const testCustomerId = await ensureTestCustomer(businessId);

  const turns = [];
  const first = await bookingService.startBookingSession(businessId, TEST_CUSTOMER_NUMBER, 'verify-script-rule-id', languageCode);
  turns.push(fieldSummary(first));

  let result = first;
  for (const reply of replies) {
    result = await bookingService.processBookingStep(businessId, TEST_CUSTOMER_NUMBER, reply, {}, languageCode);
    if (result === null) throw new Error('OLD engine: session expired unexpectedly mid-script');
    if (typeof result === 'string') {
      turns.push({ text: result });
    } else {
      turns.push(fieldSummary(result));
    }
  }

  if (typeof result !== 'string' || !result.startsWith('✅')) {
    throw new Error('OLD engine: script did not end on a confirmation message — check SCRIPTED_REPLIES against the business\'s current flow');
  }

  const bookingCodeMatch = result.match(/Booking ID: \*([A-Z0-9]+)\*/);
  if (!bookingCodeMatch) throw new Error('OLD engine: could not parse booking code out of confirmation text');
  const bookingCode = bookingCodeMatch[1];

  const { data: bookingRow, error } = await supabase
    .from('bookings').select('*').eq('business_id', businessId).eq('booking_code', bookingCode).maybeSingle();
  if (error) throw error;
  if (!bookingRow) throw new Error(`OLD engine: booking row ${bookingCode} not found for cleanup/comparison`);

  // Cleanup: this script's whole point is to be side-effect-free.
  await supabase.from('bookings').delete().eq('id', bookingRow.id);
  await supabase.from('customers').delete().eq('id', testCustomerId);
  await bookingService.deleteBookingSession(businessId, TEST_CUSTOMER_NUMBER);

  return { turns, collected: bookingRow.fields };
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

  // lastResult.collected is advanceGraphSession's raw {done:true} payload —
  // it deliberately holds RAW answers (e.g. travelDate = "Today") used for
  // edge-condition matching, not the display-formatted values that only
  // exist once finalizeGraphBooking merges session.displayOverrides in (see
  // booking.service.js). Apply that same merge here so this diffs against
  // what actually ends up in bookingRow.fields for the old engine, without
  // this script having to insert/delete a real booking row itself.
  const displayCollected = { ...lastResult.collected, ...(session.displayOverrides || {}) };
  return { turns, collected: displayCollected };
}

function diffCollected(oldCollected, newCollected) {
  const keys = new Set([...Object.keys(oldCollected || {}), ...Object.keys(newCollected || {})]);
  const mismatches = [];
  for (const key of keys) {
    const oldVal = oldCollected ? oldCollected[key] : undefined;
    const newVal = newCollected ? newCollected[key] : undefined;
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      mismatches.push({ key, old: oldVal, new: newVal });
    }
  }
  return mismatches;
}

async function cleanupTestData(businessId) {
  if (!businessId) return;
  await supabase.from('bookings').delete().eq('business_id', businessId).eq('customer_number', TEST_CUSTOMER_NUMBER);
  await supabase.from('customers').delete().eq('business_id', businessId).eq('whatsapp_number', TEST_CUSTOMER_NUMBER);
  await bookingService.deleteBookingSession(businessId, TEST_CUSTOMER_NUMBER);
}

// No round_trip route_fare exists for Pune->Mumbai on the real SG Travels
// data (only 'oneway' is seeded), so the Round Trip branch needs one
// inserted for the duration of its run — same create-then-delete pattern
// as the test customer/booking rows, just on route_fares instead. Exercises
// the route_fare tap-verification path (already proven by the One Way
// branch) for Round Trip's field-sequence concern specifically: the
// dynamically-inserted numberOfDays field between travelDate and pickupTime.
async function insertTestRoundTripRouteFare(businessId) {
  const { data: vehicle, error: vehicleErr } = await supabase
    .from('vehicles').select('id').eq('business_id', businessId).eq('is_active', true).limit(1).maybeSingle();
  if (vehicleErr) throw vehicleErr;
  if (!vehicle) throw new Error('No active vehicle found to attach the test round_trip route_fare to.');
  const { data: inserted, error } = await supabase.from('route_fares').insert({
    business_id: businessId, from_city: 'pune', to_city: 'mumbai', trip_type: 'round_trip',
    vehicle_id: vehicle.id, fare: 7200, is_active: true
  }).select('id').single();
  if (error) throw error;
  return inserted.id;
}

async function deleteTestRouteFare(routeFareId) {
  if (!routeFareId) return;
  await supabase.from('route_fares').delete().eq('id', routeFareId);
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

// Local Rental with no rental packages configured exercises the
// dropLocation-detour fix in bookingGraph.service.js's advanceGraphSession
// (see its header comment) — deactivating SG Travels' one real package for
// the run's duration reproduces "no packages configured" from both
// engines' point of view (both groupRentalPackagesByKey/
// findRentalPackageOptions filter on is_active=true), without deleting the
// row. Reactivated after.
async function setRentalPackagesActive(businessId, isActive) {
  const { error } = await supabase.from('rental_packages').update({ is_active: isActive }).eq('business_id', businessId);
  if (error) throw error;
}

async function main() {
  const { data: business, error: bizErr } = await supabase
    .from('businesses').select('id, name').eq('business_category', 'travels').maybeSingle();
  if (bizErr) throw bizErr;
  if (!business) throw new Error("No business found with business_category = 'travels'.");

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
      replies: ['One Way', 'Pune', 'Mumbai', 'Today', 'Morning (8-11 AM)', '0']
    },
    {
      name: 'Local Rental, Pune, rental_package match',
      replies: ['Local Rental', 'Pune', '8HR_80KM', 'Today', 'Morning (8-11 AM)', '0']
    },
    {
      name: 'Round Trip, Pune -> Mumbai, route_fare match (numberOfDays field)',
      replies: ['Round Trip', 'Pune', 'Mumbai', 'Today', '3', 'Morning (8-11 AM)', '0'],
      setup: async (businessId) => ({ routeFareId: await insertTestRoundTripRouteFare(businessId) }),
      teardown: async (_businessId, ctx) => deleteTestRouteFare(ctx.routeFareId)
    },
    {
      name: 'One Way, Pune -> Satara, distance_estimate (no route_fare for this pair)',
      replies: ['One Way', 'Pune', 'Satara', 'Today', 'Morning (8-11 AM)', '0'],
      setup: async (businessId) => {
        const priorEnableDistanceFares = false; // known SG Travels baseline, confirmed before this session's changes
        await setEnableDistanceFares(businessId, true);
        const cacheKey = await seedDistanceCache(businessId, 'Pune', 'Satara', 120);
        return { cacheKey, priorEnableDistanceFares };
      },
      teardown: async (businessId, ctx) => {
        await setEnableDistanceFares(businessId, ctx.priorEnableDistanceFares);
        await redis.del(ctx.cacheKey);
      }
    },
    {
      name: 'Local Rental, Pune -> Satara, no packages configured (dropLocation detour)',
      replies: ['Local Rental', 'Pune', 'Satara', 'Today', 'Morning (8-11 AM)', 'Hatchback'],
      setup: async (businessId) => {
        await setRentalPackagesActive(businessId, false);
        return {};
      },
      teardown: async (businessId) => setRentalPackagesActive(businessId, true)
    }
  ];

  let anyFailed = false;

  try {
    for (const branch of branches) {
      console.log(`=== ${branch.name} ===`);
      console.log('Replies:', branch.replies.join(' | '));

      const setupCtx = branch.setup ? await branch.setup(business.id) : null;
      let oldRun, newRun, branchFailed = false;
      try {
        try {
          oldRun = await runOldEngine(business.id, branch.replies, null);
        } catch (err) {
          console.error('OLD engine run FAILED:', err.message);
          anyFailed = true;
          branchFailed = true;
        }
        if (!branchFailed) {
          try {
            newRun = await runNewEngine(business.id, entryNode.id, branch.replies, null);
          } catch (err) {
            console.error('NEW engine run FAILED:', err.message);
            anyFailed = true;
            branchFailed = true;
          }
        }
      } finally {
        if (branch.teardown) await branch.teardown(business.id, setupCtx);
      }
      if (branchFailed) continue;

      console.log('\n-- turn-by-turn --');
      const maxTurns = Math.max(oldRun.turns.length, newRun.turns.length);
      let turnsMatch = true;
      for (let i = 0; i < maxTurns; i++) {
        const oldTurn = oldRun.turns[i];
        const newTurn = newRun.turns[i];
        // Documented boundary, not a divergence: the new engine's advance()
        // is deliberately kept free of side effects (no booking-row insert,
        // no confirmation-text formatting) — it signals completion with
        // {done:true} and leaves that to a caller that doesn't exist yet.
        // The old engine's confirmation STRING is only comparable once that
        // caller is built; `collected` (diffed below) is the real
        // correctness signal for the terminal turn until then.
        const isDesignedTerminalPair = !!(oldTurn && oldTurn.text && oldTurn.text.startsWith('✅') && newTurn && newTurn.done === true);
        const o = JSON.stringify(oldTurn ?? '<missing>');
        const n = JSON.stringify(newTurn ?? '<missing>');
        const match = isDesignedTerminalPair || o === n;
        if (!match) turnsMatch = false;
        const status = isDesignedTerminalPair ? 'OK* ' : (match ? 'OK  ' : 'DIFF');
        console.log(`  [${i}] ${status}  old=${o}`);
        if (!match || isDesignedTerminalPair) console.log(`              new=${n}`);
      }

      console.log('\n-- collected diff --');
      const mismatches = diffCollected(oldRun.collected, newRun.collected);
      if (mismatches.length === 0) {
        console.log('  (no differences)');
      } else {
        anyFailed = true;
        for (const m of mismatches) {
          console.log(`  MISMATCH ${m.key}: old=${JSON.stringify(m.old)}  new=${JSON.stringify(m.new)}`);
        }
      }

      if (!turnsMatch) anyFailed = true;
      console.log(`\n${branch.name}: ${turnsMatch && mismatches.length === 0 ? 'PASS' : 'FAIL'}\n`);
    }
  } finally {
    // Belt-and-suspenders: runOldEngine cleans up on its own success path,
    // this catches anything left behind by a mid-branch throw.
    await cleanupTestData(business.id);
  }

  if (anyFailed) {
    console.error('One or more branches failed or diverged from the old engine.');
    process.exit(1);
  }
  console.log('All scripted branches match the old engine.');
  // Explicit exit: the real supabase client (unlike the shimmed redis
  // stub) holds an open handle nothing here closes, which otherwise
  // leaves the process hanging after this point instead of exiting.
  process.exit(0);
}

main().catch(err => {
  console.error('Verification script crashed:', err);
  process.exit(1);
});
