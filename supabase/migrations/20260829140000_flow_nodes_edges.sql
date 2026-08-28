-- ============================================
-- FLOW NODES / FLOW EDGES / FLOW SNAPSHOTS
-- ============================================
-- Graph-based replacement for `rules` + `business_flows`. One row per node
-- (a matchable keyword reply, or a booking question) and one row per edge
-- (a navigable transition between two nodes). This is a full replacement,
-- not an additive feature — once the engine (chatbot.service.js,
-- booking.service.js, webhook.controller.js, whatsapp.service.js) and the
-- CRUD surface are migrated over, `rules` and `business_flows` become dead
-- and can be dropped. Do NOT drop them as part of this migration — that is
-- a final cleanup step after everything is confirmed working end-to-end.
--
-- NODE_TYPE semantics
--   'reply'            — a keyword-triggered node (today's `rules` row).
--                         Matched directly against inbound text via
--                         keyword/match_type/hindi_aliases — these are the
--                         chatbot engine's "trigger nodes". content_type
--                         'text'/'buttons'/'list' controls whether it also
--                         offers choices; those choices are NOT stored on
--                         the node — they ARE the outgoing flow_edges (see
--                         below), one edge per button/list row.
--   'question'          — a booking-flow field (today's business_flows
--                         .booking_fields entry). content_type 'text'/
--                         'buttons'/'list' controls how it's rendered;
--                         buttons/list choices ARE stored on the node
--                         (options column) because they're collected DATA,
--                         not navigation — the customer's answer becomes
--                         session.collected[field_key], which downstream
--                         edges may branch on. Outgoing edges represent
--                         "what question comes next", not "what was
--                         tapped".
--   'vehicle_carousel'  — computed equivalent of a 'question' node for the
--                         vehicle-choice step. Always is_computed = true.
--   'rentalPackage'     — computed equivalent of a 'question' node for the
--                         Local Rental package-choice step. Always
--                         is_computed = true.
--
-- FIELD_KEY IS NOT UNIQUE PER BUSINESS. Multiple nodes intentionally share
-- one field_key:
--   - An authored choice node and its manual fallback, e.g. travelDate
--     (content_type='buttons', options Today/Tomorrow/"Other date") and
--     travelDate_manual-equivalent (content_type='text', field_key still
--     'travelDate'). When the customer taps the "Other ..." option, the
--     engine swaps in the sibling text node for that one turn — discovered
--     by (business_id, field_key, content_type='text'), not by a
--     dedicated edge. Same pattern for pickupTime and, for businesses with
--     servedCities configured, pickupLocation/dropLocation.
--   - A computed node and its static authored fallback, e.g. the
--     vehicle_carousel node and the plain 'vehicleType' list node: when
--     the live route_fares/vehicles query comes back empty, the engine
--     falls back to the sibling non-computed node with the same
--     field_key, discovered the same way.
-- This is intentional, not a bug — every code path that looks up "the"
-- node for a field_key must be prepared for more than one row and use
-- content_type/is_computed to disambiguate, never assume uniqueness.
--
-- IS_COMPUTED. True only for 'vehicle_carousel' and 'rentalPackage' nodes.
-- When true, the `options` column is ALWAYS ignored — the runtime must
-- query route_fares/vehicles (or rental_packages) fresh, exactly as
-- booking.service.js does today (findBestVehicleCarouselOptions /
-- findRentalVehicleCarouselOptions). Every code path that reads
-- flow_nodes.options MUST check is_computed first and skip the column
-- entirely when true — enforced here at the DB level too (see check
-- constraint below), but the app-layer check is still required since the
-- constraint can't stop code from reading a stale `options` value it
-- shouldn't.
--
-- WHATSAPP INTERACTION IDS — two schemes, not one:
--   - Authored branches (a 'reply' node's buttons/list, content_type !=
--     'text'; NOT a computed node): id = flow_edges.id (uuid, well under
--     Meta's 200/256 char caps). One edge per rendered button/list row.
--   - Computed nodes (vehicle_carousel / rentalPackage options): id =
--     "{node_id}:{index}" (~40 chars, still safe), since there's no
--     persisted edge to reference — the options are generated fresh per
--     turn from a live query. `index` matches the option's position in
--     that turn's computed options array.
-- webhook.controller.js's id-decode logic goes from three schemes today
-- (rule keyword id, "{step}:{index}" booking id, "vehicle_{index}"
-- carousel id) down to these two.
create table flow_nodes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  node_type text not null check (node_type in ('reply','question','vehicle_carousel','rentalPackage')),

  -- 'reply' node fields (trigger matching + reply content)
  keyword text,
  match_type text check (match_type in ('exact','contains','startsWith')),
  hindi_aliases jsonb not null default '[]',
  reply_kind text check (reply_kind in ('text','booking_trigger','payment_trigger')),
  trigger_count integer not null default 0,

  -- shared rendering fields (reply text, or question prompt)
  content_type text not null default 'text' check (content_type in ('text','buttons','list')),
  label text not null,
  label_translations jsonb,
  image_url text,

  -- 'question' / 'vehicle_carousel' / 'rentalPackage' node fields
  field_key text,
  summary_label text,
  required boolean not null default false,
  "order" numeric,
  options jsonb not null default '[]',  -- authored choices: [{value,label,labelTranslations}] or plain strings; IGNORED when is_computed
  is_computed boolean not null default false,

  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint flow_nodes_reply_needs_keyword check (node_type != 'reply' or keyword is not null),
  constraint flow_nodes_question_needs_field_key check (node_type = 'reply' or field_key is not null),
  constraint flow_nodes_is_computed_only_for_computed_types
    check (not is_computed or node_type in ('vehicle_carousel','rentalPackage'))
);
create index idx_flow_nodes_business_id on flow_nodes(business_id);
create index idx_flow_nodes_business_field_key on flow_nodes(business_id, field_key);
create index idx_flow_nodes_business_keyword on flow_nodes(business_id, keyword);

comment on table flow_nodes is
  'Graph-based replacement for rules + business_flows.booking_fields. '
  'field_key is NOT unique per business by design — an authored node and '
  'its manual-fallback or computed-fallback sibling share a field_key, '
  'disambiguated by content_type/is_computed. See migration file header '
  'for full node_type/is_computed/id-scheme documentation.';

-- ============================================
-- FLOW EDGES
-- ============================================
-- A directed transition between two flow_nodes.
--   - From a 'reply' node: one edge per rendered button/list row. `label`
--     (and `description`, list rows only) is the button/row text; the
--     edge's own id IS the WhatsApp interaction id for that row (see
--     flow_nodes comment above). `condition` is null — which edge fires
--     is determined entirely by which one the customer taps.
--   - From a 'question'/'vehicle_carousel'/'rentalPackage' node: an edge
--     represents "what question comes next". `condition` is null for a
--     plain linear step, or set when the next question depends on an
--     earlier answer (e.g. the tripType branch: pickupLocation ->
--     dropLocation when tripType is One Way/Round Trip, pickupLocation ->
--     rentalPackage when tripType is Local Rental). `label`/`description`
--     are unused here — the rendered choices for these nodes live on
--     flow_nodes.options, not on the edge.
create table flow_edges (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  from_node_id uuid not null references flow_nodes(id) on delete cascade,
  to_node_id uuid not null references flow_nodes(id) on delete cascade,
  label text,
  label_translations jsonb,
  description text,
  description_translations jsonb,
  condition jsonb,  -- null (unconditional), {"field":"tripType","equals":"Local Rental"}, or {"field":"tripType","in":["One Way","Round Trip"]}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint flow_edges_condition_shape check (
    condition is null or (
      (condition ? 'field') and
      ((condition ? 'equals') <> (condition ? 'in'))  -- exactly one of equals/in, not both
    )
  )
);
create index idx_flow_edges_business_id on flow_edges(business_id);
create index idx_flow_edges_from_node_id on flow_edges(from_node_id);
create index idx_flow_edges_to_node_id on flow_edges(to_node_id);

