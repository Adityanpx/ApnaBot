-- SuperAdmin-controlled business category list, replacing the two hardcoded
-- VALID_BUSINESS_CATEGORIES / VALID_CATEGORIES arrays in business.controller.js
-- and categoryTemplate.controller.js. is_enabled controls whether a category
-- is offered at signup (createBusiness); disabled categories can still be
-- used for category templates (SuperAdmin building ahead of launch).
create table business_categories (
  value text primary key,
  label text not null,
  icon text not null default '',
  is_enabled boolean not null default false,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seed with the existing 20-value category list (same list as
-- businesses_business_category_check / flow_snapshots_category_check),
-- plus two new categories (both start disabled). Only 'travels',
-- 'software_it' and 'general' match the current live signup options.
insert into business_categories (value, label, icon, is_enabled, display_order) values
  ('tailor', 'Tailor', '', false, 10),
  ('salon', 'Salon', '', false, 20),
  ('garage', 'Garage', '', false, 30),
  ('cab', 'Cab', '', false, 40),
  ('coaching', 'Coaching', '', false, 50),
  ('gym', 'Gym', '', false, 60),
  ('medical', 'Medical', '', false, 70),
  ('general', 'General', '', true, 80),
  ('photographer', 'Photographer', '', false, 90),
  ('caterer', 'Caterer', '', false, 100),
  ('tutor', 'Tutor', '', false, 110),
  ('jeweller', 'Jeweller', '', false, 120),
  ('boutique', 'Boutique', '', false, 130),
  ('grocery', 'Grocery', '', false, 140),
  ('bakery', 'Bakery', '', false, 150),
  ('electronics_repair', 'Electronics Repair', '', false, 160),
  ('real_estate', 'Real Estate', '', false, 170),
  ('driving_school', 'Driving School', '', false, 180),
  ('travels', 'Travels', '', true, 190),
  ('software_it', 'Software / IT', '', true, 195),
  ('maha_eseva_kendra', 'Maha eSeva Kendra', '🏛️', false, 200),
  ('tax_consultant', 'Tax Consultant', '📋', false, 210)
on conflict (value) do nothing;
