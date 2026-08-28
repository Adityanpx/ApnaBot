-- ============================================
-- BUSINESS FLOWS
-- ============================================
-- Per-business flow data: one row per business, holding both the keyword
-- rules and the booking field sequence that used to be read live from the
-- shared business_type_templates row. business_type_templates keeps its
-- existing role as the category starting point copied at business creation
-- (see business.service.js createBusiness) — it is no longer read at
-- runtime for an existing business. The `rules` table remains the source
-- the chatbot engine (chatbot.service.js) matches against directly; this
-- table is the editable flow definition the dashboard's flow editor and
-- booking-field reads (booking.service.js, rule.controller.js) work against.
create table business_flows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references businesses(id) on delete cascade,
  name text not null default 'Default',
  rules jsonb not null default '[]',           -- same shape as flow_packs.rules: [{keyword,matchType,hindiAliases,reply,replyType,replyImageUrl,buttons,listOptions}]
  booking_fields jsonb not null default '[]',  -- same shape as business_type_templates.booking_fields: [{fieldKey,label,labelTranslations,summaryLabel,required,order,fieldType,options:[{value,label,labelTranslations}]}]
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_business_flows_business_id on business_flows(business_id);

create trigger trg_set_updated_at before update on business_flows
  for each row execute function set_updated_at();
