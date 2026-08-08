const express = require('express');
const router = express.Router();
const vehicleController = require('../controllers/vehicle.controller');
const { protect, requireShop } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

// All routes require: protect, requireShop
// POST, PUT, DELETE also require: requireRole('owner')
// GET, toggle also allow 'staff'

// GET /catalog - Get active vehicle catalog for shop to pick from (must be before /:id)
router.get('/catalog', protect, requireShop, vehicleController.getVehicleCatalogForShop);

// GET / - List vehicles
router.get('/', protect, requireShop, vehicleController.getVehicles);

// POST /upload-image - Upload vehicle photo
router.post(
  '/upload-image',
  protect,
  requireShop,
  requireRole('owner'),
  uploadSingle,
  vehicleController.uploadVehicleImage
);

// POST / - Create vehicle
router.post('/', protect, requireShop, requireRole('owner'), vehicleController.createVehicle);

// PUT /:id - Update vehicle
router.put('/:id', protect, requireShop, requireRole('owner'), vehicleController.updateVehicle);

// DELETE /:id - Delete vehicle
router.delete('/:id', protect, requireShop, requireRole('owner'), vehicleController.deleteVehicle);

// PUT /:id/toggle - Toggle vehicle
router.put('/:id/toggle', protect, requireShop, vehicleController.toggleVehicle);

module.exports = router;
