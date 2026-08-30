# ApnaBot-server — Project State

Multi-tenant WhatsApp chatbot backend for Indian SMBs (travels/cab,
software/IT services verticals so far). Node/Express + Supabase (Postgres)
+ Upstash Redis + BullMQ. Owner: Suresh Gavali (Averix Solutions Pvt Ltd).

**No production customers yet.** SG Travels (business_category='travels')
and Averix Solutions (business_category='software_it') are both TEST
accounts under the owner's control — freely resettable, no real customer
data to protect. This will change once ad traffic starts; update this
line when it does.

## Current architecture — TWO booking engines coexist

This is the most important thing to understand before touching anything.

### Engine A — Graph engine (flow_nodes / flow_edges)
- **Live for: SG Travels only** (business_id `5a2e3771-b877-4ff8-bd8a-0924c6b9dc0c`)
- Tables: `flow_nodes`, `flow_edges`, `flow_snapshots` (versioning, unused so far)
- Core logic: `src/services/bookingGraph.service.js` (pure, side-effect-free
  `advanceGraphSession`/`startGraphSession`), `src/services/chatbot.service.js`
  (reply-node matching), `src/controllers/webhook.controller.js` Step 12/13-16
  (orchestration, WhatsApp send)
- WhatsApp interaction ids: `flow_edges.id` for reply-node buttons/lists,
  `"{node_id}:{index}"` / `"{node_id}:other"` for question-node and
  computed-node (vehicle_carousel/rentalPackage) options
- Verified via `src/scripts/verifyBookingGraph.js` — diffs the graph
  engine's output against the OLD engine's output for identical scripted
  input, across 5 branches (One Way/route_fare, Local Rental/rental_package,
  Round Trip/route_fare+numberOfDays, distance_estimate, Local
  Rental-no-packages-configured). All PASS as of the last run — re-run this
  after ANY change to bookingGraph.service.js or booking.service.js's
  shared logic.
- **CONFIRMED WORKING ON REAL WHATSAPP TRAFFIC** (2026-08-29) — full trip
  booked end-to-end, correct fare, correct confirmation, correct DB row.

