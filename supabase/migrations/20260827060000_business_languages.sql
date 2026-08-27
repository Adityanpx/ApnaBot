-- Dynamic language selection for WhatsApp conversations. Business owners
-- choose up to 3 languages to offer (max-3 enforced at the application
-- layer, see business.controller.js - array-length constraints are awkward
-- in Postgres); a new customer picks their language on first contact and
-- the welcome message is sent in it. Rule replies, menu labels, and
-- fallbackReply stay English-only for now (separate follow-up phase).
alter table businesses
  add column enabled_languages text[] not null default '{en}',
  add column welcome_message_translations jsonb default null;

alter table customers
  add column preferred_language text default null;
