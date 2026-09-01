-- Phase 1 of flow-snapshots: personal per-business flow versioning AND
-- SuperAdmin-owned category starter templates share this one table,
-- distinguished by is_category_template.
--
--   is_category_template = false (personal snapshot): business_id set,
--     category null. A point-in-time copy of one business's own
--     flow_nodes/flow_edges, saved/restored/deleted only by that business's
--     owner via /api/flow-graph/snapshots.
--   is_category_template = true (category starter template): business_id
--     null, category set. SuperAdmin-owned, one (not DB-enforced) per
--     category, managed via /api/admin/category-templates and copied into
--     a business's flow_nodes/flow_edges either at signup
--     (business.service.js#createBusiness) or on-demand via
--     POST /api/flow-graph/snapshots/import-category-template.
--
-- Same nodes/edges jsonb full-row-array storage as before (see this
-- table's original comment in 20260829140000_flow_nodes_edges.sql) — this
-- migration only widens who a row can belong to, not how a row stores a
-- graph.
alter table flow_snapshots alter column business_id drop not null;

alter table flow_snapshots add column category text;
alter table flow_snapshots add column is_category_template boolean not null default false;

-- Same 20-value list as businesses_business_category_check
-- (20260828090000_add_software_it_business_category.sql) — NOT flow_packs'
-- list, which also has 'any'. Keep both lists in sync if either changes.
alter table flow_snapshots add constraint flow_snapshots_category_check
  check (category is null or category in (
    'tailor','salon','garage','cab','coaching','gym','medical','general',
    'photographer','caterer','tutor','jeweller','boutique','grocery','bakery',
    'electronics_repair','real_estate','driving_school','travels','software_it'
  ));

-- Exactly one of (business_id) / (category) is set, matched to
-- is_category_template — never both, never neither.
alter table flow_snapshots add constraint flow_snapshots_template_xor_business check (
  (is_category_template = true and business_id is null and category is not null) or
  (is_category_template = false and business_id is not null and category is null)
);

create index idx_flow_snapshots_category_template on flow_snapshots(category) where is_category_template = true;
