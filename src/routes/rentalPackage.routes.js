const express = require('express');
const router = express.Router();
const rentalPackageController = require('../controllers/rentalPackage.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness
// POST, PUT, DELETE also require: requireRole('owner')

// GET / - List rental packages
router.get('/', protect, requireBusiness, rentalPackageController.getRentalPackages);

// POST / - Create rental package
router.post('/', protect, requireBusiness, requireRole('owner'), rentalPackageController.createRentalPackage);

// PUT /:id - Update rental package
router.put('/:id', protect, requireBusiness, requireRole('owner'), rentalPackageController.updateRentalPackage);

// DELETE /:id - Delete rental package
router.delete('/:id', protect, requireBusiness, requireRole('owner'), rentalPackageController.deleteRentalPackage);

module.exports = router;
