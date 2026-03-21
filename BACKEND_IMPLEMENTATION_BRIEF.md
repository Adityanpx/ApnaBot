# AI WhatsApp Business Bot SaaS — Backend Implementation Brief
> Version: MVP (V1)
> Stack: Node.js + Express + MongoDB + Redis + BullMQ + Docker + Nginx + Hostinger VPS
> Auth: JWT | Media: Cloudinary | Payments: Razorpay + UPI | WhatsApp: Meta Cloud API
> Chatbot: Rule-based only (AI integration planned for V2)

---

## 1. What Are We Building

This is a **multi-tenant SaaS platform** where small Indian businesses (tailors, salons, garages, cab services, coaching classes, gyms, medical shops, etc.) can subscribe and get their own **WhatsApp chatbot automation** without writing any code.

One backend serves thousands of shops. Each shop is completely isolated — own WhatsApp number, own chatbot rules, own customers, own bookings, own subscription plan.

Think of it as the Indian version of WATI or Interakt, built specifically for Tier 2/3 India small businesses.

---

## 2. User Roles

There are **three roles** in the system. All three are defined in the DB from day one.

### 2.1 Super Admin
- This is the SaaS owner (you).
- Has a separate Next.js admin panel.
- Can see all shops, all usage, all revenue.
- Can activate or deactivate any shop.
- Can create, edit, delete subscription plans.
- Can change any shop's plan manually.
- Can extend or reset any shop's subscription expiry.
- Can view all Razorpay transactions.
- Cannot interfere with chatbot rules or customer data of a shop (read-only for shop data).
- Only one super admin exists. Created via a seed script, not via public signup.

### 2.2 Shop Owner
- The paying customer of the SaaS.
- Has full access to their own shop only — strict data isolation.
- Can connect their WhatsApp number.
- Can manage chatbot rules.
- Can view all chats and customers.
- Can view and manage bookings.
- Can generate and send payment links in chat.
- Can view their usage and subscription.
- Can add and manage Staff members under their shop.
- Cannot see any other shop's data ever.

### 2.3 Staff
- Added by a Shop Owner under their shop.
- Has limited access defined by the Shop Owner.
- In MVP: Staff can view chats, view customers, view bookings, update booking status.
- In MVP: Staff cannot change chatbot rules, cannot access billing, cannot add other staff.
- Staff login uses the same Flutter app as Shop Owner but sees a restricted UI based on role.
- The role and permissions fields are in the DB from day one so V2 expansion requires zero schema changes.

> Key principle: Every API route checks req.user.role and req.user.shopId. A Shop Owner and Staff can only ever touch data where shopId matches their own. Super Admin bypasses this check.

---

## 3. Business Type and Service Replication

Each shop declares its **business type** when creating their shop. Based on this, the system pre-populates default chatbot rules, default booking flow fields, and default FAQ templates. This makes onboarding fast.

### Supported Business Types in MVP

| Business Type | Default Rules Pre-loaded | Booking Fields |
|---|---|---|
| Tailor / Boutique | price, timing, order status | name, measurement, delivery date, service type |
| Salon / Parlour | price, timing, appointment | name, service, preferred time |
| Garage / Mechanic | service price, timing, booking | name, vehicle number, issue, date |
| Cab / Travel | route price, availability | name, pickup, drop, date, time |
| Coaching / Classes | fee, schedule, enrollment | name, class, batch, phone |
| Gym / Fitness | membership price, timing | name, plan, start date |
| Medical / Pharmacy | timing, availability | name, issue, preferred time |
| General Shop | price, timing, location | name, item, quantity |

When a Shop Owner selects their business type during onboarding, the backend automatically creates a set of starter rules for that shop. They can edit, delete, or add more rules at any time.

This is seeded data in a businessTypeTemplates collection that super admin can manage from the admin panel.

---

## 4. Core Architecture

```
Flutter App (Shop Owner + Staff)
Next.js Panel (Super Admin)
        |
        | HTTPS
        |
    Nginx (Reverse Proxy + SSL)
        |
   Express.js API Server
        |
   +-----------+-------------+
   |           |             |
MongoDB      Redis        BullMQ
(data)      (cache +     (outbound
             sessions)    WA queue)
                |
         WhatsApp Worker
                |
         Meta Cloud API
```

