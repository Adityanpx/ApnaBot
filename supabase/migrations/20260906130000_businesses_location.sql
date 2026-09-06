-- Business's own location, sent to customers as a WhatsApp map pin (a
-- reply node with content_type='location', or a booking-flow question node
-- of the same type). Nullable with no default -- every existing business
-- gets null, meaning "not set" (webhook.controller.js falls back to a plain
-- text reply when null rather than sending a broken/empty location message).
-- double precision, not numeric: supabase-js returns numeric columns as JS
-- strings, which would need an explicit parseFloat before going into the
-- Meta API's location.latitude/longitude JSON fields.
alter table businesses add column business_latitude double precision;
alter table businesses add column business_longitude double precision;
