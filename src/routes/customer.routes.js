// src/routes/customer.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getCustomers,
  getCustomerById,
  updateCustomer,
  blockCustomer,
  unblockCustomer
} = require('../controllers/customer.controller');

router.use(protect, requireShop);

router.get('/',             requireRole('owner', 'staff', 'superadmin'), getCustomers);
router.get('/:id',          requireRole('owner', 'staff', 'superadmin'), getCustomerById);
router.put('/:id',          requireRole('owner', 'superadmin'),          updateCustomer);
router.post('/:id/block',   requireRole('owner', 'superadmin'),          blockCustomer);
router.post('/:id/unblock', requireRole('owner', 'superadmin'),          unblockCustomer);

module.exports = router;