### Request Flow — Incoming WhatsApp Message
```
Customer sends WhatsApp message
        ↓
Meta Cloud API fires POST /api/webhook/receive
        ↓
Webhook Controller receives payload
        ↓
Tenant Service resolves shop by phoneNumberId
        ↓
Subscription Middleware checks shop active + within limits
        ↓
Usage Service increments message count
        ↓
Chatbot Service runs rule matching engine
        ↓
If rule found → prepare reply
If no rule → send default fallback message
        ↓
If booking flow active for this customer → Booking State Machine handles
        ↓
Payment Service generates link if needed
        ↓
Reply added to BullMQ outbound queue
        ↓
WhatsApp Worker picks job → calls Meta Cloud API → message sent
        ↓
Message saved to MongoDB
        ↓
Socket.io emits new_message event to shop dashboard
```

---

## 5. Folder Structure

```
/
├── src/
│   ├── config/
│   │   ├── db.js                    # MongoDB connection via Mongoose
│   │   ├── redis.js                 # Redis connection via ioredis
│   │   └── env.js                   # Validate all env vars on startup
│   │
│   ├── models/
│   │   ├── User.js
│   │   ├── Shop.js
│   │   ├── BusinessTypeTemplate.js
│   │   ├── Plan.js
│   │   ├── Subscription.js
│   │   ├── Rule.js
│   │   ├── Customer.js
│   │   ├── Message.js
│   │   ├── Booking.js
│   │   └── Usage.js
│   │
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── shop.routes.js
│   │   ├── rule.routes.js
│   │   ├── customer.routes.js
│   │   ├── message.routes.js
│   │   ├── booking.routes.js
│   │   ├── webhook.routes.js
│   │   ├── payment.routes.js
│   │   ├── subscription.routes.js
│   │   ├── staff.routes.js
│   │   └── admin.routes.js
│   │
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── shop.controller.js
│   │   ├── rule.controller.js
│   │   ├── customer.controller.js
│   │   ├── message.controller.js
│   │   ├── booking.controller.js
│   │   ├── webhook.controller.js
│   │   ├── payment.controller.js
│   │   ├── subscription.controller.js
│   │   ├── staff.controller.js
│   │   └── admin.controller.js
│   │
│   ├── services/
│   │   ├── whatsapp.service.js      # All Meta Cloud API calls
│   │   ├── chatbot.service.js       # Rule matching engine
│   │   ├── booking.service.js       # Booking state machine
│   │   ├── payment.service.js       # Razorpay + UPI deep link
│   │   ├── tenant.service.js        # Resolve shop by phoneNumberId
│   │   ├── usage.service.js         # Increment + check limits
│   │   ├── subscription.service.js  # Plan checks + expiry logic
│   │   └── socket.service.js        # Emit realtime events
│   │
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── role.middleware.js
│   │   ├── shop.middleware.js
│   │   ├── plan.middleware.js
│   │   ├── rateLimiter.middleware.js
│   │   └── errorHandler.middleware.js
│   │
│   ├── queues/
│   │   ├── whatsapp.queue.js
│   │   └── whatsapp.worker.js
│   │
│   ├── socket/
│   │   └── socket.js
│   │
│   ├── utils/
│   │   ├── response.js              # Standard { success, data, message }
│   │   ├── logger.js                # Winston logger
│   │   ├── crypto.js                # AES encrypt/decrypt Meta tokens
│   │   └── pagination.js
│   │
│   └── app.js
│
├── server.js
├── docker-compose.yml
├── Dockerfile
├── nginx.conf
├── .env.example
└── package.json
```

---

## 6. MongoDB Schemas

### 6.1 User
```
Collection: users

_id: ObjectId
name: String (required)
email: String (required, unique, lowercase)
passwordHash: String (required)
role: Enum ['superadmin', 'owner', 'staff'] (required)
shopId: ObjectId ref Shop (null for superadmin)
permissions: {
  canViewChats: Boolean        default: true
  canManageRules: Boolean      default: false (staff), true (owner)
  canManageBookings: Boolean   default: true
  canViewCustomers: Boolean    default: true
  canManageBilling: Boolean    default: false (staff), true (owner)
}
isActive: Boolean (default true)
lastLoginAt: Date
createdAt / updatedAt: Date

Indexes: email (unique), shopId
```

