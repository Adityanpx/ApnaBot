-- Free-text business hours and an optional footer line appended to
-- business-authored bot replies. Both nullable with no default — every
-- existing business gets null, meaning "not set."
alter table businesses add column business_hours text;
alter table businesses add column footer_message text;
