-- messages.triggered_rule_id had no ON DELETE behavior (default RESTRICT),
-- which blocked deleting any rule that had ever been triggered. Messages are
-- historical chat logs and should persist even after the triggering rule is
-- deleted or replaced (e.g. restoreSavedFlow/importFlowPack wiping a
-- business's rules before reapplying a flow) - they should just lose the
-- reference instead of blocking the delete.
alter table messages
  drop constraint messages_triggered_rule_id_fkey;

alter table messages
  add constraint messages_triggered_rule_id_fkey
  foreign key (triggered_rule_id) references rules(id) on delete set null;
