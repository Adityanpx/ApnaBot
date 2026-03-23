# ApnaBot — User Panel: Bug Fixes & Missing Features Implementation Plan
> All 9 Critical Bugs + 6 Missing Features — 10 Steps
> Precise: Where · What · How · Code

---

## Overview

| Step | What | Files |
|------|------|-------|
| Step 1 | Fix `response.js` — standardize parameter order | `src/utils/response.js` |
| Step 2 | Fix `auth.controller.js` — broken refresh/logout/reset responses | `src/controllers/auth.controller.js` |
| Step 3 | Fix `booking.controller.js` — completely broken response pattern + wrong pagination | `src/controllers/booking.controller.js` |
| Step 4 | Fix `rule.controller.js` — wrong import + bulkImport wrong field | `src/controllers/rule.controller.js` |
| Step 5 | Fix `payment.routes.js` — history route wrong + webhook blocked by auth | `src/routes/payment.routes.js` |
| Step 6 | Fix `payment.controller.js` — sendToCustomer missing shop credentials | `src/controllers/payment.controller.js` |
| Step 7 | Implement `payment_trigger` rule type in webhook | `src/controllers/webhook.controller.js` |
| Step 8 | Add `usage_update` socket event + fix `new_message` missing customer object | `src/controllers/webhook.controller.js` |
| Step 9 | Fix `payment.service.js` — wrong `APP_URL` config key | `src/services/payment.service.js` |
| Step 10 | Final verification — cross-check all fixes end to end | No new code |

---

# Step 1 — Fix `response.js` — Standardize Parameter Order

**File:** `src/utils/response.js`  
**Action:** REPLACE entire file  
**Why:** `errorResponse` signature is `(res, message, statusCode)` but every controller calls it as `(res, statusCode, message)`. This causes every error response to crash with "Invalid status code" — the string message gets passed as the HTTP status code.

```js
// src/utils/response.js — REPLACE ENTIRE FILE

const successResponse = (res, statusCode = 200, data = null, message = 'Success') => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    errors: null
  });
};

const errorResponse = (res, statusCode = 500, message = 'Internal Server Error', errors = null) => {
  return res.status(statusCode).json({
    success: false,
    message,
    data: null,
    errors
  });
};

module.exports = {
  successResponse,
  errorResponse
};
```

**After this fix the standard response shape will be:**
```json
// Success
{
  "success": true,
  "message": "Login successful",
  "data": { ... },
  "errors": null
}

// Error
{
  "success": false,
  "message": "Invalid credentials",
  "data": null,
  "errors": null
}
```

---

# Step 2 — Fix `auth.controller.js` — Broken Response Calls

**File:** `src/controllers/auth.controller.js`  
**Action:** UPDATE 4 specific functions — `refresh`, `logout`, `forgotPassword`, `resetPassword`  
**Why:** These 4 functions pass message and data in wrong order or skip the data param entirely causing 500 errors.

## 2.1 Fix `refresh` function

**Find this exact block** (around line 178):
```js
// ❌ WRONG — message and data are swapped
return successResponse(res, 200, 'Token refreshed', { accessToken });
```

**Replace with:**
```js
// ✅ CORRECT
return successResponse(res, 200, { accessToken }, 'Token refreshed');
```

---

## 2.2 Fix `logout` function

**Find these two lines** (around line 210 and 214):
```js
// ❌ WRONG — string passed as data param
return successResponse(res, 200, 'Logged out successfully');
// and
return successResponse(res, 200, 'Logged out successfully');
```

**Replace both with:**
```js
// ✅ CORRECT — null data, message as 4th param
return successResponse(res, 200, null, 'Logged out successfully');
```

---

## 2.3 Fix `forgotPassword` function

**Find this line** (around line 245):
```js
// ❌ WRONG — null data correct but message is in wrong position
return successResponse(res, 200, null, 'If this email is registered, a reset link has been sent.');
```

This one is actually already correct — `null` as data, message as 4th param. **No change needed here.**

---

## 2.4 Fix `resetPassword` function

**Find this line** (around line 286):
```js
// ❌ WRONG — string passed as data param
return successResponse(res, 200, 'Password reset successfully');
```

