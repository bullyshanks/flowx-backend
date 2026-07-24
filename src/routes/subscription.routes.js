const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/subscription.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

// Customer
router.post('/', requireAuth, requireRole('CUSTOMER'), ctrl.create);
router.get('/my', requireAuth, requireRole('CUSTOMER'), ctrl.mySubscriptions);
router.post('/:id/pause', requireAuth, requireRole('CUSTOMER'), ctrl.pause);
router.post('/:id/resume', requireAuth, requireRole('CUSTOMER'), ctrl.resume);
router.post('/:id/cancel', requireAuth, requireRole('CUSTOMER'), ctrl.cancel);

// Admin
router.get('/admin/all', requireAuth, requireRole('ADMIN'), ctrl.adminList);
router.post('/admin/:id/pause', requireAuth, requireRole('ADMIN'), ctrl.adminPause);
router.post('/admin/:id/resume', requireAuth, requireRole('ADMIN'), ctrl.adminResume);
router.post('/admin/:id/cancel', requireAuth, requireRole('ADMIN'), ctrl.adminCancel);

module.exports = router;
