-- Atomic trigger_count increment for rules, used by chatbot.service.js's
-- fire-and-forget increment after a rule match. Supabase's REST API has no
-- built-in atomic increment (Mongoose's $inc was atomic), so this replaces it.
create or replace function increment_rule_trigger_count(rule_id uuid)
returns void as $$
begin
  update rules set trigger_count = trigger_count + 1 where id = rule_id;
end;
$$ language plpgsql;
