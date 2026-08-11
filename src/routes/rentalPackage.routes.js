const express = require('express');
const router = express.Router();
const rentalPackageController = require('../controllers/rentalPackage.controller');
const { protect, requireShop } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireShop
// POST, PUT, DELETE also require: requireRole('owner')

// GET / - List rental packages
router.get('/', protect, requireShop, rentalPackageController.getRentalPackages);

// POST / - Create rental package
router.post('/', protect, requireShop, requireRole('owner'), rentalPackageController.createRentalPackage);

// PUT /:id - Update rental package
router.put('/:id', protect, requireShop, requireRole('owner'), rentalPackageController.updateRentalPackage);

// DELETE /:id - Delete rental package
router.delete('/:id', protect, requireShop, requireRole('owner'), rentalPackageController.deleteRentalPackage);

module.exports = router;
