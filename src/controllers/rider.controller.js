// ═══════════════════════════════════════════════════════════
//  Rider Controller
//  Admin: list/approve/reject riders (account-status gate).
//  Mirrors vendor.controller.js — vendorStatus is reused as the
//  generic account-approval status for both roles.
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { needsRider, tryAssignRider, reassignRiderOrders } = require('../services/assignment.service');
const {
  sendAccountFrozenSms, sendAccountUnfrozenSms, sendRiderApprovedSms,
  sendAccountSuspendedSms, sendAccountReactivatedSms, sendAccountRejectedSms,
} = require('../services/sms.service');

// ─────────────────────────────────────────────
// Admin: list all riders (filterable)
// ─────────────────────────────────────────────
exports.listRiders = async (req, res, next) => {
  try {
    const { status, zoneId } = req.query;

    const riders = await prisma.user.findMany({
      where: {
        role: 'RIDER',
        ...(status && { vendorStatus: status }),
        ...(zoneId && { zoneId }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, phone: true, vendorStatus: true, kycStatus: true,
        vehicleDetails: true, isOnline: true, isFrozen: true, codLimit: true,
        approvedAt: true, createdAt: true,
        zone: { select: { id: true, name: true } },
        _count: { select: { riderOrders: true } },
      },
    });

    res.json({ success: true, riders });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: approve a rider's account (separate from KYC approval)
// ─────────────────────────────────────────────
exports.approveRider = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, role: 'RIDER' } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Rider not found' });
    }
    if (existing.vendorStatus !== 'PENDING') {
      return res.status(409).json({
        success: false,
        message: `Cannot approve a rider with status ${existing.vendorStatus}`,
      });
    }

    const rider = await prisma.user.update({
      where: { id: existing.id },
      data: {
        vendorStatus: 'APPROVED',
        approvedAt: new Date(),
        isVerified: true,
        rejectedReason: null,
      },
    });

    if (rider.phone) sendRiderApprovedSms(rider.phone);

    res.json({ success: true, message: 'Rider account approved', rider });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: reject a rider's account
// ─────────────────────────────────────────────
exports.rejectRider = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, role: 'RIDER' } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Rider not found' });
    }
    if (existing.vendorStatus !== 'PENDING') {
      return res.status(409).json({
        success: false,
        message: `Cannot reject a rider with status ${existing.vendorStatus}`,
      });
    }

    const { reason } = req.body;
    const rider = await prisma.user.update({
      where: { id: existing.id },
      data: {
        vendorStatus: 'REJECTED',
        rejectedReason: reason || 'Application rejected',
      },
    });

    if (rider.phone) sendAccountRejectedSms(rider.phone, reason);

    res.json({ success: true, message: 'Rider rejected', rider });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: suspend/reactivate a rider (toggle between APPROVED and SUSPENDED)
// ─────────────────────────────────────────────
exports.toggleSuspend = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, role: 'RIDER' } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Rider not found' });
    }
    if (existing.vendorStatus !== 'APPROVED' && existing.vendorStatus !== 'SUSPENDED') {
      return res.status(409).json({
        success: false,
        message: `Cannot suspend a rider with status ${existing.vendorStatus}`,
      });
    }

    const { reason } = req.body;
    const suspending = existing.vendorStatus === 'APPROVED';
    const rider = await prisma.user.update({
      where: { id: existing.id },
      data: suspending
        ? { vendorStatus: 'SUSPENDED', rejectedReason: reason || 'Account suspended' }
        : { vendorStatus: 'APPROVED', rejectedReason: null },
    });

    if (rider.phone) {
      if (suspending) sendAccountSuspendedSms(rider.phone, reason);
      else sendAccountReactivatedSms(rider.phone);
    }

    if (suspending) await reassignRiderOrders(rider.id);

    res.json({ success: true, message: suspending ? 'Rider suspended' : 'Rider reactivated', rider });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: change rider zone
