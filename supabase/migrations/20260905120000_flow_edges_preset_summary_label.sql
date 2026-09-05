-- Adds an optional "summaryLabel" key to flow_edges.preset so a template
-- author can give a preset a confirmation-text label distinct from the
-- edge's own button/list-row label (matched.label) — which is a button
-- caption ("Apply Now"), not a description of the field being answered.
-- Without summaryLabel set, bookingGraph.service.js falls back to a
-- humanized version of preset.field. See flow_edges_preset_shape's
-- original comment for the base shape; this only adds the new optional key.
alter table flow_edges drop constraint flow_edges_preset_shape;

alter table flow_edges add constraint flow_edges_preset_shape check (
  preset is null or (
    (preset ? 'field') and (preset ? 'value') and
    (not (preset ? 'summaryLabel') or jsonb_typeof(preset->'summaryLabel') = 'string')
  )
);

comment on column flow_edges.preset is
  '{"field": "<booking field_key>", "value": "<value>", "summaryLabel": "<optional display label>"}, '
  'or null. Applied to session.collected when this edge is traversed, so the '
  'question chain skips asking for that field. summaryLabel, if set, is used '
  'in the confirmation-text summary instead of a humanized field key. See '
  'flow_edges_preset_shape.';
