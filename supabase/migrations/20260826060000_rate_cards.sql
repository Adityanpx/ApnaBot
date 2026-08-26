-- ============================================
-- RATE CARDS
-- ============================================
-- Meta's Tech-Provider billing charges Averix per message, varying by
-- destination country and message category, phased in over time (AI agent
-- messages from Aug 1 2026; service/utility-in-window from Oct 1 2026).
-- Rates live here as data, not hardcoded, so new countries/categories/price
-- changes don't require a deploy. Append-only: never update/delete a row,
-- so wallet_transactions stay traceable to the rate that was actually
-- charged at send time (see rateCard.service.js).
create table rate_cards (
  id uuid primary key default gen_random_uuid(),
  country_code text not null,
  category text not null check (category in
    ('marketing','utility','authentication','service','meta_business_agent')),
  price_paise integer not null check (price_paise >= 0),
  effective_from date not null,
  created_at timestamptz not null default now()
);
create index idx_rate_cards_lookup on rate_cards(country_code, category, effective_from desc);

insert into rate_cards (country_code, category, price_paise, effective_from)
values ('IN', 'marketing', 79, current_date);
