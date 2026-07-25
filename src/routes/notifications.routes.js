const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/notifications.controller');
const { requireAuth } = require('../middleware/auth');

router.post('/subscribe', requireAuth, ctrl.subscribe);
router.delete('/subscribe', requireAuth, ctrl.unsubscribe);

module.exports = router;
