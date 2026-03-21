// src/routes/admin.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  getShops,
  getShopById,
  toggleShop,
  changeShopPlan,
  extendSubscription,
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
router.put('/shops/:id/plan',       changeShopPlan);
router.put('/shops/:id/extend',     extendSubscription);

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
