const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// Meta webhook verification
router.get('/verify', webhookController.verifyWebhook);

// Receive WhatsApp messages
router.post('/receive', webhookController.receiveWebhook);

module.exports = router;
