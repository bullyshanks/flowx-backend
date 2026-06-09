// ═══════════════════════════════════════════════════════════
//  Vendor Controller
//  Admin: list/approve/reject vendors. Vendor: dashboard stats
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { sendVendorApprovedSms } = require('../services/sms.service');

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
        id: true, name: true, phone: true, cnic: true, vendorStatus: true,
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
