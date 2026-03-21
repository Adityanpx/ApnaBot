const Rule = require('../models/Rule');
const redis = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Get rules from cache or DB
 * @param {string} shopId - The shop ID
 * @returns {Promise<Array>}
 */
const getRulesFromCache = async (shopId) => {
  const cacheKey = `rules:${shopId}`;

  try {
    // Try cache first
    const cachedRules = await redis.get(cacheKey);
    if (cachedRules) {
      return JSON.parse(cachedRules);
    }

    // Cache miss - query DB
    const rules = await Rule.find({ shopId, isActive: true });

    // Store in Redis with 1 hour TTL
    await redis.set(cacheKey, JSON.stringify(rules), 'EX', 3600);

    return rules;
  } catch (error) {
    logger.error('Error in getRulesFromCache:', error);
    // On error, try to fetch from DB directly
    return Rule.find({ shopId, isActive: true });
  }
};

/**
 * Invalidate rules cache
 * @param {string} shopId - The shop ID
 */
const invalidateRulesCache = async (shopId) => {
  const cacheKey = `rules:${shopId}`;

  try {
    await redis.del(cacheKey);
    logger.info(`Rules cache invalidated for shop ${shopId}`);
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
 * Find matching rule for incoming message
 * @param {string} shopId - The shop ID
 * @param {string} incomingText - The incoming message text
 * @returns {Promise<Object|null>}
 */
const findMatchingRule = async (shopId, incomingText) => {
  try {
    // Normalize the incoming text
    const normalizedText = normalizeText(incomingText);

    if (!normalizedText) {
      return null;
    }

    // Load rules from cache
    const rules = await getRulesFromCache(shopId);

    // Filter active rules only
    const activeRules = rules.filter(rule => rule.isActive);

    // Sort by priority (lower priority = higher importance)
    activeRules.sort((a, b) => a.priority - b.priority);

    // Pass 1 - Exact match
    const exactMatch = activeRules.find(rule => 
      rule.matchType === 'exact' && normalizeText(rule.keyword) === normalizedText
    );

    if (exactMatch) {
      // Increment trigger count (fire and forget)
      Rule.findByIdAndUpdate(exactMatch._id, { $inc: { triggerCount: 1 } })
        .catch(err => logger.error('Error incrementing trigger count:', err));
      return exactMatch;
    }

    // Pass 2 - Starts with match
    const startsWithMatch = activeRules.find(rule =>
      rule.matchType === 'startsWith' && normalizedText.startsWith(normalizeText(rule.keyword))
    );

    if (startsWithMatch) {
      Rule.findByIdAndUpdate(startsWithMatch._id, { $inc: { triggerCount: 1 } })
        .catch(err => logger.error('Error incrementing trigger count:', err));
      return startsWithMatch;
    }

    // Pass 3 - Contains match
    const containsMatch = activeRules.find(rule =>
      rule.matchType === 'contains' && normalizedText.includes(normalizeText(rule.keyword))
    );

    if (containsMatch) {
      Rule.findByIdAndUpdate(containsMatch._id, { $inc: { triggerCount: 1 } })
        .catch(err => logger.error('Error incrementing trigger count:', err));
      return containsMatch;
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
