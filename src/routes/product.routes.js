const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/product.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

// Public
router.get('/', ctrl.getAll);
router.get('/zones', ctrl.getZones);
router.get('/:id', ctrl.getOne);

// Admin
router.post('/', requireAuth, requireRole('ADMIN'), ctrl.create);
router.put('/:id', requireAuth, requireRole('ADMIN'), ctrl.update);
router.delete('/:id', requireAuth, requireRole('ADMIN'), ctrl.remove);

module.exports = router;
