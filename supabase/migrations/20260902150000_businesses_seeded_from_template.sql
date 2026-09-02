-- Tracks which flow_snapshots category template (if any) a business was
-- seeded from at signup. Null means either no active template existed for
-- that category at signup time, or the business predates this tracking.
-- Set once in business.service.js#createBusiness, never updated afterward
-- (not in businessFieldMap, so updateBusiness can't touch it).
alter table businesses add column seeded_from_template_name text;
