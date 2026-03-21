# ApnaBot Backend — Remaining Implementation Plan (Steps 6–10)
> Comprehensive Guide: Where · What · How · Code  
> Stack: Node.js + Express + MongoDB + Redis + BullMQ

---

## Overview

Steps 1–5 are complete. This document covers the final 5 steps.

### Steps 6–10 at a Glance

| Step | Module | Action | Priority |
|------|--------|--------|----------|
| Step 6 | Admin Panel APIs | CREATE 2 files + REPLACE 1 | HIGH |
| Step 7 | Email Service + Forgot Password | CREATE 1 file + UPDATE 1 | MEDIUM |
| Step 8 | .env.example + nginx.conf + CI/CD | CREATE 3 files | MEDIUM |
| Step 9 | Seeds Completion + Duplicate Index Fixes | UPDATE 5 files | HIGH |
| Step 10 | Complete Testing (All Endpoints) | TEST ONLY — no new code | CRITICAL |

---

# Step 6 — Admin Panel APIs

The `admin.routes.js` is a stub. This step creates the full admin controller with all endpoints the super admin needs to manage shops, plans, subscriptions, and business type templates.

**Files to create/update:**
- CREATE: `src/controllers/admin.controller.js`
- CREATE: `src/services/admin.service.js`
- REPLACE: `src/routes/admin.routes.js`

---

## 6.1 CREATE: `src/services/admin.service.js`

```js
// src/services/admin.service.js — CREATE THIS FILE

const Shop = require('../models/Shop');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Plan = require('../models/Plan');
const Usage = require('../models/Usage');
const Message = require('../models/Message');
const Booking = require('../models/Booking');
const logger = require('../utils/logger');

/**
 * Get platform-wide stats for admin dashboard
 */
const getPlatformStats = async () => {
  try {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalShops,
      activeShops,
      totalUsers,
      activeSubscriptions,
      totalMessagesThisMonth,
      totalBookingsThisMonth,
      revenueThisMonth
    ] = await Promise.all([
      Shop.countDocuments(),
      Shop.countDocuments({ isActive: true }),
      User.countDocuments({ role: { $in: ['owner', 'staff'] } }),
      Subscription.countDocuments({ status: 'active' }),
      Message.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Booking.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Subscription.aggregate([
        { $match: { status: 'active', createdAt: { $gte: startOfMonth } } },
        { $lookup: { from: 'plans', localField: 'planId', foreignField: '_id', as: 'plan' } },
        { $unwind: '$plan' },
        { $group: { _id: null, total: { $sum: '$plan.price' } } }
      ])
    ]);

    return {
      totalShops,
      activeShops,
      inactiveShops: totalShops - activeShops,
      totalUsers,
      activeSubscriptions,
      totalMessagesThisMonth,
      totalBookingsThisMonth,
      revenueThisMonth: revenueThisMonth[0]?.total || 0,
      month: currentMonth
    };
  } catch (error) {
    logger.error('Error in getPlatformStats:', error);
    throw error;
  }
};

/**
 * Get monthly revenue report
 */
const getRevenueReport = async (months = 6) => {
  try {
    const report = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const endDate = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      const result = await Subscription.aggregate([
        {
          $match: {
            status: { $in: ['active', 'expired'] },
            createdAt: { $gte: date, $lte: endDate }
          }
        },
        { $lookup: { from: 'plans', localField: 'planId', foreignField: '_id', as: 'plan' } },
        { $unwind: '$plan' },
        {
          $group: {
            _id: null,
            revenue: { $sum: '$plan.price' },
            count: { $sum: 1 }
          }
        }
      ]);

      report.push({
        month: monthKey,
        revenue: result[0]?.revenue || 0,
        subscriptions: result[0]?.count || 0
      });
    }

    return report.reverse();
  } catch (error) {
    logger.error('Error in getRevenueReport:', error);
    throw error;
  }
};

module.exports = {
  getPlatformStats,
  getRevenueReport
};
```

---

## 6.2 CREATE: `src/controllers/admin.controller.js`

