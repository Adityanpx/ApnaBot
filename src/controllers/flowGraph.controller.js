const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('../services/chatbot.service');
const bookingGraphService = require('../services/bookingGraph.service');
const {
  findCycles,
  findUnreachableNodes,
  findFallbackSiblingNodeIds,
  resolveBookingTriggerEntryNodeIds,
  validateConditionField
} = require('../utils/flowGraphValidation');
const { validateLabelTranslations } = require('../utils/bookingFieldValidation');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const { isValidLanguageCode } = require('../utils/languageCatalog');
const logger = require('../utils/logger');

const VALID_MATCH_TYPES = ['exact', 'contains', 'startsWith'];
const VALID_CONTENT_TYPES = ['text', 'buttons', 'list'];
const VALID_REPLY_KINDS = ['text', 'booking_trigger', 'payment_trigger'];

// Ported from business.controller.js's updateBookingFields — same literal
// field_key list bookingGraph.service.js still hardcodes (OTHER_SENTINELS,
// the tripType === 'Local Rental' check, resolvePrimarySibling('dropLocation')),
// so the same guard reasoning applies to the graph engine, not just the old one.
const TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS = ['cab', 'travels'];
const RESERVED_TRAVEL_FIELD_KEYS = ['tripType', 'pickupLocation', 'dropLocation', 'travelDate', 'pickupTime'];

/**
 * Loads the business's real graph, applies a hypothetical edit via
 * transformFn ({nodes, edges} -> {nodes, edges}), and checks the result is
 * still safe to commit. Never writes to Supabase itself — every mutating
 * handler below calls this BEFORE its own write and discards the
 * hypothetical result either way.
 *
 * Cycle check is ABSOLUTE (zero cycles required after the edit) — a
 * legitimately-built graph never has a pre-existing cycle (only an edge
 * write can create one; node creation can't), so there's nothing to be
 * relative to.
 *
 * Reachability check is DIFFERENTIAL, not absolute — this matters. A
 * business can legitimately have pre-existing unreachable nodes at any
 * moment: createQuestionNode deliberately does not validate reachability
 * on creation (nodes are meant to be created isolated, then wired in via
 * an edge afterward). An absolute "zero unreachable nodes after this edit"
 * check would reject every future edge write anywhere in the graph, even
 * ones completely unrelated to the orphan, for as long as that one
 * not-yet-wired-in node exists — found the hard way while testing this
 * step against a throwaway isolated node. Only reject when THIS edit newly
 * strands a node that was reachable before it ran.
 */
const assertGraphStillValid = async (businessId, transformFn) => {
  const { nodes, edges } = await bookingGraphService.loadGraph(businessId);
  const hypothetical = transformFn({ nodes, edges });

  const cyclicNodeIds = findCycles(hypothetical.nodes, hypothetical.edges);
  if (cyclicNodeIds.length > 0) {
    return `This change would create a cycle in the booking flow involving ${cyclicNodeIds.length} node(s) — a customer could get stuck answering the same questions forever.`;
  }

  const beforeEntryNodeIds = resolveBookingTriggerEntryNodeIds(nodes, edges);
  const beforeUnreachable = new Set(findUnreachableNodes(nodes, edges, beforeEntryNodeIds));

  const afterEntryNodeIds = resolveBookingTriggerEntryNodeIds(hypothetical.nodes, hypothetical.edges);
  const afterUnreachable = findUnreachableNodes(hypothetical.nodes, hypothetical.edges, afterEntryNodeIds);
  const newlyUnreachable = afterUnreachable.filter(id => !beforeUnreachable.has(id));

  if (newlyUnreachable.length > 0) {
    return `This change would make ${newlyUnreachable.length} previously-reachable booking question(s) unreachable — a customer could never reach them.`;
  }

  return null;
};

/**
 * Shape check for flow_edges.condition, mirroring the DB check constraint
 * (flow_edges_condition_shape) at the API layer so a malformed condition
 * gets a friendly 400 instead of a raw constraint-violation error.
 */
const validateConditionShape = (condition) => {
  if (condition === null || condition === undefined) return null;
  if (typeof condition !== 'object' || Array.isArray(condition) || !condition.field) {
    return 'condition must be an object with a "field" key.';
  }
  const hasEquals = condition.equals !== undefined;
  const hasIn = condition.in !== undefined;
  if (hasEquals === hasIn) {
    return 'condition must have exactly one of "equals" or "in" (not both, not neither).';
  }
  return null;
};

/** field_key set among this business's question-subgraph nodes, for validateConditionField. */
const resolveKnownQuestionFieldKeys = async (businessId) => {
  const { data, error } = await supabase
    .from('flow_nodes').select('field_key').eq('business_id', businessId)
    .in('node_type', ['question', 'vehicle_carousel', 'rentalPackage']);
  if (error) throw error;
  return new Set((data || []).map(n => n.field_key).filter(Boolean));
};

