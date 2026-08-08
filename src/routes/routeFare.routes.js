const express = require('express');
const router = express.Router();
const routeFareController = require('../controllers/routeFare.controller');
const { protect, requireShop } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireShop
// POST, PUT, DELETE also require: requireRole('owner')

// GET / - List route fares
router.get('/', protect, requireShop, routeFareController.getRouteFares);

// POST / - Create (or upsert) route fare
router.post('/', protect, requireShop, requireRole('owner'), routeFareController.createRouteFare);

// PUT /:id - Update route fare
router.put('/:id', protect, requireShop, requireRole('owner'), routeFareController.updateRouteFare);

// DELETE /:id - Delete route fare
router.delete('/:id', protect, requireShop, requireRole('owner'), routeFareController.deleteRouteFare);

module.exports = router;
