// ═══════════════════════════════════════════════════════════
//  KYC Review Controller (admin)
//  Shared across VENDOR and RIDER — KYC is one identity-verification
//  gate independent of each role's own account-approval status.
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');

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
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { kycStatus: 'APPROVED' },
      select: { id: true, name: true, role: true, kycStatus: true },
    });
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
    const { reason } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { kycStatus: 'REJECTED', rejectedReason: reason || 'KYC documents rejected' },
      select: { id: true, name: true, role: true, kycStatus: true, rejectedReason: true },
    });
    res.json({ success: true, message: 'KYC rejected', user });
  } catch (err) {
    next(err);
  }
};
