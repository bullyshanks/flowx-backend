// ═══════════════════════════════════════════════════════════
//  Authentication Controller
//  Handles register, login, OTP for both customers and vendors
// ═══════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const { signToken } = require('../utils/jwt');
const { generateOtp, generateReferralCode } = require('../utils/generators');
const { sendOtpSms } = require('../services/sms.service');

// A guest order never gets a customerId — it's just guestName/guestPhone on
// the order row, no User involved. If that same person later registers or
// logs in with the same phone, their past guest orders would otherwise stay
// permanently invisible in their own order history (myOrders only matches
// customerId). Link them in, matching the shape of an order placed while
// logged in (guest fields cleared, deliveryAddress is already authoritative).
async function backfillGuestOrders(phone, customerId) {
  await prisma.order.updateMany({
    where: { customerId: null, guestPhone: phone },
    data: { customerId, guestName: null, guestPhone: null, guestAddress: null },
  });
}

// Every customer gets their own shareable code (retried on the astronomically
// rare unique clash). If they signed up with a friend's code, link the
// referral — PENDING until their first order is delivered, see
// order.controller's DELIVERED handler for the actual crediting. Referral
// failures must never block signup: invalid code, self-referral, an already-
// referred phone re-registering — all just silently skipped, never an error.
async function setupReferral(userId, referralCode) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await prisma.user.update({ where: { id: userId }, data: { referralCode: generateReferralCode() } });
      break;
    } catch (err) {
      if (err.code !== 'P2002') throw err; // unique clash on referralCode — retry with a new one
    }
  }

  if (!referralCode || !String(referralCode).trim()) return;
  const code = String(referralCode).trim().toUpperCase();

  const referrer = await prisma.user.findUnique({ where: { referralCode: code } });
  if (!referrer || referrer.id === userId || referrer.role !== 'CUSTOMER') return;

  try {
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { referredById: referrer.id } }),
      prisma.referral.create({ data: { referrerId: referrer.id, refereeId: userId } }),
    ]);
  } catch (err) {
    if (err.code !== 'P2002') throw err; // refereeId already has a referral row — ignore
  }
}

// Account approval gates login itself (as in v1). KYC approval gates "going
// live" — accepting/managing orders — enforced separately by
// requireApprovedVendor/requireApprovedRider, not here. Gating login on KYC
// too would be circular: KYC submission itself requires a JWT, so a
// vendor/rider with an approved account but no KYC yet would have no way to
// log in and reach the KYC endpoint.
//
// Shared by both login paths on purpose — this check used to live inline in
// password login only, which let a suspended vendor sidestep it entirely by
// logging in through OTP instead. Returns the rejection message, or null when
// the account is clear to hold a session.
function accountBlockedMessage(user) {
  if (user.role !== 'VENDOR' && user.role !== 'RIDER') return null;
  if (user.vendorStatus === 'APPROVED') return null;

  const label = user.role === 'VENDOR' ? 'Vendor' : 'Rider';
  if (user.vendorStatus === 'REJECTED') {
    return `${label} application rejected${user.rejectedReason ? `: ${user.rejectedReason}` : ''}.`;
  }
  if (user.vendorStatus === 'SUSPENDED') {
    return `${label} account suspended. Contact FlowX admin.`;
  }
  return `${label} account status: ${user.vendorStatus}. Awaiting approval.`;
}

// The user shape every login path returns. vendorStatus/kycStatus matter to
// the frontend's portal guards (vendor-portal/rider-portal layouts read them
// straight off the persisted auth store) — omitting them, as OTP login used
// to, left those guards comparing against undefined and bouncing approved
// vendors back out of their own portal.
const sessionUser = (user) => ({
  id: user.id,
  name: user.name,
  phone: user.phone,
  role: user.role,
  vendorStatus: user.vendorStatus,
  kycStatus: user.kycStatus,
});

const PK_PHONE_REGEX = /^(\+92|0)?3\d{9}$/;

// ─────────────────────────────────────────────
// Register a customer (with optional password)
// ─────────────────────────────────────────────
exports.registerCustomer = async (req, res, next) => {
  try {
    const { name, phone, email, password, zoneId, defaultAddress, referralCode } = req.body;

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

    await setupReferral(user.id, referralCode);

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

    if (!name || !String(name).trim() || !phone || !password || !zoneId) {
      return res.status(400).json({ success: false, message: 'Name, phone, password, and zone are required' });
    }
    if (!PK_PHONE_REGEX.test(String(phone).replace(/\s|-/g, ''))) {
      return res.status(400).json({ success: false, message: 'A valid Pakistani phone number is required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
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
        name: String(name).trim(),
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

    if (!name || !String(name).trim() || !phone || !password || !zoneId) {
      return res.status(400).json({ success: false, message: 'Name, phone, password, and zone are required' });
    }
    if (!PK_PHONE_REGEX.test(String(phone).replace(/\s|-/g, ''))) {
      return res.status(400).json({ success: false, message: 'A valid Pakistani phone number is required' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
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
        name: String(name).trim(),
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
    const { phone, code, purpose = 'login', referralCode } = req.body;
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
      await setupReferral(user.id, referralCode);
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { isVerified: true },
      });
    }

    const blocked = accountBlockedMessage(user);
    if (blocked) return res.status(403).json({ success: false, message: blocked });

    if (user.role === 'CUSTOMER') await backfillGuestOrders(phone, user.id);

    const token = signToken({ id: user.id, role: user.role });

    res.json({
      success: true,
      message: 'OTP verified',
      token,
      user: sessionUser(user),
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

    const blocked = accountBlockedMessage(user);
    if (blocked) return res.status(403).json({ success: false, message: blocked });

    if (user.role === 'CUSTOMER') await backfillGuestOrders(user.phone, user.id);

    const token = signToken({ id: user.id, role: user.role });

    res.json({
      success: true,
      token,
      user: sessionUser(user),
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

// ─────────────────────────────────────────────
// Update current user's own profile (name, email, address — self-service
// only; role-gated fields like vendorStatus go through admin endpoints)
// ─────────────────────────────────────────────
exports.updateMe = async (req, res, next) => {
  try {
    const { name, email, defaultAddress } = req.body;
    const data = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'name must be a non-empty string' });
      }
      data.name = name.trim();
    }
    if (email !== undefined) {
      data.email = email === null || email === '' ? null : String(email).trim();
    }
    if (defaultAddress !== undefined) {
      data.defaultAddress = defaultAddress === null || defaultAddress === '' ? null : String(defaultAddress).trim();
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: { id: true, name: true, phone: true, email: true, role: true, defaultAddress: true },
    });
    res.json({ success: true, user });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ success: false, message: 'That email is already in use' });
    }
    next(err);
  }
};
