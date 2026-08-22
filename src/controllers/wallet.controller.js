const Razorpay = require('razorpay');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const walletService = require('../services/wallet.service');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const config = require('../config/env');
const logger = require('../utils/logger');

const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * GET /api/wallet
 * Current wallet balance for the business
 */
const getWallet = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const wallet = await walletService.getOrCreateWallet(businessId);

    return successResponse(res, 200, {
      balancePaise: wallet.balance_paise,
      balanceRupees: wallet.balance_paise / 100
    });
  } catch (error) {
    logger.error('Error in getWallet:', error);
    next(error);
  }
};

/**
 * GET /api/wallet/transactions
 * Paginated wallet transaction history, newest first
 */
const getWalletTransactions = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const wallet = await walletService.getOrCreateWallet(businessId);

    const { data, error, count } = await supabase
      .from('wallet_transactions').select('*', { count: 'exact' }).eq('wallet_id', wallet.id)
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);
    return successResponse(res, 200, { transactions: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error in getWalletTransactions:', error);
    next(error);
  }
};

/**
 * POST /api/wallet/topup/initiate
 * Create a Razorpay order for a wallet top-up
 */
const initiateTopup = async (req, res, next) => {
  try {
    const { amountRupees } = req.body;
    const businessId = req.user.businessId;

    if (!amountRupees || amountRupees <= 0) {
      return errorResponse(res, 400, 'amountRupees must be a positive number');
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amountRupees * 100), // paise
      currency: 'INR',
      receipt: `wallet_${Date.now()}`, // Max 40 chars: "wallet_" + 13 digits = 20 chars
      notes: {
        businessId: businessId.toString(),
        purpose: 'wallet_topup'
      }
    });

    logger.info(`Razorpay order created for wallet top-up: ${order.id}, business ${businessId}`);
    return successResponse(res, 200, {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: config.RAZORPAY_KEY_ID
    });
  } catch (error) {
    logger.error('Error in initiateTopup:', error);
    next(error);
  }
};

/**
 * POST /api/wallet/topup/verify
 * Verify Razorpay payment signature and credit the wallet
 */
const verifyTopup = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      amountRupees
    } = req.body;
    const businessId = req.user.businessId;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !amountRupees) {
      return errorResponse(res, 400, 'Missing payment verification fields');
    }

    // Verify Razorpay signature
    const expectedSig = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      logger.warn(`Invalid wallet top-up payment signature for business ${businessId}`);
      return errorResponse(res, 400, 'Invalid payment signature');
    }

    // The signature only proves order_id + payment_id are genuine — it says
    // nothing about amountRupees, which is client-supplied and not part of the
    // signed payload. Fetch the order from Razorpay and credit its actual
    // amount (already in paise) so a client can't under-pay and claim a
    // larger top-up.
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const amountPaise = order.amount;

    if (Math.round(amountRupees * 100) !== amountPaise) {
      logger.warn(`Wallet top-up amount mismatch for business ${businessId}: client claimed ₹${amountRupees}, order ${razorpay_order_id} is actually ${amountPaise} paise`);
    }

    const newBalance = await walletService.creditWallet(
      businessId, amountPaise, razorpay_payment_id, `Wallet top-up via Razorpay order ${razorpay_order_id}`
    );

    logger.info(`Wallet topped up for business ${businessId}, payment ${razorpay_payment_id}`);
    return successResponse(res, 200, {
      balancePaise: newBalance,
      balanceRupees: newBalance / 100
    }, 'Wallet topped up successfully');
  } catch (error) {
    logger.error('Error in verifyTopup:', error);
    next(error);
  }
};

module.exports = {
  getWallet,
  getWalletTransactions,
  initiateTopup,
  verifyTopup
};
