const supabase = require('../config/supabase');

/**
 * Looks up the applicable rate for a message: the row with the latest
 * effective_from <= today for this (country_code, category) pair. Returns
 * 0 (free) when no row matches yet — Meta's phased rollout means most
 * categories have no rate_cards row until their charging date arrives.
 */
const getRateForMessage = async (countryCode, category) => {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('rate_cards').select('price_paise')
    .eq('country_code', countryCode)
    .eq('category', category)
    .lte('effective_from', today)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  return data ? data.price_paise : 0;
};

module.exports = { getRateForMessage };
