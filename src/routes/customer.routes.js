const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/customer.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/referral', requireAuth, requireRole('CUSTOMER'), ctrl.getReferral);

module.exports = router;
