# ApnaBot Backend — Remaining Implementation Plan (Steps 1–5)
> Comprehensive Guide: Where · What · How · Code  
> Stack: Node.js + Express + MongoDB + Redis + BullMQ

---

## Overview

The core WhatsApp chatbot flow is already complete. What remains is the management layer. This document covers Steps 1–5 of the 10-step remaining plan.

### Already Complete (do not touch)
- Auth system (register, login, JWT, refresh, logout)
- Shop CRUD + WhatsApp connect/disconnect
- Rule engine + chatbot service + Redis caching
- Webhook flow (full end-to-end)
- Booking state machine + booking CRUD
- Payment (Razorpay + UPI)
- BullMQ queue + worker
- Socket.io realtime events

### Steps 1–5 at a Glance

| Step | Module | Action | Priority |
|------|--------|--------|----------|
| Step 1 | Bug Fixes in Existing Code | UPDATE 3 existing files | CRITICAL |
| Step 2 | Customer Controller + Routes | CREATE + REPLACE | HIGH |
| Step 3 | Message Controller + Routes | CREATE + REPLACE | HIGH |
| Step 4 | Subscription System | CREATE 2 files + UPDATE 2 | HIGH |
| Step 5 | Staff Management | CREATE + REPLACE | MEDIUM |

---

# Step 1 — Critical Bug Fixes in Existing Code

> Before writing any new code, fix these bugs. Two of them are fatal runtime crashes.

---

## 1.1 Bug: Missing `generateTokens` and `saveTokenToRedis` in auth.service.js

**Where:** `src/services/auth.service.js`  
**What:** `shop.controller.js` calls `generateTokens()` and `saveTokenToRedis()` from auth.service — but these functions do not exist. Server crashes on `POST /api/shop`.  
**How:** Add both functions before the `module.exports` block, then add them to exports.

```js
// src/services/auth.service.js
// ADD these two functions before module.exports

/**
 * Generate both access and refresh tokens in one call
 * Called by shop.controller.js after shop creation
 */
const generateTokens = (payload) => {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload.userId);
  return { accessToken, refreshToken };
};

/**
 * Save refresh token to Redis — wrapper used by shop.controller.js
 */
const saveTokenToRedis = async (userId, token) => {
  await saveRefreshToken(userId, token);
};

// UPDATE module.exports to include both:
module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,       // NEW
  saveTokenToRedis,     // NEW
  saveRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  buildPermissions
};
```

---

## 1.2 Bug: Wrong field name `response` instead of `reply` in shop.service.js

**Where:** `src/services/shop.service.js` inside `createShop()` function  
**What:** Default rules are copied from BusinessTypeTemplate using `rule.response` but the Rule model schema field is `reply`. Rules created on shop signup will have empty reply text — bot will send blank messages.  
**How:** Find the `rulesToCreate` mapping and replace it.

```js
// src/services/shop.service.js — inside createShop()
// FIND and REPLACE the rulesToCreate block:

// ❌ WRONG
const rulesToCreate = template.defaultRules.map(rule => ({
  shopId: shop._id,
  keyword: rule.keyword,
  response: rule.response,   // ← field ignored by Mongoose, wrong name
  priority: rule.priority || 0,
  isActive: true,
  businessType
}));

// ✅ CORRECT
const rulesToCreate = template.defaultRules.map(rule => ({
  shopId: shop._id,
  keyword: rule.keyword,
  matchType: rule.matchType || 'contains',
  reply: rule.reply || rule.response || '',  // correct field name
  replyType: rule.replyType || 'text',
  priority: rule.priority || 0,
  isActive: true,
  triggerCount: 0
}));
```

---

## 1.3 Bug: `message_status` socket event never emitted in webhook.controller.js

**Where:** `src/controllers/webhook.controller.js` inside `receiveWebhook()`, the statuses loop  
**What:** The brief requires emitting `message_status` via Socket.io when Meta sends delivery/read status updates. Currently only the DB is updated — no socket emit.  
**How:** Find the statuses loop and replace it.

