// src/routes/staff.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getStaff,
  inviteStaff,
  updatePermissions,
  removeStaff,
  toggleStaff
} = require('../controllers/staff.controller');

// All staff management routes — owner only
router.use(protect, requireShop, requireRole('owner', 'superadmin'));

router.get('/',                  getStaff);
router.post('/invite',           inviteStaff);
router.put('/:id/permissions',   updatePermissions);
router.delete('/:id',            removeStaff);
router.post('/:id/toggle',       toggleStaff);

module.exports = router;
