// src/routes/subscription.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireBusiness } = require('../middleware/business.middleware');
const {
  getCurrentSubscription,
  getPlans,
  createSubscriptionOrder,
  verifyAndActivate,
  cancelAutoRenew,
  createAutopaySubscription,
  verifyAutopayAuthorization
} = require('../controllers/subscription.controller');

router.use(protect);

// Plan listing is public (no business required — needed during onboarding)
router.get('/plans', getPlans);

// All below require business + owner role
router.use(requireBusiness, requireRole('owner', 'superadmin'));

router.get('/',        getCurrentSubscription);
router.post('/create', createSubscriptionOrder);
router.post('/verify', verifyAndActivate);
router.post('/cancel', cancelAutoRenew);
router.post('/autopay/create', createAutopaySubscription);
router.post('/autopay/verify', verifyAutopayAuthorization);

module.exports = router;
