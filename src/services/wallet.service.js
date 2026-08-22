const supabase = require('../config/supabase');
const logger = require('../utils/logger');

/**
 * Get the business's wallet, creating it (balance 0) if it doesn't exist yet.
 * Every business gets a wallet automatically — there's no separate signup step.
 */
const getOrCreateWallet = async (businessId) => {
  const { data: existing, error: findErr } = await supabase
    .from('wallets').select('*').eq('business_id', businessId).maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing;

  const { data: created, error: createErr } = await supabase
    .from('wallets').insert({ business_id: businessId, balance_paise: 0 }).select().single();
  if (createErr) throw createErr;

  logger.info(`Wallet created for business ${businessId}`);
  return created;
};

const recordTransaction = async (walletId, type, amountPaise, balanceAfterPaise, referenceId, notes) => {
  const { error } = await supabase.from('wallet_transactions').insert({
    wallet_id: walletId,
    type,
    amount_paise: amountPaise,
    balance_after_paise: balanceAfterPaise,
    reference_id: referenceId || null,
    notes: notes || null
  });
  if (error) throw error;
};

/**
 * Credit a wallet (e.g. a Razorpay top-up). Atomic via increment_wallet_balance
 * so concurrent credits/debits on the same wallet can't race.
 */
const creditWallet = async (businessId, amountPaise, referenceId, notes) => {
  const wallet = await getOrCreateWallet(businessId);

  const { data: newBalance, error } = await supabase.rpc('increment_wallet_balance', {
    p_wallet_id: wallet.id,
    p_amount_paise: amountPaise
  });
  if (error) throw error;

  await recordTransaction(wallet.id, 'topup', amountPaise, newBalance, referenceId, notes);

  logger.info(`Wallet credited for business ${businessId}: +${amountPaise} paise`);
  return newBalance;
};

/**
 * Debit a wallet (e.g. broadcast billing). Atomic via decrement_wallet_balance,
 * which rejects the debit if it would take the balance negative.
 */
const debitWallet = async (businessId, amountPaise, referenceId, notes) => {
  const wallet = await getOrCreateWallet(businessId);

  const { data: newBalance, error } = await supabase.rpc('decrement_wallet_balance', {
    p_wallet_id: wallet.id,
    p_amount_paise: amountPaise
  });
  if (error) {
    if (error.message && error.message.includes('Insufficient')) {
      throw new Error('Insufficient wallet balance');
    }
    throw error;
  }

  await recordTransaction(wallet.id, 'broadcast_debit', amountPaise, newBalance, referenceId, notes);

  logger.info(`Wallet debited for business ${businessId}: -${amountPaise} paise`);
  return newBalance;
};

/**
 * Refund a prior debit back into the wallet (e.g. a failed broadcast send).
 */
const refundToWallet = async (businessId, amountPaise, referenceId, notes) => {
  const wallet = await getOrCreateWallet(businessId);

  const { data: newBalance, error } = await supabase.rpc('increment_wallet_balance', {
    p_wallet_id: wallet.id,
    p_amount_paise: amountPaise
  });
  if (error) throw error;

  await recordTransaction(wallet.id, 'broadcast_refund', amountPaise, newBalance, referenceId, notes);

  logger.info(`Wallet refunded for business ${businessId}: +${amountPaise} paise`);
  return newBalance;
};

module.exports = {
  getOrCreateWallet,
  creditWallet,
  debitWallet,
  refundToWallet
};
