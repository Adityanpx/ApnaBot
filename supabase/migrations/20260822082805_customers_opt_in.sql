-- Marketing opt-in tracking for customers.
--
-- opted_in / opted_in_at / opt_in_source are about MARKETING consent, not the
-- 24h WhatsApp customer-service window. A 'customer_initiated' source (e.g.
-- customer messages the bot first) only proves service-window consent per
-- WhatsApp policy — it must NOT auto-set opted_in = true. Marketing opt-in
-- requires an explicit action (manual staff entry or a website form), so
-- opted_in defaults to false and is only flipped by the application layer
-- when source is 'manual' or 'website_form'.
alter table customers
  add column opted_in boolean not null default false,
  add column opted_in_at timestamptz,
  add column opt_in_source text check (opt_in_source in ('customer_initiated', 'manual', 'website_form'));