```js
// src/controllers/webhook.controller.js — inside receiveWebhook()
// FIND and REPLACE the statuses handling block:

// ❌ CURRENT — no socket emit
if (statuses) {
  for (const status of statuses) {
    await Message.findOneAndUpdate(
      { metaMessageId: status.id },
      { status: status.status }
    );
  }
  return;
}

// ✅ REPLACE WITH — emits socket event after DB update
if (statuses) {
  for (const status of statuses) {
    const updatedMsg = await Message.findOneAndUpdate(
      { metaMessageId: status.id },
      { status: status.status },
      { new: true }
    );
    if (updatedMsg) {
      try {
        socketService.emitToShop(updatedMsg.shopId.toString(), 'message_status', {
          messageId: updatedMsg._id,
          metaMessageId: status.id,
          status: status.status
        });
      } catch (socketErr) {
        logger.error('Error emitting message_status socket event:', socketErr);
      }
    }
  }
  return;
}
```

> **After Step 1:** Restart server, run `POST /api/shop` and confirm no crash. Check that default rules are created with non-empty `reply` fields in MongoDB.

---

# Step 2 — Customer Controller and Routes

**Files to create/update:**
- CREATE: `src/controllers/customer.controller.js`
- REPLACE: `src/routes/customer.routes.js`

---

## 2.1 CREATE: `src/controllers/customer.controller.js`

```js
// src/controllers/customer.controller.js — CREATE THIS FILE

const Customer = require('../models/Customer');
const Message = require('../models/Message');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/customers
 * List all customers for shop — paginated + searchable by name or number
 */
const getCustomers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isBlocked } = req.query;
    const shopId = req.user.shopId;

    const filter = { shopId };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { whatsappNumber: { $regex: search, $options: 'i' } }
      ];
    }

    if (isBlocked !== undefined) {
      filter.isBlocked = isBlocked === 'true';
    }

    const [total, customers] = await Promise.all([
      Customer.countDocuments(filter),
      Customer.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
    ]);

    const pagination = getPagination(total, page, limit);
    return successResponse(res, 200, { customers, pagination });
  } catch (error) {
    logger.error('Error in getCustomers:', error);
    next(error);
  }
};

/**
 * GET /api/customers/:id
 * Customer detail + last 50 messages
 */
const getCustomerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    const messages = await Message.find({ shopId, customerId: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return successResponse(res, 200, { customer, messages: messages.reverse() });
  } catch (error) {
    logger.error('Error in getCustomerById:', error);
    next(error);
  }
};

/**
 * PUT /api/customers/:id
 * Update customer name, tags, notes
 */
const updateCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, tags, notes } = req.body;
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    if (name !== undefined) customer.name = name.trim();
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return errorResponse(res, 400, 'Tags must be an array');
      customer.tags = tags.map(t => t.trim()).filter(Boolean);
    }
    if (notes !== undefined) customer.notes = notes;

    await customer.save();
    return successResponse(res, 200, customer);
  } catch (error) {
    logger.error('Error in updateCustomer:', error);
    next(error);
  }
};

/**
 * POST /api/customers/:id/block
 * Block customer — bot stops replying to them
 */
const blockCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');
    if (customer.isBlocked) return errorResponse(res, 400, 'Customer is already blocked');

    customer.isBlocked = true;
    await customer.save();

    logger.info(`Customer ${id} blocked for shop ${shopId}`);
    return successResponse(res, 200, customer, 'Customer blocked successfully');
  } catch (error) {
    logger.error('Error in blockCustomer:', error);
    next(error);
  }
};

/**
 * POST /api/customers/:id/unblock
 * Unblock a customer
 */
const unblockCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: id, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');
    if (!customer.isBlocked) return errorResponse(res, 400, 'Customer is not blocked');

    customer.isBlocked = false;
    await customer.save();

    logger.info(`Customer ${id} unblocked for shop ${shopId}`);
    return successResponse(res, 200, customer, 'Customer unblocked successfully');
  } catch (error) {
    logger.error('Error in unblockCustomer:', error);
    next(error);
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  updateCustomer,
  blockCustomer,
  unblockCustomer
};
```

---

