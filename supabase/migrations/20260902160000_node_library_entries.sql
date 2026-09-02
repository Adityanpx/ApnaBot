-- SuperAdmin Node Library: a curated catalog of individual flow_nodes rows
-- (one reply keyword-reply, or one booking question), separate from
-- flow_snapshots' category templates (which snapshot an entire graph).
-- A business owner browses this by their own business_category and inserts
-- one node at a time into their live flow_nodes, rather than replacing
-- their whole graph the way importCategoryTemplate does.
--
-- node_data is a full snapshot of the source flow_nodes row at the moment a
-- SuperAdmin added it (raw snake_case, same full-row-jsonb pattern
-- flow_snapshots.nodes/.edges already uses), minus id/business_id/
-- created_at/updated_at/trigger_count — those are per-insertion-target and
-- get regenerated fresh every time a business inserts this entry (see
-- nodeLibraryPublic.controller.js#insertNodeFromLibrary).
--
-- source_business_id/source_node_id are PROVENANCE, not a live reference to
-- an editable row — the source flow_nodes row can be edited or deleted
-- later with zero effect on this library entry (node_data already has its
-- own independent copy). source_node_id carries no FK at all for exactly
-- that reason. source_business_id does keep a real FK (ON DELETE SET NULL,
-- nullable) purely so the row survives if the source business is deleted —
-- the pair only matters operationally for the dedup unique index below,
-- while both are still populated.
create table node_library_entries (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it'
  )),
  node_type text not null check (node_type in ('reply', 'question')),
  node_data jsonb not null,
  source_business_id uuid references businesses(id) on delete set null,
  source_node_id uuid not null,
  added_by_admin_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_node_library_category on node_library_entries(category);

-- Enforces "don't add the same source node twice" at the DB level. Only
-- meaningful while source_business_id is still set — once a source business
-- is deleted and this column nulls out, Postgres treats NULL as distinct
-- across rows in a unique index, so multiple orphaned entries with the same
-- former source_node_id can coexist without conflict (there's no live
-- business left to re-derive a duplicate from anyway).
create unique index idx_node_library_source_dedup on node_library_entries(source_business_id, source_node_id);

comment on table node_library_entries is
  'SuperAdmin-curated individual flow_nodes entries, browsable by category '
  'and insertable one-at-a-time into a business''s own flow_nodes via '
  '/api/flow-graph/library/insert. Distinct from flow_snapshots category '
  'templates, which copy an entire graph at once.';