### 6.2 Shop
```
Collection: shops

_id: ObjectId
name: String (required)            "Shree Tailor"
ownerUserId: ObjectId ref User
businessType: Enum ['tailor','salon','garage','cab','coaching','gym','medical','general']
whatsappNumber: String             "919822xxxxxx" E.164 format
phoneNumberId: String              Meta phone number ID — used for API calls
wabaId: String                     WhatsApp Business Account ID
accessToken: String                AES encrypted Meta API token
displayName: String                shown to customers on WhatsApp
profileImage: String               Cloudinary URL
upiId: String                      shop owner UPI ID for payment links
address: String
city: String
isActive: Boolean (default true)   super admin can toggle
isWhatsappConnected: Boolean (default false)
webhookVerifyToken: String         unique per shop
fallbackReply: String              default "Thank you, we will reply shortly"
createdAt / updatedAt: Date

Indexes: phoneNumberId (unique, critical), ownerUserId, businessType
```

### 6.3 Plan
```
Collection: plans

_id: ObjectId
name: Enum ['basic', 'pro', 'business']
displayName: String
price: Number                      monthly price INR
msgLimit: Number                   -1 = unlimited
ruleLimit: Number                  -1 = unlimited
customerLimit: Number              -1 = unlimited
bookingEnabled: Boolean
paymentLinkEnabled: Boolean
staffEnabled: Boolean
maxStaff: Number
isActive: Boolean

Seed data:
  Basic:    ₹199  | 500 msgs  | 10 rules  | 100 customers | no staff
  Pro:      ₹399  | 2000 msgs | 50 rules  | 500 customers | 2 staff
  Business: ₹699  | unlimited | unlimited | unlimited     | 5 staff
```

### 6.4 Subscription
```
Collection: subscriptions

_id: ObjectId
shopId: ObjectId ref Shop
planId: ObjectId ref Plan
status: Enum ['trial', 'active', 'expired', 'cancelled']
startDate: Date
endDate: Date
razorpaySubscriptionId: String (nullable)
razorpayPaymentId: String (nullable)
autoRenew: Boolean (default true)
createdAt / updatedAt: Date

Indexes: shopId, status, endDate (for expiry cron)
```

### 6.5 Rule
```
Collection: rules

_id: ObjectId
shopId: ObjectId ref Shop (required)
keyword: String                    lowercase, trimmed
matchType: Enum ['exact', 'contains', 'startsWith'] default: 'contains'
reply: String                      text to send
replyType: Enum ['text', 'booking_trigger', 'payment_trigger']
  text             → send reply text directly
  booking_trigger  → start booking flow conversation
  payment_trigger  → generate and send payment link
isActive: Boolean (default true)
triggerCount: Number (default 0)
createdAt / updatedAt: Date

Indexes: shopId, shopId+keyword (compound)

Cache: rules:{shopId} in Redis (TTL 1hr). Invalidate on any rule write.
```

### 6.6 Customer
```
Collection: customers

_id: ObjectId
shopId: ObjectId ref Shop
whatsappNumber: String             "919822xxxxxx"
name: String (nullable)
firstSeenAt: Date
lastMessageAt: Date
totalMessages: Number (default 0)
tags: [String]
notes: String
isBlocked: Boolean (default false)
createdAt: Date

Indexes: shopId+whatsappNumber (compound unique), shopId
```

### 6.7 Message
```
Collection: messages

_id: ObjectId
shopId: ObjectId ref Shop
customerId: ObjectId ref Customer
customerNumber: String
direction: Enum ['inbound', 'outbound']
type: Enum ['text', 'image', 'document', 'audio']
content: String
mediaUrl: String                   Cloudinary URL for media
metaMessageId: String              WA message ID from Meta
status: Enum ['sent', 'delivered', 'read', 'failed']
isRead: Boolean (default false for inbound)
triggeredRuleId: ObjectId ref Rule (nullable)
createdAt: Date

Indexes: shopId+customerId (compound), shopId+createdAt, metaMessageId
```

