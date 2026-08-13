const express = require('express');
const router = express.Router();
const ruleController = require('../controllers/rule.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

// All routes require: protect, requireBusiness
// POST, PUT, DELETE also require: requireRole('owner')
// GET, toggle also allow 'staff'

// GET / - List rules
router.get('/', protect, requireBusiness, ruleController.getRules);

// GET /templates - Get templates (must be before /:id)
router.get('/templates', protect, requireBusiness, ruleController.getTemplates);

// POST /bulk-import - Bulk import rules
router.post(
  '/bulk-import',
  protect,
  requireBusiness,
  requireRole('owner'),
  ruleController.bulkImportRules
);

// POST /upload-image - Upload rule reply image
router.post(
  '/upload-image',
  protect,
  requireBusiness,
  requireRole('owner'),
  uploadSingle,
  ruleController.uploadRuleImage
);

// POST / - Create rule
router.post('/', protect, requireBusiness, requireRole('owner'), ruleController.createRule);

// PUT /:id - Update rule
router.put('/:id', protect, requireBusiness, requireRole('owner'), ruleController.updateRule);

// DELETE /:id - Delete rule
router.delete('/:id', protect, requireBusiness, requireRole('owner'), ruleController.deleteRule);

// PUT /:id/toggle - Toggle rule
router.put('/:id/toggle', protect, requireBusiness, ruleController.toggleRule);

module.exports = router;
