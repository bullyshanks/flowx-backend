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
      select: { id: true, name: true, phone: true, role: true, vendorStatus: true, zoneId: true, isVerified: true, codLimit: true, codLiability: true, isFrozen: true },
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
 * Vendor-specific — must also be APPROVED
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
  next();
};

module.exports = { requireAuth, requireRole, requireApprovedVendor };
