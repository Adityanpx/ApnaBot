-- ============================================
-- EXTENSIONS
-- ============================================
create extension if not exists "pgcrypto";

-- Auto-update updated_at trigger, reused on every table
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================
-- USERS
-- ============================================
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  is_verified boolean not null default false,
  role text not null check (role in ('superadmin','owner','staff')),
  business_id uuid,   -- FK added after businesses exists, see ALTER below
  can_view_chats boolean not null default true,
  can_manage_rules boolean not null default false,
  can_manage_bookings boolean not null default true,
  can_view_customers boolean not null default true,
  can_manage_billing boolean not null default false,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================
-- BUSINESSES
-- ============================================
create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references users(id),
  business_category text not null check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels'
  )),
  whatsapp_number text,
  phone_number_id text unique,   -- partial-unique equivalent handled by allowing NULLs (Postgres unique already allows multiple NULLs)
  waba_id text,
  access_token text,
  display_name text,
  profile_image text,
  upi_id text,
  address text,
  city text,
  is_active boolean not null default true,
  is_whatsapp_connected boolean not null default false,
  webhook_verify_token text,
  fallback_reply text not null default 'Thank you for your message. We will get back to you shortly.',
  enable_smart_fallback boolean not null default false,
  welcome_message text default '',
  is_menu_enabled boolean not null default false,
  enable_distance_fares boolean not null default false,
  round_trip_per_day_km numeric not null default 250,
  round_trip_driver_da_enabled boolean not null default false,
  round_trip_driver_da_amount numeric not null default 0,
  preview_credits_used integer not null default 0,
  preview_credits_reset_at timestamptz,
  preview_credits_purchased integer not null default 0,
  menu_items jsonb not null default '[]',        -- [{number,label,ruleId,order}]
  disabled_booking_fields jsonb not null default '[]',  -- string[]
  served_cities jsonb not null default '[]',     -- string[]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table users add constraint users_business_id_fkey
  foreign key (business_id) references businesses(id);

create index idx_businesses_owner_user_id on businesses(owner_user_id);
create index idx_businesses_category on businesses(business_category);
create index idx_users_business_id on users(business_id);

-- ============================================
-- CUSTOMERS
-- ============================================
create table customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  whatsapp_number text not null,
  name text,
  first_seen_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  total_messages integer not null default 0,
  tags jsonb not null default '[]',
  notes text,
  is_blocked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, whatsapp_number)
);
create index idx_customers_business_id on customers(business_id);

-- ============================================
-- RULES
-- ============================================
create table rules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  keyword text not null,
  match_type text not null default 'contains' check (match_type in ('exact','contains','startsWith')),
  hindi_aliases jsonb not null default '[]',
  reply text not null,
  reply_image_url text,
  buttons jsonb not null default '[]',       -- [{title,nextKeyword}] max 3, enforce in app layer
  list_options jsonb not null default '[]',  -- [{label,description,nextKeyword}] max 10, enforce in app layer
  reply_type text not null default 'text' check (reply_type in ('text','booking_trigger','payment_trigger')),
  is_active boolean not null default true,
  trigger_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_rules_business_id on rules(business_id);
create index idx_rules_business_keyword on rules(business_id, keyword);

-- ============================================
-- BOOKINGS
-- ============================================
create table bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id),
  customer_number text not null,
  status text not null default 'pending' check (status in ('pending','confirmed','completed','cancelled')),
  booking_code text,
  fields jsonb not null default '{}',        -- session.fields snapshot — schema-flexible by design, keep as jsonb
  payment_status text not null default 'not_required' check (payment_status in ('pending','paid','not_required')),
  payment_amount numeric not null default 0,
  payment_link text,
  razorpay_order_id text,
  upi_link text,
  payment_id text,
  payment_details jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_bookings_business_id on bookings(business_id);
create index idx_bookings_business_status on bookings(business_id, status);
create index idx_bookings_business_created on bookings(business_id, created_at desc);
create index idx_bookings_customer_id on bookings(customer_id);

-- ============================================
-- VEHICLE TYPE CATALOG (global, not per-business)
-- ============================================
create table vehicle_type_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'sedan' check (type in ('hatchback','sedan','suv','tempo_traveller','mini_bus','bus','other')),
  photo_url text,
  seats integer,
  is_active boolean not null default true,
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_vtc_active_order on vehicle_type_catalog(is_active, "order");

-- ============================================
-- VEHICLES
-- ============================================
create table vehicles (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  owner_id uuid references users(id),
  catalog_id uuid not null references vehicle_type_catalog(id),
  custom_name text,
  custom_photo_url text,
  per_km_rate numeric,
  is_active boolean not null default true,
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_vehicles_business_id on vehicles(business_id);
create index idx_vehicles_business_active on vehicles(business_id, is_active);

-- ============================================
-- ROUTE FARES
-- ============================================
create table route_fares (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  from_city text not null,
  to_city text not null,
  trip_type text not null default 'oneway' check (trip_type in ('oneway','round_trip','outstation','local')),
  vehicle_id uuid not null references vehicles(id),
  fare numeric not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, from_city, to_city, trip_type, vehicle_id)
);
create index idx_route_fares_business_id on route_fares(business_id);

