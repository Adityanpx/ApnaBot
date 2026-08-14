const express = require('express');
const router = express.Router();
const flowPackController = require('../controllers/flowPack.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes — superadmin only
router.use(protect, requireRole('superadmin'));

// GET / - List flow packs
router.get('/', flowPackController.getFlowPacks);

// GET /:id - Get a single flow pack
router.get('/:id', flowPackController.getFlowPack);

// POST / - Create flow pack
router.post('/', flowPackController.createFlowPack);

// PUT /:id - Update flow pack
router.put('/:id', flowPackController.updateFlowPack);

// DELETE /:id - Delete flow pack
router.delete('/:id', flowPackController.deleteFlowPack);

module.exports = router;
