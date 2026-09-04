-- Lets an edge carry a field/value pair that gets written into
-- session.collected whenever the edge is traversed — whether by a customer
-- tapping the button/list row it represents, or by the question chain's own
-- conditional walk (bookingGraph.service.js's pickNextNodeId). Lets the flow
-- author skip a field entirely for a given branch (e.g. an "Airport
-- Transfer" button presets tripType without a question node ever asking for
-- it) instead of the customer being asked a question whose answer the
-- branch already implies.
--
-- Nullable with no default — every existing edge gets preset = null, so
-- traversal behavior is unchanged until someone explicitly sets one.
--
-- Shape mirrors flow_edges_condition_shape, but unlike condition.field,
-- preset.field is deliberately NOT checked against this business's known
-- question-node field_keys anywhere in the app layer — a preset is
-- specifically for a field with NO question node asking for it, so that
-- check would incorrectly reject every valid preset.
alter table flow_edges add column preset jsonb;

alter table flow_edges add constraint flow_edges_preset_shape check (
  preset is null or ((preset ? 'field') and (preset ? 'value'))
);

comment on column flow_edges.preset is
  '{"field": "<booking field_key>", "value": "<value>"}, or null. Applied to '
  'session.collected when this edge is traversed, so the question chain '
  'skips asking for that field. See flow_edges_preset_shape.';
