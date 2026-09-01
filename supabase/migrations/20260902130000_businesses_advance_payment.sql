-- Advance-payment collection toggle. type/value are only meaningful when
-- require_advance_payment is true; left nullable rather than not-null
-- since a business with the toggle off never needs them — validated at
-- the app layer (business.controller.js) that both are set together
-- whenever the toggle is turned on.
alter table businesses
  add column require_advance_payment boolean not null default false,
  add column advance_payment_type text check (advance_payment_type in ('fixed', 'percentage')),
  add column advance_payment_value numeric;
