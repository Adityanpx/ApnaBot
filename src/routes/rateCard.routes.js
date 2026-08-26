const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { getRateCards, createRateCard } = require('../controllers/rateCard.controller');

router.use(protect, requireRole('superadmin'));

router.get('/', getRateCards);
router.post('/', createRateCard);

module.exports = router;
