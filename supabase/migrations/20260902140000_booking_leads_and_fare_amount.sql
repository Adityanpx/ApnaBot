-- Reports feature: track when a booking session actually starts (a "lead"),
-- separately from whether it completes into a bookings row, plus persist
-- the quoted fare as a real column (previously only lived inside the
-- bookings.fields jsonb blob, unqueryable for aggregate reporting).
create table booking_leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index idx_booking_leads_business_created on booking_leads(business_id, created_at);

alter table bookings add column fare_amount numeric;