## 2.2 REPLACE: `src/routes/customer.routes.js`

```js
// src/routes/customer.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getCustomers,
  getCustomerById,
  updateCustomer,
  blockCustomer,
  unblockCustomer
} = require('../controllers/customer.controller');

router.use(protect, requireShop);

router.get('/',             requireRole('owner', 'staff', 'superadmin'), getCustomers);
router.get('/:id',          requireRole('owner', 'staff', 'superadmin'), getCustomerById);
router.put('/:id',          requireRole('owner', 'superadmin'),          updateCustomer);
router.post('/:id/block',   requireRole('owner', 'superadmin'),          blockCustomer);
router.post('/:id/unblock', requireRole('owner', 'superadmin'),          unblockCustomer);

module.exports = router;
```

> **Verify:** `GET /api/customers` returns paginated list. `GET /api/customers?search=Rahul` filters by name/number. `POST /api/customers/:id/block` sets `isBlocked=true` and the webhook skips future messages from that number automatically (already handled in webhook.controller.js).

---

# Step 3 — Message Controller and Routes

**Files to create/update:**
- CREATE: `src/controllers/message.controller.js`
- REPLACE: `src/routes/message.routes.js`

---

## 3.1 CREATE: `src/controllers/message.controller.js`

```js
// src/controllers/message.controller.js — CREATE THIS FILE

const mongoose = require('mongoose');
const Message = require('../models/Message');
const Customer = require('../models/Customer');
const Shop = require('../models/Shop');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/messages
 * List conversations grouped by customer.
 * Returns latest message per customer + unread count.
 */
const getConversations = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const shopId = req.user.shopId;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const conversations = await Message.aggregate([
      { $match: { shopId: new mongoose.Types.ObjectId(shopId.toString()) } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$customerId',
          customerNumber: { $first: '$customerNumber' },
          lastMessage: { $first: '$content' },
          lastMessageAt: { $first: '$createdAt' },
          lastDirection: { $first: '$direction' },
          unreadCount: {
            $sum: {
              $cond: [
                { $and: [
                  { $eq: ['$direction', 'inbound'] },
                  { $eq: ['$isRead', false] }
                ]},
                1, 0
              ]
            }
          }
        }
      },
      { $sort: { lastMessageAt: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
      {
        $lookup: {
          from: 'customers',
          localField: '_id',
          foreignField: '_id',
          as: 'customer'
        }
      },
      { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } }
    ]);

    const totalResult = await Message.aggregate([
      { $match: { shopId: new mongoose.Types.ObjectId(shopId.toString()) } },
      { $group: { _id: '$customerId' } },
      { $count: 'total' }
    ]);

    const total = totalResult[0]?.total || 0;
    const pagination = getPagination(total, page, limit);

    return successResponse(res, 200, { conversations, pagination });
  } catch (error) {
    logger.error('Error in getConversations:', error);
    next(error);
  }
};

/**
 * GET /api/messages/:customerId
 * Full paginated chat history with a specific customer
 */
const getChatHistory = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const shopId = req.user.shopId;

    const customer = await Customer.findOne({ _id: customerId, shopId });
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    const filter = { shopId, customerId };
    const [total, messages] = await Promise.all([
      Message.countDocuments(filter),
      Message.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean()
    ]);

    const pagination = getPagination(total, page, limit);
    return successResponse(res, 200, {
      customer,
      messages: messages.reverse(), // return in chronological order
      pagination
    });
  } catch (error) {
    logger.error('Error in getChatHistory:', error);
    next(error);
  }
};

/**
 * PUT /api/messages/:id/read
 * Mark an inbound message as read
 */
const markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const message = await Message.findOneAndUpdate(
      { _id: id, shopId, direction: 'inbound' },
      { isRead: true },
      { new: true }
    );

    if (!message) return errorResponse(res, 404, 'Message not found');
    return successResponse(res, 200, message, 'Message marked as read');
  } catch (error) {
    logger.error('Error in markAsRead:', error);
    next(error);
  }
};

/**
 * POST /api/messages/send
 * Manually send a WhatsApp message to a customer.
 * ALWAYS goes through BullMQ — never calls Meta API directly.
 */
const sendMessage = async (req, res, next) => {
  try {
    const { customerNumber, message } = req.body;
    const shopId = req.user.shopId;

    if (!customerNumber || !message) {
      return errorResponse(res, 400, 'customerNumber and message are required');
    }
    if (message.trim().length === 0) {
      return errorResponse(res, 400, 'Message cannot be empty');
    }

    // Verify shop has WhatsApp connected
    const shop = await Shop.findById(shopId);
    if (!shop) return errorResponse(res, 404, 'Shop not found');
    if (!shop.isWhatsappConnected || !shop.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this shop');
    }

    // Upsert customer record
    const customer = await Customer.findOneAndUpdate(
      { shopId, whatsappNumber: customerNumber },
      {
        $setOnInsert: { firstSeenAt: new Date() },
        $set: { lastMessageAt: new Date() }
      },
      { upsert: true, new: true }
    );

    // Save outbound message to DB
    const outboundMsg = await Message.create({
      shopId,
      customerId: customer._id,
      customerNumber,
      direction: 'outbound',
      type: 'text',
      content: message.trim(),
      status: 'sent',
      isRead: true
    });

    // Queue via BullMQ — NEVER call Meta API directly from controller
    await addToWhatsappQueue({
      shopId: shopId.toString(),
      phoneNumberId: shop.phoneNumberId,
      encryptedAccessToken: shop.accessToken,
      to: customerNumber,
      message: message.trim(),
      type: 'text',
      messageId: outboundMsg._id.toString()
    });

    logger.info(`Manual message queued to ${customerNumber} for shop ${shopId}`);
    return successResponse(res, 201, outboundMsg, 'Message queued for delivery');
  } catch (error) {
    logger.error('Error in sendMessage:', error);
    next(error);
  }
};

module.exports = {
  getConversations,
  getChatHistory,
  markAsRead,
  sendMessage
};
```