### 6.8 Booking
```
Collection: bookings

_id: ObjectId
shopId: ObjectId ref Shop
customerId: ObjectId ref Customer
customerNumber: String
status: Enum ['pending', 'confirmed', 'completed', 'cancelled']
fields: Object                     dynamic per business type
  Tailor example:
    { customerName, service, measurement, deliveryDate, notes }
  Salon example:
    { customerName, service, preferredTime }
  Cab example:
    { customerName, pickup, drop, date, time }
paymentStatus: Enum ['pending', 'paid', 'not_required']
paymentAmount: Number
paymentLink: String (nullable)
razorpayOrderId: String (nullable)
createdAt / updatedAt: Date

Indexes: shopId, shopId+status, shopId+createdAt, customerId
```

### 6.9 Usage
```
Collection: usages

_id: ObjectId
shopId: ObjectId ref Shop
month: String                      "2026-03" format YYYY-MM
msgCount: Number (default 0)
inboundCount: Number (default 0)
outboundCount: Number (default 0)
bookingCount: Number (default 0)
paymentLinkCount: Number (default 0)
createdAt / updatedAt: Date

Indexes: shopId+month (compound unique)

Cache: usage:{shopId}:{YYYY-MM} in Redis. Increment atomically with $incr.
Persist to MongoDB asynchronously every 10 increments or via cron.
```

### 6.10 BusinessTypeTemplate
```
Collection: businessTypeTemplates

_id: ObjectId
businessType: String (unique)
defaultRules: [
  { keyword, matchType, reply, replyType }
]
bookingFields: [
  { fieldKey, label, required, order }
]
createdAt / updatedAt: Date

Note: Seeded once. Super admin can edit from admin panel.
When shop is created, backend copies matching template rules into rules collection for that shop.
```

---

## 7. API Routes

### Auth — /api/auth
```
POST /api/auth/register              Shop owner signup
POST /api/auth/login                 Login for all roles
POST /api/auth/refresh               Get new access token via refresh token
POST /api/auth/logout                Invalidate refresh token in Redis
POST /api/auth/forgot-password       Send reset email
POST /api/auth/reset-password        Reset with token
```

### Shop — /api/shop [owner]
```
GET    /api/shop                     Get own shop profile
PUT    /api/shop                     Update shop profile
POST   /api/shop/connect-whatsapp    Save phoneNumberId + encrypted accessToken
DELETE /api/shop/disconnect-whatsapp
GET    /api/shop/dashboard-stats     Today's message, booking, customer counts
```

### Rules — /api/rules [owner]
```
GET    /api/rules                    List all rules (paginated)
POST   /api/rules                    Create rule
PUT    /api/rules/:id                Update rule
DELETE /api/rules/:id                Delete rule
PUT    /api/rules/:id/toggle         Enable or disable rule
GET    /api/rules/templates          Get default rules for shop's business type
POST   /api/rules/bulk-import        Import template rules into shop
```

### Customers — /api/customers [owner + staff]
```
GET    /api/customers                List customers (paginated, searchable)
GET    /api/customers/:id            Customer detail + message history
PUT    /api/customers/:id            Update name, tags, notes
POST   /api/customers/:id/block      Block customer
POST   /api/customers/:id/unblock    Unblock customer
```

### Messages — /api/messages [owner + staff]
```
GET    /api/messages                 List conversations grouped by customer
GET    /api/messages/:customerId     Full chat history with a customer
PUT    /api/messages/:id/read        Mark message as read
POST   /api/messages/send            Manually send a message to customer
```

### Bookings — /api/bookings [owner + staff]
```
GET    /api/bookings                 List bookings (filter by status, date)
GET    /api/bookings/:id             Booking detail
PUT    /api/bookings/:id/status      Update status (confirm/complete/cancel)
PUT    /api/bookings/:id/notes       Add internal notes
DELETE /api/bookings/:id             Delete booking
```

### Payments — /api/payments [owner]
```
POST   /api/payments/razorpay/create-link    Create Razorpay payment link
POST   /api/payments/upi/create-link         Generate UPI deep link string
POST   /api/payments/send-to-customer        Queue payment link as WA message
GET    /api/payments/history                 List payment links sent
POST   /api/payments/razorpay/webhook        Razorpay payment status callback
```

### Subscription — /api/subscription [owner]
```
GET    /api/subscription             Current plan + usage + expiry
GET    /api/subscription/plans       All available plans
POST   /api/subscription/create      Initiate Razorpay subscription checkout
POST   /api/subscription/verify      Verify payment + activate subscription
POST   /api/subscription/cancel      Cancel auto-renew
```

