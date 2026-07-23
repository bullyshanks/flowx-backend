const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/finance.controller');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('ADMIN'));

router.get('/commission-settings', ctrl.getCommissionSettings);
router.patch('/commission-settings', ctrl.updateCommissionSettings);
router.patch('/products/:id/rates', ctrl.updateProductRates);

router.get('/vendors/:id/wallet', ctrl.getVendorWallet);
router.patch('/vendors/:id/cod-limit', ctrl.setCodLimit);
router.patch('/vendors/:id/freeze', ctrl.toggleFreeze);

router.get('/riders/:id/wallet', ctrl.getRiderWallet);

router.get('/settlements/pending', ctrl.pendingSettlements);
router.post('/settlements/generate', ctrl.generateSettlements);
router.post('/settlements/:id/approve', ctrl.approveSettlement);
router.post('/settlements/:id/pay', ctrl.paySettlement);

module.exports = router;
