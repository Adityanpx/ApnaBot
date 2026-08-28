-- Adds 'software_it' as a valid business_category/category value.
-- Three separate CHECK constraints enumerate the same category list
-- (businesses, business_type_templates, flow_packs) — all three must be
-- updated together or an insert/seed using 'software_it' will be rejected.
alter table businesses drop constraint businesses_business_category_check;
alter table businesses add constraint businesses_business_category_check
  check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it'
  ));

alter table business_type_templates drop constraint business_type_templates_business_category_check;
alter table business_type_templates add constraint business_type_templates_business_category_check
  check (business_category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it'
  ));

alter table flow_packs drop constraint flow_packs_category_check;
alter table flow_packs add constraint flow_packs_category_check
  check (category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','any','software_it'
  ));
