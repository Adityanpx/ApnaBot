const express = require('express');
const router = express.Router();
const flowPackPublicController = require('../controllers/flowPackPublic.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness (business owners/staff — no superadmin gate)

// GET / - List active flow packs, optionally filtered by category
router.get('/', protect, requireBusiness, flowPackPublicController.getFlowPacks);

// POST /:id/import - Replace business's rules with a flow pack's rules
router.post(
  '/:id/import',
  protect,
  requireBusiness,
  requireRole('owner'),
  flowPackPublicController.importFlowPack
);

module.exports = router;
