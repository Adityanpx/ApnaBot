const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// Meta webhook verification (GET /api/webhook)
router.get('/', webhookController.verifyWebhook);

// Receive WhatsApp messages (POST /api/webhook)
router.post('/', webhookController.receiveWebhook);

module.exports = router;