---

## 3.2 REPLACE: `src/routes/message.routes.js`

```js
// src/routes/message.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getConversations,
  getChatHistory,
  markAsRead,
  sendMessage
} = require('../controllers/message.controller');

router.use(protect, requireShop);

// IMPORTANT: /send must be declared BEFORE /:customerId
// otherwise Express treats the string 'send' as a customerId param
router.post('/send',           requireRole('owner', 'superadmin'),          sendMessage);

router.get('/',                requireRole('owner', 'staff', 'superadmin'), getConversations);
router.get('/:customerId',     requireRole('owner', 'staff', 'superadmin'), getChatHistory);
router.put('/:id/read',        requireRole('owner', 'staff', 'superadmin'), markAsRead);

module.exports = router;
```

---

# Step 4 — Subscription System (Full)

This is the most complex remaining module. Covers: view current plan/usage, list plans, Razorpay checkout, payment verification + activation, cancel auto-renew, and the daily expiry cron job.

**Files to create/update:**
- CREATE: `src/services/subscription.service.js`
- CREATE: `src/controllers/subscription.controller.js`
- REPLACE: `src/routes/subscription.routes.js`
- UPDATE: `server.js` (add cron job)

---

## 4.1 CREATE: `src/services/subscription.service.js`

```js
// src/services/subscription.service.js — CREATE THIS FILE

const Subscription = require('../models/Subscription');
const Shop = require('../models/Shop');
const redis = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_KEY = (shopId) => `subscription:${shopId}`;
const CACHE_TTL = 300; // 5 minutes

/**
 * Get active subscription for shop with plan details.
 * Redis-first, falls back to MongoDB.
 */
const getActiveSubscription = async (shopId) => {
  try {
    const cacheKey = CACHE_KEY(shopId);
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const sub = await Subscription.findOne({ shopId, status: 'active' })
      .populate('planId')
      .lean();

    if (sub) await redis.set(cacheKey, JSON.stringify(sub), 'EX', CACHE_TTL);
    return sub || null;
  } catch (error) {
    logger.error('Error in getActiveSubscription:', error);
    throw error;
  }
};

/**
 * Invalidate subscription cache — call after any subscription change
 */
const invalidateSubscriptionCache = async (shopId) => {
  try {
    await redis.del(CACHE_KEY(shopId));
    logger.info(`Subscription cache cleared for shop ${shopId}`);
  } catch (error) {
    logger.error('Error clearing subscription cache:', error);
  }
};

/**
 * Create a new subscription (trial or paid).
 * Cancels any existing active subscription first.
 */
const createSubscription = async (shopId, planId, options = {}) => {
  try {
    // Cancel existing active subscriptions
    await Subscription.updateMany(
      { shopId, status: 'active' },
      { status: 'cancelled' }
    );

    const startDate = new Date();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1); // 1 month validity

    const sub = await Subscription.create({
      shopId,
      planId,
      status: options.status || 'active',
      startDate,
      endDate,
      razorpaySubscriptionId: options.razorpaySubscriptionId || null,
      razorpayPaymentId: options.razorpayPaymentId || null,
      autoRenew: options.autoRenew !== undefined ? options.autoRenew : true
    });

    // Activate shop on subscription creation
    await Shop.findByIdAndUpdate(shopId, { isActive: true });

    await invalidateSubscriptionCache(shopId);

    logger.info(`Subscription created for shop ${shopId}, plan ${planId}`);
    return sub;
  } catch (error) {
    logger.error('Error in createSubscription:', error);
    throw error;
  }
};

/**
 * Daily expiry check — called by cron job in server.js
 * Expires subscriptions past endDate, deactivates shops
 */
const runExpiryCheck = async () => {
  try {
    const now = new Date();
    logger.info('Running subscription expiry check...');

    const expiredSubs = await Subscription.find({
      status: 'active',
      endDate: { $lt: now }
    });

    logger.info(`Found ${expiredSubs.length} expired subscriptions`);

    for (const sub of expiredSubs) {
      try {
        sub.status = 'expired';
        await sub.save();

        await Shop.findByIdAndUpdate(sub.shopId, { isActive: false });

        // Clear Redis caches
        await redis.del(CACHE_KEY(sub.shopId));
        const shop = await Shop.findById(sub.shopId).select('phoneNumberId');
        if (shop?.phoneNumberId) {
          await redis.del(`tenant:${shop.phoneNumberId}`);
        }

        logger.info(`Subscription expired for shop ${sub.shopId}`);
      } catch (err) {
        logger.error(`Error processing expiry for sub ${sub._id}:`, err);
      }
    }

    return expiredSubs.length;
  } catch (error) {
    logger.error('Error in runExpiryCheck:', error);
    throw error;
  }
};

module.exports = {
  getActiveSubscription,
  invalidateSubscriptionCache,
  createSubscription,
  runExpiryCheck
};
```

