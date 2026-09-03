const express = require('express');
const router = express.Router();
const categoryTemplateController = require('../controllers/categoryTemplate.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// SuperAdmin only - same protect + requireRole('superadmin') pattern as admin.routes.js
router.use(protect, requireRole('superadmin'));

router.get('/', categoryTemplateController.getCategoryTemplates);
router.post('/clone-from-business', categoryTemplateController.cloneFromBusiness);
router.post('/import-json', categoryTemplateController.importTemplateJson);
router.delete('/:id', categoryTemplateController.deleteCategoryTemplate);
router.get('/:id/export', categoryTemplateController.exportTemplateJson);

module.exports = router;