### Staff — /api/staff [owner]
```
GET    /api/staff                    List all staff in shop
POST   /api/staff/invite             Create staff account
PUT    /api/staff/:id/permissions    Update staff permissions
DELETE /api/staff/:id                Remove staff
POST   /api/staff/:id/toggle         Activate or deactivate staff
```

### Webhook — /api/webhook [public]
```
GET    /api/webhook/verify           Meta webhook verification (hub.challenge)
POST   /api/webhook/receive          All inbound WhatsApp messages
```

### Admin — /api/admin [superadmin only]
```
GET    /api/admin/shops              List all shops (paginated, searchable)
GET    /api/admin/shops/:id          Shop detail + usage + subscription
PUT    /api/admin/shops/:id/toggle   Activate or deactivate shop
PUT    /api/admin/shops/:id/plan     Change shop plan manually
PUT    /api/admin/shops/:id/extend   Extend subscription expiry
GET    /api/admin/stats              Platform-wide stats
GET    /api/admin/revenue            Revenue report by month
GET    /api/admin/plans              List all plans
POST   /api/admin/plans              Create plan
PUT    /api/admin/plans/:id          Edit plan
DELETE /api/admin/plans/:id          Delete plan
GET    /api/admin/templates          List business type templates
PUT    /api/admin/templates/:id      Edit template rules and booking fields
```

---

## 8. Webhook Flow (Detailed)

This is the most critical module. Everything starts here.

### 8.1 Webhook Verification (GET)
```
Meta sends GET to verify webhook URL on registration.

GET /api/webhook/verify?hub.mode=subscribe&hub.challenge=xyz&hub.verify_token=abc

Logic:
  1. Check hub.verify_token matches env.WEBHOOK_VERIFY_TOKEN
  2. If match → respond with hub.challenge (status 200)
  3. If no match → respond 403
```

### 8.2 Incoming Message (POST)
```
Step 1 — Return 200 to Meta immediately
  Do this before any processing to prevent Meta retry spam.
  Process everything asynchronously after responding.

Step 2 — Verify signature
  Verify X-Hub-Signature-256 header using HMAC SHA256 with META_APP_SECRET
  If invalid → log and discard silently

Step 3 — Parse payload
  Extract: phoneNumberId, from (customer number), messageType, messageContent, metaMessageId
  Skip if message type is not text or media (status updates come through same webhook)

Step 4 — Tenant resolution (tenant.service.js)
  Redis lookup: tenant:{phoneNumberId}
  If cache miss → query DB: Shop.findOne({ phoneNumberId })
  Store in Redis: TTL 1 hour
  If no shop found → log and stop

Step 5 — Subscription check
  Redis lookup: subscription:{shopId}
  If cache miss → query DB + plan, store in Redis (TTL 5min)
  If expired or shop.isActive === false → send unavailable message, stop

Step 6 — Usage check
  Redis lookup: usage:{shopId}:{YYYY-MM}
  If msgCount >= plan.msgLimit (and limit is not -1) → send limit message, stop
  Increment Redis counter atomically

Step 7 — Customer upsert
  findOneAndUpdate with upsert on shopId + customerNumber
  Update lastMessageAt, increment totalMessages
  If isBlocked === true → stop, do not reply

Step 8 — Save inbound message to MongoDB

Step 9 — Check active booking session
  Redis lookup: booking_session:{shopId}:{customerNumber}
  If session exists → pass to booking.service.js (state machine), stop rule matching

Step 10 — Rule matching (chatbot.service.js)
  Load rules from Redis: rules:{shopId}
  Run matching engine (see section 9)
  If match found:
    text → queue reply text
    booking_trigger → start booking session, send first question
    payment_trigger → generate payment link, queue it
  If no match → queue shop's fallbackReply text

Step 11 — Emit Socket.io event
  Room: shop:{shopId}
  Event: new_message
  Data: { customer, message }
```

---

## 9. Chatbot Engine — Rule Matching

### Logic (chatbot.service.js)
```
Input: shopId, incomingText

1. Normalise text: lowercase, trim, remove punctuation, collapse spaces

2. Load rules from Redis: rules:{shopId}
   Cache miss → load from DB, store in Redis (TTL 1hr)

3. Filter: isActive === true only

4. Match in priority order:
   Pass 1 — exact:      rule.keyword === normalisedText
   Pass 2 — startsWith: normalisedText.startsWith(rule.keyword)
   Pass 3 — contains:   normalisedText.includes(rule.keyword)

5. Return first match found
   No match → return null

6. Increment rule.triggerCount asynchronously (non-blocking)
```

