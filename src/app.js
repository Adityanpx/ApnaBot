const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const config = require('./config/env');
const { globalLimiter } = require('./middleware/rateLimiter.middleware');
const errorHandler = require('./middleware/errorHandler.middleware');

// Import routes
const authRoutes = require('./routes/auth.routes');
const shopRoutes = require('./routes/shop.routes');
const ruleRoutes = require('./routes/rule.routes');
const customerRoutes = require('./routes/customer.routes');
const messageRoutes = require('./routes/message.routes');
const bookingRoutes = require('./routes/booking.routes');
const webhookRoutes = require('./routes/webhook.routes');
const paymentRoutes = require('./routes/payment.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const staffRoutes = require('./routes/staff.routes');
const adminRoutes = require('./routes/admin.routes');

const app = express();

// Trust the first proxy hop (required on Render to avoid ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
app.set('trust proxy', 1);

// Middlewares
app.use(helmet());
app.use(cors({
  origin: [config.FRONTEND_URL, config.ADMIN_URL]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Apply global rate limiter to all routes except /api/webhook
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook')) return next();
  return globalLimiter(req, res, next);
});

// Health check route
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Server is running',
    timestamp: new Date()
  });
});

// Root route - API info
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ApnaBot API is running',
    frontend: config.FRONTEND_URL,
    admin: config.ADMIN_URL,
    docs: '/health'
  });
});

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/rules', ruleRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/admin', adminRoutes);

// Error handler middleware
app.use(errorHandler);

module.exports = app;
