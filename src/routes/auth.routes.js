const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth');

// Customer registration
router.post('/register/customer', ctrl.registerCustomer);

// Vendor registration
router.post('/register/vendor', ctrl.registerVendor);

// OTP flow
router.post('/otp/send', ctrl.sendOtp);
router.post('/otp/verify', ctrl.verifyOtp);

// Password login (vendors & admins)
router.post('/login', ctrl.login);

// Current user
router.get('/me', requireAuth, ctrl.me);

module.exports = router;
