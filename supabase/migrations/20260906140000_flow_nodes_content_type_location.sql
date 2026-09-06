-- Allow content_type='location' on flow_nodes (reply nodes that send the
-- business's own saved coordinates as a WhatsApp map pin, and question nodes
-- of the same type), alongside the existing text/buttons/list. The API-layer
-- VALID_CONTENT_TYPES check in flowGraph.controller.js mirrors this
-- constraint, same as it already does for flow_edges.condition/preset shape.
alter table flow_nodes drop constraint flow_nodes_content_type_check;
alter table flow_nodes add constraint flow_nodes_content_type_check
  check (content_type in ('text','buttons','list','location'));
