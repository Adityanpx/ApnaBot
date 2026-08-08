const express = require('express');
const router = express.Router();
const vehicleCatalogController = require('../controllers/vehicleCatalog.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

// All routes — superadmin only
router.use(protect, requireRole('superadmin'));

// GET / - List vehicle catalog entries
router.get('/', vehicleCatalogController.getVehicleCatalog);

// POST /upload-image - Upload vehicle catalog image
router.post('/upload-image', uploadSingle, vehicleCatalogController.uploadVehicleCatalogImage);

// POST / - Create vehicle catalog entry
router.post('/', vehicleCatalogController.createVehicleCatalogEntry);

// PUT /:id - Update vehicle catalog entry
router.put('/:id', vehicleCatalogController.updateVehicleCatalogEntry);

// DELETE /:id - Delete vehicle catalog entry
router.delete('/:id', vehicleCatalogController.deleteVehicleCatalogEntry);

module.exports = router;
