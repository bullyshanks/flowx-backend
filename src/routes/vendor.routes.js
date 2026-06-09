const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/vendor.controller');
const { requireAuth, requireRole, requireApprovedVendor } = require('../middleware/auth');

// ── Vendor self ──
router.get('/dashboard', requireAuth, requireApprovedVendor, ctrl.dashboard);

// ── Admin only ──
router.get('/', requireAuth, requireRole('ADMIN'), ctrl.listVendors);
router.post('/:id/approve', requireAuth, requireRole('ADMIN'), ctrl.approveVendor);
router.post('/:id/reject', requireAuth, requireRole('ADMIN'), ctrl.rejectVendor);
router.patch('/:id/zone', requireAuth, requireRole('ADMIN'), ctrl.changeVendorZone);

module.exports = router;
