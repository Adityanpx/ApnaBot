const express = require('express');
const router = express.Router();
const nodeLibraryPublicController = require('../controllers/nodeLibraryPublic.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness. GET (browse) is open to any
// authenticated business member, mirroring flowSnapshot.routes.js's
// GET-open/write-owner-only pattern. POST /insert (owner-only) mutates the
// business's live flow_nodes.
router.use(protect, requireBusiness);

router.get('/', nodeLibraryPublicController.getLibraryForCategory);
router.post('/insert', requireRole('owner'), nodeLibraryPublicController.insertNodeFromLibrary);

module.exports = router;