### Engine B — Old flat engine (rules / business_flows)
- **Runtime path is unconditionally graph-only today** — the webhook
  controller and `chatbot.service.js` always run the graph engine
  regardless of a business's `booking_engine` value; nothing on the live
  message path branches on it. `booking_engine` only gates the
  **dashboard CRUD surface** (which of `/api/business/booking-fields` vs
  `/api/flow-graph` a business's owner is allowed to use — see "CRUD for
  the graph engine" below). So describing Engine B as "live for every
  other business" is misleading: Averix's `rules`/`business_flows` rows
  still exist and are readable/writable via the dashboard, but nothing
  currently sends Averix's real WhatsApp traffic through
  `startBookingSession`/`processBookingStep` — that would require
  Averix's data to actually be migrated into `flow_nodes`/`flow_edges`
  the way SG Travels' was, which has NOT happened. (This is a real gap
  to resolve, not just a doc fix — see "Known gaps" #2.)
- Tables: `rules` (chatbot.service.js's OLD keyword matching), `business_flows`
  (per-business copy of booking_fields, made from `business_type_templates`
  at signup)
- Core logic: `src/services/booking.service.js`'s `startBookingSession`/
  `processBookingStep` (session.step/session.fields splice-array model) —
  still exported and unit-testable, but not reachable from the live
  webhook path as of 2026-08-29

### CRUD for the graph engine — node + edge CRUD done
`businesses.booking_engine` (`'legacy'`/`'graph'`, added 2026-08-29) now
gates access — SG Travels is `'graph'`, every other business (incl.
Averix) is `'legacy'`. New surface: `src/middleware/flowGraph.middleware.js`
(`requireGraphEngine`), `src/controllers/flowGraph.controller.js`,
`src/routes/flowGraph.routes.js`, mounted at `/api/flow-graph`. Structural
safety lives in `src/utils/flowGraphValidation.js` (`findCycles`,
`findUnreachableNodes`, `findFallbackSiblingNodeIds`,
`resolveBookingTriggerEntryNodeIds`) — pure functions over `{nodes, edges}`,
called by every mutating handler via the controller's private
`assertGraphStillValid` before it writes.

Done: full CRUD for `reply`-type nodes (`/reply-nodes`), `question`-type
nodes (`/question-nodes`), and `flow_edges` (`/edges` — add/retarget/
set-condition/delete/reorder), all live-tested against SG Travels' real
graph. Edge writes are surgical (UPDATE in place, never delete+recreate) —
an edge's id is a live WhatsApp interaction id a customer may already be
holding, so replacing it the way the old `rules` table's buttons array
replace pattern did would silently break an in-flight tap.

Guards in place: reserved-field-key (tripType/pickupLocation/dropLocation/
travelDate/pickupTime, travels/cab categories), servedCities-overlay
rejection on pickupLocation/dropLocation options, cascade-delete protection
(refuses to delete a node other nodes' edges still target), the
contentType-switch-with-live-edges guard, the fallback-sibling delete guard
(blocks deleting a node like the static `vehicleType` fallback that has no
incoming edge but is still load-bearing at runtime), `flow_edges.condition`
existence-only field validation, and cycle/reachability re-validation on
every node or edge write that could break the question subgraph (including
reply-node `replyKind` edits/deletes that would remove the last
`booking_trigger` entry point). Reachability re-validation is
**differential, not absolute** — it only rejects an edit that newly strands
a node that was reachable before the edit ran; a pre-existing orphan (a
question node created but not yet wired to an edge, which is the normal,
expected in-between state per the create-then-wire workflow) doesn't block
unrelated edge writes elsewhere in the graph. (An earlier absolute version
of this check would have blocked nearly all edge writes the moment any
node was mid-way through being wired in — caught and fixed while live-
testing step 5, before it shipped.)

`vehicle_carousel` nodes can now be created (2026-08-30) via
`POST /api/flow-graph/question-nodes` with `nodeType: 'vehicle_carousel'`
— server forces `is_computed=true`/`content_type='list'` and rejects a
non-empty `options` array. Still read-only after creation (update/delete
stay scoped to `node_type='question'`), and `createEdge` refuses any edge
sourced FROM a vehicle_carousel node (zero outgoing edges — the
post-selection flow is hardcoded in `bookingGraph.service.js`, not
edge-driven).

NOT done yet: `rentalPackage` nodes are still read-only through this
surface (by design — engine-internal, no dashboard concept of creating
one). `flow_snapshots`
("save current flow, start new" versioning) is still completely unused —
no reader or writer anywhere touches it. Full CRUD (node + edge) for the
graph engine is otherwise done as of 2026-08-29.

## Data model reference

- `businesses` — core tenant table. `business_category` gates template
  selection at signup. `disabled_booking_fields`, `served_cities` are
  live per-business config, applied as an OVERLAY at read time by both
  engines (never baked into stored flow data).
- `business_type_templates` — category starting point, copied once at
  business creation into `rules` + `business_flows` (old engine) or
  historically into `flow_nodes`/`flow_edges` via the one-time migration
  script (graph engine). NOT read again after creation for either engine.
  Still the source SuperAdmin edits for category defaults.
- `flow_packs`, `business_flows.rules` (a stale snapshot never read after
  step-3a of the graph migration) — legacy/parallel mechanisms, still
  exist, not part of the graph engine.

## WhatsApp/Meta specifics
- Tech Provider status (not Solution Partner) — each client business adds
  their own Meta payment method.
- Redis quota (Upstash free tier, 500k req/month) has been hit twice this
  project — once from BullMQ workers double-running (local + Render
  sharing one REDIS_URL, fixed via `QUEUE_NAMESPACE` prefixing, see
  `src/config/env.js`), and generally from continuous BullMQ polling +
  heavy manual testing. Consider upgrading the Upstash tier before real
  ad traffic starts.

## Known gaps / deferred work
1. **The CRUD gap above** — CLOSED as of 2026-08-29. Node CRUD (reply +
   question) and edge CRUD (add/retarget/condition/reorder) all done and
   live-tested against SG Travels' real graph.
2. **Averix (`software_it`) still on the old engine** — never migrated to
   graph. Decide when/whether to migrate.
3. **Local Rental/no-packages-configured** — handled via a detour to the
   primary `dropLocation` node in the graph engine (see
   `bookingGraph.service.js`'s header comment) — verified working, but
   worth knowing this is an approximation of the old splice behavior, not
   an edge-condition-native solution.
4. **`distance_estimate` carousel branch** — verified in the graph engine
   via a seeded Redis cache entry (no `GOOGLE_MAPS_API_KEY` in dev). Real
   Google Distance Matrix calls untested end-to-end against the graph
   engine.
5. **Rule translations** — `bookingFields` support `labelTranslations`
   (hi/mr); the `rules` table has NO translation mechanism for reply text
   at all (confirmed gap, not yet built for either engine).
6. **`usage.service.js`'s `incrementUsage`** — uses Redis hash commands
   (`hincrby` etc.) — confirmed working correctly against real
   `ioredis`; an earlier false alarm during testing was a gap in a test
   script's Redis shim, not a real bug.
7. **Unified visual flow canvas** (React Flow, one-flow-at-a-time,
   save/version) — explicitly parked as a future initiative, separate
   from the graph engine's internal node/edge representation. Don't
   conflate: the graph engine is a DATA MODEL change; the visual canvas
   is a UI project that would sit on top of it later.
8. **`verifyBookingGraph.js` currently unusable** — `business_flows` rows
   are missing for SG Travels' post-reset `business_id` (SG Infotech +
   Averix were wiped and recreated fresh on 2026-08-29; the business ids
   elsewhere in this doc predate that reset and need re-confirming).
   The script diffs the graph engine against the old engine's
   `business_flows`-driven output, so it can't run until either
   `business_flows` is reseeded for the current business_id or the
   script is reworked to not depend on it. CLAUDE.md rule 6 requires
   re-running this script after graph-engine changes — currently
   blocked; the three bug fixes above were verified on real WhatsApp
   traffic instead.
9. **`bookings.customer_id` NOT NULL vs. null-tolerant insert** —
   `createBookingAndConfirmation` (`booking.service.js:894-909`) inserts
   `customer_id: customer ? customer.id : null` when no matching
   `customers` row is found for the business+whatsapp_number pair. If
   `bookings.customer_id` is actually `NOT NULL` in the live schema,
   that insert would fail. Latent gap — never hit in real traffic yet
   (every booking tested so far had a pre-existing customer row).
   Schema not yet verified either way; check before assuming it's safe.
10. **Averix still on `booking_engine='legacy'`** — a signup bug from
    earlier today (2026-08-30) was never fully resolved or retraced.
    Unrelated to the SG Travels graph-engine work above; needs its own
    follow-up session.
11. **Round Trip branch built and wired, not yet walked end-to-end on
    WhatsApp** — same rebuild as the Session log entry above, but only
    One Way was actually confirmed live; Round Trip needs the same final
    confirmation pass before it's trusted the way One Way now is.

## Session log (append here as major milestones land)
- 2026-08-30: SG Travels' full travels booking flow (welcome menu →
  tripType branching → full question chain → real `vehicle_carousel`
  with live fares → booking complete) rebuilt from scratch through the
  graph engine editor (`/api/flow-graph`) and **CONFIRMED WORKING END
  TO END ON REAL WHATSAPP TRAFFIC** — One Way branch and the travelDate
  fix (below) both walked live today. Three real bugs found and fixed
  during the rebuild:
  - **Reply-node → question-node send failure** (`ba80518`) — a button/
    list wired straight from a reply node to a question node (e.g. "hi"
    → "Book a ride" → tripType) resolved its WhatsApp interaction id via
    the target node's `keyword`, which only exists on reply nodes; sent
    as `null`, Meta's schema validator rejected it. Fixed by always using
    `edge.id` as the interaction id outbound, and resolving inbound taps
    structurally (`resolveTappedEdge`) instead of re-running keyword
    matching.
  - **Missing `{{customerName}}` substitution** (`65cb2e5`) —
    `applyMessageTemplate` only ever substituted `{{businessName}}`;
    `{{customerName}}` passed through literally in every reply. Fixed by
    threading `customer` into every `applyMessageTemplate` call site and
    adding the substitution (falls back to "there"). Also fixed
    `booking_trigger` labels skipping `applyMessageTemplate` entirely
    (first question was sent with placeholders unresolved).
  - **travelDate display-value overwriting the raw match value**
    (`f9e55ba`, `bb7a69b`) — `session.collected`'s stored value for a
    field was being overwritten with its display-formatted string
    *before* edge-condition matching ran against it, so a travelDate
    edge condition compared against the formatted display string instead
    of the raw value, silently failed to match, and fell through —
    causing travelDate bookings to complete early with the wrong branch
    taken. `f9e55ba` first added diagnostic logging on wired-edge
    condition-match failures (to surface this class of silent bug at
    all); `bb7a69b` fixed the actual ordering bug and updated
    `verifyBookingGraph.js` accordingly.
- 2026-08-2X: `business_flows` table + per-business booking flow reads
  (replaces live template reads) — done, verified on SG Travels + Averix.
- 2026-08-29: `flow_nodes`/`flow_edges`/`flow_snapshots` graph engine —
  built, verified via 5-branch script, wired into webhook.controller.js,
  confirmed working on real WhatsApp traffic for SG Travels.
- 2026-08-29: Redis queue namespace fix (`QUEUE_NAMESPACE` prefixing) —
  prevents local/prod BullMQ worker collision.
- 2026-08-29: `businesses.booking_engine` column added + backfilled (SG
  Travels → `'graph'`); graph-engine CRUD (`/api/flow-graph` — reply-nodes,
  question-nodes, edges) built end to end with full structural safety
  (`flowGraphValidation.js`: cycle detection, differential reachability
  re-validation, fallback-sibling delete protection), live-tested against
  SG Travels' real graph at every step, including deliberate
  break-it-on-purpose cases (cycles, orphaning retargets/deletes, reserved
  fields, computed nodes). CRUD gap from the graph-engine build now closed.