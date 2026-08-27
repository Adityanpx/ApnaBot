-- Per-language rule reply text, mirroring businesses.welcome_message_translations.
-- Button/list option translations do NOT get their own column - they live
-- inside the existing rules.buttons / rules.list_options jsonb arrays, as a
-- titleTranslations / labelTranslations / descriptionTranslations key on
-- each option object, alongside their untranslated nextKeyword which must
-- never be translated (it's the matching key returned in button_reply.id).
alter table rules
  add column reply_translations jsonb default null;
