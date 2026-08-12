const express = require('express');
const router = express.Router();
const messageTemplateController = require('../controllers/messageTemplate.controller');
const { protect, requireShop } = require('../middleware/auth.middleware');

// All routes require: protect, requireShop

// GET / - List message templates
router.get('/', protect, requireShop, messageTemplateController.getMessageTemplates);

// POST / - Create message template (draft)
router.post('/', protect, requireShop, messageTemplateController.createMessageTemplate);

// POST /:id/submit - Submit template to Meta for review
router.post('/:id/submit', protect, requireShop, messageTemplateController.submitMessageTemplate);

// DELETE /:id - Delete a draft/rejected template
router.delete('/:id', protect, requireShop, messageTemplateController.deleteMessageTemplate);

module.exports = router;
