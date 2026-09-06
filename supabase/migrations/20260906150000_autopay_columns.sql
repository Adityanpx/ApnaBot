-- Autopay: map of price (in paise, as string key) to the Razorpay Plan ID
-- that represents that price+monthly cadence. New keys are created lazily
-- when admin edits a plan's price; old keys remain so existing subscribers
-- keep charging at their grandfathered amount.
alter table plans
  add column razorpay_plan_ids jsonb not null default '{}'::jsonb;

-- Autopay adds new lifecycle states and per-row context.

-- 1. Widen the status check to include the autopay states.
alter table subscriptions
  drop constraint subscriptions_status_check;

alter table subscriptions
  add constraint subscriptions_status_check
  check (status in (
    'trial',
    'active',
    'expired',
    'cancelled',
    'past_due',       -- last charge failed, inside 3-day grace, bot still works
    'paused',         -- grace expired without success, bot disabled
    'pending_start'   -- upgrade authorized, waiting for old sub's cycle to end
  ));

-- 2. Distinguish autopay subs from legacy one-time subs.
alter table subscriptions
  add column is_autopay boolean not null default false;

-- 3. Grace-period deadline (only set when status = 'past_due').
alter table subscriptions
  add column grace_until timestamptz;

-- 4. Mandated amount at time of authorization (in paise).
--    We store this because plan price can change; grandfathered subs must
--    keep charging the amount the customer actually approved.
alter table subscriptions
  add column mandated_amount_paise integer;

-- 5. For scheduled upgrades: points from old sub -> new (pending_start) sub.
alter table subscriptions
  add column scheduled_change_to uuid references subscriptions(id);

comment on column subscriptions.razorpay_subscription_id is
  'For is_autopay=true: Razorpay Subscription id (sub_XXX). For legacy is_autopay=false rows: historically stored Razorpay Order id (rzp_order_XXX) — do not rely on shape.';

-- ============================================
-- WEBHOOK_EVENTS — idempotency table
-- ============================================
-- Razorpay retries webhooks. If we extend end_date by one month on every
-- subscription.charged and Razorpay re-sends the same event, we would
-- double-extend. Store the event id and short-circuit repeats.
create table webhook_events (
  event_id text primary key,        -- Razorpay's own event id from payload
  event_type text not null,
  processed_at timestamptz not null default now()
);

create index idx_webhook_events_processed_at on webhook_events(processed_at);