-- ============================================
-- RENTAL PACKAGES
-- ============================================
create table rental_packages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id),
  package_key text not null check (package_key in ('6HR_60KM','8HR_80KM','10HR_100KM','ENGAGE_12HR','ENGAGE_24HR')),
  label text,
  price numeric not null,
  extra_km_rate numeric,
  extra_hr_rate numeric,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_rental_packages_business_id on rental_packages(business_id);
create index idx_rental_packages_lookup on rental_packages(business_id, vehicle_id, package_key);

-- ============================================
-- BUSINESS TYPE TEMPLATES (global, seeded)
-- ============================================
create table business_type_templates (
  id uuid primary key default gen_random_uuid(),
  business_category text not null unique check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels'
  )),
  default_rules jsonb not null default '[]',   -- [{keyword,matchType,reply,replyType}]
  booking_fields jsonb not null default '[]',  -- [{fieldKey,label,summaryLabel,required,order,fieldType,options}]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================
-- FLOW PACKS (global, SuperAdmin-curated)
-- ============================================
create table flow_packs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text default '',
  category text not null check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','any'
  )),
  is_active boolean not null default true,
  rules jsonb not null default '[]',   -- full embedded rule objects incl. buttons/listOptions
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================
-- MESSAGES
-- ============================================
create table messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id),
  customer_number text not null,
  direction text not null check (direction in ('inbound','outbound')),
  type text not null default 'text' check (type in ('text','image','document','audio','interactive')),
  content text,
  media_url text,
  meta_message_id text,
  status text not null default 'sent' check (status in ('sent','delivered','read','failed')),
  is_read boolean not null default false,
  triggered_rule_id uuid references rules(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_messages_business_customer on messages(business_id, customer_id);
create index idx_messages_business_created on messages(business_id, created_at desc);
create index idx_messages_meta_message_id on messages(meta_message_id) where meta_message_id is not null;

-- ============================================
-- MESSAGE TEMPLATES
-- ============================================
create table message_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  category text not null default 'MARKETING' check (category in ('MARKETING','UTILITY')),
  language text not null default 'en',
  body_text text not null,
  variable_count integer not null default 0,
  meta_template_id text,
  status text not null default 'draft' check (status in ('draft','pending','approved','rejected')),
  rejection_reason text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_msg_templates_business_id on message_templates(business_id);
create index idx_msg_templates_business_status on message_templates(business_id, status);

-- ============================================
-- BROADCASTS
-- ============================================
create table broadcasts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  template_id uuid not null references message_templates(id),
  name text not null,
  audience_filter text not null default 'all_customers' check (audience_filter in ('all_customers')),
  template_variables jsonb not null default '[]',
  status text not null default 'draft' check (status in ('draft','scheduled','sending','completed','failed','cancelled')),
  scheduled_at timestamptz,
  total_recipients integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_broadcasts_business_id on broadcasts(business_id);
create index idx_broadcasts_business_status on broadcasts(business_id, status);

-- ============================================
-- USAGE
-- ============================================
create table usage (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  month text not null,   -- e.g. '2026-08'
  msg_count integer not null default 0,
  inbound_count integer not null default 0,
  outbound_count integer not null default 0,
  booking_count integer not null default 0,
  payment_link_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, month)
);

-- ============================================
-- PLANS
-- ============================================
create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  display_name text not null,
  price numeric not null check (price >= 0),
  msg_limit integer not null default -1,
  rule_limit integer not null default -1,
  customer_limit integer not null default -1,
  booking_enabled boolean not null default true,
  payment_link_enabled boolean not null default false,
  staff_enabled boolean not null default false,
  max_staff integer not null default 0,
  is_active boolean not null default true,
  razorpay_plan_id text,   -- add now since you're building auto-pay next
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================
-- SUBSCRIPTIONS
-- ============================================
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  plan_id uuid not null references plans(id),
  status text not null default 'trial' check (status in ('trial','active','expired','cancelled')),
  start_date timestamptz not null,
  end_date timestamptz not null,
  razorpay_subscription_id text,
  razorpay_payment_id text,
  auto_renew boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_subscriptions_business_id on subscriptions(business_id);
create index idx_subscriptions_status on subscriptions(status);
create index idx_subscriptions_end_date on subscriptions(end_date);

-- ============================================
-- updated_at TRIGGERS (all tables)
-- ============================================
do $$
declare t text;
begin
  for t in
    select unnest(array[
      'users','businesses','customers','rules','bookings','vehicle_type_catalog',
      'vehicles','route_fares','rental_packages','business_type_templates','flow_packs',
      'messages','message_templates','broadcasts','usage','plans','subscriptions'
    ])
  loop
    execute format('create trigger trg_set_updated_at before update on %I
      for each row execute function set_updated_at();', t);
  end loop;
end $$;