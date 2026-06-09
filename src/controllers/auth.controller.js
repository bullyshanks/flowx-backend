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

    // Vendor must be approved before login
    if (user.role === 'VENDOR' && user.vendorStatus !== 'APPROVED') {
      return res.status(403).json({
        success: false,
        message: `Vendor account status: ${user.vendorStatus}. Awaiting approval.`,
      });
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
        vendorStatus: true, isVerified: true, defaultAddress: true,
        zone: { select: { id: true, name: true } },
      },
    });
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
};
