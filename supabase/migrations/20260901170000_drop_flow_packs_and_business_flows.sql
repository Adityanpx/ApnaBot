-- Cleanup pass: drop the legacy "flow pack / saved flow" feature (superseded
-- by flow_snapshots' personal versioning + category starter templates, see
-- 20260901120000_flow_snapshots_category_templates.sql) and the old-engine
-- business_flows table (dead since the legacy booking engine removal,
-- commit 660d5b9 — see PRD.md / booking-graph-rewrite history).
--
-- Frontend confirmed clean: SavedFlows.tsx, StarterFlows.tsx, and the old
-- Rules-tab UI (the only consumers of /api/saved-flows, /api/flow-packs,
-- /api/admin/flow-packs, and businesses.activeFlowPackId/activeSavedFlowId)
-- were already deleted in the "remove legacy Rules tab UI" pass, before the
-- flow-graph canvas work started. Live row counts at time of writing:
-- flow_packs=4, business_saved_flows=0, business_flows=1 (Averix), 0
-- businesses with active_flow_pack_id/active_saved_flow_id set. FK list
-- verified against live pg_constraint, not just migration files — nothing
-- else references any of these three tables.
--
-- Column drops first (removes the FKs on the referencing side), then the
-- now-unreferenced tables.
alter table businesses drop column active_flow_pack_id;
alter table businesses drop column active_saved_flow_id;

drop table business_saved_flows;
drop table flow_packs;
drop table business_flows;
