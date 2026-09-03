const express = require('express');
const router = express.Router();
const businessCategoryController = require('../controllers/businessCategory.controller');
const { protect } = require('../middleware/auth.middleware');

// Deliberately NOT requireBusiness — this runs during onboarding, before a
// business exists yet.
router.use(protect);

router.get('/', businessCategoryController.getEnabledCategories);

module.exports = router;
