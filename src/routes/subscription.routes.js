// src/routes/subscription.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getCurrentSubscription,
  getPlans,
  createSubscriptionOrder,
  verifyAndActivate,
  cancelAutoRenew
} = require('../controllers/subscription.controller');

router.use(protect);

// Plan listing is public (no shop required — needed during onboarding)
router.get('/plans', getPlans);

// All below require shop + owner role
router.use(requireShop, requireRole('owner', 'superadmin'));

router.get('/',        getCurrentSubscription);
router.post('/create', createSubscriptionOrder);
router.post('/verify', verifyAndActivate);
router.post('/cancel', cancelAutoRenew);

module.exports = router;