/**
 * Ported verbatim from rule.controller.js's validateTranslationsMap (not
 * bookingFieldValidation.js's validateLabelTranslations — that one rejects
 * 'en' as a translation key, this one doesn't; the two existing validators
 * in this codebase already disagree on that point, pre-existing
 * inconsistency, not introduced here). Kept as its own local copy rather
 * than importing rule.controller.js's, matching this codebase's existing
 * pattern of each controller carrying its own copy rather than sharing one.
 */
const validateTranslationsMap = (translations, fieldLabel, maxLen) => {
  if (translations === null || translations === undefined) return null;
  if (typeof translations !== 'object' || Array.isArray(translations)) {
    return `${fieldLabel} must be an object.`;
  }
  for (const [code, value] of Object.entries(translations)) {
    if (!isValidLanguageCode(code)) {
      return `${fieldLabel} has an invalid language code "${code}".`;
    }
    if (typeof value !== 'string') {
      return `${fieldLabel} values must be strings.`;
    }
    if (maxLen !== undefined && value.length > maxLen) {
      return `${fieldLabel} for language "${code}" must be ${maxLen} characters or less.`;
    }
  }
  return null;
};

/**
 * GET /api/flow-graph/reply-nodes
 * List all reply-type flow_nodes for the business (paginated).
 */
