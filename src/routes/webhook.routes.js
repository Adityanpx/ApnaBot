const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// Meta webhook verification (GET /api/webhook)
router.get('/', webhookController.verifyWebhook);

// Receive WhatsApp messages (POST /api/webhook)
router.post('/', (req, res, next) => {
  console.log('WEBHOOK POST hit');
  next();
}, webhookController.receiveWebhook);

module.exports = router;
