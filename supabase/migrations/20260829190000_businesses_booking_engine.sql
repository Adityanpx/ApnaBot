-- Explicit gate for which booking engine a business runs on, replacing
-- "does this business have any flow_nodes rows" inference (which breaks
-- the moment a business can have a graph created for it from scratch, or
-- transiently has zero rows mid-edit). 'legacy' = rules/business_flows
-- (booking.service.js's session.step/session.fields engine). 'graph' =
-- flow_nodes/flow_edges (bookingGraph.service.js). See PRD.md "Current
-- architecture" for the two-engine split this column formalizes.
alter table businesses
  add column booking_engine text not null default 'legacy'
    check (booking_engine in ('legacy', 'graph'));

-- Backfill: SG Travels is the one business actually migrated to the graph
-- engine so far (migrateFlowGraph.js, run once; webhook.controller.js's
-- Step 12 wired in as of commit c029f23). Every other business, including
-- Averix Solutions, stays on the default 'legacy'.
update businesses
  set booking_engine = 'graph'
  where id = '5a2e3771-b877-4ff8-bd8a-0924c6b9dc0c';
