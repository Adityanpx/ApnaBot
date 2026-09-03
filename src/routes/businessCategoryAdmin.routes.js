const express = require('express');
const router = express.Router();
const businessCategoryAdminController = require('../controllers/businessCategoryAdmin.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// SuperAdmin only - same protect + requireRole('superadmin') pattern as categoryTemplate.routes.js
router.use(protect, requireRole('superadmin'));

router.get('/', businessCategoryAdminController.getCategories);
router.put('/:value/toggle', businessCategoryAdminController.toggleCategory);

module.exports = router;
