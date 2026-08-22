-- Atomic sent_count/failed_count increment for broadcasts, used by
-- broadcast.worker.js after each batch finishes sending. Supabase's REST API
-- has no built-in atomic increment (same gap addressed for rules by
-- increment_rule_trigger_count), and here it matters more: many BullMQ jobs
-- fan out from a single broadcast row and can update it concurrently.
--
-- Also flips status -> 'completed' (and stamps completed_at) in the same
-- statement once every recipient has been accounted for, so the last batch
-- to finish - whichever one that is - closes out the broadcast without a
-- separate read-then-write race.
create or replace function increment_broadcast_progress(p_broadcast_id uuid, p_sent_delta int, p_failed_delta int)
returns void as $$
begin
  update broadcasts
  set sent_count = sent_count + p_sent_delta,
      failed_count = failed_count + p_failed_delta,
      status = case
        when sent_count + p_sent_delta + failed_count + p_failed_delta >= total_recipients
          then 'completed'
        else status
      end,
      completed_at = case
        when sent_count + p_sent_delta + failed_count + p_failed_delta >= total_recipients
          then now()
        else completed_at
      end
  where id = p_broadcast_id;
end;
$$ language plpgsql;
