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
 * Get reply-trigger flow nodes from cache or DB
 * @param {string} businessId - The business ID
 * @returns {Promise<Array>}
 */
const getRulesFromCache = async (businessId) => {
  const cacheKey = `flow:${businessId}`;

  try {
    // Try cache first
    const cachedNodes = await redis.get(cacheKey);
    if (cachedNodes) {
      return JSON.parse(cachedNodes);
    }

    // Cache miss - query DB
    const { data, error } = await supabase
      .from('flow_nodes').select('*').eq('business_id', businessId).eq('node_type', 'reply').eq('is_active', true);
    if (error) throw error;
    const nodes = (data || []).map(toCamelCase);

    // Store in Redis with 1 hour TTL
    await redis.set(cacheKey, JSON.stringify(nodes), 'EX', 3600);

    return nodes;
  } catch (error) {
    logger.error('Error in getRulesFromCache:', error);
    // On error, try to fetch from DB directly
    const { data } = await supabase
      .from('flow_nodes').select('*').eq('business_id', businessId).eq('node_type', 'reply').eq('is_active', true);
    return (data || []).map(toCamelCase);
  }
};

/**
 * Invalidate the reply-trigger flow node cache
 * @param {string} businessId - The business ID
 */
const invalidateRulesCache = async (businessId) => {
  const cacheKey = `flow:${businessId}`;

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
 * increment_flow_node_trigger_count.
 * @param {string} nodeId
 */
const incrementTriggerCount = (nodeId) => {
  supabase.rpc('increment_flow_node_trigger_count', { node_id: nodeId })
    .then(({ error }) => {
      if (error) logger.error('Error incrementing trigger count:', error);
    })
    .catch(err => logger.error('Error incrementing trigger count:', err));
};

/**
 * Fetch a reply node's outgoing button/list edges, live (not cached — see
 * findMatchingRule). Each edge is annotated with `nextKeyword`, resolved
 * from its to_node_id against the business's cached reply-node list, so
 * callers can keep building the same {title, nextKeyword} / {label,
 * description, nextKeyword} shape whatsapp.service.js's outbound button/list
 * senders already expect (button/list row id = nextKeyword, until the
 * edge-id-based scheme lands).
 * @param {string} nodeId - the matched reply node's id (from_node_id)
 * @param {Array} nodes - this business's cached active reply nodes (for keyword lookup)
 * @param {string} businessId - for error logging only
 * @returns {Promise<Array>}
 */
const getOutgoingEdges = async (nodeId, nodes, businessId) => {
  const { data, error } = await supabase
    .from('flow_edges').select('*').eq('from_node_id', nodeId)
    .order('display_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) {
    logger.error('Error fetching outgoing flow edges:', error);
    return [];
  }

  const keywordByNodeId = new Map(nodes.map(node => [node.id, node.keyword]));

  return (data || []).map(toCamelCase).map(edge => {
    const nextKeyword = keywordByNodeId.get(edge.toNodeId);
    if (!nextKeyword) {
      logger.error(`flow_edges row ${edge.id} (business ${businessId}) targets node ${edge.toNodeId}, which isn't an active reply node — its button/list row will have no working id`);
    }
    return { ...edge, nextKeyword: nextKeyword || null };
  });
};

/**
 * Find matching reply-trigger flow node for incoming message
 * @param {string} businessId - The business ID
 * @param {string} incomingText - The incoming message text
 * @returns {Promise<{node: Object, edges: Array}|null>}
 */
const findMatchingRule = async (businessId, incomingText) => {
  try {
    // Normalize the incoming text
    const normalizedText = normalizeText(incomingText);

    if (!normalizedText) {
      return null;
    }

    // Load reply nodes from cache
    const nodes = await getRulesFromCache(businessId);

    // Filter active nodes only
    const activeNodes = nodes.filter(node => node.isActive);

    // Pass 1 - Exact match
    let matchedNode = activeNodes.find(node =>
      node.matchType === 'exact' && normalizeText(node.keyword) === normalizedText
    );

    // Pass 2 - Starts with match
    if (!matchedNode) {
      matchedNode = activeNodes.find(node =>
        node.matchType === 'startsWith' && normalizedText.startsWith(normalizeText(node.keyword))
      );
    }

    // Pass 3 - Contains match
    if (!matchedNode) {
      matchedNode = activeNodes.find(node =>
        node.matchType === 'contains' && normalizedText.includes(normalizeText(node.keyword))
      );
    }

    // Pass 4 - Hindi/Hinglish alias match (last resort, after English matching fails)
    // Exact alias match first (highest confidence)
    if (!matchedNode) {
      matchedNode = activeNodes.find(node =>
        (node.hindiAliases || []).some(alias => normalizeText(alias) === normalizedText)
      );
    }

    // Contains match - customer's message contains an alias phrase anywhere in it
    if (!matchedNode) {
      matchedNode = activeNodes.find(node =>
        (node.hindiAliases || []).some(alias => {
          const normalizedAlias = normalizeText(alias);
          return normalizedAlias && normalizedText.includes(normalizedAlias);
        })
      );
    }

    // Pass 5 - Fuzzy match (last resort, free/local, no AI). Catches typos
    // and near-misses of the full keyword (e.g. "pric" vs "price") for
    // short customer messages — not substring fuzzy matching within longer
    // sentences, which produces too many false positives.
    if (!matchedNode) {
      let closestFuzzyMatch = null;
      let closestFuzzyDistance = Infinity;

      for (const node of activeNodes) {
        const normalizedKeyword = normalizeText(node.keyword);
        if (!normalizedKeyword) continue;

        const editDistance = distance(normalizedText, normalizedKeyword);
        const threshold = fuzzyThresholdFor(normalizedKeyword.length);

        if (editDistance <= threshold && editDistance < closestFuzzyDistance) {
          closestFuzzyMatch = node;
          closestFuzzyDistance = editDistance;
        }
      }

      matchedNode = closestFuzzyMatch;
    }

    if (!matchedNode) {
      return null;
    }

    incrementTriggerCount(matchedNode.id);

    // Only reply nodes with a rendered button/list carry outgoing edges —
    // skip the query for plain text replies (is_computed nodes are a
    // 'question'/'vehicle_carousel'/'rentalPackage' concept, never 'reply').
    const edges = matchedNode.contentType === 'text'
      ? []
      : await getOutgoingEdges(matchedNode.id, nodes, businessId);

    return { node: matchedNode, edges };
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
