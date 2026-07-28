// ═══════════════════════════════════════════════════════════
//  FlowX Express App
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth.routes');
const productRoutes = require('./routes/product.routes');
const orderRoutes = require('./routes/order.routes');
const vendorRoutes = require('./routes/vendor.routes');
const riderRoutes = require('./routes/rider.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const adminRoutes = require('./routes/admin.routes');
const financeRoutes = require('./routes/finance.routes');
const kycRoutes = require('./routes/kyc.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const customerRoutes = require('./routes/customer.routes');
const paymentRoutes = require('./routes/payment.routes');

const app = express();

// ── Security & parsing ──
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL?.split(',') || '*',
    credentials: true,
  })
);
// Safepay signs its webhook over the raw request bytes, so this one route has
// to see them before any parser reorders or re-encodes the JSON. Mounted ahead
// of express.json() for that reason — moving it below silently breaks
// signature verification, which fails closed and rejects real payments.
app.use(
  '/api/payments/callback',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      try {
        req.parsedBody = req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
      } catch {
        req.parsedBody = {};
      }
    }
    next();
  }
);

// 15mb: KYC submission sends up to 3 base64-encoded images (see auth.controller.submitKyc)
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── Rate limiting ──
// The smoke suite makes far more auth calls in one run than the 20-request
// ceiling allows, and these limiters are in-memory — there's no way to clear
// them between suites short of restarting the server. Allow opting out, but
// only ever outside production, so setting this on Railway does nothing.
const rateLimitingDisabled =
  process.env.DISABLE_RATE_LIMIT === 'true' && process.env.NODE_ENV !== 'production';

if (rateLimitingDisabled) {
  console.warn('⚠  Rate limiting DISABLED (DISABLE_RATE_LIMIT=true, non-production)');
} else {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);

  // Stricter limit for auth
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
  });
  app.use('/api/auth/', authLimiter);
}

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'FlowX API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── Routes ──
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/riders', riderRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin/finance', financeRoutes);
app.use('/api/admin/kyc', kycRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/payments', paymentRoutes);

// ── 404 handler ──
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
});

// ── Error handler (must be last) ──
app.use(errorHandler);

module.exports = app;
