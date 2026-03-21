const express = require('express');
const router = express.Router();
const ruleController = require('../controllers/rule.controller');
const { protect, requireShop } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireShop
// POST, PUT, DELETE also require: requireRole('owner')
// GET, toggle also allow 'staff'

// GET / - List rules
router.get('/', protect, requireShop, ruleController.getRules);

// GET /templates - Get templates (must be before /:id)
router.get('/templates', protect, requireShop, ruleController.getTemplates);

// POST /bulk-import - Bulk import rules
router.post(
  '/bulk-import',
  protect,
  requireShop,
  requireRole('owner'),
  ruleController.bulkImportRules
);

// POST / - Create rule
router.post('/', protect, requireShop, requireRole('owner'), ruleController.createRule);

// PUT /:id - Update rule
router.put('/:id', protect, requireShop, requireRole('owner'), ruleController.updateRule);

// DELETE /:id - Delete rule
router.delete('/:id', protect, requireShop, requireRole('owner'), ruleController.deleteRule);

// PUT /:id/toggle - Toggle rule
router.put('/:id/toggle', protect, requireShop, ruleController.toggleRule);

module.exports = router;