---

## 4.2 CREATE: `src/controllers/subscription.controller.js`

```js
// src/controllers/subscription.controller.js — CREATE THIS FILE

const Razorpay = require('razorpay');
const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const subscriptionService = require('../services/subscription.service');
const usageService = require('../services/usage.service');
const { successResponse, errorResponse } = require('../utils/response');
const config = require('../config/env');
const logger = require('../utils/logger');

const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * GET /api/subscription
 * Get current plan + usage + expiry for the shop
 */
const getCurrentSubscription = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const [subscription, usage] = await Promise.all([
      Subscription.findOne({ shopId, status: { $in: ['active', 'trial'] } })
        .populate('planId')
        .lean(),
      usageService.getUsageForShop(shopId)
    ]);

    return successResponse(res, 200, {
      subscription: subscription || null,
      plan: subscription?.planId || null,
      usage,
      isActive: !!subscription
    });
  } catch (error) {
    logger.error('Error in getCurrentSubscription:', error);
    next(error);
  }
};

/**
 * GET /api/subscription/plans
 * List all available active plans
 */
const getPlans = async (req, res, next) => {
  try {
    const plans = await Plan.find({ isActive: true }).sort({ price: 1 });
    return successResponse(res, 200, { plans });
  } catch (error) {
    logger.error('Error in getPlans:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/create
 * Create a Razorpay order for subscription payment
 */
const createSubscriptionOrder = async (req, res, next) => {
  try {
    const { planId } = req.body;
    const shopId = req.user.shopId;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const plan = await Plan.findById(planId);
    if (!plan || !plan.isActive) return errorResponse(res, 404, 'Plan not found');

    const order = await razorpay.orders.create({
      amount: plan.price * 100, // paise
      currency: 'INR',
      receipt: `sub_${shopId}_${Date.now()}`,
      notes: {
        shopId: shopId.toString(),
        planId: planId.toString(),
        planName: plan.name
      }
    });

    logger.info(`Razorpay order created: ${order.id} for shop ${shopId}`);
    return successResponse(res, 200, {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      plan: {
        _id: plan._id,
        name: plan.name,
        displayName: plan.displayName,
        price: plan.price
      }
    });
  } catch (error) {
    logger.error('Error in createSubscriptionOrder:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/verify
 * Verify Razorpay payment signature and activate subscription
 */
const verifyAndActivate = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planId
    } = req.body;
    const shopId = req.user.shopId;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planId) {
      return errorResponse(res, 400, 'Missing payment verification fields');
    }

    // Verify Razorpay signature
    const expectedSig = crypto
      .createHmac('sha256', config.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      logger.warn(`Invalid payment signature for shop ${shopId}`);
      return errorResponse(res, 400, 'Invalid payment signature');
    }

    // Activate subscription
    const subscription = await subscriptionService.createSubscription(shopId, planId, {
      status: 'active',
      razorpayPaymentId: razorpay_payment_id,
      razorpaySubscriptionId: razorpay_order_id
    });

    const populated = await Subscription.findById(subscription._id).populate('planId');

    logger.info(`Subscription activated for shop ${shopId}, payment ${razorpay_payment_id}`);
    return successResponse(res, 200, { subscription: populated }, 'Subscription activated successfully');
  } catch (error) {
    logger.error('Error in verifyAndActivate:', error);
    next(error);
  }
};

/**
 * POST /api/subscription/cancel
 * Disable auto-renew. Subscription stays active until endDate.
 */
const cancelAutoRenew = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const sub = await Subscription.findOne({ shopId, status: 'active' });
    if (!sub) return errorResponse(res, 404, 'No active subscription found');
    if (!sub.autoRenew) return errorResponse(res, 400, 'Auto-renew is already disabled');

    sub.autoRenew = false;
    await sub.save();

    logger.info(`Auto-renew cancelled for shop ${shopId}`);
    return successResponse(
      res, 200, sub,
      `Auto-renew cancelled. Subscription active until ${sub.endDate.toDateString()}`
    );
  } catch (error) {
    logger.error('Error in cancelAutoRenew:', error);
    next(error);
  }
};

module.exports = {
  getCurrentSubscription,
  getPlans,
  createSubscriptionOrder,
  verifyAndActivate,
  cancelAutoRenew
};
```

