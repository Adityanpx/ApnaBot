const express = require('express');
const router = express.Router();
const vehicleController = require('../controllers/travel/vehicle.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

// All routes require: protect, requireBusiness
// POST, PUT, DELETE also require: requireRole('owner')
// GET, toggle also allow 'staff'

// GET /catalog - Get active vehicle catalog for business to pick from (must be before /:id)
router.get('/catalog', protect, requireBusiness, vehicleController.getVehicleCatalogForBusiness);

// GET / - List vehicles
router.get('/', protect, requireBusiness, vehicleController.getVehicles);

// POST /upload-image - Upload vehicle photo
router.post(
  '/upload-image',
  protect,
  requireBusiness,
  requireRole('owner'),
  uploadSingle,
  vehicleController.uploadVehicleImage
);

// POST / - Create vehicle
router.post('/', protect, requireBusiness, requireRole('owner'), vehicleController.createVehicle);

// PUT /:id - Update vehicle
router.put('/:id', protect, requireBusiness, requireRole('owner'), vehicleController.updateVehicle);

// DELETE /:id - Delete vehicle
router.delete('/:id', protect, requireBusiness, requireRole('owner'), vehicleController.deleteVehicle);

// PUT /:id/toggle - Toggle vehicle
router.put('/:id/toggle', protect, requireBusiness, vehicleController.toggleVehicle);

module.exports = router;