**Replace with:**
```js
// ✅ CORRECT
return successResponse(res, 200, null, 'Password reset successfully');
```

---

# Step 3 — Fix `booking.controller.js` — Completely Broken

**File:** `src/controllers/booking.controller.js`  
**Action:** REPLACE entire file  
**Why:** 
- All `successResponse` calls missing statusCode — passes data as statusCode
- All `errorResponse` calls have message and statusCode swapped
- `paginateResponse` called with `(total, page, limit)` but signature is `(data, total, page, limit)` — first arg must be the data array
- `paginateResponse` from pagination.js returns `{ data, pagination }` but `getBookings` was trying to call it with wrong args anyway

```js
// src/controllers/booking.controller.js — REPLACE ENTIRE FILE

const Booking = require('../models/Booking');
const Customer = require('../models/Customer');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');

/**
 * GET /api/bookings
 * List bookings for shop with filters
 */
const getBookings = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, date, customerNumber } = req.query;
    const shopId = req.user.shopId;

    const filter = { shopId };

    if (status) {
      filter.status = status;
    }

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: startOfDay, $lte: endOfDay };
    }

    if (customerNumber) {
      filter.customerNumber = { $regex: customerNumber, $options: 'i' };
    }

    const [total, bookings] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .populate('customerId', 'name whatsappNumber')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
    ]);

    const pagination = getPagination(total, page, limit);

    return successResponse(res, 200, { bookings, pagination });
  } catch (error) {
    logger.error('Error fetching bookings:', error);
    next(error);
  }
};

/**
 * GET /api/bookings/:id
 * Get single booking detail
 */
const getBookingById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const booking = await Booking.findOne({ _id: id, shopId }).populate('customerId');

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    return successResponse(res, 200, booking);
  } catch (error) {
    logger.error('Error fetching booking:', error);
    next(error);
  }
};

/**
 * PUT /api/bookings/:id/status
 * Update booking status
 */
const updateBookingStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const shopId = req.user.shopId;

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return errorResponse(res, 400, 'Invalid status. Must be one of: pending, confirmed, completed, cancelled');
    }

    const booking = await Booking.findOne({ _id: id, shopId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    booking.status = status;
    await booking.save();

    try {
      socketService.emitToShop(shopId.toString(), 'booking_updated', {
        bookingId: id,
        status
      });
    } catch (socketError) {
      logger.error('Error emitting socket event:', socketError);
    }

    return successResponse(res, 200, booking, 'Booking status updated');
  } catch (error) {
    logger.error('Error updating booking status:', error);
    next(error);
  }
};

/**
 * PUT /api/bookings/:id/notes
 * Add or update internal notes on booking
 */
const addBookingNotes = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const shopId = req.user.shopId;

    if (!notes || typeof notes !== 'string') {
      return errorResponse(res, 400, 'Notes is required');
    }

    const booking = await Booking.findOne({ _id: id, shopId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    booking.fields = booking.fields || {};
    booking.fields.internalNotes = notes;
    booking.markModified('fields');
    await booking.save();

    return successResponse(res, 200, booking, 'Notes added successfully');
  } catch (error) {
    logger.error('Error adding booking notes:', error);
    next(error);
  }
};

/**
 * DELETE /api/bookings/:id
 * Delete booking
 */
const deleteBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shopId = req.user.shopId;

    const booking = await Booking.findOne({ _id: id, shopId });

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    await Booking.deleteOne({ _id: id });

    return successResponse(res, 200, null, 'Booking deleted successfully');
  } catch (error) {
    logger.error('Error deleting booking:', error);
    next(error);
  }
};

module.exports = {
  getBookings,
  getBookingById,
  updateBookingStatus,
  addBookingNotes,
  deleteBooking
};
```

---

# Step 4 — Fix `rule.controller.js` — Wrong Import + bulkImport Wrong Field

**File:** `src/controllers/rule.controller.js`  
**Action:** UPDATE 2 specific places  

## 4.1 Fix wrong import at top of file

