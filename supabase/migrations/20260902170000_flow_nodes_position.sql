-- Canvas position for the flow editor's node-graph view. Nullable — a node
-- with no saved position (every node that exists before this migration, and
-- any newly-created node the frontend hasn't dragged yet) falls back to
-- dagre auto-layout client-side, same behavior as today for every existing
-- node. Only ever written by PUT /api/flow-graph/full; no other endpoint
-- sets these.
alter table flow_nodes add column position_x numeric;
alter table flow_nodes add column position_y numeric;