---

## 4.3 REPLACE: `src/routes/subscription.routes.js`

```js
// src/routes/subscription.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getCurrentSubscription,
  getPlans,
  createSubscriptionOrder,
  verifyAndActivate,
  cancelAutoRenew
} = require('../controllers/subscription.controller');

router.use(protect);

// Plan listing is public (no shop required — needed during onboarding)
router.get('/plans', getPlans);

// All below require shop + owner role
router.use(requireShop, requireRole('owner', 'superadmin'));

router.get('/',        getCurrentSubscription);
router.post('/create', createSubscriptionOrder);
router.post('/verify', verifyAndActivate);
router.post('/cancel', cancelAutoRenew);

module.exports = router;
```

---

## 4.4 UPDATE: `server.js` — Add Daily Expiry Cron Job

Add this block to `server.js` after the BullMQ worker `require` statement:

```js
// server.js — ADD after the BullMQ worker require block

// ── Subscription Expiry Cron (every 24 hours) ──────────────────────────────
const subscriptionService = require('./src/services/subscription.service');

const runDailyExpiryCheck = async () => {
  try {
    const count = await subscriptionService.runExpiryCheck();
    logger.info(`Expiry check complete. ${count} subscriptions expired.`);
  } catch (err) {
    logger.error('Subscription expiry cron failed:', err);
  }
};

// Run once on startup to catch any missed expiries, then every 24 hours
runDailyExpiryCheck();
setInterval(runDailyExpiryCheck, 24 * 60 * 60 * 1000);

logger.info('Subscription expiry cron scheduled (runs every 24h)');
```

