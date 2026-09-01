-- Add duration_options JSONB column to plans table
-- Each plan can have multiple billing durations with different prices
-- Default is a single monthly option using the existing price column
alter table plans
  add column duration_options jsonb;

-- Backfill existing plans: create a single monthly duration option from current price
update plans
set duration_options = jsonb_build_array(
  jsonb_build_object(
    'months', 1,
    'price', price,
    'label', 'Monthly',
    'discount', 0
  )
);

-- Make it NOT NULL after backfill
alter table plans
  alter column duration_options set not null,
  alter column duration_options set default '[{"months":1,"price":0,"label":"Monthly","discount":0}]'::jsonb;