### Fallback
No rule matched → send shop's `fallbackReply` text.
Default text: "Thank you for your message. We will get back to you shortly."
Shop owner can customise this in shop settings.

---

## 10. Booking Flow — State Machine

When a rule with replyType `booking_trigger` is matched, the booking state machine starts. The entire conversation state is tracked in Redis per customer.

### Redis Session
```
Key: booking_session:{shopId}:{customerNumber}
TTL: 30 minutes (reset on every customer reply)

Value (JSON):
{
  "step": 0,
  "fields": [
    { "fieldKey": "customerName", "label": "What is your name?", "required": true },
    { "fieldKey": "service", "label": "Which service do you need?", "required": true },
    { "fieldKey": "preferredTime", "label": "What time works for you?", "required": true }
  ],
  "collected": {},
  "ruleId": "rule_abc123"
}
```

### State Machine Steps (booking.service.js)
```
Session does not exist (booking just triggered):
  Load bookingFields for shop's businessType from DB/cache
  Create Redis session: step=0, fields=[...], collected={}
  Send first question: fields[0].label

Customer replies (session exists at step N):
  Store reply in collected[fields[N].fieldKey]
  Increment step

More fields remain (step < fields.length):
  Send next question: fields[step].label

All fields collected (step === fields.length):
  Create booking document in MongoDB with collected fields
  Delete Redis session
  Send confirmation message to customer:
    "Booking confirmed!
     [field summaries]
     We will contact you shortly."
  Emit Socket.io: new_booking to shop:{shopId}
  Increment bookingCount in usage

Session TTL expires (30min no reply):
  Redis auto-deletes session
  Customer's next message is treated as a fresh message
```

---

## 11. Payment Link Flow

### Razorpay Payment Link
```
POST /api/payments/razorpay/create-link
Input: { amount, customerNumber, description, customerId }

1. Check plan.paymentLinkEnabled === true
2. Create Razorpay Payment Link via Razorpay API
3. Save link record in DB (amount, customerId, status: pending)
4. Return { paymentLink: "https://rzp.io/..." }

POST /api/payments/send-to-customer
Input: { paymentLinkUrl, customerNumber, message }
1. Queue WA message with link text
2. Worker sends via Meta Cloud API
3. Increment paymentLinkCount in usage

POST /api/payments/razorpay/webhook
1. Verify Razorpay webhook signature
2. On payment.captured → update booking paymentStatus to 'paid'
3. Send confirmation WA message to customer
```

### UPI Deep Link
```
POST /api/payments/upi/create-link
Input: { amount, note }

Logic:
  Load shop.upiId from shop profile
  Generate: upi://pay?pa={upiId}&pn={shopName}&am={amount}&tn={note}
  Return URL string

No external API needed. Completely free.
The shop owner must have their UPI ID saved in shop settings.
```

---

## 12. BullMQ Outbound Queue

All outbound WhatsApp messages go through BullMQ. Never call Meta API directly from controllers or webhook handler.

### Queue (whatsapp.queue.js)
```
Queue name: whatsapp-outbound
Redis: ioredis connection

Default job options:
  attempts: 3
  backoff: { type: 'exponential', delay: 2000 }
  removeOnComplete: 100
  removeOnFail: 500
```

### Worker (whatsapp.worker.js)
```
Concurrency: 5

Job data: { shopId, phoneNumberId, encryptedAccessToken, to, message, type }

Processing:
  1. Decrypt accessToken using crypto.js
  2. Call Meta Cloud API:
     POST https://graph.facebook.com/v18.0/{phoneNumberId}/messages
     Authorization: Bearer {accessToken}
     Body: {
       messaging_product: "whatsapp",
       to: customerNumber,
       type: "text",
       text: { body: message }
     }
  3. Success → save outbound message to DB, status: 'sent'
  4. Failure → BullMQ retries (up to 3 times with backoff)
  5. Final failure → save message with status: 'failed', log error with shopId
```

---

## 13. Authentication and Authorization