> **Note:** For production, install `node-cron` and use `cron.schedule('0 0 * * *', runDailyExpiryCheck)` for exact midnight scheduling.

---

# Step 5 — Staff Management

**Files to create/update:**
- CREATE: `src/controllers/staff.controller.js`
- REPLACE: `src/routes/staff.routes.js`

---

## 5.1 CREATE: `src/controllers/staff.controller.js`

```js
// src/controllers/staff.controller.js — CREATE THIS FILE

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const { successResponse, errorResponse } = require('../utils/response');
const { buildPermissions } = require('../services/auth.service');
const logger = require('../utils/logger');

/**
 * GET /api/staff
 * List all staff members in the shop
 */
const getStaff = async (req, res, next) => {
  try {
    const shopId = req.user.shopId;

    const staff = await User.find({ shopId, role: 'staff' })
      .select('-passwordHash')
      .sort({ createdAt: -1 });

    return successResponse(res, 200, { staff, total: staff.length });
  } catch (error) {
    logger.error('Error in getStaff:', error);
    next(error);
  }
};

/**
 * POST /api/staff/invite
 * Create a staff account under this shop.
 * Validates plan staff limit before creating.
 */
const inviteStaff = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    const shopId = req.user.shopId;

    if (!name || !email || !password) {
      return errorResponse(res, 400, 'Name, email, and password are required');
    }
    if (password.length < 6) {
      return errorResponse(res, 400, 'Password must be at least 6 characters');
    }

    // Check plan allows staff
    const subscription = await Subscription.findOne({ shopId, status: 'active' })
      .populate('planId');

    if (!subscription) {
      return errorResponse(res, 403, 'No active subscription. Cannot add staff.');
    }
    if (!subscription.planId.staffEnabled) {
      return errorResponse(res, 403, 'Staff feature not available on your plan. Please upgrade.');
    }

    const maxStaff = subscription.planId.maxStaff || 0;
    const currentCount = await User.countDocuments({ shopId, role: 'staff', isActive: true });

    if (currentCount >= maxStaff) {
      return errorResponse(res, 403, `Staff limit reached (${maxStaff}). Please upgrade your plan.`);
    }

    // Check email not already registered
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return errorResponse(res, 409, 'Email is already registered');

    const staffUser = new User({
      name: name.trim(),
      email: email.toLowerCase(),
      passwordHash: password, // pre-save hook in User model hashes this
      role: 'staff',
      shopId,
      permissions: buildPermissions('staff'),
      isActive: true
    });
    await staffUser.save();

    const responseUser = staffUser.toObject();
    delete responseUser.passwordHash;

    logger.info(`Staff ${staffUser._id} created for shop ${shopId}`);
    return successResponse(res, 201, responseUser, 'Staff member added successfully');
  } catch (error) {
    logger.error('Error in inviteStaff:', error);
    next(error);
  }
};

/**
 * PUT /api/staff/:id/permissions
 * Update staff permissions — canManageRules and canManageBilling
 * are always enforced as false for staff (hard-coded protection).
 */
const updatePermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;
    const shopId = req.user.shopId;

    if (!permissions || typeof permissions !== 'object') {
      return errorResponse(res, 400, 'permissions object is required');
    }

    const staffMember = await User.findOne({ _id: id, shopId, role: 'staff' });
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    // Only these 3 flags are adjustable for staff
    const adjustable = ['canViewChats', 'canManageBookings', 'canViewCustomers'];
    for (const key of adjustable) {
      if (permissions[key] !== undefined) {
        staffMember.permissions[key] = Boolean(permissions[key]);
      }
    }

    // Hard enforce — staff can never have these
    staffMember.permissions.canManageRules = false;
    staffMember.permissions.canManageBilling = false;

    await staffMember.save();

    const responseUser = staffMember.toObject();
    delete responseUser.passwordHash;

    return successResponse(res, 200, responseUser, 'Permissions updated');
  } catch (error) {
    logger.error('Error in updatePermissions:', error);
    next(error);
  }
};

/**
 * DELETE /api/staff/:id
 * Permanently remove a staff member
 */
const removeStaff = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const staffMember = await User.findOne({ _id: id, shopId, role: 'staff' });
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    await User.findByIdAndDelete(id);

    logger.info(`Staff ${id} removed from shop ${shopId}`);
    return successResponse(res, 200, null, 'Staff member removed successfully');
  } catch (error) {
    logger.error('Error in removeStaff:', error);
    next(error);
  }
};

/**
 * POST /api/staff/:id/toggle
 * Activate or deactivate a staff member account
 */
const toggleStaff = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const staffMember = await User.findOne({ _id: id, shopId, role: 'staff' });
    if (!staffMember) return errorResponse(res, 404, 'Staff member not found');

    staffMember.isActive = !staffMember.isActive;
    await staffMember.save();

    const action = staffMember.isActive ? 'activated' : 'deactivated';
    logger.info(`Staff ${id} ${action} for shop ${shopId}`);

    const responseUser = staffMember.toObject();
    delete responseUser.passwordHash;

    return successResponse(res, 200, responseUser, `Staff member ${action}`);
  } catch (error) {
    logger.error('Error in toggleStaff:', error);
    next(error);
  }
};

module.exports = {
  getStaff,
  inviteStaff,
  updatePermissions,
  removeStaff,
  toggleStaff
};
```

