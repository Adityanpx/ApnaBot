// src/routes/message.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getConversations,
  getChatHistory,
  markAsRead,
  sendMessage
} = require('../controllers/message.controller');

router.use(protect, requireShop);

// IMPORTANT: /send must be declared BEFORE /:customerId
// otherwise Express treats the string 'send' as a customerId param
router.post('/send',           requireRole('owner', 'superadmin'),          sendMessage);

router.get('/',                requireRole('owner', 'staff', 'superadmin'), getConversations);
router.get('/:customerId',     requireRole('owner', 'staff', 'superadmin'), getChatHistory);
router.put('/:id/read',        requireRole('owner', 'staff', 'superadmin'), markAsRead);

module.exports = router;