### JWT Strategy
```
Access Token:
  Payload: { userId, shopId, role, permissions }
  Expiry: 15 minutes
  Stored in memory on Flutter app, never in localStorage

Refresh Token:
  Payload: { userId }
  Expiry: 30 days
  Stored in Redis: refresh:{userId} → token (TTL 30 days)
  Also set as httpOnly cookie for Next.js admin panel

On logout:
  Delete Redis key refresh:{userId}
  Token invalidated immediately regardless of expiry
```

### Middleware Chain Per Protected Route
```
1. auth.middleware.js
   Extract Bearer token from Authorization header
   Verify JWT signature using JWT_SECRET
   Attach req.user = { userId, shopId, role, permissions }
   Return 401 if invalid or expired

2. role.middleware.js (where role restriction needed)
   Check req.user.role against allowed roles for route
   Return 403 if not allowed

3. shop.middleware.js (for all shop-scoped routes)
   Confirm req.user.shopId matches resource being accessed
   Superadmin bypasses this check entirely
   Return 403 on mismatch

4. plan.middleware.js (for feature-gated routes)
   Load active subscription for shop
   Check if requested feature is allowed on current plan
   Return 403 with "upgrade your plan" message if not
```

---

## 14. Redis Key Reference

```
tenant:{phoneNumberId}                 shopId string              TTL: 1hr
rules:{shopId}                         JSON array of rules        TTL: 1hr
subscription:{shopId}                  subscription + plan JSON   TTL: 5min
usage:{shopId}:{YYYY-MM}               message count integer      TTL: end of month
booking_session:{shopId}:{number}      booking state JSON         TTL: 30min
refresh:{userId}                       refresh token string       TTL: 30 days
rate_limit:{ip}                        request count integer      TTL: 1min
```

---

## 15. Socket.io Realtime Events

```
Connection:
  Client sends auth: { token: JWT }
  Server verifies JWT on connect
  Server joins client to room: shop:{shopId}
  Superadmin joins room: admin

Events emitted to room shop:{shopId}:
  new_message       { customer, message }          new inbound WA message
  message_status    { messageId, status }           delivered/read update from Meta
  new_booking       { booking }                     booking created via chatbot
  booking_updated   { bookingId, status }           staff changed booking status
  usage_update      { msgCount, limit }             after each processed message

Events emitted to room admin:
  shop_activated    { shopId, shopName }
  shop_deactivated  { shopId, shopName }
  new_subscription  { shopId, plan, amount }
```

---

## 16. Subscription Enforcement

### On Every Webhook Message
```
1. Load subscription from Redis (TTL 5min)
2. Check subscription.status === 'active'
3. Check subscription.endDate > Date.now()
4. Load usage from Redis
5. Check usage.msgCount < plan.msgLimit (skip if plan.msgLimit === -1)
6. Any check fails:
   Do not process
   Send single WA reply: "This service is currently unavailable."
   Log with shopId and reason
   Do NOT increment usage
```

### Expiry Cron Job (runs daily at midnight)
```
Find subscriptions where endDate < now AND status === 'active'
Set status to 'expired'
Set shop.isActive to false
Invalidate Redis: subscription:{shopId}
Send email notification to shop owner
Log expired shop
```

---

## 17. Environment Variables

```
PORT=3000
NODE_ENV=production

MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/whatsapp-saas

REDIS_URL=rediss://default:password@hostname:6379

JWT_SECRET=your_strong_jwt_secret_min_32_chars
JWT_REFRESH_SECRET=your_strong_refresh_secret
JWT_EXPIRY=15m
JWT_REFRESH_EXPIRY=30d

ENCRYPTION_KEY=32_char_aes_256_key_for_meta_tokens

META_APP_SECRET=meta_app_secret_for_webhook_signature_verify
WEBHOOK_VERIFY_TOKEN=your_custom_webhook_verify_token

RAZORPAY_KEY_ID=rzp_live_xxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxx

CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

FRONTEND_URL=https://app.yourproduct.com
ADMIN_URL=https://admin.yourproduct.com
```

---

## 18. Docker Setup

