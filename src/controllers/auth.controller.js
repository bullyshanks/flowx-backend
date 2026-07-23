// ═══════════════════════════════════════════════════════════
//  Authentication Controller
//  Handles register, login, OTP for both customers and vendors
// ═══════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { signToken } = require('../utils/jwt');
const { generateOtp } = require('../utils/generators');
const { sendOtpSms } = require('../services/sms.service');

// ─────────────────────────────────────────────
// Register a customer (with optional password)
// ─────────────────────────────────────────────
exports.registerCustomer = async (req, res, next) => {
  try {
    const { name, phone, email, password, zoneId, defaultAddress } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ success: false, message: 'Name and phone are required' });
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Phone already registered' });
    }

    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;

    const user = await prisma.user.create({
      data: {
        name,
        phone,
        email,
        password: hashedPassword,
        role: 'CUSTOMER',
        zoneId,
        defaultAddress,
        isVerified: false,
      },
    });

    // Send OTP for verification
    const code = generateOtp();
    await prisma.otp.create({
      data: {
        phone,
        code,
        purpose: 'register',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    await sendOtpSms(phone, code);

    res.status(201).json({
      success: true,
      message: 'Registered. OTP sent to your phone.',
      userId: user.id,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Register a vendor (status = PENDING)
// ─────────────────────────────────────────────
exports.registerVendor = async (req, res, next) => {
  try {
    const { name, phone, cnic, password, zoneId } = req.body;

    if (!name || !phone || !password || !zoneId) {
      return res.status(400).json({ success: false, message: 'Name, phone, password, and zone are required' });
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Phone already registered' });
    }

    const zoneExists = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zoneExists) {
      return res.status(400).json({ success: false, message: 'Invalid zone' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const vendor = await prisma.user.create({
      data: {
        name,
        phone,
        password: hashedPassword,
        cnic,
        zoneId,
        role: 'VENDOR',
        vendorStatus: 'PENDING',
        isVerified: false,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Vendor application submitted. Admin will review within 24 hours.',
      vendorId: vendor.id,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Register a rider (status = PENDING) — mirrors registerVendor.
// Account approval (vendorStatus, reused across VENDOR/RIDER) and KYC
// approval (kycStatus) are separate gates; both must be APPROVED before
// a rider can log in — see submitKyc below and login()'s check.
// ─────────────────────────────────────────────
exports.registerRider = async (req, res, next) => {
  try {
    const { name, phone, password, vehicleDetails, zoneId } = req.body;

    if (!name || !phone || !password || !zoneId) {
      return res.status(400).json({ success: false, message: 'Name, phone, password, and zone are required' });
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Phone already registered' });
    }

    const zoneExists = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zoneExists) {
      return res.status(400).json({ success: false, message: 'Invalid zone' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const rider = await prisma.user.create({
      data: {
        name,
        phone,
        password: hashedPassword,
        vehicleDetails,
        zoneId,
        role: 'RIDER',
        vendorStatus: 'PENDING', // reused as the generic account-approval status
        isVerified: false,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Rider application submitted. Admin will review within 24 hours.',
      riderId: rider.id,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Submit KYC documents (vendor or rider, own account) — separate step from
// registration. Sets kycStatus = PENDING for admin review.
//
// Storage: MVP stores documents as base64 data URIs directly on the User
// row (cnicFront/cnicBack/selfieUrl are just String columns). This avoids
// any third-party dependency but bloats the database and doesn't scale —
// flag to client: a real file store (S3, Cloudinary's free tier, etc.)
// is the correct long-term answer and is additional cost/infra to wire up.
// Swapping later just means these fields hold a URL instead of a data URI;
// no schema change required.
// ─────────────────────────────────────────────
const MAX_DATA_URI_LENGTH = 4 * 1024 * 1024; // ~4MB string (~3MB image) per file

exports.submitKyc = async (req, res, next) => {
  try {
    const { cnicFront, cnicBack, selfieUrl } = req.body;

    if (!cnicFront || !cnicBack || !selfieUrl) {
      return res.status(400).json({ success: false, message: 'CNIC front, CNIC back, and selfie are all required' });
    }

    for (const [field, value] of Object.entries({ cnicFront, cnicBack, selfieUrl })) {
      if (value.startsWith('data:') && value.length > MAX_DATA_URI_LENGTH) {
        return res.status(413).json({ success: false, message: `${field} is too large (max ~3MB image)` });
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { cnicFront, cnicBack, selfieUrl, kycStatus: 'PENDING' },
      select: { id: true, name: true, kycStatus: true },
    });

    res.json({ success: true, message: 'KYC submitted for review', user });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Send OTP (for login or verification)
// ─────────────────────────────────────────────
exports.sendOtp = async (req, res, next) => {
  try {
    const { phone, purpose = 'login' } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone is required' });
    }

    const code = generateOtp();
    await prisma.otp.create({
      data: {
        phone,
        code,
        purpose,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    await sendOtpSms(phone, code);

    res.json({ success: true, message: 'OTP sent to your phone' });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Verify OTP — returns JWT
// ─────────────────────────────────────────────
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, code, purpose = 'login' } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ success: false, message: 'Phone and code are required' });
    }

    const otp = await prisma.otp.findFirst({
      where: {
        phone,
        code,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // Mark OTP as consumed
    await prisma.otp.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    // Get or create user
    let user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      user = await prisma.user.create({
        data: { phone, name: 'FlowX User', role: 'CUSTOMER', isVerified: true },
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true },
      });
    }

    const token = signToken({ id: user.id, role: user.role });

    res.json({
      success: true,
      message: 'OTP verified',
      token,
      user: { id: user.id, name: user.name, phone: user.phone, role: user.role },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Login with phone + password (vendors & admins)
// ─────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password required' });
    }

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user || !user.password) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Account approval gates login itself (as in v1). KYC approval gates
    // "going live" — accepting/managing orders — enforced separately by
    // requireApprovedVendor/requireApprovedRider, not here. Gating login on
    // KYC too would be circular: KYC submission itself requires a JWT, so a
    // vendor/rider with an approved account but no KYC yet would have no way
    // to log in and reach the KYC endpoint.
    if (user.role === 'VENDOR' || user.role === 'RIDER') {
      const label = user.role === 'VENDOR' ? 'Vendor' : 'Rider';
      if (user.vendorStatus !== 'APPROVED') {
        return res.status(403).json({
          success: false,
          message: `${label} account status: ${user.vendorStatus}. Awaiting approval.`,
        });
      }
    }

    const token = signToken({ id: user.id, role: user.role });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        vendorStatus: user.vendorStatus,
        kycStatus: user.kycStatus,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Get current user profile (requires auth)
// ─────────────────────────────────────────────
exports.me = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, name: true, phone: true, email: true, role: true,
        vendorStatus: true, kycStatus: true, rejectedReason: true, isVerified: true, defaultAddress: true,
        vehicleDetails: true, businessName: true, shopDetails: true, isOpen: true, stockStatus: true, isOnline: true,
        codLimit: true, codLiability: true, isFrozen: true,
        zone: { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
};
