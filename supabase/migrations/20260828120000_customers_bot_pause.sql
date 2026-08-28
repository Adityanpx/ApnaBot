-- Per-customer bot pause. A single nullable timestamp instead of a separate
-- boolean: null or a past timestamp means the bot is active, a future
-- timestamp means the bot stays silent for that customer until then.
alter table customers
  add column bot_paused_until timestamptz;
