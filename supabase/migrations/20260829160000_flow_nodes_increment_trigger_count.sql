-- Atomic trigger_count increment for flow_nodes, mirroring
-- increment_rule_trigger_count (see 20260820125619_rules_increment_trigger_count.sql)
-- for the chatbot engine's new flow_nodes-based matching path
-- (chatbot.service.js findMatchingRule). The old RPC stays as-is and keeps
-- serving the rules-table CRUD surface (rule.controller.js etc.) until that
-- is migrated too — this is an addition, not a replacement.
create or replace function increment_flow_node_trigger_count(node_id uuid)
returns void as $$
begin
  update flow_nodes set trigger_count = trigger_count + 1 where id = node_id;
end;
$$ language plpgsql;