```js
// src/controllers/admin.controller.js — CREATE THIS FILE

const Shop = require('../models/Shop');
const User = require('../models/User');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const subscriptionService = require('../services/subscription.service');
const adminService = require('../services/admin.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * GET /api/admin/shops
 * List all shops — paginated + searchable
 */
const getShops = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isActive, businessType } = req.query;

    const filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { city: { $regex: search, $options: 'i' } }
      ];
    }
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (businessType) filter.businessType = businessType;

    const [total, shops] = await Promise.all([
      Shop.countDocuments(filter),
      Shop.find(filter)
        .populate('ownerUserId', 'name email')
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .select('-accessToken') // never expose encrypted token
    ]);

    const pagination = getPagination(total, page, limit);
    return successResponse(res, 200, { shops, pagination });
  } catch (error) {
    logger.error('Error in getShops:', error);
    next(error);
  }
};

/**
 * GET /api/admin/shops/:id
 * Get full shop detail — includes subscription + usage
 */
const getShopById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const shop = await Shop.findById(id)
      .populate('ownerUserId', 'name email lastLoginAt')
      .select('-accessToken');

    if (!shop) return errorResponse(res, 404, 'Shop not found');

    const subscription = await Subscription.findOne({
      shopId: id,
      status: { $in: ['active', 'trial'] }
    }).populate('planId');

    const staffCount = await User.countDocuments({ shopId: id, role: 'staff' });

    return successResponse(res, 200, {
      shop,
      subscription: subscription || null,
      plan: subscription?.planId || null,
      staffCount
    });
  } catch (error) {
    logger.error('Error in getShopById:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/toggle
 * Activate or deactivate a shop
 */
const toggleShop = async (req, res, next) => {
  try {
    const { id } = req.params;

    const shop = await Shop.findById(id);
    if (!shop) return errorResponse(res, 404, 'Shop not found');

    shop.isActive = !shop.isActive;
    await shop.save();

    const action = shop.isActive ? 'activated' : 'deactivated';
    logger.info(`Shop ${id} ${action} by superadmin`);

    return successResponse(res, 200, { isActive: shop.isActive }, `Shop ${action} successfully`);
  } catch (error) {
    logger.error('Error in toggleShop:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/plan
 * Manually change a shop's subscription plan
 */
const changeShopPlan = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { planId } = req.body;

    if (!planId) return errorResponse(res, 400, 'planId is required');

    const shop = await Shop.findById(id);
    if (!shop) return errorResponse(res, 404, 'Shop not found');

    const plan = await Plan.findById(planId);
    if (!plan || !plan.isActive) return errorResponse(res, 404, 'Plan not found');

    const subscription = await subscriptionService.createSubscription(id, planId, {
      status: 'active'
    });

    const populated = await Subscription.findById(subscription._id).populate('planId');

    logger.info(`Shop ${id} plan changed to ${plan.name} by superadmin`);
    return successResponse(res, 200, { subscription: populated }, 'Plan changed successfully');
  } catch (error) {
    logger.error('Error in changeShopPlan:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/shops/:id/extend
 * Extend a shop's subscription expiry by N days
 */
const extendSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { days = 30 } = req.body;

    const subscription = await Subscription.findOne({
      shopId: id,
      status: { $in: ['active', 'expired'] }
    });

    if (!subscription) return errorResponse(res, 404, 'No subscription found for this shop');

    const currentEnd = subscription.endDate > new Date() ? subscription.endDate : new Date();
    subscription.endDate = new Date(currentEnd.getTime() + days * 24 * 60 * 60 * 1000);
    subscription.status = 'active';
    await subscription.save();

    // Reactivate shop if it was deactivated
    await Shop.findByIdAndUpdate(id, { isActive: true });

    // Clear Redis cache
    await subscriptionService.invalidateSubscriptionCache(id);

    logger.info(`Shop ${id} subscription extended by ${days} days by superadmin`);
    return successResponse(res, 200, subscription, `Subscription extended by ${days} days`);
  } catch (error) {
    logger.error('Error in extendSubscription:', error);
    next(error);
  }
};

/**
 * GET /api/admin/stats
 * Platform-wide statistics
 */
const getPlatformStats = async (req, res, next) => {
  try {
    const stats = await adminService.getPlatformStats();
    return successResponse(res, 200, stats);
  } catch (error) {
    logger.error('Error in getPlatformStats:', error);
    next(error);
  }
};

/**
 * GET /api/admin/revenue
 * Monthly revenue report (last 6 months by default)
 */
const getRevenueReport = async (req, res, next) => {
  try {
    const { months = 6 } = req.query;
    const report = await adminService.getRevenueReport(parseInt(months));
    return successResponse(res, 200, { report });
  } catch (error) {
    logger.error('Error in getRevenueReport:', error);
    next(error);
  }
};

/**
 * GET /api/admin/plans
 * List all plans (including inactive)
 */
const getPlans = async (req, res, next) => {
  try {
    const plans = await Plan.find().sort({ price: 1 });
    return successResponse(res, 200, { plans });
  } catch (error) {
    logger.error('Error in getPlans:', error);
    next(error);
  }
};

/**
 * POST /api/admin/plans
 * Create a new plan
 */
const createPlan = async (req, res, next) => {
  try {
    const {
      name, displayName, price, msgLimit, ruleLimit,
      customerLimit, bookingEnabled, paymentLinkEnabled,
      staffEnabled, maxStaff
    } = req.body;

    if (!name || !displayName || price === undefined) {
      return errorResponse(res, 400, 'name, displayName, and price are required');
    }

    const existing = await Plan.findOne({ name });
    if (existing) return errorResponse(res, 409, 'A plan with this name already exists');

    const plan = await Plan.create({
      name,
      displayName,
      price,
      msgLimit: msgLimit ?? 500,
      ruleLimit: ruleLimit ?? 10,
      customerLimit: customerLimit ?? 100,
      bookingEnabled: bookingEnabled ?? true,
      paymentLinkEnabled: paymentLinkEnabled ?? false,
      staffEnabled: staffEnabled ?? false,
      maxStaff: maxStaff ?? 0,
      isActive: true
    });

    logger.info(`Plan ${plan.name} created by superadmin`);
    return successResponse(res, 201, plan, 'Plan created successfully');
  } catch (error) {
    logger.error('Error in createPlan:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/plans/:id
 * Update an existing plan
 */
const updatePlan = async (req, res, next) => {
  try {
    const { id } = req.params;

    const plan = await Plan.findById(id);
    if (!plan) return errorResponse(res, 404, 'Plan not found');

    const allowedFields = [
      'displayName', 'price', 'msgLimit', 'ruleLimit', 'customerLimit',
      'bookingEnabled', 'paymentLinkEnabled', 'staffEnabled', 'maxStaff', 'isActive'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        plan[field] = req.body[field];
      }
    }

    await plan.save();

    logger.info(`Plan ${id} updated by superadmin`);
    return successResponse(res, 200, plan, 'Plan updated successfully');
  } catch (error) {
    logger.error('Error in updatePlan:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/plans/:id
 * Soft delete — marks plan as inactive
 */
const deletePlan = async (req, res, next) => {
  try {
    const { id } = req.params;

    const plan = await Plan.findById(id);
    if (!plan) return errorResponse(res, 404, 'Plan not found');

    // Check if any active subscriptions use this plan
    const activeCount = await Subscription.countDocuments({ planId: id, status: 'active' });
    if (activeCount > 0) {
      return errorResponse(res, 400, `Cannot delete — ${activeCount} active subscriptions use this plan`);
    }

    plan.isActive = false;
    await plan.save();

    logger.info(`Plan ${id} deactivated by superadmin`);
    return successResponse(res, 200, null, 'Plan deactivated successfully');
  } catch (error) {
    logger.error('Error in deletePlan:', error);
    next(error);
  }
};

/**
 * GET /api/admin/templates
 * List all business type templates
 */
const getTemplates = async (req, res, next) => {
  try {
    const templates = await BusinessTypeTemplate.find().sort({ businessType: 1 });
    return successResponse(res, 200, { templates });
  } catch (error) {
    logger.error('Error in getTemplates:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/templates/:id
 * Update a business type template's default rules and booking fields
 */
const updateTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { defaultRules, bookingFields } = req.body;

    const template = await BusinessTypeTemplate.findById(id);
    if (!template) return errorResponse(res, 404, 'Template not found');

    if (defaultRules !== undefined) template.defaultRules = defaultRules;
    if (bookingFields !== undefined) template.bookingFields = bookingFields;

    await template.save();

    logger.info(`Template ${id} updated by superadmin`);
    return successResponse(res, 200, template, 'Template updated successfully');
  } catch (error) {
    logger.error('Error in updateTemplate:', error);
    next(error);
  }
};

module.exports = {
  getShops,
  getShopById,
  toggleShop,
  changeShopPlan,
  extendSubscription,
  getPlatformStats,
  getRevenueReport,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getTemplates,
  updateTemplate
};
```

