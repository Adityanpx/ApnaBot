-- Per-recipient template personalization for broadcasts. Previously
-- template_variables was a single static array shared by every recipient
-- (see broadcast.controller.js sendBroadcast). variable_mapping lets a
-- broadcast instead describe, per template position, whether to pull from
-- a recipient field (e.g. customer.name) or use a fixed value - resolved
-- per-recipient in broadcast.worker.js. Left null for broadcasts created
-- before this change, which keep using the old static template_variables.
alter table broadcasts add column variable_mapping jsonb default null;
