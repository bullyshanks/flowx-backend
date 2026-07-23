// ═══════════════════════════════════════════════════════════
//  Authentication & Authorization middleware
// ═══════════════════════════════════════════════════════════

const { verifyToken } = require('../utils/jwt');
const prisma = require('../config/prisma');

/**
 * Require a valid JWT — attaches req.user
 */
const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = header.split(' ')[1];
    const decoded = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true, name: true, phone: true, role: true, vendorStatus: true, zoneId: true, isVerified: true,
        codLimit: true, codLiability: true, isFrozen: true,
        kycStatus: true, isOnline: true, isOpen: true, stockStatus: true,
      },
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

/**
 * Require a specific role (or array of roles)
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden — insufficient role' });
  }
  next();
};

/**
 * Vendor-specific — must have BOTH account approval (vendorStatus) and
 * KYC approval before they can go live (accept/manage orders).
 */
const requireApprovedVendor = (req, res, next) => {
  if (req.user?.role !== 'VENDOR') {
    return res.status(403).json({ success: false, message: 'Vendor access required' });
  }
  if (req.user.vendorStatus !== 'APPROVED') {
    return res.status(403).json({
      success: false,
      message: `Vendor account status: ${req.user.vendorStatus}. Awaiting admin approval.`,
    });
  }
  if (req.user.kycStatus !== 'APPROVED') {
    return res.status(403).json({
      success: false,
      message: `KYC status: ${req.user.kycStatus}. Awaiting verification before you can go live.`,
    });
  }
  next();
};

/**
 * Rider-specific — must have BOTH account approval (vendorStatus, reused as
 * the generic approval-status field) and KYC approval before they can go live.
 */
const requireApprovedRider = (req, res, next) => {
  if (req.user?.role !== 'RIDER') {
    return res.status(403).json({ success: false, message: 'Rider access required' });
  }
  if (req.user.vendorStatus !== 'APPROVED') {
    return res.status(403).json({
      success: false,
      message: `Rider account status: ${req.user.vendorStatus}. Awaiting admin approval.`,
    });
  }
  if (req.user.kycStatus !== 'APPROVED') {
    return res.status(403).json({
      success: false,
      message: `KYC status: ${req.user.kycStatus}. Awaiting verification before you can go live.`,
    });
  }
  next();
};

module.exports = { requireAuth, requireRole, requireApprovedVendor, requireApprovedRider };