### Dockerfile
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
```

### docker-compose.yml (Local Dev)
```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    env_file: .env
    depends_on:
      - mongo
      - redis
    volumes:
      - ./src:/app/src

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  mongo_data:
```

### Nginx Config (VPS Production)
```nginx
server {
    listen 80;
    server_name api.yourproduct.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.yourproduct.com;

    ssl_certificate /etc/letsencrypt/live/api.yourproduct.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourproduct.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 19. GitHub Actions CI/CD

```yaml
name: Deploy to VPS
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Deploy via SSH
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /app/whatsapp-saas
            git pull origin main
            docker compose build app
            docker compose up -d app
```

---

## 20. Build Order for Developers

Follow this exact sequence. Do not skip phases.

```
Phase 1 — Foundation
  1. Project scaffold (Express + Mongoose + Redis + dotenv)
  2. MongoDB + Redis connection with retry logic
  3. All Mongoose models (section 6)
  4. response.js utility + Winston logger
  5. Global error handler middleware

Phase 2 — Auth System
  6. Register + Login (Shop Owner)
  7. JWT access token + refresh token
  8. Logout with Redis invalidation
  9. Auth middleware + role middleware
  10. Superadmin seed script

Phase 3 — Shop + Rules
  11. Shop CRUD routes
  12. BusinessTypeTemplate seed data
  13. Rule CRUD routes
  14. Rule Redis cache + invalidation on write

Phase 4 — Webhook Core
  15. Webhook GET verification
  16. Webhook POST — parse + signature verify + return 200 immediately
  17. Tenant resolution service with Redis cache
  18. Customer upsert logic
  19. Inbound message save

Phase 5 — Chatbot Engine
  20. Rule matching engine (chatbot.service.js)
  21. BullMQ queue + worker setup
  22. Meta Cloud API send message (whatsapp.service.js)
  23. End to end test: receive message → match rule → send reply

Phase 6 — Booking Flow
  24. Booking state machine (booking.service.js)
  25. Redis session create + advance + complete
  26. Booking CRUD routes
  27. End to end booking flow test

Phase 7 — Payments
  28. UPI deep link generation (free, no API)
  29. Razorpay payment link creation
  30. Razorpay webhook for payment confirmation
  31. Send payment link via WA queue

Phase 8 — Subscription + Usage
  32. Plan seed data
  33. Subscription create + Razorpay verify + activate
  34. Subscription check middleware
  35. Usage increment in Redis + async persist to MongoDB
  36. Expiry cron job

Phase 9 — Staff Management
  37. Staff invite + account creation
  38. Staff permissions update
  39. Staff role in JWT payload + route guards

Phase 10 — Admin Panel APIs
  40. All admin routes (section 7)
  41. Platform stats aggregation queries

Phase 11 — Realtime
  42. Socket.io init + JWT auth on connect
  43. Room join logic (shop:{shopId} + admin)
  44. Emit events at all correct points in webhook flow

Phase 12 — DevOps
  45. Dockerfile + docker-compose tested locally
  46. Nginx config + SSL via Let's Encrypt
  47. GitHub Actions deploy workflow
  48. Smoke test full flow on VPS
```

---

## 21. Non-Negotiable Rules for All Developers

1. **Never call Meta Cloud API directly from a controller or webhook handler.** Always add to BullMQ queue. This prevents message loss on Meta API slowness.

2. **Always return 200 to Meta webhook immediately**, before any async processing. Meta will retry aggressively if you are slow. Handle everything after the response.

3. **Every DB query on shop-level collections must include shopId as a filter.** One missed shopId filter is a data leak between tenants. No exceptions.

4. **Never store Meta access tokens in plain text.** AES encrypt before saving, decrypt only when making API calls. Use crypto.js utility.

5. **Validate all env vars at startup in config/env.js.** Crash the server immediately with a clear error if anything is missing. Never let the app start in a broken state.

6. **Redis is source of truth for live state** (tenant cache, rule cache, booking sessions, usage counters). MongoDB is the persistent record. Always keep them in sync on writes.

7. **Invalidate Redis rule cache immediately** when any rule is created, updated, or deleted. Stale rules = wrong replies to customers.

8. **All API responses must use response.js wrapper.** Never send raw objects or inconsistent shapes from controllers.

9. **Every log entry must include shopId and customerId** where relevant. When something breaks at 2am you need to trace it fast.

10. **Test the full webhook flow on Meta's test tools** before marking any chatbot feature as complete. The webhook is the heartbeat of this entire product.

---

*End of Backend Implementation Brief — MVP V1*

*Next documents to generate:*
*— Flutter App Implementation Brief*
*— Next.js Super Admin Panel Brief*
*— Database Seed Script Guide*
