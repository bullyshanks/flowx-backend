// ═══════════════════════════════════════════════════════════
//  Vendor Controller
//  Admin: list/approve/reject vendors. Vendor: dashboard stats
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { sendVendorApprovedSms } = require('../services/sms.service');
const { tryAssignVendor } = require('../services/assignment.service');

// ─────────────────────────────────────────────
// Admin: list all vendors (filterable)
// ─────────────────────────────────────────────
exports.listVendors = async (req, res, next) => {
  try {
    const { status, zoneId } = req.query;

    const vendors = await prisma.user.findMany({
      where: {
        role: 'VENDOR',
        ...(status && { vendorStatus: status }),
        ...(zoneId && { zoneId }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, phone: true, cnic: true, vendorStatus: true, kycStatus: true,
        businessName: true, shopDetails: true, isOpen: true, stockStatus: true,
        approvedAt: true, createdAt: true,
        zone: { select: { id: true, name: true } },
        _count: { select: { assignedOrders: true } },
      },
    });

    res.json({ success: true, vendors });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: approve a vendor
// ─────────────────────────────────────────────
exports.approveVendor = async (req, res, next) => {
  try {
    const vendor = await prisma.user.update({
      where: { id: req.params.id, role: 'VENDOR' },
      data: {
        vendorStatus: 'APPROVED',
        approvedAt: new Date(),
        isVerified: true,
      },
    });

    sendVendorApprovedSms(vendor.phone);

    res.json({ success: true, message: 'Vendor approved', vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: reject a vendor
// ─────────────────────────────────────────────
exports.rejectVendor = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const vendor = await prisma.user.update({
      where: { id: req.params.id, role: 'VENDOR' },
      data: {
        vendorStatus: 'REJECTED',
        rejectedReason: reason || 'Application rejected',
      },
    });
    res.json({ success: true, message: 'Vendor rejected', vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: suspend/reactivate a vendor (toggle between APPROVED and SUSPENDED)
// ─────────────────────────────────────────────
exports.toggleSuspend = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({ where: { id: req.params.id, role: 'VENDOR' } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }
    if (existing.vendorStatus !== 'APPROVED' && existing.vendorStatus !== 'SUSPENDED') {
      return res.status(409).json({
        success: false,
        message: `Cannot suspend a vendor with status ${existing.vendorStatus}`,
      });
    }

    const { reason } = req.body;
    const suspending = existing.vendorStatus === 'APPROVED';
    const vendor = await prisma.user.update({
      where: { id: existing.id },
      data: suspending
        ? { vendorStatus: 'SUSPENDED', rejectedReason: reason || 'Account suspended' }
        : { vendorStatus: 'APPROVED', rejectedReason: null },
    });

    res.json({ success: true, message: suspending ? 'Vendor suspended' : 'Vendor reactivated', vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: change vendor zone
// ─────────────────────────────────────────────
exports.changeVendorZone = async (req, res, next) => {
  try {
    const { zoneId } = req.body;
    const vendor = await prisma.user.update({
      where: { id: req.params.id, role: 'VENDOR' },
      data: { zoneId },
      include: { zone: true },
    });
    res.json({ success: true, vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: update my own storefront (open/closed, in stock/out of stock)
// ─────────────────────────────────────────────
exports.updateStorefront = async (req, res, next) => {
  try {
    const { isOpen, stockStatus } = req.body;
    const data = {};
    if (typeof isOpen === 'boolean') data.isOpen = isOpen;
    if (typeof stockStatus === 'boolean') data.stockStatus = stockStatus;
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const vendor = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { id: true, zoneId: true, isOpen: true, stockStatus: true },
    });

    // Reopening (or restocking) can unblock orders that never got offered to
    // anyone because no vendor was eligible in the zone at the time — those
    // otherwise sit stuck forever, since reassignIfExpired only re-checks
    // offers that were made and expired, not orders that never got one.
    if (vendor.isOpen && vendor.stockStatus) {
      const orphaned = await prisma.order.findMany({
        where: {
          zoneId: vendor.zoneId,
          status: 'PENDING',
          vendorId: null,
          offeredVendorId: null,
        },
        select: { id: true },
      });
      for (const order of orphaned) {
        await tryAssignVendor(order.id);
      }
    }

    res.json({ success: true, vendor });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: dashboard stats
// ─────────────────────────────────────────────
exports.dashboard = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayOrders, pendingOrders, completedOrders, totalAssigned] = await Promise.all([
      prisma.order.count({
        where: { vendorId: req.user.id, createdAt: { gte: today } },
      }),
      prisma.order.count({
        where: { vendorId: req.user.id, status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } },
      }),
      prisma.order.count({
        where: { vendorId: req.user.id, status: 'DELIVERED' },
      }),
      prisma.order.count({ where: { vendorId: req.user.id } }),
    ]);

    res.json({
      success: true,
      stats: { todayOrders, pendingOrders, completedOrders, totalAssigned },
    });
  } catch (err) {
    next(err);
  }
};
