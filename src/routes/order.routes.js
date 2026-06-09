const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/order.controller');
const { requireAuth, requireRole, requireApprovedVendor } = require('../middleware/auth');

// ── Public / optional auth ──
// Place order works for guests AND logged-in users
const optionalAuth = async (req, res, next) => {
  if (req.headers.authorization) {
    return require('../middleware/auth').requireAuth(req, res, next);
  }
  next();
};

router.post('/', optionalAuth, ctrl.placeOrder);
router.get('/track/:orderNumber', ctrl.trackOrder);

// ── Customer ──
router.get('/my-orders', requireAuth, requireRole('CUSTOMER'), ctrl.myOrders);

// ── Vendor ──
router.get('/vendor/queue', requireAuth, requireApprovedVendor, ctrl.vendorOrders);
router.post('/:id/accept', requireAuth, requireApprovedVendor, ctrl.acceptOrder);
router.patch('/:id/status', requireAuth, requireRole('VENDOR', 'ADMIN'), ctrl.updateStatus);

// ── Admin ──
router.get('/admin/all', requireAuth, requireRole('ADMIN'), ctrl.adminListOrders);
router.post('/:id/assign', requireAuth, requireRole('ADMIN'), ctrl.assignVendor);

module.exports = router;