**Find this line** (line 6):
```js
// ❌ WRONG — chatbotService does not exist as named export
const { chatbotService, invalidateRulesCache } = require('../services/chatbot.service');
```

**Replace with:**
```js
// ✅ CORRECT — these are the actual exports from chatbot.service.js
const { invalidateRulesCache } = require('../services/chatbot.service');
```

---

## 4.2 Fix bulkImportRules — wrong field name `response` → `reply`

**Find this block** inside the `bulkImportRules` function (around line 260):
```js
// ❌ WRONG — 'response' is not a field in Rule model schema
await Rule.create({
  shopId,
  keyword: rule.keyword,
  matchType: rule.matchType || 'contains',
  response: rule.response,   // ← wrong field, ignored by Mongoose
  reply: rule.response,      // ← reads from wrong source field
  replyType: 'text',
  isActive: true,
  triggerCount: 0,
  priority: rule.priority || 0,
  businessType: shop.businessType
});
```

**Replace with:**
```js
// ✅ CORRECT — use rule.reply which is the correct field in BusinessTypeTemplate
await Rule.create({
  shopId,
  keyword: rule.keyword,
  matchType: rule.matchType || 'contains',
  reply: rule.reply || '',   // ← correct field from template
  replyType: rule.replyType || 'text',
  isActive: true,
  triggerCount: 0
});
```

---

# Step 5 — Fix `payment.routes.js` — Two Bugs

**File:** `src/routes/payment.routes.js`  
**Action:** REPLACE entire file  
**Why:**
- Bug 1: `GET /history` points to `getPaymentStatus` instead of `getPaymentHistory`
- Bug 2: `router.use(requireShop)` applies to ALL routes including `/webhook` — Razorpay webhook has no auth token so it gets 403 on every payment callback

```js
// src/routes/payment.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireShop } = require('../middleware/shop.middleware');

// ─── PUBLIC ROUTE — No auth (Razorpay calls this directly) ───────────────────
// MUST be declared BEFORE the protect middleware is applied
router.post('/webhook', paymentController.razorpayWebhook);

// ─── PROTECTED ROUTES — require auth + shop ──────────────────────────────────
router.use(protect, requireShop);

// Create Razorpay payment link for a booking
router.post('/create-razorpay-link', paymentController.createRazorpayLink);

// Create UPI payment link
router.post('/create-upi-link', paymentController.createUPILink);

// Send payment link to customer via WhatsApp
router.post('/send-to-customer', paymentController.sendToCustomer);

// Get payment history — FIX: was pointing to getPaymentStatus before
router.get('/history', paymentController.getPaymentHistory);

// Get payment status for a specific booking
router.get('/status/:bookingId', paymentController.getPaymentStatus);

module.exports = router;
```

---

# Step 6 — Fix `payment.controller.js` — sendToCustomer Missing Shop Credentials

**File:** `src/controllers/payment.controller.js`  
**Action:** UPDATE `sendToCustomer` function only  
**Why:** The `addToWhatsappQueue` call is missing `phoneNumberId` and `encryptedAccessToken`. Without these, the BullMQ worker has no credentials to call the Meta API and the message will silently fail after 3 retries.

**Find the entire `sendToCustomer` function and REPLACE it:**

```js
/**
 * Send payment link to customer via WhatsApp
 * POST /api/payment/send-to-customer
 */
const sendToCustomer = async (req, res, next) => {
  try {
    const { bookingId, paymentLink } = req.body;
    const shopId = req.user.shopId;

    if (!bookingId || !paymentLink) {
      return errorResponse(res, 400, 'Booking ID and payment link are required');
    }

    // Find booking and verify ownership
    const booking = await Booking.findOne({ _id: bookingId, shopId });
    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    // Get customer phone
    const customer = await Customer.findById(booking.customerId);
    if (!customer) {
      return errorResponse(res, 404, 'Customer not found');
    }

    // Load shop to get WhatsApp credentials — REQUIRED for queue
    const Shop = require('../models/Shop');
    const shop = await Shop.findById(shopId);
    if (!shop || !shop.isWhatsappConnected || !shop.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this shop');
    }

    const { addToWhatsappQueue } = require('../queues/whatsapp.queue');

    const message = `Your payment link: ${paymentLink}\n\nPlease complete your payment to confirm your booking.`;

    // Queue with all required fields including shop WhatsApp credentials
    await addToWhatsappQueue({
      shopId: shopId.toString(),
      phoneNumberId: shop.phoneNumberId,
      encryptedAccessToken: shop.accessToken,
      to: customer.whatsappNumber,
      message,
      type: 'text'
    });

    logger.info('Payment link queued to customer:', customer.whatsappNumber);

    return successResponse(res, 200, null, 'Payment link sent to customer successfully');
  } catch (error) {
    logger.error('Error sending payment link to customer:', error);
    next(error);
  }
};
```

