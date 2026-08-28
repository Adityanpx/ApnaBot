-- The 20260829140000_flow_nodes_edges.sql migration file declares
-- `not null default` on several jsonb/integer columns, but those defaults
-- never actually landed on the live table — the file was evidently edited
-- to add them after the migration had already been applied, and never
-- re-pushed. Confirmed by real inserts: flow_nodes.hindi_aliases, .options,
-- and .trigger_count all raised not-null violations when omitted, despite
-- the migration file (and PostgREST's schema cache for the scalar columns)
-- claiming a default exists. flow_snapshots.nodes/.edges show the same
-- "declared default, missing from live schema" signature via PostgREST
-- introspection (NO DEFAULT reported, unlike is_active on the same table)
-- and are fixed here pre-emptively. flow_edges has no columns in this
-- category — its only not-null columns are id/business_id/from_node_id/
-- to_node_id/created_at/updated_at, all already working live.
alter table flow_nodes alter column hindi_aliases set default '[]'::jsonb;
alter table flow_nodes alter column options set default '[]'::jsonb;
alter table flow_nodes alter column trigger_count set default 0;

alter table flow_snapshots alter column nodes set default '[]'::jsonb;
alter table flow_snapshots alter column edges set default '[]'::jsonb;
