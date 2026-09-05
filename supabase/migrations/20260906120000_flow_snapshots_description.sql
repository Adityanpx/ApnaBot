-- Multiple category templates per category are now allowed (business
-- owners pick from a list instead of getting one fixed template per
-- category) — see flowSnapshot.controller.js#getCategoryTemplateOptions
-- and categoryTemplate.controller.js#cloneFromBusiness. `description` is a
-- short blurb shown to business owners choosing between templates for
-- their category, e.g. "Full-service CSC center with 17 government
-- services" vs "Compact starter with just the most common services".
alter table flow_snapshots add column description text;