---

## 5.2 REPLACE: `src/routes/staff.routes.js`

```js
// src/routes/staff.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireShop } = require('../middleware/shop.middleware');
const {
  getStaff,
  inviteStaff,
  updatePermissions,
  removeStaff,
  toggleStaff
} = require('../controllers/staff.controller');

// All staff management routes — owner only
router.use(protect, requireShop, requireRole('owner', 'superadmin'));

router.get('/',                  getStaff);
router.post('/invite',           inviteStaff);
router.put('/:id/permissions',   updatePermissions);
router.delete('/:id',            removeStaff);
router.post('/:id/toggle',       toggleStaff);

module.exports = router;
```

## 5.3 Staff Login — No Changes Needed

Staff login already works via `POST /api/auth/login` using the same endpoint as owners. The JWT payload will contain `role: 'staff'` and the `shopId` of their employer shop. The `requireRole` middleware automatically blocks staff from owner-only routes.

> **Test sequence:**
> 1. `POST /api/staff/invite` with owner token → creates staff user
> 2. `POST /api/auth/login` with staff credentials → JWT with `role: 'staff'`
> 3. `GET /api/customers` with staff token → 200 OK
> 4. `POST /api/rules` with staff token → 403 Forbidden
> 5. `DELETE /api/staff/:id` with staff token → 403 Forbidden

---

# Summary — All Files Changed in Steps 1–5

| Step | Action | File Path |
|------|--------|-----------|
| 1 | UPDATE | `src/services/auth.service.js` |
| 1 | UPDATE | `src/services/shop.service.js` |
| 1 | UPDATE | `src/controllers/webhook.controller.js` |
| 2 | CREATE | `src/controllers/customer.controller.js` |
| 2 | REPLACE | `src/routes/customer.routes.js` |
| 3 | CREATE | `src/controllers/message.controller.js` |
| 3 | REPLACE | `src/routes/message.routes.js` |
| 4 | CREATE | `src/services/subscription.service.js` |
| 4 | CREATE | `src/controllers/subscription.controller.js` |
| 4 | REPLACE | `src/routes/subscription.routes.js` |
| 4 | UPDATE | `server.js` |
| 5 | CREATE | `src/controllers/staff.controller.js` |
| 5 | REPLACE | `src/routes/staff.routes.js` |

---

> Steps 6–10 (Admin Panel APIs, .env.example, nginx.conf, email service, testing) will be covered in the next document.