---

# Step 7 — Implement `payment_trigger` Rule Type in Webhook

**File:** `src/controllers/webhook.controller.js`  
**Action:** UPDATE one block inside `receiveWebhook`  
**Why:** When a rule with `replyType: 'payment_trigger'` is matched, the code currently just sends the rule's reply text as a plain message. The actual requirement is to generate a UPI deep link using the shop's `upiId` and send it as the WhatsApp reply.

**Find this block** (around Step 14, inside `receiveWebhook`):
```js
// ❌ CURRENT — payment_trigger falls through to plain text reply
} else {
  // payment_trigger - Phase 7 will handle
  replyText = matchedRule.reply;
}
```

**Replace the entire matched rule handling block** (from `if (matchedRule)` to `} else {` for fallback):

```js
// Step 14 — Prepare reply based on rule type
let replyText = null;
let triggeredRuleId = null;

if (matchedRule) {
  triggeredRuleId = matchedRule._id;

  if (matchedRule.replyType === 'text') {
    // Simple text reply
    replyText = matchedRule.reply;

  } else if (matchedRule.replyType === 'booking_trigger') {
    // Start booking flow — ask first question
    const firstQuestion = await bookingService.startBookingSession(
      tenant.shopId,
      customerNumber,
      matchedRule._id
    );
    replyText = firstQuestion;

  } else if (matchedRule.replyType === 'payment_trigger') {
    // Generate UPI deep link and send it
    try {
      const Shop = require('../models/Shop');
      const shop = await Shop.findById(tenant.shopId).select('upiId name');

      if (shop && shop.upiId) {
        // Build UPI deep link
        const upiParams = new URLSearchParams({
          pa: shop.upiId,
          pn: shop.name || 'Shop',
          tn: 'Payment'
        });
        const upiLink = `upi://pay?${upiParams.toString()}`;

        replyText = matchedRule.reply
          ? `${matchedRule.reply}\n\nPay here: ${upiLink}`
          : `Please complete your payment:\n\n${upiLink}`;

        // Increment payment link usage
        usageService.incrementUsage(tenant.shopId, 'paymentLink').catch(err =>
          logger.error('Error incrementing paymentLink usage:', err)
        );
      } else {
        // Shop has no UPI ID configured — fall back to reply text
        replyText = matchedRule.reply || 'Please contact us to arrange payment.';
        logger.warn(`Shop ${tenant.shopId} has payment_trigger rule but no upiId configured`);
      }
    } catch (paymentErr) {
      logger.error('Error generating payment trigger UPI link:', paymentErr);
      replyText = matchedRule.reply || 'Please contact us to arrange payment.';
    }
  }
} else {
  // No rule matched — send fallback reply
  replyText = tenant.fallbackReply || 'Thank you for your message. We will get back to you soon.';
}
```

---

# Step 8 — Add `usage_update` Socket Event + Fix `new_message` Missing Customer

**File:** `src/controllers/webhook.controller.js`  
**Action:** UPDATE two places inside `receiveWebhook`  

## 8.1 Fix `new_message` socket emit — add full customer object

The brief says `new_message` should emit `{ customer, message }` but currently only emits `{ message, customerNumber }`. Flutter needs the customer object to display name in chat list.

**Find the first `new_message` emit** (inside the booking session block, around step 12):
```js
// ❌ CURRENT — missing customer object
socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
  message: outboundMsg,
  customerNumber
});
```

**Replace with:**
```js
// ✅ FIXED — includes full customer object
socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
  customer,
  message: outboundMsg,
  customerNumber
});
```

**Find the second `new_message` emit** — there is no explicit emit for the main rule-matched reply path. Add it after Step 16 (queue outbound message), right before Step 17:

```js
// Step 16 — Queue outbound message
await addToWhatsappQueue({
  shopId: tenant.shopId,
  phoneNumberId: tenant.phoneNumberId,
  encryptedAccessToken: tenant.accessToken,
  to: customerNumber,
  message: replyText,
  type: 'text',
  messageId: outboundMsg._id
});

