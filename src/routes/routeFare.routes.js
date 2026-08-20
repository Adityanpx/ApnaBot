const express = require('express');
const router = express.Router();
const routeFareController = require('../controllers/travel/routeFare.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness
// POST, PUT, DELETE also require: requireRole('owner')

// GET / - List route fares
router.get('/', protect, requireBusiness, routeFareController.getRouteFares);

// POST / - Create (or upsert) route fare
router.post('/', protect, requireBusiness, requireRole('owner'), routeFareController.createRouteFare);

// PUT /:id - Update route fare
router.put('/:id', protect, requireBusiness, requireRole('owner'), routeFareController.updateRouteFare);

// DELETE /:id - Delete route fare
router.delete('/:id', protect, requireBusiness, requireRole('owner'), routeFareController.deleteRouteFare);

module.exports = router;
