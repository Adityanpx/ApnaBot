const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const ALLOWED_CATEGORIES = ['marketing', 'utility', 'authentication', 'service', 'meta_business_agent'];

/**
 * GET /api/admin/rate-cards
 */
const getRateCards = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('rate_cards').select('*')
      .order('country_code', { ascending: true })
      .order('category', { ascending: true })
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { rateCards: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getRateCards:', error);
    next(error);
  }
};

/**
 * POST /api/admin/rate-cards
 * Append-only: inserts a new rate row, never updates/deletes, so
 * wallet_transactions stay traceable to whatever rate was actually charged.
 */
const createRateCard = async (req, res, next) => {
  try {
    const { country_code: countryCode, category, price_paise: pricePaise, effective_from: effectiveFrom } = req.body;

    if (!countryCode || typeof countryCode !== 'string') {
      return errorResponse(res, 400, 'country_code is required');
    }
    if (!ALLOWED_CATEGORIES.includes(category)) {
      return errorResponse(res, 400, `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
    }
    if (!Number.isInteger(pricePaise) || pricePaise < 0) {
      return errorResponse(res, 400, 'price_paise must be a non-negative integer');
    }
    if (!effectiveFrom || isNaN(Date.parse(effectiveFrom))) {
      return errorResponse(res, 400, 'effective_from must be a valid date');
    }

    const { data, error } = await supabase.from('rate_cards').insert({
      country_code: countryCode,
      category,
      price_paise: pricePaise,
      effective_from: effectiveFrom
    }).select().single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(data), 'Rate card created successfully');
  } catch (error) {
    logger.error('Error in createRateCard:', error);
    next(error);
  }
};

module.exports = { getRateCards, createRateCard };