// ADD THIS — Emit new_message to Flutter app with full customer object
try {
  socketService.emitToShop(tenant.shopId.toString(), 'new_message', {
    customer,
    message: outboundMsg,
    customerNumber
  });
} catch (socketError) {
  logger.error('Error emitting new_message socket event:', socketError);
}

// Step 17 — Increment outbound usage (fire and forget)
usageService.incrementUsage(tenant.shopId, 'outbound');
```

---

## 8.2 Add `usage_update` socket event

The brief says emit `usage_update: { msgCount, limit }` after each processed message. This lets Flutter show a live usage bar.

**Add this block right after Step 10 (increment usage):**

```js
// Step 10 — Increment usage (fire and forget)
usageService.incrementUsage(tenant.shopId, 'inbound');

// ADD THIS — Emit usage_update to Flutter dashboard
usageService.checkUsageLimit(tenant.shopId, tenant.plan?.msgLimit || 500)
  .then(usageCheck => {
    socketService.emitToShop(tenant.shopId.toString(), 'usage_update', {
      msgCount: usageCheck.current,
      limit: usageCheck.limit
    });
  })
  .catch(err => logger.error('Error emitting usage_update:', err));
```

---

# Step 9 — Fix `payment.service.js` — Wrong Config Key `APP_URL`

**File:** `src/services/payment.service.js`  
**Action:** UPDATE one line in `createRazorpayPaymentLink`  
**Why:** The Razorpay payment link uses `config.APP_URL` for the callback URL but this key does not exist in `config/env.js`. It should use `config.FRONTEND_URL`.

**Find this line** inside `createRazorpayPaymentLink`:
```js
// ❌ WRONG — APP_URL is undefined, will make callback_url = "undefined/payment/callback..."
callback_url: `${config.APP_URL}/payment/callback?bookingId=${bookingId}`,
```

**Replace with:**
```js
// ✅ CORRECT — FRONTEND_URL exists in env config
callback_url: `${config.FRONTEND_URL}/payment/callback?bookingId=${bookingId}`,
```

---

# Step 10 — Final Verification Checklist

> No new code in this step. Run through each check manually after applying all fixes.

---

## 10.1 Server Startup Check

Start the server and confirm all 3 lines appear with no errors:

```bash
npm run dev
```

Expected:
```
Redis connected
MongoDB connected  
BullMQ worker started
Server running on port 3000
```

If you see `"chatbotService is not a function"` → Step 4.1 was not applied correctly.  
If you see `"Invalid status code"` → Step 1 was not applied correctly.

---

## 10.2 Response Shape Verification

**Test auth login:**
```
POST /api/auth/login
Body: { "email": "rahul@test.com", "password": "test1234" }

Expected shape:
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { ... },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  },
  "errors": null
}
```

**Test token refresh:**
```
POST /api/auth/refresh
Body: { "refreshToken": "eyJ..." }

Expected shape:
{
  "success": true,
  "message": "Token refreshed",
  "data": { "accessToken": "eyJ..." },
  "errors": null
}
```

**Test error response:**
```
POST /api/auth/login
Body: { "email": "wrong@test.com", "password": "wrong" }

Expected shape:
{
  "success": false,
  "message": "Invalid credentials",
  "data": null,
  "errors": null
}
```

---

## 10.3 Booking Endpoints Verification

```
GET /api/bookings
Authorization: Bearer {{owner_token}}

