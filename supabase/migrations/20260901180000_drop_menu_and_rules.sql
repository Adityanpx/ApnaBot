-- Kill the numbered-menu feature and the dead old-engine "rules" table.
-- Structurally wired but functionally dead since the graph-engine cutover:
-- nothing writes to `rules` anymore (chatbot.service.js's findMatchingRule
-- matches against flow_nodes, see 20260829140000_flow_nodes_edges.sql), so
-- the menu picker (businesses.is_menu_enabled/menu_items -> rules.id) has
-- always been empty in practice. Its only frontend consumer (apnabot-web's
-- onboarding MenuStep) is being removed in a companion change; the
-- getRules/createRule/updateRule/deleteRule/toggleRule/uploadRuleImage/
-- translateRules routes had zero other callers.
--
-- FK check: messages.triggered_rule_id had a hard FK to rules(id), but that
-- was already dropped in 20260829170000_messages_triggered_rule_id_drop_fk.sql
-- (the column is now an unenforced historical uuid) — confirmed via a full
-- read of the migration history; no live pg_constraint query was available
-- in this environment to double-check against the running DB (only the
-- supabase-js REST client is configured here, no raw-SQL/psql access).
--
-- increment_rule_trigger_count(uuid) (20260820125619) is dropped too — it's
-- an orphaned function with zero JS callers left (superseded by
-- increment_flow_node_trigger_count, 20260829160000), and its body directly
-- references the table being dropped here.
--
-- Column drops first (removes the menu config on the referencing side),
-- then the function, then the now-unreferenced table.
alter table businesses drop column is_menu_enabled;
alter table businesses drop column menu_items;

drop function increment_rule_trigger_count(uuid);

drop table rules;
