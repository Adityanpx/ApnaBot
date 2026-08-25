const express = require('express');
const router = express.Router();
const savedFlowController = require('../controllers/savedFlow.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness, requireRole('owner')

// POST / - Snapshot current rules as a new named saved flow
router.post('/', protect, requireBusiness, requireRole('owner'), savedFlowController.createSavedFlow);

// GET / - List this business's saved flows, newest first
router.get('/', protect, requireBusiness, requireRole('owner'), savedFlowController.getSavedFlows);

// POST /:id/restore - Replace business's rules with a saved flow's rules
router.post(
  '/:id/restore',
  protect,
  requireBusiness,
  requireRole('owner'),
  savedFlowController.restoreSavedFlow
);

// DELETE /:id - Delete a saved flow
router.delete('/:id', protect, requireBusiness, requireRole('owner'), savedFlowController.deleteSavedFlow);

module.exports = router;
