-- Lets a business owner snapshot their current rules as a named personal
-- backup they can restore later. Private to the business (unlike flow_packs,
-- which is superadmin-curated and shared platform-wide).
create table business_saved_flows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  rules jsonb not null,
  created_at timestamptz not null default now(),
  unique (business_id, name)
);
create index idx_business_saved_flows_business_id on business_saved_flows(business_id);

-- Mirrors active_flow_pack_id: which saved snapshot (if any) a business
-- currently has active. Mutually exclusive with active_flow_pack_id — only
-- one "currently active" source at a time (see savedFlow.controller.js and
-- flowPackPublic.controller.js).
alter table businesses
  add column active_saved_flow_id uuid references business_saved_flows(id) on delete set null;
