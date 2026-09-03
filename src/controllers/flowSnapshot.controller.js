const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const {
  readBusinessGraphRows,
  deleteBusinessGraphRows,
  writeBusinessGraphRows
} = require('../services/flowSnapshot.service');
const logger = require('../utils/logger');

/**
 * POST /api/flow-graph/snapshots
 * Body: { name }. Copies this business's CURRENT flow_nodes/flow_edges into
 * a new flow_snapshots row (business_id = this business, is_category_template
 * = false, category = null). Full row arrays, original ids intact — see
 * flow_snapshots' table comment for why (restore needs from_node_id/
 * to_node_id to stay resolvable).
 */
const createSnapshot = async (req, res, next) => {
  try {
    const { name } = req.body;
    const businessId = req.user.businessId;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorResponse(res, 400, 'name is required');
    }

    const { nodes, edges } = await readBusinessGraphRows(businessId);

    const { data: snapshot, error } = await supabase.from('flow_snapshots').insert({
      business_id: businessId,
      name: name.trim(),
      nodes,
      edges,
      is_category_template: false,
      category: null
    }).select('id, name, created_at, is_active').single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(snapshot));
  } catch (error) {
    logger.error('Error in createSnapshot:', error);
    next(error);
  }
};

/**
 * GET /api/flow-graph/snapshots
 * This business's own snapshots, most recent first. Deliberately excludes
 * the nodes/edges jsonb columns — the list view only needs enough to pick a
 * snapshot to restore/delete, and those columns can be large.
 */
const getSnapshots = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('flow_snapshots')
      .select('id, name, created_at, is_active')
      .eq('business_id', businessId)
      .eq('is_category_template', false)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { snapshots: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getSnapshots:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/snapshots/:id/restore
 * Full replace: deletes this business's current flow_nodes/flow_edges and
 * recreates them from the snapshot's stored rows, reusing the ORIGINAL
 * node/edge ids (see flowSnapshot.service.js#writeBusinessGraphRows doc
 * comment — safe here because target and source are the same business, and
 * keeps any in-flight WhatsApp session's currentNodeId resolvable across
 * the restore). Marks this snapshot is_active=true, unsets it on every
 * other snapshot for this business.
 */
const restoreSnapshot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: snapshot, error: findErr } = await supabase
      .from('flow_snapshots').select('*')
      .eq('id', id).eq('business_id', businessId).eq('is_category_template', false)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!snapshot) {
      return errorResponse(res, 404, 'Snapshot not found');
    }

    await deleteBusinessGraphRows(businessId);
    await writeBusinessGraphRows(businessId, snapshot.nodes, snapshot.edges, {
      reuseIds: true,
      resetTriggerCount: false
    });

    const { error: unsetErr } = await supabase
      .from('flow_snapshots').update({ is_active: false })
      .eq('business_id', businessId).eq('is_category_template', false).neq('id', id);
    if (unsetErr) throw unsetErr;

    const { data: updatedSnapshot, error: setErr } = await supabase
      .from('flow_snapshots').update({ is_active: true }).eq('id', id)
      .select('id, name, created_at, is_active').single();
    if (setErr) throw setErr;

    return successResponse(res, 200, toCamelCase(updatedSnapshot), 'Snapshot restored successfully');
  } catch (error) {
    logger.error('Error in restoreSnapshot:', error);
    next(error);
  }
};

/**
 * DELETE /api/flow-graph/snapshots/:id
 */
const deleteSnapshot = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: snapshot, error: findErr } = await supabase
      .from('flow_snapshots').select('id')
      .eq('id', id).eq('business_id', businessId).eq('is_category_template', false)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!snapshot) {
      return errorResponse(res, 404, 'Snapshot not found');
    }

    const { error } = await supabase.from('flow_snapshots').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Snapshot deleted successfully');
  } catch (error) {
    logger.error('Error in deleteSnapshot:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/snapshots/import-category-template
 * Body: { category }. Full replace of this business's current graph with
 * the active category-template's stored nodes/edges, minting FRESH ids
 * (writeBusinessGraphRows reuseIds:false — the same template row is copied
 * into many businesses, so reusing its stored ids would collide the moment
 * a second business imports it) and resetting trigger_count (the source is
 * a template or another business, not this one — its historical counts are
 * meaningless here).
 *
 * Deliberately does NOT refuse when this business's graph is already
 * non-empty — always replaces. Confirmed with the requester: the guard
 * against accidentally wiping a business's in-progress graph belongs in the
 * frontend as an explicit confirmation step before this endpoint is called,
 * not as a backend precondition.
 */
const importCategoryTemplate = async (req, res, next) => {
  try {
    const { category } = req.body;
    const businessId = req.user.businessId;

    if (!category || typeof category !== 'string') {
      return errorResponse(res, 400, 'category is required');
    }

    const { data: template, error: findErr } = await supabase
      .from('flow_snapshots').select('*')
      .eq('category', category).eq('is_category_template', true).eq('is_active', true)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!template) {
      return errorResponse(res, 404, `No category template found for category "${category}"`);
    }

    await deleteBusinessGraphRows(businessId);
    await writeBusinessGraphRows(businessId, template.nodes, template.edges, {
      reuseIds: false,
      resetTriggerCount: true
    });

    return successResponse(res, 200, null, 'Category template imported successfully');
  } catch (error) {
    logger.error('Error in importCategoryTemplate:', error);
    next(error);
  }
};

/**
 * POST /api/flow-graph/snapshots/start-blank
 * Wipes this business's current flow_nodes/flow_edges entirely, going back
 * to a literal empty graph. Uses the same raw-delete path restoreSnapshot/
 * importCategoryTemplate use (deleteBusinessGraphRows) — no reserved-
 * fieldKey/incoming-edge/fallback-sibling guard checks apply here, since
 * this is an explicit owner-confirmed wipe, not an accidental single-node
 * delete via /api/flow-graph.
 *
 * Also unsets is_active on every non-template snapshot for this business:
 * none of them describe the current (now blank) live graph anymore.
 */
const startBlankFlow = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    await deleteBusinessGraphRows(businessId);

    const { error: unsetErr } = await supabase
      .from('flow_snapshots').update({ is_active: false })
      .eq('business_id', businessId).eq('is_category_template', false);
    if (unsetErr) throw unsetErr;

    return successResponse(res, 200, null, 'Flow reset to blank successfully');
  } catch (error) {
    logger.error('Error in startBlankFlow:', error);
    next(error);
  }
};

module.exports = {
  createSnapshot,
  getSnapshots,
  restoreSnapshot,
  deleteSnapshot,
  importCategoryTemplate,
  startBlankFlow
};
