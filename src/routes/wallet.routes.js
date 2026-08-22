const express = require('express');
const router = express.Router();
const walletController = require('../controllers/wallet.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');

// All routes require: protect, requireBusiness

// GET / - Current wallet balance
router.get('/', protect, requireBusiness, walletController.getWallet);

// GET /transactions - Paginated wallet transaction history
router.get('/transactions', protect, requireBusiness, walletController.getWalletTransactions);

// POST /topup/initiate - Create Razorpay order for a wallet top-up
router.post('/topup/initiate', protect, requireBusiness, walletController.initiateTopup);

// POST /topup/verify - Verify payment signature and credit the wallet
router.post('/topup/verify', protect, requireBusiness, walletController.verifyTopup);

module.exports = router;