Expected:
{
  "success": true,
  "data": {
    "bookings": [],
    "pagination": {
      "total": 0,
      "page": 1,
      "limit": 20,
      "totalPages": 0
    }
  }
}
```

If `success: false` with status 500 → Step 3 was not applied correctly.

---

## 10.4 Rules Endpoint Startup Verification

```
GET /api/rules
Authorization: Bearer {{owner_token}}

Expected: 200 OK with rules array
```

If server crashes on startup with `TypeError: chatbotService is not a function` → Step 4.1 was not applied.

---

## 10.5 Payment Route Verification

**Verify history route works:**
```
GET /api/payment/history
Authorization: Bearer {{owner_token}}

Expected: 200 OK with bookings array (not payment status object)
```

**Verify webhook route is public (no auth):**
```
POST /api/payment/webhook
No Authorization header
Body: { "event": "test" }

Expected: 400 (invalid signature) — NOT 401 or 403
```
If you get 401/403 → Step 5 was not applied correctly.

---

## 10.6 BulkImport Rules Verification

```
POST /api/rules/bulk-import
Authorization: Bearer {{owner_token}}
Body: { "replaceExisting": true }

Then GET /api/rules — check that rules have non-empty reply field

Expected: Each rule has "reply": "some text here"
NOT: "reply": ""
```

---

## 10.7 Payment Trigger Rule Verification

Create a rule with `payment_trigger` type:
```
POST /api/rules
Authorization: Bearer {{owner_token}}
Body:
{
  "keyword": "pay",
  "matchType": "contains",
  "reply": "Here is your payment link",
  "replyType": "payment_trigger"
}
```

Make sure shop has `upiId` set:
```
PUT /api/shop
Body: { "upiId": "yourname@upi" }
```

When a customer sends "pay" via webhook simulation, the reply should contain `upi://pay?pa=yourname@upi...`

---

## 10.8 SendToCustomer Payment Verification

```
POST /api/payment/send-to-customer
Authorization: Bearer {{owner_token}}
Body: {
  "bookingId": "{{booking_id}}",
  "paymentLink": "https://rzp.io/test123"
}

Expected: 200 OK — "Payment link sent to customer successfully"
NOT: 400 "WhatsApp is not connected"
```

If you get 400 → Shop needs WhatsApp connected first via `POST /api/shop/connect-whatsapp`.

---

## 10.9 Complete Bug Fix Summary

After all 10 steps, verify this checklist:

| Check | Fix Applied | Status |
|-------|-------------|--------|
| `response.js` parameter order | Step 1 | ✅ |
| Auth refresh returns correct shape | Step 2.1 | ✅ |
| Auth logout returns correct shape | Step 2.2 | ✅ |
| Auth resetPassword correct shape | Step 2.4 | ✅ |
| Booking endpoints all return 200 | Step 3 | ✅ |
| Rule controller no crash on startup | Step 4.1 | ✅ |
| BulkImport creates rules with reply text | Step 4.2 | ✅ |
| Payment /history returns list not status | Step 5 | ✅ |
| Payment /webhook no longer blocked by auth | Step 5 | ✅ |
| SendToCustomer includes shop credentials | Step 6 | ✅ |
| payment_trigger generates UPI link | Step 7 | ✅ |
| new_message socket includes customer object | Step 8.1 | ✅ |
| usage_update socket emitted after each message | Step 8.2 | ✅ |
| Razorpay callback_url uses correct config key | Step 9 | ✅ |

---

## 10.10 Files Changed Summary

| Step | Action | File |
|------|--------|------|
| 1 | REPLACE | `src/utils/response.js` |
| 2 | UPDATE | `src/controllers/auth.controller.js` |
| 3 | REPLACE | `src/controllers/booking.controller.js` |
| 4 | UPDATE | `src/controllers/rule.controller.js` |
| 5 | REPLACE | `src/routes/payment.routes.js` |
| 6 | UPDATE | `src/controllers/payment.controller.js` |
| 7 | UPDATE | `src/controllers/webhook.controller.js` |
| 8 | UPDATE | `src/controllers/webhook.controller.js` |
| 9 | UPDATE | `src/services/payment.service.js` |
| 10 | TEST ONLY | — |
