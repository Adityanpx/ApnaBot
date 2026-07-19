const express = require('express');
const router = express.Router();
const config = require('../config/env');

// GET /api/public/whatsapp-embedded-signup-config
// Returns non-secret Meta app config needed by the client-side Facebook JS SDK
// to launch WhatsApp Embedded Signup. appId/configId are not secrets - they are
// designed to be used in client-side JS SDK calls per Meta's docs.
router.get('/whatsapp-embedded-signup-config', (req, res) => {
  res.json({
    success: true,
    data: {
      appId: config.META_APP_ID,
      configId: config.META_CONFIG_ID
    }
  });
});

module.exports = router;
