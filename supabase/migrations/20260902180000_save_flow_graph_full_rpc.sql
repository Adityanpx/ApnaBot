-- Atomic multi-row write for PUT /api/flow-graph/full (the canvas batch-save
-- endpoint). Mirrors increment_rule_trigger_count / increment_wallet_balance's
-- pattern of pushing only the part that needs a real transaction boundary
-- into SQL — everything else (loading the current graph, diffing it against
-- the payload, minting ids for new rows, remapping edge from/to ids through
-- an old-id -> new-id map, and the cycle/reachability/reserved-field-key
-- validation) stays in flowGraph.controller.js, in JS, using the existing
-- flowGraphValidation.js logic unchanged. This function receives the
-- already-resolved result of that work — every id final, every row
-- validated — and its only job is committing it as one unit.
--
-- New pattern for this codebase: every prior RPC here takes scalar args and
-- updates a single row. This one takes jsonb arrays (via jsonb_to_recordset)
-- and upserts many rows across two tables — flagged here explicitly since
-- there's no batch-write precedent to match; PostgREST's REST API has no way
-- to express "insert this array of full rows, update these ids, delete
-- those ids, across two tables, as one commit", so this is the boundary
-- where that capability has to live.
--
-- Write order matters and is NOT arbitrary:
--   1. Upsert nodes first — so any edge upserted in step 4 that references a
--      brand-new node id always finds that id already present.
--   2. Delete edges being removed.
--   3. Delete nodes being removed — safe now because any edge that used to
--      point at one of these nodes was either remapped away from it (still
--      referencing it isn't possible, the caller's diff wouldn't produce
--      that) or already deleted in step 2.
--   4. Upsert edges last, once every node id they could reference (old,
--      untouched, or brand-new) already exists in the table.
-- Deleting edges before nodes (rather than relying on flow_nodes' ON DELETE
-- CASCADE) matches flowSnapshot.service.js's deleteBusinessGraphRows, which
-- already prefers an explicit edges-then-nodes delete order over the
-- implicit cascade for the same reason: callers that care about the result
-- get an explicit, ordered write, not "whatever the cascade happened to do".
--
-- business_id = p_business_id is re-asserted on every delete/insert here
-- despite the caller (flowGraph.controller.js) already scoping everything to
-- req.user.businessId — an RPC with delete power across two tables is a
-- lower trust boundary than the controller, and should not assume the caller
-- got the scoping right.
create or replace function save_flow_graph_full(
  p_business_id uuid,
  p_node_upserts jsonb,   -- array of full flow_nodes rows (snake_case), ids pre-minted for new rows
  p_node_deletes uuid[],
  p_edge_upserts jsonb,   -- array of full flow_edges rows (snake_case), ids pre-minted, from/to already remapped
  p_edge_deletes uuid[]
) returns void as $$
begin
  insert into flow_nodes (
    id, business_id, node_type, keyword, match_type, hindi_aliases, reply_kind,
    trigger_count, content_type, label, label_translations, image_url,
    field_key, summary_label, required, "order", options, is_computed,
    is_active, position_x, position_y
  )
  select
    x.id, p_business_id, x.node_type, x.keyword, x.match_type, x.hindi_aliases, x.reply_kind,
    x.trigger_count, x.content_type, x.label, x.label_translations, x.image_url,
    x.field_key, x.summary_label, x.required, x."order", x.options, x.is_computed,
    x.is_active, x.position_x, x.position_y
  from jsonb_to_recordset(coalesce(p_node_upserts, '[]'::jsonb)) as x(
    id uuid, node_type text, keyword text, match_type text, hindi_aliases jsonb, reply_kind text,
    trigger_count integer, content_type text, label text, label_translations jsonb, image_url text,
    field_key text, summary_label text, required boolean, "order" numeric, options jsonb, is_computed boolean,
    is_active boolean, position_x numeric, position_y numeric
  )
  on conflict (id) do update set
    business_id = excluded.business_id,
    node_type = excluded.node_type,
    keyword = excluded.keyword,
    match_type = excluded.match_type,
    hindi_aliases = excluded.hindi_aliases,
    reply_kind = excluded.reply_kind,
    trigger_count = excluded.trigger_count,
    content_type = excluded.content_type,
    label = excluded.label,
    label_translations = excluded.label_translations,
    image_url = excluded.image_url,
    field_key = excluded.field_key,
    summary_label = excluded.summary_label,
    required = excluded.required,
    "order" = excluded."order",
    options = excluded.options,
    is_computed = excluded.is_computed,
    is_active = excluded.is_active,
    position_x = excluded.position_x,
    position_y = excluded.position_y;

  delete from flow_edges where id = any(p_edge_deletes) and business_id = p_business_id;
  delete from flow_nodes where id = any(p_node_deletes) and business_id = p_business_id;

  insert into flow_edges (
    id, business_id, from_node_id, to_node_id, label, label_translations,
    description, description_translations, condition, display_order
  )
  select
    x.id, p_business_id, x.from_node_id, x.to_node_id, x.label, x.label_translations,
    x.description, x.description_translations, x.condition, x.display_order
  from jsonb_to_recordset(coalesce(p_edge_upserts, '[]'::jsonb)) as x(
    id uuid, from_node_id uuid, to_node_id uuid, label text, label_translations jsonb,
    description text, description_translations jsonb, condition jsonb, display_order integer
  )
  on conflict (id) do update set
    business_id = excluded.business_id,
    from_node_id = excluded.from_node_id,
    to_node_id = excluded.to_node_id,
    label = excluded.label,
    label_translations = excluded.label_translations,
    description = excluded.description,
    description_translations = excluded.description_translations,
    condition = excluded.condition,
    display_order = excluded.display_order;
end;
$$ language plpgsql;
