-- flow_edges had no column to persist a rendered order for a node's
-- outgoing edges (button/list row order, or which conditional branch is
-- considered "first"). chatbot.service.js's getOutgoingEdges has been
-- ordering by created_at as a stand-in, which happens to work for
-- migrateFlowGraph.js's single-batch inserts but isn't a real sort key —
-- adding this now, before any flow-editor reordering UI or
-- booking.service.js's graph-traversal rewrite gets built assuming
-- created_at ordering.
alter table flow_edges add column display_order integer not null default 0;