// ─────────────────────────────────────────────
exports.changeRiderZone = async (req, res, next) => {
  try {
    const { zoneId } = req.body;
    const rider = await prisma.user.update({
      where: { id: req.params.id, role: 'RIDER' },
      data: { zoneId },
      include: { zone: true },
    });
    res.json({ success: true, rider });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: set a rider's COD limit (mirrors finance.controller's vendor version)
// ─────────────────────────────────────────────
exports.setCodLimit = async (req, res, next) => {
  try {
    const { codLimit } = req.body;
    let value = null;
    if (codLimit !== null && codLimit !== undefined && codLimit !== '') {
      value = Number(codLimit);
      if (Number.isNaN(value) || value < 0) {
        return res.status(400).json({ success: false, message: 'codLimit must be >= 0 (or null for unlimited)' });
      }
    }

    const rider = await prisma.user.findFirst({ where: { id: req.params.id, role: 'RIDER' } });
    if (!rider) {
      return res.status(404).json({ success: false, message: 'Rider not found' });
    }

    const updated = await prisma.user.update({
      where: { id: rider.id },
      data: { codLimit: value },
      select: { id: true, name: true, codLimit: true, codLiability: true },
    });
    res.json({ success: true, rider: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: freeze/unfreeze a rider (toggle, or set via body.isFrozen)
// ─────────────────────────────────────────────
exports.toggleFreeze = async (req, res, next) => {
  try {
    const rider = await prisma.user.findFirst({ where: { id: req.params.id, role: 'RIDER' } });
    if (!rider) {
      return res.status(404).json({ success: false, message: 'Rider not found' });
    }

    const isFrozen = typeof req.body.isFrozen === 'boolean' ? req.body.isFrozen : !rider.isFrozen;
    const updated = await prisma.user.update({
      where: { id: rider.id },
      data: { isFrozen },
      select: { id: true, name: true, phone: true, isFrozen: true },
    });

    if (updated.phone) {
      if (isFrozen) sendAccountFrozenSms(updated.phone);
      else sendAccountUnfrozenSms(updated.phone);
    }

    // Financial hold and delivery capability are separate concerns — a frozen
    // rider shouldn't be able to hold a customer's order hostage. Mirrors
    // toggleSuspend above.
    if (isFrozen) await reassignRiderOrders(updated.id, 'frozen');

    res.json({ success: true, rider: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Rider: update my own online/offline status
// ─────────────────────────────────────────────
exports.toggleOnline = async (req, res, next) => {
  try {
    const isOnline = typeof req.body.isOnline === 'boolean' ? req.body.isOnline : !req.user.isOnline;
    const rider = await prisma.user.update({
      where: { id: req.user.id },
      data: { isOnline },
      select: { id: true, zoneId: true, isOnline: true },
    });

    // Mirrors updateStorefront's sweep: deliveries that needed a rider but had
    // none online in the zone sit at riderId: null forever otherwise, since
    // reassignIfExpired only re-checks offers that were made and expired.
    if (rider.isOnline) {
      const orphaned = await prisma.order.findMany({
        where: {
          zoneId: rider.zoneId,
          status: 'ASSIGNED',
          vendorId: { not: null },
          riderId: null,
          fulfillmentType: 'DELIVERY',
        },
        include: { items: { include: { product: true } } },
      });
      for (const order of orphaned) {
        if (needsRider(order)) await tryAssignRider(order.id);
      }
    }

    res.json({ success: true, rider });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Rider: dashboard stats (mirrors vendor.controller.dashboard)
// ─────────────────────────────────────────────
exports.dashboard = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayOrders, pendingOrders, completedOrders, totalAssigned] = await Promise.all([
      prisma.order.count({
        where: { riderId: req.user.id, createdAt: { gte: today } },
      }),
      prisma.order.count({
        where: { riderId: req.user.id, status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } },
      }),
      prisma.order.count({
        where: { riderId: req.user.id, status: 'DELIVERED' },
      }),
      prisma.order.count({ where: { riderId: req.user.id } }),
    ]);

    res.json({
      success: true,
      stats: { todayOrders, pendingOrders, completedOrders, totalAssigned },
    });
  } catch (err) {
    next(err);
  }
};
