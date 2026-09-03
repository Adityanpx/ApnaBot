const express = require('express');
const router = express.Router();
const flowSnapshotController = require('../controllers/flowSnapshot.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness. Write ops (create, restore,
// delete, import) also require: requireRole('owner'). GET (list) is open to
// any authenticated business member, mirroring flowGraph.routes.js's
// GET-allows-staff pattern.
router.use(protect, requireBusiness);

// GET / - List this business's own snapshots (id/name/createdAt/isActive only)
router.get('/', flowSnapshotController.getSnapshots);

// POST / - Save this business's current flow_nodes/flow_edges as a new snapshot
router.post('/', requireRole('owner'), flowSnapshotController.createSnapshot);

// POST /import-category-template - Full replace of this business's current
// graph with the active category-template for the given category. Registered
// before /:id/restore so it isn't ambiguous, though the two don't actually
// collide (different literal suffixes).
router.post('/import-category-template', requireRole('owner'), flowSnapshotController.importCategoryTemplate);

// POST /start-blank - Wipes this business's current graph entirely (back to
// a literal empty graph). Registered before /:id/restore for the same
// non-colliding-suffix reasoning as import-category-template above.
router.post('/start-blank', requireRole('owner'), flowSnapshotController.startBlankFlow);

// POST /:id/restore - Full replace of this business's current graph with one
// of its own saved snapshots
router.post('/:id/restore', requireRole('owner'), flowSnapshotController.restoreSnapshot);

// DELETE /:id - Delete one of this business's own snapshots
router.delete('/:id', requireRole('owner'), flowSnapshotController.deleteSnapshot);

module.exports = router;
