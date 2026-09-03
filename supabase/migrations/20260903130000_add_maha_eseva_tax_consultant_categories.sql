-- Adds 'maha_eseva_kendra' and 'tax_consultant' to the two CHECK constraints
-- that still enumerate the old 20-value category list as a literal set
-- (businesses_business_category_check, flow_snapshots_category_check).
-- business_type_templates_business_category_check and flow_packs_category_check
-- also enumerate this list but are dead tables (no live reads/writes in src/
-- as of this migration) and are intentionally left untouched.
alter table businesses drop constraint businesses_business_category_check;
alter table businesses add constraint businesses_business_category_check
  check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant'
  ));

alter table flow_snapshots drop constraint flow_snapshots_category_check;
alter table flow_snapshots add constraint flow_snapshots_category_check
  check (category is null or category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it',
    'maha_eseva_kendra','tax_consultant'
  ));
