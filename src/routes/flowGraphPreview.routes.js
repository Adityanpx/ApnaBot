const express = require('express');
const router = express.Router();
const flowGraphPreviewController = require('../controllers/flowGraphPreview.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');

// Read-mostly (no writes to customers/bookings/messages/booking_leads, no
// Redis session, no WhatsApp queue) - owner+staff, same auth as the other
// read-mostly flow-graph endpoints. No requireGraphEngine: every business is
// graph-only now, and this handler needs more of the business row
// (displayName/fallbackReply/enableSmartFallback) than that middleware's
// narrower select provides, so it fetches the business itself instead.
router.use(protect, requireBusiness);

// POST /message - Stateless simulated conversation turn. See
// flowGraphPreview.controller.js's doc comment for the full contract.
router.post('/message', flowGraphPreviewController.previewMessage);

module.exports = router;
