const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/payment.controller');
const { requireAuth } = require('../middleware/auth');

// Guests place and pay for orders without an account, so ownership is checked
// inside the controller (JWT, or the guest phone on the order) rather than by
// a blanket requireAuth here.
const optionalAuth = async (req, res, next) => {
  if (req.headers.authorization) return requireAuth(req, res, next);
  next();
};

router.post('/initiate', optionalAuth, ctrl.initiate);
router.get('/status/:orderNumber', optionalAuth, ctrl.status);

// Gateway callbacks. Unauthenticated by necessity — the gateway has no token —
// which is exactly why every one of these is verified by signature before it
// can settle anything (see payment.service.settlePayment).
//
// Safepay signs the raw body, so its webhook needs the unparsed bytes. This
// route is mounted with express.raw() in app.js ahead of the JSON parser;
// req.rawBody carries the buffer and req.parsedBody the decoded object.
router.post('/callback/:provider', ctrl.callback);

// JazzCash and Easypaisa send the customer's browser back here via GET.
// Treated as a callback too (both sign their return payload), then redirected
// on to the frontend result page.
router.get('/callback/:provider', ctrl.callback);

// Dev-only stand-in for a hosted checkout page. Guarded twice in the
// controller: never in production, never for a configured provider.
router.get('/simulate/:reference', ctrl.simulate);

module.exports = router;
