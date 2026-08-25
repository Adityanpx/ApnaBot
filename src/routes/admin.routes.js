// src/routes/admin.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  getShops,
  getShopById,
  toggleShop,
  deleteShop,
  changeShopPlan,
  extendSubscription,
  grantSubscription,
  getSubscriptionHistory,
  getPlatformStats,
  getRevenueReport,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getTemplates,
  updateTemplate
} = require('../controllers/admin.controller');

// All admin routes — superadmin only
router.use(protect, requireRole('superadmin'));

// Shops
router.get('/shops',                getShops);
router.get('/shops/:id',            getShopById);
router.put('/shops/:id/toggle',     toggleShop);
router.delete('/shops/:id',         deleteShop);
router.put('/shops/:id/plan',       changeShopPlan);
router.put('/shops/:id/extend',     extendSubscription);

// Manual subscription grants (superadmin override — bypasses payment)
router.post('/shops/:id/grant-subscription',     grantSubscription);
router.get('/shops/:id/subscription-history',    getSubscriptionHistory);

// Stats & Revenue
router.get('/stats',                getPlatformStats);
router.get('/revenue',              getRevenueReport);

// Plans
router.get('/plans',                getPlans);
router.post('/plans',               createPlan);
router.put('/plans/:id',            updatePlan);
router.delete('/plans/:id',         deletePlan);

// Business Type Templates
router.get('/templates',            getTemplates);
router.put('/templates/:id',        updateTemplate);

module.exports = router;