---

## 6.3 REPLACE: `src/routes/admin.routes.js`

```js
// src/routes/admin.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  getShops,
  getShopById,
  toggleShop,
  changeShopPlan,
  extendSubscription,
  getPlatformStats,
  getRevenueReport,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getTemplates,
  updateTemplate
} = require('../controllers/admin.controller');

// All admin routes — superadmin only
router.use(protect, requireRole('superadmin'));

// Shops
router.get('/shops',                getShops);
router.get('/shops/:id',            getShopById);
router.put('/shops/:id/toggle',     toggleShop);
router.put('/shops/:id/plan',       changeShopPlan);
router.put('/shops/:id/extend',     extendSubscription);

// Stats & Revenue
router.get('/stats',                getPlatformStats);
router.get('/revenue',              getRevenueReport);

// Plans
router.get('/plans',                getPlans);
router.post('/plans',               createPlan);
router.put('/plans/:id',            updatePlan);
router.delete('/plans/:id',         deletePlan);

// Business Type Templates
router.get('/templates',            getTemplates);
router.put('/templates/:id',        updateTemplate);

module.exports = router;
```

> **Verify:** Login with superadmin credentials, use that token, hit `GET /api/admin/stats` — should return platform-wide counts. Try `GET /api/admin/shops` — should list all shops. Try the same endpoints with an owner token — should get 403.

---

# Step 7 — Email Service + Forgot Password

Currently `forgotPassword` in `auth.controller.js` only logs the reset token to console. This step wires up a real email sender using **Nodemailer** with Gmail or any SMTP.

**Files to create/update:**
- CREATE: `src/services/email.service.js`
- UPDATE: `src/controllers/auth.controller.js` (forgot password function only)
- UPDATE: `.env` (add email credentials)

---

## 7.1 Install Nodemailer

```bash
npm install nodemailer
```

---

## 7.2 Add to `.env`

```env
# Email Configuration
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASS=your-gmail-app-password
EMAIL_FROM=ApnaBot <your-gmail@gmail.com>
```

> **Note:** For Gmail, you need an **App Password** not your regular password. Go to Google Account → Security → 2-Step Verification → App Passwords → generate one.

---

## 7.3 CREATE: `src/services/email.service.js`

```js
// src/services/email.service.js — CREATE THIS FILE

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// Create reusable transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/**
 * Send password reset email
 * @param {string} toEmail - Recipient email
 * @param {string} resetToken - The reset token
 * @param {string} userName - Recipient name
 */
const sendPasswordResetEmail = async (toEmail, resetToken, userName) => {
  try {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}&email=${toEmail}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'ApnaBot <noreply@apnabot.com>',
      to: toEmail,
      subject: 'Reset your ApnaBot password',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Password Reset Request</h2>
          <p>Hi ${userName},</p>
          <p>We received a request to reset your ApnaBot password.</p>
          <p>Click the button below to reset it. This link expires in <strong>1 hour</strong>.</p>
          <a href="${resetUrl}"
             style="display: inline-block; background: #1a1a2e; color: white;
                    padding: 12px 24px; border-radius: 6px; text-decoration: none;
                    margin: 16px 0;">
            Reset Password
          </a>
          <p style="color: #777; font-size: 13px;">
            If you did not request this, ignore this email. Your password will not change.
          </p>
          <p style="color: #777; font-size: 13px;">
            Or copy this link: ${resetUrl}
          </p>
        </div>
      `
    });

    logger.info(`Password reset email sent to ${toEmail}`);
  } catch (error) {
    logger.error('Error sending password reset email:', error);
    throw error;
  }
};

