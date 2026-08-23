-- Meta's Template Management API requires an `example` (sample values) for
-- every {{n}} placeholder in a template's body before it can be submitted
-- for review. variable_samples stores those sample strings in variable
-- order (e.g. ["Rohan"] for a template with one {{1}}), set from the
-- ApnaBot app so submitMessageTemplate can build the `example` field
-- itself instead of requiring a manual edit in Meta's WhatsApp Manager UI.
alter table message_templates add column variable_samples jsonb default null;
