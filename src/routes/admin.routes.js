const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/admin.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('ADMIN'));

router.get('/dashboard', ctrl.dashboard);
router.get('/orders/by-status', ctrl.ordersByStatus);
router.get('/orders/top-zones', ctrl.topZones);

module.exports = router;
