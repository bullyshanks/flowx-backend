// ═══════════════════════════════════════════════════════════
//  KYC Review Controller (admin)
//  Shared across VENDOR and RIDER — KYC is one identity-verification
//  gate independent of each role's own account-approval status.
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { sendKycApprovedSms, sendKycRejectedSms } = require('../services/sms.service');
const { needsRider, tryAssignVendor, tryAssignRider } = require('../services/assignment.service');

// ─────────────────────────────────────────────
// Admin: list users with KYC pending review (optionally by role)
// ─────────────────────────────────────────────
exports.listPending = async (req, res, next) => {
  try {
    const { role } = req.query;

    const users = await prisma.user.findMany({
      where: {
        role: role ? role : { in: ['VENDOR', 'RIDER'] },
        kycStatus: 'PENDING',
      },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true, name: true, phone: true, role: true, vendorStatus: true, kycStatus: true,
        cnicFront: true, cnicBack: true, selfieUrl: true,
        zone: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, users });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: view one user's submitted KYC documents
// ─────────────────────────────────────────────
exports.getSubmission = async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: ['VENDOR', 'RIDER'] } },
      select: {
        id: true, name: true, phone: true, role: true, vendorStatus: true, kycStatus: true,
        cnicFront: true, cnicBack: true, selfieUrl: true,
      },
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: approve KYC
// ─────────────────────────────────────────────
exports.approve = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: ['VENDOR', 'RIDER'] } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (existing.kycStatus !== 'PENDING') {
      return res.status(409).json({
        success: false,
        message: `Cannot approve KYC with status ${existing.kycStatus}`,
      });
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { kycStatus: 'APPROVED' },
      select: { id: true, name: true, phone: true, role: true, kycStatus: true, zoneId: true, vendorStatus: true },
    });

    if (user.phone) sendKycApprovedSms(user.phone);

    // KYC approval is the actual moment a vendor/rider becomes fully order-
    // eligible (vendorStatus alone isn't enough — see requireApprovedVendor/
    // requireApprovedRider). Mirrors updateStorefront's and toggleOnline's
    // sweep: orders that never got offered to anyone because no one was
    // eligible in the zone yet otherwise sit stuck forever, since
    // reassignIfExpired only re-checks offers that were made and expired.
    if (user.vendorStatus === 'APPROVED' && user.zoneId) {
      if (user.role === 'VENDOR') {
        const orphaned = await prisma.order.findMany({
          where: { zoneId: user.zoneId, status: 'PENDING', vendorId: null, offeredVendorId: null },
          select: { id: true },
        });
        for (const order of orphaned) {
          await tryAssignVendor(order.id);
        }
      } else if (user.role === 'RIDER') {
        const orphaned = await prisma.order.findMany({
          where: {
            zoneId: user.zoneId, status: 'ASSIGNED', vendorId: { not: null }, riderId: null, fulfillmentType: 'DELIVERY',
          },
          include: { items: { include: { product: true } } },
        });
        for (const order of orphaned) {
          if (needsRider(order)) await tryAssignRider(order.id);
        }
      }
    }

    res.json({ success: true, message: 'KYC approved', user });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: reject KYC
// (reuses rejectedReason — no dedicated KYC-reason field in schema)
// ─────────────────────────────────────────────
exports.reject = async (req, res, next) => {
  try {
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, role: { in: ['VENDOR', 'RIDER'] } },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (existing.kycStatus !== 'PENDING') {
      return res.status(409).json({
        success: false,
        message: `Cannot reject KYC with status ${existing.kycStatus}`,
      });
    }

    const { reason } = req.body;
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { kycStatus: 'REJECTED', rejectedReason: reason || 'KYC documents rejected' },
      select: { id: true, name: true, phone: true, role: true, kycStatus: true, rejectedReason: true },
    });

    if (user.phone) sendKycRejectedSms(user.phone, reason);

    res.json({ success: true, message: 'KYC rejected', user });
  } catch (err) {
    next(err);
  }
};