/**
 * Send subscription expiry warning email
 * @param {string} toEmail
 * @param {string} shopName
 * @param {Date} expiryDate
 */
const sendExpiryWarningEmail = async (toEmail, shopName, expiryDate) => {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'ApnaBot <noreply@apnabot.com>',
      to: toEmail,
      subject: `Your ApnaBot subscription for ${shopName} is expiring soon`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Subscription Expiring Soon</h2>
          <p>Hi,</p>
          <p>Your ApnaBot subscription for <strong>${shopName}</strong> will expire on
             <strong>${expiryDate.toDateString()}</strong>.</p>
          <p>Renew now to keep your WhatsApp chatbot running without interruption.</p>
          <a href="${process.env.FRONTEND_URL}/billing"
             style="display: inline-block; background: #1a1a2e; color: white;
                    padding: 12px 24px; border-radius: 6px; text-decoration: none;
                    margin: 16px 0;">
            Renew Subscription
          </a>
        </div>
      `
    });

    logger.info(`Expiry warning email sent to ${toEmail} for shop ${shopName}`);
  } catch (error) {
    logger.error('Error sending expiry warning email:', error);
    // Don't throw — email failure should not crash the app
  }
};

module.exports = {
  sendPasswordResetEmail,
  sendExpiryWarningEmail
};
```

---

## 7.4 UPDATE: `src/controllers/auth.controller.js`

Find the `forgotPassword` function and replace it:

```js
// src/controllers/auth.controller.js
// FIND the forgotPassword function and REPLACE it entirely:

const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, 400, 'Email is required');
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always return same message for security (don't reveal if email exists)
    if (user) {
      const resetToken = generateResetToken();

      // Save to Redis with 1 hour TTL
      await redis.set(`reset:${user._id}`, resetToken, 'EX', 3600);

      // Send actual email
      try {
        const emailService = require('../services/email.service');
        await emailService.sendPasswordResetEmail(user.email, resetToken, user.name);
      } catch (emailError) {
        // Log but don't fail the request — token is saved, user can retry
        logger.error('Failed to send reset email:', emailError);
      }
    }

    return successResponse(res, 200, null, 'If this email is registered, a reset link has been sent.');
  } catch (error) {
    logger.error('Forgot password error:', error);
    next(error);
  }
};
```

Also add the email service import at the top of `auth.controller.js` if not already:

```js
// Already importing these — just add email.service where needed inline as shown above
// No top-level import needed since it's inside the try block
```

---

# Step 8 — .env.example + nginx.conf + CI/CD

These are the DevOps files referenced in the brief that are missing from the project.

**Files to create:**
- CREATE: `.env.example`
- CREATE: `nginx.conf`
- CREATE: `.github/workflows/deploy.yml`

---

## 8.1 CREATE: `.env.example`

```env
# ── Server ─────────────────────────────────────────────
PORT=3000
NODE_ENV=production

# ── MongoDB ────────────────────────────────────────────
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/apnabot

# ── Redis ──────────────────────────────────────────────
# Local Docker: redis://localhost:6379
# Upstash:      rediss://default:password@host.upstash.io:6379
REDIS_URL=rediss://default:password@your-host.upstash.io:6379

# ── JWT ────────────────────────────────────────────────
# Must be at least 32 random characters
JWT_SECRET=your_strong_jwt_secret_min_32_chars_here
JWT_REFRESH_SECRET=your_strong_refresh_secret_min_32_chars
JWT_EXPIRY=15m
JWT_REFRESH_EXPIRY=30d

# ── Encryption ─────────────────────────────────────────
# Must be EXACTLY 32 characters — used to AES encrypt Meta tokens
ENCRYPTION_KEY=your_exactly_32_char_encryption_key

# ── Meta / WhatsApp ────────────────────────────────────
META_APP_SECRET=your_meta_app_secret_from_developer_portal
WEBHOOK_VERIFY_TOKEN=any_random_string_you_choose

# ── Razorpay ───────────────────────────────────────────
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret

# ── Cloudinary ─────────────────────────────────────────
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# ── Email (Nodemailer) ─────────────────────────────────
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASS=your-gmail-app-password
EMAIL_FROM=ApnaBot <your-gmail@gmail.com>

# ── Frontend URLs ──────────────────────────────────────
FRONTEND_URL=https://app.yourproduct.com
ADMIN_URL=https://admin.yourproduct.com
```

---

## 8.2 CREATE: `nginx.conf`

```nginx
# nginx.conf — CREATE THIS FILE in project root

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name api.yourproduct.com;
    return 301 https://$host$request_uri;
}

# Main HTTPS server
server {
    listen 443 ssl;
    server_name api.yourproduct.com;

    ssl_certificate /etc/letsencrypt/live/api.yourproduct.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourproduct.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Increase body size for file uploads
    client_max_body_size 10M;

    # Proxy to Node.js app
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # Required for Socket.io
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

---

## 8.3 CREATE: `.github/workflows/deploy.yml`

```yaml
# .github/workflows/deploy.yml — CREATE THIS FILE

name: Deploy to VPS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Deploy via SSH
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /app/apnabot
            git pull origin main
            npm install --only=production
            pm2 restart apnabot || pm2 start server.js --name apnabot
            pm2 save
```

> **Note:** Add `VPS_HOST`, `VPS_USER`, and `VPS_SSH_KEY` as secrets in your GitHub repository settings under Settings → Secrets → Actions.

---

# Step 9 — Seeds Completion + Duplicate Index Fixes

Two Mongoose warnings appear on every startup. This step fixes them and also ensures all seed scripts are complete and working.

**Files to update:**
- UPDATE: `src/models/User.js`
- UPDATE: `src/models/BusinessTypeTemplate.js`
- UPDATE: `src/seeds/planSeed.js`
- UPDATE: `src/seeds/businessTypeSeed.js`
- UPDATE: `src/seeds/adminSeed.js`

---

## 9.1 UPDATE: `src/models/User.js` — Remove duplicate index

```js
// src/models/User.js
// FIND and REMOVE this line — email already has unique:true in schema definition:

// ❌ DELETE THIS LINE
userSchema.index({ email: 1 }, { unique: true });

// ✅ KEEP this line — shopId index is fine
userSchema.index({ shopId: 1 });
```

---

## 9.2 UPDATE: `src/models/BusinessTypeTemplate.js` — Remove duplicate index

```js
// src/models/BusinessTypeTemplate.js
// FIND and REMOVE this line — businessType already has unique:true in schema:

// ❌ DELETE THIS LINE
businessTypeTemplateSchema.index({ businessType: 1 });
```

---

## 9.3 UPDATE: `src/seeds/planSeed.js` — Ensure correct plan data

Replace the entire file to ensure all 3 plans have correct fields:

```js
// src/seeds/planSeed.js — REPLACE ENTIRE FILE

const Plan = require('../models/Plan');
const logger = require('../utils/logger');

const plans = [
  {
    name: 'basic',
    displayName: 'Basic',
    price: 199,
    msgLimit: 500,
    ruleLimit: 10,
    customerLimit: 100,
    bookingEnabled: true,
    paymentLinkEnabled: false,
    staffEnabled: false,
    maxStaff: 0,
    isActive: true
  },
  {
    name: 'pro',
    displayName: 'Pro',
    price: 399,
    msgLimit: 2000,
    ruleLimit: 50,
    customerLimit: 500,
    bookingEnabled: true,
    paymentLinkEnabled: true,
    staffEnabled: true,
    maxStaff: 2,
    isActive: true
  },
  {
    name: 'business',
    displayName: 'Business',
    price: 699,
    msgLimit: -1,       // unlimited
    ruleLimit: -1,      // unlimited
    customerLimit: -1,  // unlimited
    bookingEnabled: true,
    paymentLinkEnabled: true,
    staffEnabled: true,
    maxStaff: 5,
    isActive: true
  }
];

const seedPlans = async () => {
  try {
    for (const planData of plans) {
      const existing = await Plan.findOne({ name: planData.name });
      if (!existing) {
        await Plan.create(planData);
        logger.info(`Plan created: ${planData.displayName}`);
      } else {
        // Update existing plan with latest values
        await Plan.findOneAndUpdate({ name: planData.name }, planData);
        logger.info(`Plan updated: ${planData.displayName}`);
      }
    }
    logger.info('Plan seeding complete');
  } catch (error) {
    logger.error('Plan seeding error:', error);
    throw error;
  }
};

module.exports = seedPlans;
```

---

## 9.4 UPDATE: `src/seeds/businessTypeSeed.js` — Ensure all 8 types are seeded

```js
// src/seeds/businessTypeSeed.js — REPLACE ENTIRE FILE

const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const logger = require('../utils/logger');

const templates = [
  {
    businessType: 'tailor',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Our stitching prices start from ₹200 for shirts and ₹300 for suits. Send your measurements and we will give you an exact quote!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open Monday to Saturday, 10am to 8pm. Sunday by appointment only.', replyType: 'text' },
      { keyword: 'order', matchType: 'contains', reply: 'To check your order status, please share your order number or the date you gave us your clothes.', replyType: 'text' },
      { keyword: 'book', matchType: 'contains', reply: 'Sure! Let me take your booking details.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'service', label: 'What service do you need? (shirt, suit, blouse, etc.)', required: true, order: 2 },
      { fieldKey: 'measurement', label: 'Please share your measurements or say "will visit in person"', required: false, order: 3 },
      { fieldKey: 'deliveryDate', label: 'When do you need it by?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'salon',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Haircut starts at ₹150, facial from ₹299, full package from ₹799. DM for full price list!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open every day from 9am to 9pm including Sundays!', replyType: 'text' },
      { keyword: 'appointment', matchType: 'contains', reply: 'Let me book an appointment for you!', replyType: 'booking_trigger' },
      { keyword: 'book', matchType: 'contains', reply: 'Let me book an appointment for you!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'service', label: 'Which service do you need? (haircut, facial, waxing, etc.)', required: true, order: 2 },
      { fieldKey: 'preferredTime', label: 'What date and time works for you?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'garage',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Service charges: General service ₹799, AC service ₹499, Denting/Painting quote on inspection. Call us for more details!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open Monday to Saturday 8am to 7pm. Emergency breakdown service available.', replyType: 'text' },
      { keyword: 'book', matchType: 'contains', reply: 'Let me book your vehicle service!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'vehicleNumber', label: 'What is your vehicle number?', required: true, order: 2 },
      { fieldKey: 'issue', label: 'What issue is your vehicle facing?', required: true, order: 3 },
      { fieldKey: 'date', label: 'When would you like to bring it in?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'cab',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Local rates: ₹12/km. Outstation: ₹14/km. Airport drop flat ₹499. Share pickup and drop for exact fare!', replyType: 'text' },
      { keyword: 'available', matchType: 'contains', reply: 'Yes we have cabs available! Share your pickup location and time for booking.', replyType: 'text' },
      { keyword: 'book', matchType: 'contains', reply: 'Let me book a cab for you!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'pickup', label: 'Where do you want to be picked up from?', required: true, order: 2 },
      { fieldKey: 'drop', label: 'Where is your destination?', required: true, order: 3 },
      { fieldKey: 'date', label: 'What date do you need the cab?', required: true, order: 4 },
      { fieldKey: 'time', label: 'What time should we pick you up?', required: true, order: 5 }
    ]
  },
  {
    businessType: 'coaching',
    defaultRules: [
      { keyword: 'fee', matchType: 'contains', reply: 'Monthly fees: Class 9-10: ₹1500/month, Class 11-12: ₹2000/month. Includes study material!', replyType: 'text' },
      { keyword: 'schedule', matchType: 'contains', reply: 'Morning batch: 7am-9am. Evening batch: 5pm-7pm. Weekend special batch also available.', replyType: 'text' },
      { keyword: 'enroll', matchType: 'contains', reply: 'Great! Let me collect your enrollment details.', replyType: 'booking_trigger' },
      { keyword: 'admission', matchType: 'contains', reply: 'Great! Let me collect your enrollment details.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is the student\'s name?', required: true, order: 1 },
      { fieldKey: 'class', label: 'Which class/standard?', required: true, order: 2 },
      { fieldKey: 'batch', label: 'Morning or Evening batch?', required: true, order: 3 },
      { fieldKey: 'phone', label: 'Parent\'s contact number?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'gym',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Membership plans: Monthly ₹799, Quarterly ₹2099, Half-yearly ₹3599, Annual ₹5999. Personal trainer available!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open 5am to 11pm all 7 days. No holiday closures!', replyType: 'text' },
      { keyword: 'join', matchType: 'contains', reply: 'Awesome! Let me get your membership details.', replyType: 'booking_trigger' },
      { keyword: 'membership', matchType: 'contains', reply: 'Awesome! Let me get your membership details.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'plan', label: 'Which membership plan? (monthly/quarterly/half-yearly/annual)', required: true, order: 2 },
      { fieldKey: 'startDate', label: 'When would you like to start?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'medical',
    defaultRules: [
      { keyword: 'timing', matchType: 'contains', reply: 'We are open 8am to 10pm all days. 24-hour emergency medicines also available.', replyType: 'text' },
      { keyword: 'available', matchType: 'contains', reply: 'Please share the medicine name and we will check stock and get back to you shortly.', replyType: 'text' },
      { keyword: 'appointment', matchType: 'contains', reply: 'Let me book a doctor consultation for you.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is the patient\'s name?', required: true, order: 1 },
      { fieldKey: 'issue', label: 'What is the health concern?', required: true, order: 2 },
      { fieldKey: 'preferredTime', label: 'Preferred consultation time?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'general',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Please share the product name and we will send you the latest price!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open Monday to Saturday 10am to 8pm.', replyType: 'text' },
      { keyword: 'location', matchType: 'contains', reply: 'We are located at [your address here]. You can also WhatsApp us to place an order for home delivery!', replyType: 'text' },
      { keyword: 'order', matchType: 'contains', reply: 'Let me take your order details!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'item', label: 'What would you like to order?', required: true, order: 2 },
      { fieldKey: 'quantity', label: 'How many pieces?', required: true, order: 3 }
    ]
  }
];

const seedBusinessTypes = async () => {
  try {
    for (const template of templates) {
      const existing = await BusinessTypeTemplate.findOne({ businessType: template.businessType });
      if (!existing) {
        await BusinessTypeTemplate.create(template);
        logger.info(`Business type template created: ${template.businessType}`);
      } else {
        logger.info(`Business type template already exists: ${template.businessType}`);
      }
    }
    logger.info('Business type seeding complete');
  } catch (error) {
    logger.error('Business type seeding error:', error);
    throw error;
  }
};

module.exports = seedBusinessTypes;
```

---

## 9.5 UPDATE: `src/seeds/adminSeed.js` — Verify superadmin seed is correct

```js
// src/seeds/adminSeed.js — REPLACE ENTIRE FILE

const User = require('../models/User');
const logger = require('../utils/logger');

const seedAdmin = async () => {
  try {
    const existing = await User.findOne({ role: 'superadmin' });

    if (existing) {
      logger.info('Superadmin already exists, skipping seed');
      return;
    }

    const admin = new User({
      name: 'Super Admin',
      email: process.env.ADMIN_EMAIL || 'admin@apnabot.com',
      passwordHash: process.env.ADMIN_PASSWORD || 'admin123456',
      role: 'superadmin',
      shopId: null,
      permissions: {
        canViewChats: true,
        canManageRules: true,
        canManageBookings: true,
        canViewCustomers: true,
        canManageBilling: true
      },
      isActive: true
    });

    await admin.save(); // pre-save hook hashes the password

    logger.info(`Superadmin created: ${admin.email}`);
  } catch (error) {
    logger.error('Admin seeding error:', error);
    throw error;
  }
};

module.exports = seedAdmin;
```

## 9.6 Run the Seeds

```bash
npm run seed
```

You should see in terminal:
```
Superadmin created: admin@apnabot.com
Plan created: Basic
Plan created: Pro
Plan created: Business
Business type template created: tailor
Business type template created: salon
... (all 8 types)
Seeding complete
```

---

# Step 10 — Complete Testing (All Endpoints)

> This step is testing only — no new code. Use **Postman** or **Thunder Client** (VS Code extension).

---

## 10.1 Setup — Base URL and Headers

```
Base URL: http://localhost:3000
Content-Type: application/json
Authorization: Bearer <token>   (add after login)
```

---

## 10.2 Auth Endpoints

### Register a shop owner
```
POST /api/auth/register
Body:
{
  "name": "Rahul Sharma",
  "email": "rahul@test.com",
  "password": "test1234"
}
Expected: 201 — returns user + accessToken + refreshToken
```

### Login
```
POST /api/auth/login
Body:
{
  "email": "rahul@test.com",
  "password": "test1234"
}
Expected: 200 — returns accessToken
Save the accessToken — use it in all requests below as Bearer token
```

### Refresh token
```
POST /api/auth/refresh
Body: { "refreshToken": "<your refresh token>" }
Expected: 200 — returns new accessToken
```

### Logout
```
POST /api/auth/logout
Body: { "refreshToken": "<your refresh token>" }
Expected: 200 — logged out
```

### Forgot password
```
POST /api/auth/forgot-password
Body: { "email": "rahul@test.com" }
Expected: 200 — check terminal/email for reset token
```

---

## 10.3 Shop Endpoints

### Create shop
```
POST /api/shop
Headers: Authorization: Bearer <owner_token>
Body:
{
  "name": "Rahul Tailor",
  "businessType": "tailor",
  "city": "Pune",
  "address": "123 MG Road"
}
Expected: 201 — shop created, default rules added, new tokens returned
```

### Get shop
```
GET /api/shop
Headers: Authorization: Bearer <owner_token>
Expected: 200 — shop data (no accessToken field in response)
```

### Update shop
```
PUT /api/shop
Headers: Authorization: Bearer <owner_token>
Body: { "fallbackReply": "We will reply soon!", "upiId": "rahul@upi" }
Expected: 200 — updated shop
```

### Dashboard stats
```
GET /api/shop/dashboard-stats
Headers: Authorization: Bearer <owner_token>
Expected: 200 — counts for today's messages, bookings, customers
```

---

## 10.4 Rules Endpoints

### List rules
```
GET /api/rules
Headers: Authorization: Bearer <owner_token>
Expected: 200 — list of default rules created during shop setup
```

### Create rule
```
POST /api/rules
Headers: Authorization: Bearer <owner_token>
Body:
{
  "keyword": "hello",
  "matchType": "contains",
  "reply": "Hi! Welcome to Rahul Tailor. How can we help you?",
  "replyType": "text"
}
Expected: 201 — new rule created
```

### Update rule
```
PUT /api/rules/:id
Headers: Authorization: Bearer <owner_token>
Body: { "reply": "Updated reply text" }
Expected: 200 — updated rule
```

### Toggle rule
```
PUT /api/rules/:id/toggle
Headers: Authorization: Bearer <owner_token>
Expected: 200 — isActive flipped
```

### Delete rule
```
DELETE /api/rules/:id
Headers: Authorization: Bearer <owner_token>
Expected: 200 — rule deleted
```

### Get templates
```
GET /api/rules/templates
Headers: Authorization: Bearer <owner_token>
Expected: 200 — default rules for tailor business type
```

---

## 10.5 Customer Endpoints

### List customers
```
GET /api/customers
Headers: Authorization: Bearer <owner_token>
Expected: 200 — empty list initially
```

### Search customers
```
GET /api/customers?search=Rahul
Headers: Authorization: Bearer <owner_token>
Expected: 200 — filtered results
```

### Block customer (after a customer exists)
```
POST /api/customers/:id/block
Headers: Authorization: Bearer <owner_token>
Expected: 200 — isBlocked: true
```

---

## 10.6 Message Endpoints

### List conversations
```
GET /api/messages
Headers: Authorization: Bearer <owner_token>
Expected: 200 — empty initially, populated after webhook messages
```

### Manually send message
```
POST /api/messages/send
Headers: Authorization: Bearer <owner_token>
Body:
{
  "customerNumber": "919822000000",
  "message": "Hello! This is a test message from ApnaBot"
}
Expected: 201 — message queued
Note: Will fail Meta API call since no real WhatsApp connected yet — but should save to DB and queue successfully
```

---

## 10.7 Booking Endpoints

### List bookings
```
GET /api/bookings
Headers: Authorization: Bearer <owner_token>
Expected: 200 — empty list
```

### Filter by status
```
GET /api/bookings?status=pending
Expected: 200 — filtered bookings
```

---

## 10.8 Subscription Endpoints

### List plans (no auth needed)
```
GET /api/subscription/plans
Expected: 200 — Basic, Pro, Business plans
```

### Get current subscription
```
GET /api/subscription
Headers: Authorization: Bearer <owner_token>
Expected: 200 — null subscription initially
```

### Create Razorpay order
```
POST /api/subscription/create
Headers: Authorization: Bearer <owner_token>
Body: { "planId": "<basic_plan_id_from_plans_list>" }
Expected: 200 — Razorpay orderId returned
```

---

## 10.9 Staff Endpoints

### Invite staff (need Pro/Business plan first)
```
POST /api/staff/invite
Headers: Authorization: Bearer <owner_token>
Body:
{
  "name": "Priya Staff",
  "email": "priya@test.com",
  "password": "test1234"
}
Expected: 201 — staff created
Note: Will get 403 if on Basic plan (staffEnabled: false)
```

### Login as staff
```
POST /api/auth/login
Body: { "email": "priya@test.com", "password": "test1234" }
Expected: 200 — token with role: "staff"
```

### Verify staff cannot access owner routes
```
POST /api/rules
Headers: Authorization: Bearer <staff_token>
Expected: 403 — Access denied
```

### Verify staff can access allowed routes
```
GET /api/customers
Headers: Authorization: Bearer <staff_token>
Expected: 200 — success
```

---

## 10.10 Admin Endpoints

### Login as superadmin
```
POST /api/auth/login
Body:
{
  "email": "admin@apnabot.com",
  "password": "admin123456"
}
Expected: 200 — token with role: "superadmin"
```

### Platform stats
```
GET /api/admin/stats
Headers: Authorization: Bearer <superadmin_token>
Expected: 200 — platform stats
```

### List all shops
```
GET /api/admin/shops
Headers: Authorization: Bearer <superadmin_token>
Expected: 200 — all shops
```

### Toggle shop
```
PUT /api/admin/shops/:id/toggle
Headers: Authorization: Bearer <superadmin_token>
Expected: 200 — shop activated/deactivated
```

### Verify owner cannot access admin routes
```
GET /api/admin/shops
Headers: Authorization: Bearer <owner_token>
Expected: 403 — Access denied
```

---

## 10.11 Webhook Endpoint

### Verify webhook (Meta verification)
```
GET /api/webhook/verify?hub.mode=subscribe&hub.verify_token=your-webhook-verify-token&hub.challenge=test123
Expected: 200 — responds with "test123"
```

### Simulate incoming message
```
POST /api/webhook/receive
Headers: x-hub-signature-256: sha256=<computed_hmac>
Body:
{
  "entry": [{
    "changes": [{
      "value": {
        "metadata": { "phone_number_id": "your_phone_number_id" },
        "messages": [{
          "id": "test_msg_001",
          "from": "919822000001",
          "type": "text",
          "text": { "body": "price" }
        }]
      }
    }]
  }]
}
Expected: 200 immediately — then async processing happens
```

---

## 10.12 Health Check

```
GET /health
Expected:
{
  "success": true,
  "message": "Server is running",
  "timestamp": "..."
}
```

---

## 10.13 Final Checklist Before Going Live

| Check | What to Verify |
|-------|---------------|
| ✅ Redis | `Redis connected` in terminal logs |
| ✅ MongoDB | `MongoDB connected` in terminal logs |
| ✅ BullMQ | `BullMQ worker started` in terminal logs |
| ✅ Seeds | Plans + templates + superadmin exist in DB |
| ✅ Auth | Register → Login → Refresh → Logout all work |
| ✅ Shop | Create → Get → Update → Connect WhatsApp |
| ✅ Rules | CRUD + Redis cache invalidation on every write |
| ✅ Webhook | Returns 200 immediately, processes async |
| ✅ Booking | State machine creates booking after all fields collected |
| ✅ Staff | Role-based access working correctly |
| ✅ Admin | Superadmin can see all shops, owner gets 403 |
| ✅ Subscription | Plans list, order creation, verify + activate |
| ✅ No sensitive data | accessToken never returned in any API response |
| ✅ shopId filter | Every DB query includes shopId — no data leaks |

---

## Summary — All Files Changed in Steps 6–10

| Step | Action | File Path |
|------|--------|-----------|
| 6 | CREATE | `src/services/admin.service.js` |
| 6 | CREATE | `src/controllers/admin.controller.js` |
| 6 | REPLACE | `src/routes/admin.routes.js` |
| 7 | INSTALL | `npm install nodemailer` |
| 7 | CREATE | `src/services/email.service.js` |
| 7 | UPDATE | `src/controllers/auth.controller.js` (forgotPassword only) |
| 7 | UPDATE | `.env` (add email vars) |
| 8 | CREATE | `.env.example` |
| 8 | CREATE | `nginx.conf` |
| 8 | CREATE | `.github/workflows/deploy.yml` |
| 9 | UPDATE | `src/models/User.js` (remove duplicate index) |
| 9 | UPDATE | `src/models/BusinessTypeTemplate.js` (remove duplicate index) |
| 9 | REPLACE | `src/seeds/planSeed.js` |
| 9 | REPLACE | `src/seeds/businessTypeSeed.js` |
| 9 | REPLACE | `src/seeds/adminSeed.js` |
| 10 | TEST | All endpoints via Postman / Thunder Client |

---

> All 10 steps complete. The backend is now fully implemented and ready for integration with the Flutter app and Next.js admin panel.
