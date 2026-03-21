# Backend Implementation Plan - Phase Wise

This document outlines the 8-phase implementation plan for the backend of the AI WhatsApp Business Bot SaaS as per the BACKEND_IMPLEMENTATION_BRIEF.md.

## Phase 1: Project Setup and Environment Configuration
- Initialize Node.js project with `npm init`
- Install core dependencies: express, mongoose, ioredis, jsonwebtoken, bcryptjs, dotenv, etc.
- Set up folder structure as per brief: src/config, src/models, src/routes, src/controllers, src/services, src/middleware, src/queues, src/socket, src/utils
- Create configuration files:
  - src/config/env.js: Validate environment variables on startup
  - src/config/db.js: MongoDB connection via Mongoose
  - src/config/redis.js: Redis connection via ioredis
- Create basic Express server in src/app.js with middleware (express.json, cors, etc.)
- Create server.js to start the server and listen on PORT
- Create .env.example with all required environment variables
- Set up Dockerfile and docker-compose.yml for development (MongoDB, Redis)
- Set up nginx.conf for reverse proxy (to be used later)

## Phase 2: Database Models and Seeding
- Implement all MongoDB models in src/models/:
  - User.js
  - Shop.js
  - Plan.js
  - Subscription.js
  - Rule.js
  - Customer.js
  - Message.js
  - Booking.js
  - Usage.js
  - BusinessTypeTemplate.js
- Ensure each model includes the schema, methods, and indexes as specified in the brief
- Create seed scripts:
  - Seed super admin user (not via public signup)
  - Seed plans (Basic, Pro, Business) with predefined limits and prices
  - Seed businessTypeTemplates for all 8 business types with default rules and booking fields
- Create a database connection utility and error handling

## Phase 3: Authentication and Authorization
- Implement authentication middleware (src/middleware/auth.middleware.js):
  - Verify JWT token, attach user to request
- Implement role middleware (src/middleware/role.middleware.js):
  - Check user role (superadmin, owner, staff) and permissions
- Implement shop middleware (src/middleware/shop.middleware.js):
  - Ensure user can only access data from their own shopId (except superadmin)
- Implement plan middleware (src/middleware/plan.middleware.js):
  - Check subscription status and usage limits
- Implement rate limiter middleware (src/middleware/rateLimiter.middleware.js)
- Implement error handler middleware (src/middleware/errorHandler.middleware.js)
- Implement auth controller (src/controllers/auth.controller.js):
  - POST /api/auth/register (shop owner signup)
  - POST /api/auth/login (login for all roles)
  - POST /api/auth/refresh (refresh access token)
  - POST /api/auth/logout (invalidate refresh token in Redis)
  - POST /api/auth/forgot-password (send reset email)
  - POST /api/auth/reset-password (reset with token)
- Implement auth routes (src/routes/auth.routes.js) and mount on /api/auth
- Use Redis to store refresh tokens for logout functionality
- Use crypto.js utility for AES encryption/decryption of Meta tokens

## Phase 4: Core Shop Management and WhatsApp Integration
- Implement shop controller (src/controllers/shop.controller.js):
  - GET /api/shop: Get own shop profile
  - PUT /api/shop: Update shop profile
  - POST /api/shop/connect-whatsapp: Save phoneNumberId and encrypted accessToken
  - DELETE /api/shop/disconnect-whatsapp
  - GET /api/shop/dashboard-stats: Today's message, booking, customer counts
- Implement shop routes (src/routes/shop.routes.js) and mount on /api/shop (protected by auth and shop middleware)
- Implement tenant service (src/services/tenant.service.js):
  - Resolve shop by phoneNumberId (from WhatsApp webhook)
- Implement utility functions for encrypting/decrypting Meta access tokens
- Ensure webhook verification token is generated and stored per shop

## Phase 5: Chatbot Rule Engine and Webhook Handling
- Implement rule controller (src/controllers/rule.controller.js):
  - GET /api/rules: List all rules (paginated)
  - POST /api/rules: Create rule
  - PUT /api/rules/:id: Update rule
  - DELETE /api/rules/:id: Delete rule
  - PUT /api/rules/:id/toggle: Enable or disable rule
  - GET /api/rules/templates: Get default rules for shop's business type
  - POST /api/rules/bulk-import: Import template rules into shop
- Implement rule routes (src/routes/rules.routes.js) and mount on /api/rules (owner only)
- Implement chatbot service (src/services/chatbot.service.js):
  - Rule matching engine: Given a message and shopId, find matching rule based on keyword, matchType
  - Handle reply types: text, booking_trigger, payment_trigger
