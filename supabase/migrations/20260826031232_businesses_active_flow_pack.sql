-- Tracks which flow pack (if any) a business currently has active, so the
-- frontend can show "Currently using: X" instead of a flat list with no
-- indication of current state. Cleared to null whenever rules are hand-edited
-- (see rule.controller.js), since manual edits mean the rules have diverged
-- from whatever pack was last imported.
alter table businesses
  add column active_flow_pack_id uuid references flow_packs(id) on delete set null;
