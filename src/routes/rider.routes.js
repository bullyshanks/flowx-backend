const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rider.controller');
const walletCtrl = require('../controllers/wallet.controller');
const { requireAuth, requireRole, requireApprovedRider } = require('../middleware/auth');

// ── Rider self ──
router.get('/dashboard', requireAuth, requireApprovedRider, ctrl.dashboard);
router.patch('/me/online', requireAuth, requireApprovedRider, ctrl.toggleOnline);
router.get('/wallet', requireAuth, requireApprovedRider, walletCtrl.getRiderWallet);
router.get('/wallet/transactions', requireAuth, requireApprovedRider, walletCtrl.getRiderTransactions);
router.get('/wallet/settlements', requireAuth, requireApprovedRider, walletCtrl.getRiderSettlements);

// ── Admin only ──
router.get('/', requireAuth, requireRole('ADMIN'), ctrl.listRiders);
router.post('/:id/approve', requireAuth, requireRole('ADMIN'), ctrl.approveRider);
router.post('/:id/reject', requireAuth, requireRole('ADMIN'), ctrl.rejectRider);
router.patch('/:id/zone', requireAuth, requireRole('ADMIN'), ctrl.changeRiderZone);
router.patch('/:id/cod-limit', requireAuth, requireRole('ADMIN'), ctrl.setCodLimit);
router.patch('/:id/freeze', requireAuth, requireRole('ADMIN'), ctrl.toggleFreeze);

module.exports = router;