const getReplyNodes = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, isActive } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = supabase.from('flow_nodes').select('*', { count: 'exact' })
      .eq('business_id', businessId).eq('node_type', 'reply');
    if (isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);

    return successResponse(res, 200, { replyNodes: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error in getReplyNodes:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/reply-nodes
 * Create a reply node. Deliberately does NOT accept buttons/listOptions —
 * unlike the old rules table, a reply node's buttons/list rows are now
 * flow_edges rows with their own persistent id (the literal WhatsApp
 * interaction id a customer may already have in hand). Bundling edge
 * creation into this call the way createRule bundled buttons/listOptions
 * would make node edits and edge edits inseparable; add buttons/list rows
 * afterward via the edges endpoint instead. Body: { keyword, matchType,
 * replyKind, contentType, label, labelTranslations, imageUrl, hindiAliases }.
 */
const createReplyNode = async (req, res, next) => {
  try {
    const {
      keyword, matchType = 'contains', replyKind = 'text', contentType = 'text',
      imageUrl = null, hindiAliases = [], labelTranslations = null
    } = req.body;
    let { label } = req.body;
    const businessId = req.user.businessId;

    if (!keyword) {
      return errorResponse(res, 400, 'Keyword is required');
    }
    if (!VALID_MATCH_TYPES.includes(matchType)) {
      return errorResponse(res, 400, `matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}`);
    }
    if (!VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    if (!VALID_REPLY_KINDS.includes(replyKind)) {
      return errorResponse(res, 400, `replyKind must be one of: ${VALID_REPLY_KINDS.join(', ')}`);
    }
    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return errorResponse(res, 400, 'hindiAliases must be an array of strings.');
    }
    const labelTranslationsError = validateTranslationsMap(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    // No buttons/listOptions in this call (see doc comment above), so the
    // old "reply optional if buttons/image present" carve-out is narrowed
    // to just image — flagged as a deliberate simplification from the old
    // updateRule/createRule validation, not a 1:1 port.
    if (replyKind === 'payment_trigger' && !label) {
      label = 'Please complete your payment.';
    }
    if (replyKind === 'booking_trigger' && !label) {
      label = 'Great! Let me collect your details.';
    }
    if (!label && !imageUrl) {
      return errorResponse(res, 400, 'label is required (unless imageUrl is provided)');
    }
    if (!label) label = '';

    const normalizedKeyword = keyword.toLowerCase().trim();

    const { data: existingNode, error: existingErr } = await supabase
      .from('flow_nodes').select('id').eq('business_id', businessId).eq('node_type', 'reply')
      .eq('keyword', normalizedKeyword).maybeSingle();
    if (existingErr) throw existingErr;
    if (existingNode) {
      return errorResponse(res, 409, 'A reply node with this keyword already exists.');
    }

    const { data: node, error } = await supabase.from('flow_nodes').insert({
      business_id: businessId,
      node_type: 'reply',
      keyword: normalizedKeyword,
      match_type: matchType,
      hindi_aliases: (hindiAliases || []).map(a => a.trim()).filter(Boolean),
      reply_kind: replyKind,
      content_type: contentType,
      label,
      label_translations: labelTranslations || null,
      image_url: imageUrl || null,
      is_active: true,
      trigger_count: 0
    }).select().single();
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 201, toCamelCase(node));
  } catch (error) {
    logger.error('Error in createReplyNode:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/reply-nodes/:id
 * Update a reply node's own fields. Buttons/list rows are edited via the
 * edges endpoint, not here (see createReplyNode's doc comment).
 */
const updateReplyNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { keyword, matchType, replyKind, contentType, isActive, imageUrl, hindiAliases, label, labelTranslations } = req.body;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('*').eq('id', id).eq('business_id', businessId).eq('node_type', 'reply').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Reply node not found');
    }

    if (matchType !== undefined && !VALID_MATCH_TYPES.includes(matchType)) {
      return errorResponse(res, 400, `matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}`);
    }
    if (replyKind !== undefined && !VALID_REPLY_KINDS.includes(replyKind)) {
      return errorResponse(res, 400, `replyKind must be one of: ${VALID_REPLY_KINDS.join(', ')}`);
    }
    if (contentType !== undefined && !VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    if (hindiAliases !== undefined && !Array.isArray(hindiAliases)) {
      return errorResponse(res, 400, 'hindiAliases must be an array of strings.');
    }
    const labelTranslationsError = validateTranslationsMap(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    // Switching a node's contentType away from buttons/list to text would
    // leave its existing outgoing edges inert (chatbot.service.js's
    // findMatchingRule skips the edges query entirely for content_type
    // 'text' — see the `matchedNode.contentType === 'text' ? [] : ...`
    // branch), not cascade-deleted, silently orphaning working WhatsApp
    // button ids a customer could still be holding. Refuse until those
    // edges are removed/retargeted explicitly via the edges endpoint.
    if (contentType === 'text' && node.content_type !== 'text') {
      const { count: outgoingEdgeCount, error: edgeCountErr } = await supabase
        .from('flow_edges').select('*', { count: 'exact', head: true }).eq('from_node_id', id);
      if (edgeCountErr) throw edgeCountErr;
      if (outgoingEdgeCount > 0) {
        return errorResponse(res, 400,
          `Cannot switch this node's contentType to "text" while it still has ${outgoingEdgeCount} outgoing edge(s) — ` +
          'those buttons/list rows would silently stop being sent. Remove or retarget them first.'
        );
      }
    }

    // Reachability re-validation: closes the TODO from step 3 — changing
    // replyKind AWAY from 'booking_trigger' is the only reply-node field
    // edit that can remove a question-subgraph entry point (this node's own
    // unconditional edge into the first question node stops counting as an
    // entry point the moment replyKind no longer marks it as one, even
    // though the edge row itself is untouched).
    if (replyKind !== undefined && replyKind !== node.reply_kind && node.reply_kind === 'booking_trigger') {
      const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
        nodes: nodes.map(n => n.id === id ? { ...n, replyKind } : n),
        edges
      }));
      if (validationError) {
        return errorResponse(res, 400, validationError);
      }
    }

    const updateData = {};

    if (keyword) {
      const normalizedKeyword = keyword.toLowerCase().trim();
      const { data: existingNode, error: existingErr } = await supabase
        .from('flow_nodes').select('id').eq('business_id', businessId).eq('node_type', 'reply')
        .eq('keyword', normalizedKeyword).neq('id', id).maybeSingle();
      if (existingErr) throw existingErr;
      if (existingNode) {
        return errorResponse(res, 409, 'A reply node with this keyword already exists.');
      }
      updateData.keyword = normalizedKeyword;
    }

    if (matchType) updateData.match_type = matchType;
    if (replyKind !== undefined) updateData.reply_kind = replyKind;
    if (contentType !== undefined) updateData.content_type = contentType;
    if (isActive !== undefined) updateData.is_active = isActive;
    if (imageUrl !== undefined) updateData.image_url = imageUrl || null;
    if (labelTranslations !== undefined) updateData.label_translations = labelTranslations || null;
    if (label !== undefined) updateData.label = label;
    if (hindiAliases !== undefined) {
      updateData.hindi_aliases = hindiAliases.map(a => a.trim()).filter(Boolean);
    }

    const { data: updatedNode, error } = await supabase
      .from('flow_nodes').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 200, toCamelCase(updatedNode));
  } catch (error) {
    logger.error('Error in updateReplyNode:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/reply-nodes/:id
 * flow_edges.to_node_id/from_node_id both cascade-delete on their
 * referenced node — deleting this node would silently also delete any
 * OTHER node's edge that targets it (e.g. another reply node's "back to
 * FAQ" button), orphaning that node's rendered choice with no warning.
 * Block and name the referencing node(s) instead of allowing the cascade
 * to run unannounced.
 */
const deleteReplyNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('id').eq('id', id).eq('business_id', businessId).eq('node_type', 'reply').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Reply node not found');
    }

    const { data: incomingEdges, error: incomingErr } = await supabase
      .from('flow_edges').select('id, from_node_id').eq('to_node_id', id);
    if (incomingErr) throw incomingErr;

    if ((incomingEdges || []).length > 0) {
      const fromNodeIds = [...new Set(incomingEdges.map(e => e.from_node_id))];
      const { data: fromNodes, error: fromNodesErr } = await supabase
        .from('flow_nodes').select('id, keyword, label').in('id', fromNodeIds);
      if (fromNodesErr) throw fromNodesErr;
      const names = (fromNodes || []).map(n => n.keyword || n.label || n.id).join(', ');
      return errorResponse(res, 400,
        `Cannot delete: ${incomingEdges.length} edge(s) from other node(s) (${names}) target this node. ` +
        'Deleting it would silently delete those edges too. Remove or retarget them first.'
      );
    }

    // Reachability re-validation: closes the TODO from step 3. Deleting a
    // booking_trigger reply node cascade-deletes its own outgoing entry
    // edge into the question subgraph — if this was the only such reply
    // node, everything downstream of that edge silently strands. Runs for
    // every reply-node delete (not just booking_trigger ones) for one
    // consistent code path rather than special-casing by replyKind; it's a
    // cheap dashboard-frequency check either way.
    const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
      nodes: nodes.filter(n => n.id !== id),
      edges: edges.filter(e => e.fromNodeId !== id && e.toNodeId !== id)
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { error } = await supabase.from('flow_nodes').delete().eq('id', id);
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 200, null, 'Reply node deleted successfully');
  } catch (error) {
    logger.error('Error in deleteReplyNode:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/reply-nodes/:id/toggle
 * Toggle isActive. Unlike question nodes (see bookingGraph.service.js's
 * isNodeEffectivelyActive), a reply node's is_active IS consulted at read
 * time (chatbot.service.js#getRulesFromCache filters .eq('is_active', true)).
 */
const toggleReplyNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('is_active').eq('id', id).eq('business_id', businessId).eq('node_type', 'reply').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Reply node not found');
    }

    const { data: updatedNode, error } = await supabase
      .from('flow_nodes').update({ is_active: !node.is_active }).eq('id', id).select().single();
    if (error) throw error;

    await invalidateRulesCache(businessId);

    return successResponse(res, 200, toCamelCase(updatedNode));
  } catch (error) {
    logger.error('Error in toggleReplyNode:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/question-nodes
 * List question/vehicle_carousel/rentalPackage flow_nodes for the business
 * (paginated). Computed nodes are included for visibility (the dashboard
 * needs to show them exist) but PUT/DELETE below refuse to touch them.
 */
const getQuestionNodes = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, isActive } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = supabase.from('flow_nodes').select('*', { count: 'exact' })
      .eq('business_id', businessId).in('node_type', ['question', 'vehicle_carousel', 'rentalPackage']);
    if (isActive !== undefined) {
      query = query.eq('is_active', isActive === 'true');
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);

    return successResponse(res, 200, { questionNodes: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error in getQuestionNodes:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/question-nodes
 * Create an authored question node. node_type/is_computed are never taken
 * from the request body — this endpoint only ever creates 'question' nodes;
 * vehicle_carousel/rentalPackage nodes are engine-internal (produced by
 * migrateFlowGraph.js only), there is no dashboard path to create one.
 * The node is created isolated (no edges) — wire it into the sequence via
 * the edges endpoint afterward. fieldKey is deliberately NOT checked
 * against the reserved-key list here: multiple nodes sharing a fieldKey is
 * legitimate by design (an authored node plus its manual-fallback sibling),
 * so creating another node with a reserved fieldKey is fine — only RENAMING
 * AWAY from or DELETING a reserved key is guarded (see updateQuestionNode/
 * deleteQuestionNode).
 */
const createQuestionNode = async (req, res, next) => {
  try {
    const {
      fieldKey, contentType = 'text', summaryLabel = null, required = false,
      order = null, options = [], labelTranslations = null, imageUrl = null, label
    } = req.body;
    const businessId = req.user.businessId;

    if (!fieldKey || typeof fieldKey !== 'string') {
      return errorResponse(res, 400, 'fieldKey is required');
    }
    if (!VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    // Required at the API layer because flow_nodes.label is NOT NULL at the
    // DB level and (unlike reply nodes) question nodes have no image-only
    // carve-out precedent in the old bookingFields validation to port —
    // new validation this schema requires, not a 1:1 port.
    if (!label || typeof label !== 'string') {
      return errorResponse(res, 400, 'label is required');
    }
    if (typeof required !== 'boolean') {
      return errorResponse(res, 400, 'required must be a boolean');
    }
    if (order !== null && order !== undefined && typeof order !== 'number') {
      return errorResponse(res, 400, 'order must be a number or null');
    }

    const labelTranslationsError = validateLabelTranslations(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    if ((contentType === 'buttons' || contentType === 'list') && (!Array.isArray(options) || options.length === 0)) {
      return errorResponse(res, 400, `options must have at least one entry for contentType "${contentType}"`);
    }
    for (const opt of options || []) {
      if (opt && typeof opt === 'object') {
        const optErr = validateLabelTranslations(opt.labelTranslations, `option "${opt.value}" labelTranslations`);
        if (optErr) return errorResponse(res, 400, optErr);
      }
    }

    const { data: node, error } = await supabase.from('flow_nodes').insert({
      business_id: businessId,
      node_type: 'question',
      field_key: fieldKey,
      content_type: contentType,
      label,
      label_translations: labelTranslations || null,
      image_url: imageUrl || null,
      summary_label: summaryLabel,
      required,
      order,
      options: options || [],
      is_computed: false,
      is_active: true
    }).select().single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(node));
  } catch (error) {
    logger.error('Error in createQuestionNode:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/question-nodes/:id
 * Edit an authored question node's own fields. Scoped to node_type='question'
 * at the query level, which alone implements "computed nodes cannot be
 * edited through this endpoint" (a vehicle_carousel/rentalPackage row's id
 * simply won't be found). Deliberately does NOT accept isActive — see the
 * confirmed decision that "disable a question field" routes through
 * businesses.disabledBookingFields (PUT /api/business), not
 * flow_nodes.is_active, which pickNextNodeId never reads for question
 * nodes at all.
 */
const updateQuestionNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { fieldKey, contentType, label, labelTranslations, summaryLabel, required, order, options, imageUrl } = req.body;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('*').eq('id', id).eq('business_id', businessId).eq('node_type', 'question').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Question node not found (vehicle_carousel/rentalPackage nodes cannot be edited through this endpoint)');
    }

    if (contentType !== undefined && !VALID_CONTENT_TYPES.includes(contentType)) {
      return errorResponse(res, 400, `contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`);
    }
    if (required !== undefined && typeof required !== 'boolean') {
      return errorResponse(res, 400, 'required must be a boolean');
    }
    if (order !== undefined && order !== null && typeof order !== 'number') {
      return errorResponse(res, 400, 'order must be a number or null');
    }
    const labelTranslationsError = validateLabelTranslations(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) {
      return errorResponse(res, 400, labelTranslationsError);
    }

    const effectiveContentType = contentType !== undefined ? contentType : node.content_type;
    const effectiveOptions = options !== undefined ? options : node.options;
    if ((effectiveContentType === 'buttons' || effectiveContentType === 'list') &&
        (!Array.isArray(effectiveOptions) || effectiveOptions.length === 0)) {
      return errorResponse(res, 400, `options must have at least one entry for contentType "${effectiveContentType}"`);
    }
    if (options !== undefined) {
      for (const opt of options) {
        if (opt && typeof opt === 'object') {
          const optErr = validateLabelTranslations(opt.labelTranslations, `option "${opt.value}" labelTranslations`);
          if (optErr) return errorResponse(res, 400, optErr);
        }
      }
    }

    // Decision 3 (reviewed and confirmed): reject outright, don't just warn.
    // resolveOptionsForNode overrides pickupLocation/dropLocation's options
    // with the live servedCities overlay whenever contentType is 'list' and
    // servedCities is non-empty — an edited options array would silently
    // never take effect.
    if (options !== undefined &&
        (node.field_key === 'pickupLocation' || node.field_key === 'dropLocation') &&
        effectiveContentType === 'list' &&
        req.graphBusiness.servedCities.length > 0) {
      return errorResponse(res, 400,
        `Cannot edit options on "${node.field_key}" while servedCities is configured for this business — ` +
        'the live servedCities list overrides authored options for this field at read time, so any edit here would silently have no effect. ' +
        'Clear servedCities first if you want to hand-author options for this field.'
      );
    }

    // Reserved-field-key guard (ported from business.controller.js's
    // updateBookingFields): conservative/unconditional — blocks renaming
    // AWAY from a reserved key even if another node still holds it, rather
    // than determining whether this is "the last" node with that key.
    if (fieldKey !== undefined && fieldKey !== node.field_key &&
        TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(req.graphBusiness.businessCategory) &&
        RESERVED_TRAVEL_FIELD_KEYS.includes(node.field_key)) {
      return errorResponse(res, 400,
        `Cannot rename fieldKey away from "${node.field_key}" — special booking-flow behavior depends on this exact key. ` +
        'Label, options, order, required, and translations can still be changed freely.'
      );
    }

    // Reachability re-validation only matters when fieldKey changes — it's
    // the only edit here that affects findUnreachableNodes' sibling-
    // exemption pairing (see flowGraphValidation.js).
    if (fieldKey !== undefined && fieldKey !== node.field_key) {
      const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
        nodes: nodes.map(n => n.id === id ? { ...n, fieldKey } : n),
        edges
      }));
      if (validationError) {
        return errorResponse(res, 400, validationError);
      }
    }

    const updateData = {};
    if (fieldKey !== undefined) updateData.field_key = fieldKey;
    if (contentType !== undefined) updateData.content_type = contentType;
    if (label !== undefined) updateData.label = label;
    if (labelTranslations !== undefined) updateData.label_translations = labelTranslations || null;
    if (imageUrl !== undefined) updateData.image_url = imageUrl || null;
    if (summaryLabel !== undefined) updateData.summary_label = summaryLabel;
    if (required !== undefined) updateData.required = required;
    if (order !== undefined) updateData.order = order;
    if (options !== undefined) updateData.options = options;

    const { data: updatedNode, error } = await supabase
      .from('flow_nodes').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(updatedNode));
  } catch (error) {
    logger.error('Error in updateQuestionNode:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/question-nodes/:id
 * Scoped to node_type='question' — computed nodes can't be deleted through
 * this endpoint either. Four guards, in order: reserved-key, incoming-edge
 * cascade (mirrors deleteReplyNode), fallback-sibling (a node with NO
 * incoming edge can still be load-bearing — see
 * flowGraphValidation.js#findFallbackSiblingNodeIds), then full
 * reachability re-validation for everything else.
 */
const deleteQuestionNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: node, error: findErr } = await supabase
      .from('flow_nodes').select('*').eq('id', id).eq('business_id', businessId).eq('node_type', 'question').maybeSingle();
    if (findErr) throw findErr;
    if (!node) {
      return errorResponse(res, 404, 'Question node not found (vehicle_carousel/rentalPackage nodes cannot be deleted through this endpoint)');
    }

    if (TRAVEL_CATEGORIES_WITH_RESERVED_FIELDS.includes(req.graphBusiness.businessCategory) &&
        RESERVED_TRAVEL_FIELD_KEYS.includes(node.field_key)) {
      return errorResponse(res, 400,
        `Cannot delete: fieldKey "${node.field_key}" has special booking-flow behavior hardcoded in bookingGraph.service.js.`
      );
    }

    const { data: incomingEdges, error: incomingErr } = await supabase
      .from('flow_edges').select('id, from_node_id').eq('to_node_id', id);
    if (incomingErr) throw incomingErr;
    if ((incomingEdges || []).length > 0) {
      const fromNodeIds = [...new Set(incomingEdges.map(e => e.from_node_id))];
      const { data: fromNodes, error: fromNodesErr } = await supabase
        .from('flow_nodes').select('id, field_key, label').in('id', fromNodeIds);
      if (fromNodesErr) throw fromNodesErr;
      const names = (fromNodes || []).map(n => n.field_key || n.label || n.id).join(', ');
      return errorResponse(res, 400,
        `Cannot delete: ${incomingEdges.length} edge(s) from other node(s) (${names}) target this node. ` +
        'Deleting it would silently delete those edges too, and the booking sequence would need retargeting first. Remove or retarget them first.'
      );
    }

    // A node with zero incoming edges is either the true graph entry
    // question, or a fallback sibling found by field_key lookup at runtime,
    // never by edge traversal — the incoming-edge check above can never
    // catch removing one of those. See findFallbackSiblingNodeIds's doc
    // comment: this is a live, crashable gap if left unguarded, not
    // theoretical.
    const { nodes, edges } = await bookingGraphService.loadGraph(businessId);
    const entryNodeIds = resolveBookingTriggerEntryNodeIds(nodes, edges);
    const fallbackSiblingIds = findFallbackSiblingNodeIds(nodes, edges, entryNodeIds);
    if (fallbackSiblingIds.includes(id)) {
      return errorResponse(res, 400,
        `Cannot delete: this node has no incoming edge, but another node shares its fieldKey "${node.field_key}" and IS reachable. ` +
        "This check can't tell apart two different situations that look identical from here — figure out which one you're in before proceeding: " +
        "(1) this is a real fallback the engine finds at runtime by fieldKey, not by an edge (e.g. \"Other date\"/\"Other time\" manual alternatives, or vehicleType's static fallback when the live vehicle/rental-package query is empty) — deleting it removes that fallback path, which can crash a live booking the next time the primary option is unavailable; " +
        '(2) this node was just created and happens to reuse an existing fieldKey by coincidence, with no real fallback relationship intended — in that case this block is a false positive, safe to work around. ' +
        'Either way, the fix is the same: change this node\'s fieldKey to something else, then delete it.'
      );
    }

    const validationError = await assertGraphStillValid(businessId, ({ nodes: n, edges: e }) => ({
      nodes: n.filter(x => x.id !== id),
      edges: e.filter(x => x.fromNodeId !== id && x.toNodeId !== id)
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { error } = await supabase.from('flow_nodes').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Question node deleted successfully');
  } catch (error) {
    logger.error('Error in deleteQuestionNode:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/edges?fromNodeId=
 * Outgoing edges for one node, ordered by displayOrder.
 */
const getEdges = async (req, res, next) => {
  try {
    const { fromNodeId } = req.query;
    const businessId = req.user.businessId;
    if (!fromNodeId) {
      return errorResponse(res, 400, 'fromNodeId query param is required');
    }

    const { data: fromNode, error: nodeErr } = await supabase
      .from('flow_nodes').select('id').eq('id', fromNodeId).eq('business_id', businessId).maybeSingle();
    if (nodeErr) throw nodeErr;
    if (!fromNode) {
      return errorResponse(res, 404, 'fromNodeId not found for this business');
    }

    const { data, error } = await supabase
      .from('flow_edges').select('*').eq('from_node_id', fromNodeId).order('display_order', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { edges: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getEdges:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/edges
 * Create one edge. Body: { fromNodeId, toNodeId, label, labelTranslations,
 * description, descriptionTranslations, condition, displayOrder }.
 * displayOrder defaults to appended-at-the-end (max existing + 1 among
 * fromNodeId's outgoing edges) when omitted. Runs the shared cycle/
 * reachability validator against the hypothetical post-create graph before
 * writing — findCycles/findUnreachableNodes both self-filter to
 * question-subgraph node types internally, so this is safe to call
 * unconditionally regardless of what kind of edge is being created (a
 * reply-node button edge just never trips either check).
 */
const createEdge = async (req, res, next) => {
  try {
    const {
      fromNodeId, toNodeId, label = null, labelTranslations = null,
      description = null, descriptionTranslations = null, condition = null, displayOrder
    } = req.body;
    const businessId = req.user.businessId;

    if (!fromNodeId || !toNodeId) {
      return errorResponse(res, 400, 'fromNodeId and toNodeId are required');
    }

    const { data: endpointNodes, error: nodesErr } = await supabase
      .from('flow_nodes').select('id, node_type').eq('business_id', businessId).in('id', [fromNodeId, toNodeId]);
    if (nodesErr) throw nodesErr;
    if (!(endpointNodes || []).some(n => n.id === fromNodeId)) {
      return errorResponse(res, 404, 'fromNodeId not found for this business');
    }
    if (!(endpointNodes || []).some(n => n.id === toNodeId)) {
      return errorResponse(res, 404, 'toNodeId not found for this business');
    }

    const labelTranslationsError = validateTranslationsMap(labelTranslations, 'labelTranslations');
    if (labelTranslationsError) return errorResponse(res, 400, labelTranslationsError);
    const descriptionTranslationsError = validateTranslationsMap(descriptionTranslations, 'descriptionTranslations');
    if (descriptionTranslationsError) return errorResponse(res, 400, descriptionTranslationsError);

    const conditionShapeError = validateConditionShape(condition);
    if (conditionShapeError) return errorResponse(res, 400, conditionShapeError);
    if (condition) {
      const knownFieldKeys = await resolveKnownQuestionFieldKeys(businessId);
      const conditionFieldError = validateConditionField(condition, knownFieldKeys);
      if (conditionFieldError) return errorResponse(res, 400, conditionFieldError);
    }

    let effectiveDisplayOrder = displayOrder;
    if (effectiveDisplayOrder === undefined || effectiveDisplayOrder === null) {
      const { data: siblingEdges, error: sibErr } = await supabase
        .from('flow_edges').select('display_order').eq('from_node_id', fromNodeId)
        .order('display_order', { ascending: false }).limit(1);
      if (sibErr) throw sibErr;
      effectiveDisplayOrder = siblingEdges && siblingEdges.length > 0 ? siblingEdges[0].display_order + 1 : 0;
    } else if (typeof effectiveDisplayOrder !== 'number') {
      return errorResponse(res, 400, 'displayOrder must be a number');
    }

    const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
      nodes,
      edges: [...edges, { id: '__pending__', businessId, fromNodeId, toNodeId, condition: condition || null }]
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { data: edge, error } = await supabase.from('flow_edges').insert({
      business_id: businessId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      label,
      label_translations: labelTranslations || null,
      description,
      description_translations: descriptionTranslations || null,
      condition: condition || null,
      display_order: effectiveDisplayOrder
    }).select().single();
    if (error) throw error;

    // No cache to flush here: chatbot.service.js's flow:{businessId} cache
    // holds reply-type flow_nodes rows only — getOutgoingEdges queries
    // flow_edges live, uncached, every time. Only reply-NODE field writes
    // need invalidateRulesCache, not edge writes.
    return successResponse(res, 201, toCamelCase(edge));
  } catch (error) {
    logger.error('Error in createEdge:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/edges/:id
 * Surgical edit — retarget (toNodeId), condition, label/translations,
 * description/translations, displayOrder. Deliberately does NOT accept
 * fromNodeId (moving an edge's source is a different edge conceptually;
 * delete + create instead) — and critically, this UPDATEs the existing row
 * rather than replacing it, so the edge's id (a live WhatsApp interaction
 * id for a reply node's button/list row) never changes. This is the
 * concrete fix for Finding A from the design pass: the old rules table's
 * full-array-replace pattern would have silently rotated every button's id
 * on every edit had it been ported here as-is.
 */
const updateEdge = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { toNodeId, label, labelTranslations, description, descriptionTranslations, condition, displayOrder } = req.body;
    const businessId = req.user.businessId;

    const { data: edge, error: findErr } = await supabase
      .from('flow_edges').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!edge) {
      return errorResponse(res, 404, 'Edge not found');
    }

    const updateData = {};

    if (toNodeId !== undefined && toNodeId !== edge.to_node_id) {
      const { data: toNode, error: toNodeErr } = await supabase
        .from('flow_nodes').select('id').eq('id', toNodeId).eq('business_id', businessId).maybeSingle();
      if (toNodeErr) throw toNodeErr;
      if (!toNode) {
        return errorResponse(res, 404, 'toNodeId not found for this business');
      }
      updateData.to_node_id = toNodeId;
    }

    if (labelTranslations !== undefined) {
      const err = validateTranslationsMap(labelTranslations, 'labelTranslations');
      if (err) return errorResponse(res, 400, err);
      updateData.label_translations = labelTranslations || null;
    }
    if (descriptionTranslations !== undefined) {
      const err = validateTranslationsMap(descriptionTranslations, 'descriptionTranslations');
      if (err) return errorResponse(res, 400, err);
      updateData.description_translations = descriptionTranslations || null;
    }
    if (label !== undefined) updateData.label = label;
    if (description !== undefined) updateData.description = description;
    if (displayOrder !== undefined) {
      if (typeof displayOrder !== 'number') return errorResponse(res, 400, 'displayOrder must be a number');
      updateData.display_order = displayOrder;
    }

    if (condition !== undefined) {
      const conditionShapeError = validateConditionShape(condition);
      if (conditionShapeError) return errorResponse(res, 400, conditionShapeError);
      if (condition) {
        const knownFieldKeys = await resolveKnownQuestionFieldKeys(businessId);
        const conditionFieldError = validateConditionField(condition, knownFieldKeys);
        if (conditionFieldError) return errorResponse(res, 400, conditionFieldError);
      }
      updateData.condition = condition;
    }

    if (Object.keys(updateData).length === 0) {
      return errorResponse(res, 400, 'No recognized fields to update');
    }

    // Only a retarget or a condition change can affect topology/branching —
    // label/description/displayOrder edits can't create a cycle or strand a
    // node, so skip the reload+walk for those.
    if (updateData.to_node_id !== undefined || updateData.condition !== undefined) {
      const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
        nodes,
        edges: edges.map(e => e.id === id ? {
          ...e,
          toNodeId: updateData.to_node_id !== undefined ? updateData.to_node_id : e.toNodeId,
          condition: updateData.condition !== undefined ? updateData.condition : e.condition
        } : e)
      }));
      if (validationError) {
        return errorResponse(res, 400, validationError);
      }
    }

    const { data: updatedEdge, error } = await supabase
      .from('flow_edges').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(updatedEdge));
  } catch (error) {
    logger.error('Error in updateEdge:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/edges/:id
 * Deleting an edge can only ever LOSE reachability, never create a cycle —
 * still runs the same shared validator for one consistent code path, and
 * because losing reachability is exactly the failure mode this guards
 * against.
 */
const deleteEdge = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: edge, error: findErr } = await supabase
      .from('flow_edges').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!edge) {
      return errorResponse(res, 404, 'Edge not found');
    }

    const validationError = await assertGraphStillValid(businessId, ({ nodes, edges }) => ({
      nodes,
      edges: edges.filter(e => e.id !== id)
    }));
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const { error } = await supabase.from('flow_edges').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Edge deleted successfully');
  } catch (error) {
    logger.error('Error in deleteEdge:', error);
    next(error);
  }
};

/**
 * PUT /api/flow-graph/edges/reorder
 * Body: { fromNodeId, orderedEdgeIds: [...] } — must contain exactly
 * fromNodeId's current outgoing edges, no more, no fewer. Writes
 * display_order sequentially (0-indexed). Pure reordering never changes
 * from/to/condition, so no cycle/reachability re-check is needed.
 */
const reorderEdges = async (req, res, next) => {
  try {
    const { fromNodeId, orderedEdgeIds } = req.body;
    const businessId = req.user.businessId;

    if (!fromNodeId || !Array.isArray(orderedEdgeIds) || orderedEdgeIds.length === 0) {
      return errorResponse(res, 400, 'fromNodeId and a non-empty orderedEdgeIds array are required');
    }

    const { data: existingEdges, error: fetchErr } = await supabase
      .from('flow_edges').select('id').eq('from_node_id', fromNodeId).eq('business_id', businessId);
    if (fetchErr) throw fetchErr;

    const existingIds = new Set((existingEdges || []).map(e => e.id));
    const requestedIds = new Set(orderedEdgeIds);
    if (existingIds.size !== orderedEdgeIds.length || requestedIds.size !== orderedEdgeIds.length ||
        !orderedEdgeIds.every(id => existingIds.has(id))) {
      return errorResponse(res, 400, 'orderedEdgeIds must contain exactly the current outgoing edges of fromNodeId, no more, no fewer, no duplicates');
    }

    for (let i = 0; i < orderedEdgeIds.length; i++) {
      const { error } = await supabase.from('flow_edges').update({ display_order: i }).eq('id', orderedEdgeIds[i]);
      if (error) throw error;
    }

    const { data: reordered, error: reErr } = await supabase
      .from('flow_edges').select('*').eq('from_node_id', fromNodeId).order('display_order', { ascending: true });
    if (reErr) throw reErr;

    return successResponse(res, 200, { edges: (reordered || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in reorderEdges:', error);
    next(error);
  }
};

module.exports = {
  getReplyNodes,
  createReplyNode,
  updateReplyNode,
  deleteReplyNode,
  toggleReplyNode,
  getQuestionNodes,
  createQuestionNode,
  updateQuestionNode,
  deleteQuestionNode,
  getEdges,
  createEdge,
  updateEdge,
  deleteEdge,
  reorderEdges
};
