const { distance } = require('fastest-levenshtein');
const supabase = require('../config/supabase');
const redis = require('../config/redis');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');

/**
 * Adaptive edit-distance threshold for fuzzy keyword matching, scaled to
 * keyword length so short keywords (e.g. "hi") don't fuzzy-match everything.
 * @param {number} keywordLength
 * @returns {number}
 */
const fuzzyThresholdFor = (keywordLength) => {
  if (keywordLength <= 5) return 1;
  if (keywordLength <= 10) return 2;
  return 3;
};

/**
 * Get rules from cache or DB
 * @param {string} businessId - The business ID
 * @returns {Promise<Array>}
 */
const getRulesFromCache = async (businessId) => {
  const cacheKey = `rules:${businessId}`;

  try {
    // Try cache first
    const cachedRules = await redis.get(cacheKey);
    if (cachedRules) {
      return JSON.parse(cachedRules);
    }

    // Cache miss - query DB
    const { data, error } = await supabase
      .from('rules').select('*').eq('business_id', businessId).eq('is_active', true);
    if (error) throw error;
    const rules = (data || []).map(toCamelCase);

    // Store in Redis with 1 hour TTL
    await redis.set(cacheKey, JSON.stringify(rules), 'EX', 3600);

    return rules;
  } catch (error) {
    logger.error('Error in getRulesFromCache:', error);
    // On error, try to fetch from DB directly
    const { data } = await supabase
      .from('rules').select('*').eq('business_id', businessId).eq('is_active', true);
    return (data || []).map(toCamelCase);
  }
};

/**
 * Invalidate rules cache
 * @param {string} businessId - The business ID
 */
const invalidateRulesCache = async (businessId) => {
  const cacheKey = `rules:${businessId}`;

  try {
    await redis.del(cacheKey);
    logger.info(`Rules cache invalidated for business ${businessId}`);
  } catch (error) {
    logger.error('Error in invalidateRulesCache:', error);
  }
};

/**
 * Normalize text for matching
 * @param {string} text - Input text
 * @returns {string}
 */
const normalizeText = (text) => {
  if (!text) return '';

  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ');   // Collapse multiple spaces
};

/**
 * Fire-and-forget trigger_count increment via RPC (atomic on the DB side,
 * unlike a read-then-write). See supabase/migrations for
 * increment_rule_trigger_count.
 * @param {string} ruleId
 */
const incrementTriggerCount = (ruleId) => {
  supabase.rpc('increment_rule_trigger_count', { rule_id: ruleId })
    .then(({ error }) => {
      if (error) logger.error('Error incrementing trigger count:', error);
    })
    .catch(err => logger.error('Error incrementing trigger count:', err));
};

/**
 * Find matching rule for incoming message
 * @param {string} businessId - The business ID
 * @param {string} incomingText - The incoming message text
 * @returns {Promise<Object|null>}
 */
const findMatchingRule = async (businessId, incomingText) => {
  try {
    // Normalize the incoming text
    const normalizedText = normalizeText(incomingText);

    if (!normalizedText) {
      return null;
    }

    // Load rules from cache
    const rules = await getRulesFromCache(businessId);

    // Filter active rules only
    const activeRules = rules.filter(rule => rule.isActive);

    // Pass 1 - Exact match
    const exactMatch = activeRules.find(rule =>
      rule.matchType === 'exact' && normalizeText(rule.keyword) === normalizedText
    );

    if (exactMatch) {
      incrementTriggerCount(exactMatch.id);
      return exactMatch;
    }

    // Pass 2 - Starts with match
    const startsWithMatch = activeRules.find(rule =>
      rule.matchType === 'startsWith' && normalizedText.startsWith(normalizeText(rule.keyword))
    );

    if (startsWithMatch) {
      incrementTriggerCount(startsWithMatch.id);
      return startsWithMatch;
    }

    // Pass 3 - Contains match
    const containsMatch = activeRules.find(rule =>
      rule.matchType === 'contains' && normalizedText.includes(normalizeText(rule.keyword))
    );

    if (containsMatch) {
      incrementTriggerCount(containsMatch.id);
      return containsMatch;
    }

    // Pass 4 - Hindi/Hinglish alias match (last resort, after English matching fails)
    // Exact alias match first (highest confidence)
    const hindiExactMatch = activeRules.find(rule =>
      (rule.hindiAliases || []).some(alias => normalizeText(alias) === normalizedText)
    );

    if (hindiExactMatch) {
      incrementTriggerCount(hindiExactMatch.id);
      return hindiExactMatch;
    }

    // Contains match - customer's message contains an alias phrase anywhere in it
    const hindiContainsMatch = activeRules.find(rule =>
      (rule.hindiAliases || []).some(alias => {
        const normalizedAlias = normalizeText(alias);
        return normalizedAlias && normalizedText.includes(normalizedAlias);
      })
    );

    if (hindiContainsMatch) {
      incrementTriggerCount(hindiContainsMatch.id);
      return hindiContainsMatch;
    }

    // Pass 5 - Fuzzy match (last resort, free/local, no AI). Catches typos
    // and near-misses of the full keyword (e.g. "pric" vs "price") for
    // short customer messages — not substring fuzzy matching within longer
    // sentences, which produces too many false positives.
    let closestFuzzyMatch = null;
    let closestFuzzyDistance = Infinity;

    for (const rule of activeRules) {
      const normalizedKeyword = normalizeText(rule.keyword);
      if (!normalizedKeyword) continue;

      const editDistance = distance(normalizedText, normalizedKeyword);
      const threshold = fuzzyThresholdFor(normalizedKeyword.length);

      if (editDistance <= threshold && editDistance < closestFuzzyDistance) {
        closestFuzzyMatch = rule;
        closestFuzzyDistance = editDistance;
      }
    }

    if (closestFuzzyMatch) {
      incrementTriggerCount(closestFuzzyMatch.id);
      return closestFuzzyMatch;
    }

    // No match found
    return null;
  } catch (error) {
    logger.error('Error in findMatchingRule:', error);
    return null;
  }
};

module.exports = {
  getRulesFromCache,
  invalidateRulesCache,
  normalizeText,
  findMatchingRule
};
