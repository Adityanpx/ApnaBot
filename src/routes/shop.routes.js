const express = require('express');
const router = express.Router();
const shopController = require('../controllers/shop.controller');
const { protect, requireShop } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

// GET    /                   → protect, requireShop, shop.controller.getShop
// POST   /                   → protect, shop.controller.createShop
// PUT    /                   → protect, requireShop, shop.controller.updateShop
// POST   /connect-whatsapp   → protect, requireShop, requireRole('owner'), shop.controller.connectWhatsapp
// DELETE /disconnect-whatsapp → protect, requireShop, requireRole('owner'), shop.controller.disconnectWhatsapp
// GET    /dashboard-stats     → protect, requireShop, shop.controller.getDashboardStats
// POST   /upload-image        → protect, requireShop, requireRole('owner'), upload, shop.controller.uploadProfileImage

// GET / - Get shop profile
router.get('/', protect, requireShop, shopController.getShop);

// POST / - Create shop (user has no shopId yet)
router.post('/', protect, shopController.createShop);

// PUT / - Update shop profile
router.put('/', protect, requireShop, shopController.updateShop);

// POST /connect-whatsapp - Connect WhatsApp Business
router.post(
  '/connect-whatsapp',
  protect,
  requireShop,
  requireRole('owner'),
  shopController.connectWhatsapp
);

// DELETE /disconnect-whatsapp - Disconnect WhatsApp
router.delete(
  '/disconnect-whatsapp',
  protect,
  requireShop,
  requireRole('owner'),
  shopController.disconnectWhatsapp
);

// GET /dashboard-stats - Get dashboard statistics
router.get('/dashboard-stats', protect, requireShop, shopController.getDashboardStats);

// POST /upload-image - Upload profile image
router.post(
  '/upload-image',
  protect,
  requireShop,
  requireRole('owner'),
  uploadSingle,
  shopController.uploadProfileImage
);

module.exports = router;