comment on table flow_edges is
  'condition supports both equality ({field,equals}) and set membership '
  '({field,in:[...]}). See migration file header for the two distinct '
  'edge semantics (reply-node button/list rows vs question-node sequence '
  'transitions).';

-- ============================================
-- FLOW SNAPSHOTS
-- ============================================
-- "Save current flow, start new" versioning. A snapshot is a point-in-time
-- copy of one business's flow_nodes/flow_edges rows, not a live version
-- tag. Saving = copy this business's current flow_nodes/flow_edges into a
-- new flow_snapshots row (nodes/edges stored as full row arrays, including
-- each node/edge's original id, so edges' from_node_id/to_node_id stay
-- resolvable when restored). Switching to a snapshot = delete this
-- business's current flow_nodes/flow_edges, then recreate rows from the
-- snapshot's stored nodes/edges. is_active marks which snapshot (if any)
-- reflects what's currently live, for display purposes only — the live
-- flow_nodes/flow_edges rows are always the source of truth for the
-- running engine, never a snapshot row.
create table flow_snapshots (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  nodes jsonb not null default '[]',
  edges jsonb not null default '[]',
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_flow_snapshots_business_id on flow_snapshots(business_id);

do $$
declare t text;
begin
  for t in select unnest(array['flow_nodes','flow_edges','flow_snapshots'])
  loop
    execute format('create trigger trg_set_updated_at before update on %I
      for each row execute function set_updated_at();', t);
  end loop;
end $$;
