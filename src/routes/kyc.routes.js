const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/kyc.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('ADMIN'));

router.get('/pending', ctrl.listPending);
router.get('/:id', ctrl.getSubmission);
router.post('/:id/approve', ctrl.approve);
router.post('/:id/reject', ctrl.reject);

module.exports = router;
