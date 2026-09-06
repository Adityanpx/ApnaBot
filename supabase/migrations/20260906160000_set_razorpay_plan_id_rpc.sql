-- Atomic jsonb-merge write for plans.razorpay_plan_ids, used by
-- getOrCreateRazorpayPlan (razorpaySubscriptions.service.js) so a
-- concurrent request for the same (plan, price) pair never creates two
-- Razorpay Plans for it. supabase-js's .update() cannot reference a
-- column's own current value (no `||` merge in the REST API), same gap
-- addressed for rules/wallet/broadcasts via increment_rule_trigger_count /
-- increment_wallet_balance / increment_broadcast_progress.
create or replace function set_razorpay_plan_id(p_plan_id uuid, p_price_key text, p_rzp_plan_id text)
returns void as $$
begin
  update plans
  set razorpay_plan_ids = razorpay_plan_ids || jsonb_build_object(p_price_key, p_rzp_plan_id)
  where id = p_plan_id;
end;
$$ language plpgsql;
