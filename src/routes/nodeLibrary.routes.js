const express = require('express');
const router = express.Router();
const nodeLibraryController = require('../controllers/nodeLibrary.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// SuperAdmin only - same protect + requireRole('superadmin') pattern as categoryTemplate.routes.js
router.use(protect, requireRole('superadmin'));

// GET /businesses/:businessId/nodes - registered before the root-level
// routes below since it's its own unambiguous literal prefix.
router.get('/businesses/:businessId/nodes', nodeLibraryController.getBusinessNodes);

router.post('/', nodeLibraryController.addNodeToLibrary);
router.get('/', nodeLibraryController.listLibraryEntries);
router.delete('/:id', nodeLibraryController.deleteLibraryEntry);

module.exports = router;
