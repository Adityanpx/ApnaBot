-- ============================================
-- WALLETS + WALLET TRANSACTIONS
-- ============================================
-- Balances are stored in paise (integer), not rupees, matching Razorpay's own
-- unit — this avoids the float rounding errors a numeric/rupees column would
-- reintroduce at every credit/debit.
create table wallets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references businesses(id) on delete cascade,
  balance_paise bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references wallets(id) on delete cascade,
  type text not null check (type in ('topup','broadcast_debit','broadcast_refund')),
  amount_paise bigint not null,
  balance_after_paise bigint not null,
  reference_id text,   -- Razorpay payment id (topup) or broadcast id (debit/refund)
  notes text,
  created_at timestamptz not null default now()
);
create index idx_wallet_transactions_wallet_id on wallet_transactions(wallet_id, created_at desc);

create trigger trg_set_updated_at before update on wallets
  for each row execute function set_updated_at();

-- ============================================
-- ATOMIC BALANCE ADJUSTMENT RPCs
-- ============================================
-- Mirrors increment_rule_trigger_count's pattern: Supabase's REST API has no
-- built-in atomic increment/decrement, and wallet.service.js's creditWallet/
-- debitWallet need one to avoid read-then-write races across concurrent
-- top-ups and broadcast debits on the same wallet.
create or replace function increment_wallet_balance(p_wallet_id uuid, p_amount_paise bigint)
returns bigint as $$
declare
  new_balance bigint;
begin
  update wallets
  set balance_paise = balance_paise + p_amount_paise
  where id = p_wallet_id
  returning balance_paise into new_balance;

  if new_balance is null then
    raise exception 'Wallet % not found', p_wallet_id;
  end if;

  return new_balance;
end;
$$ language plpgsql;

-- Same shape as increment_wallet_balance, but rejects (raises, rolling back
-- the update) when the debit would take the balance below zero — this is
-- what lets debitWallet() throw instead of ever leaving a wallet negative.
create or replace function decrement_wallet_balance(p_wallet_id uuid, p_amount_paise bigint)
returns bigint as $$
declare
  new_balance bigint;
begin
  update wallets
  set balance_paise = balance_paise - p_amount_paise
  where id = p_wallet_id
  returning balance_paise into new_balance;

  if new_balance is null then
    raise exception 'Wallet % not found', p_wallet_id;
  end if;

  if new_balance < 0 then
    raise exception 'Insufficient wallet balance';
  end if;

  return new_balance;
end;
$$ language plpgsql;