- Implement webhook controller (src/controllers/webhook.controller.js):
  - POST /api/webhook/receive: Main webhook endpoint for incoming WhatsApp messages
  - Steps: verify signature, resolve shop via tenant service, check subscription/middleware, increment usage, run chatbot service, handle booking flow, generate payment link if needed, add reply to BullMQ outbound queue
- Implement webhook routes (src/routes/webhook.routes.js) and mount on /api/webhook
- Implement usage service (src/services/usage.service.js):
  - Increment message count atomically in Redis, persist to MongoDB periodically
  - Check limits based on plan
- Implement subscription service (src/services/subscription.service.js):
  - Plan checks, expiry logic, status updates
- Ensure rules are cached in Redis with TTL 1hr and invalidated on write

## Phase 6: Booking and Payment Integration
- Implement booking controller (src/controllers/booking.controller.js):
  - Standard CRUD operations for bookings (protected by owner/staff middleware)
  - Additional endpoints for updating booking status, etc.
- Implement booking routes (src/routes/bookings.routes.js) and mount on /api/bookings
- Implement booking service (src/services/booking.service.js):
  - Booking state machine: Handle booking flow conversation steps
  - Dynamic fields per business type
  - Generate payment link if payment is required
- Implement payment controller (src/controllers/payment.controller.js):
  - POST /api/payment/generate-link: Generate Razorpay payment link or UPI deep link
  - POST /api/payment/webhook: Handle Razorpay webhook for payment status updates
- Implement payment routes (src/routes/payment.routes.js) and mount on /api/payment
- Implement payment service (src/services/payment.service.js):
  - Razorpay integration for creating orders, payment links
  - UPI deep link generation
  - Verify payment status via Razorpay webhook
- Update booking model to include payment status, amount, link, Razorpay order ID
- Ensure payment links can be generated and sent in chat via the webhook flow

## Phase 7: Real-time Features and Worker Queues
- Implement socket service (src/services/socket.service.js):
  - Initialize Socket.io instance
  - Emit real-time events (e.g., new_message) to shop dashboard
- Implement socket.js (src/socket/socket.js): Connection handling and event listeners
- Update message controller to emit socket event when new message is saved
- Implement BullMQ queue for outbound WhatsApp messages:
  - Create whatsapp.queue.js (src/queues/whatsapp.queue.js): Define queue and add job function
  - Create whatsapp.worker.js (src/queues/whatsapp.worker.js): Process jobs, call Meta Cloud API to send message, save message to MongoDB, handle failures/retries
- Implement WhatsApp service (src/services/whatsapp.service.js):
  - All Meta Cloud API calls: send message, get media, etc.
  - Use encrypted access token from shop document
- Ensure outbound messages are added to queue by webhook controller after processing
- Worker runs independently, processes queue, sends messages via Meta Cloud API

## Phase 8: Staff Management, Admin Panel APIs, and Testing
- Implement staff controller (src/controllers/staff.controller.js):
  - POST /api/staff: Add staff member under shop (owner only)
  - GET /api/staff: List staff members
  - PUT /api/staff/:id: Update staff role/permissions
  - DELETE /api/staff/:id: Remove staff
  - (Note: Staff login uses same auth endpoints, role determines access)
- Implement staff routes (src/routes/staff.routes.js) and mount on /api/staff (owner only)
- Implement admin controller (src/controllers/admin.controller.js):
  - GET /api/admin/shops: List all shops (superadmin only)
  - GET /api/admin/shops/:id: Get shop details
  - PUT /api/admin/shops/:id/status: Activate/deactivate shop
  - POST /api/admin/plans: Create/edit/delete subscription plans
  - PUT /api/admin/shops/:id/plan: Change shop's plan manually
  - PUT /api/admin/shops/:id/extend: Extend or reset subscription expiry
  - GET /api/admin/transactions: View all Razorpay transactions
- Implement admin routes (src/routes/admin.routes.js) and mount on /api/admin (superadmin only)
- Implement remaining utility functions:
  - response.js: Standard { success, data, message } format
  - logger.js: Winston logger for request logging and error tracking
  - pagination.js: Helper for paginated queries
- Write comprehensive tests for APIs, services, and middleware
- Final error handling and validation across all endpoints
- Prepare for deployment:
  - Ensure Dockerfile builds the Node.js application correctly
  - Test docker-compose setup with MongoDB, Redis, and the app
  - Verify Nginx configuration for SSL and reverse proxy to Node.js and Next.js (admin panel)
  - Document environment variables and setup steps

## Conclusion
Each phase builds upon the previous one, ensuring a solid foundation and incremental development. After completing all phases, the backend will be ready for integration with the Flutter app (shop owner/staff) and Next.js admin panel (superadmin).
