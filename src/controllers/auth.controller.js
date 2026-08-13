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
// Who is allowed to refer whom.
//
// A customer referral can only come from another customer — that has always
// been the rule, and letting a vendor hand out customer discount codes in their
// own zone would be paying them to discount their own orders.
//
// A vendor referral can come from anyone holding a code. Vendors referring
// vendors is the point (they know the trade), but a customer who introduces
// their local water shop has done exactly as much good.
const REFERRER_ALLOWED = {
  CUSTOMER: (referrer) => referrer.role === 'CUSTOMER',
  VENDOR: (referrer) => referrer.role === 'CUSTOMER' || referrer.role === 'VENDOR',
};

async function vendorReferralReward() {
  const settings = await prisma.commissionSettings.findFirst();
  return settings ? Number(settings.vendorReferralReward) : 1000;
}

async function setupReferral(userId, referralCode, kind = 'CUSTOMER') {
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
  if (!referrer || referrer.id === userId || !REFERRER_ALLOWED[kind]?.(referrer)) return;

  // A new vendor gets orders, not a discount — the reward is one-sided, and
  // paid only once they actually deliver something (see order.controller).
  const bonus = kind === 'VENDOR' ? await vendorReferralReward() : undefined;

  try {
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { referredById: referrer.id } }),
      prisma.referral.create({
        data: {
          referrerId: referrer.id,
          refereeId: userId,
          kind,
          ...(kind === 'VENDOR' && { referrerBonus: bonus, refereeDiscount: 0 }),
        },
      }),
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
    // Password is optional for customers (OTP login always works without
    // one), but if they do set one it should meet the same floor vendors and
    // riders already have — a 1-character password was previously accepted.
    if (password && String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
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
    const { name, phone, cnic, password, zoneId, referralCode } = req.body;

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

    // Gives this vendor their own code to share, and links the one they signed
    // up with. Never allowed to fail the registration — same rule as customers.
    await setupReferral(vendor.id, referralCode, 'VENDOR');

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

// Only ever a base64 data: URI of an actual raster image — not an arbitrary
// URL. Two reasons: (1) the size cap below only fired for strings starting
// with "data:", so any other string (e.g. a bare https:// URL) bypassed size
// checking entirely, bounded only by the 15MB JSON body limit; (2) these
// values are rendered as <img src> straight into the admin KYC review UI —
// an attacker-controlled URL there is a way to beacon the admin's IP/UA and
// the exact review timestamp to an external host on every review.
const KYC_DATA_URI_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+=*$/;

exports.submitKyc = async (req, res, next) => {
  try {
    const { cnicFront, cnicBack, selfieUrl } = req.body;

    if (!cnicFront || !cnicBack || !selfieUrl) {
      return res.status(400).json({ success: false, message: 'CNIC front, CNIC back, and selfie are all required' });
    }

    for (const [field, value] of Object.entries({ cnicFront, cnicBack, selfieUrl })) {
      if (typeof value !== 'string' || !KYC_DATA_URI_RE.test(value)) {
        return res.status(400).json({ success: false, message: `${field} must be a base64-encoded PNG/JPEG/WEBP image` });
      }
      if (value.length > MAX_DATA_URI_LENGTH) {
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
//
// Two controls beyond the global IP rate limiter, both keyed on phone+purpose
// so they can't be dodged by rotating source IPs:
//   - cooldown: refuse a resend within OTP_RESEND_COOLDOWN_MS of the last one
//   - window cap: refuse beyond OTP_MAX_SENDS_PER_WINDOW sends in OTP_SEND_WINDOW_MS,
//     which also bounds how many simultaneously-valid codes can ever exist
//     for one phone number regardless of how many times send is called
// Sending a fresh code also invalidates every prior unconsumed one for that
// phone+purpose, so only the latest code is ever guessable.
// ─────────────────────────────────────────────
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_SEND_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_SENDS_PER_WINDOW = 5;
const OTP_MAX_ATTEMPTS = 5;

exports.sendOtp = async (req, res, next) => {
  try {
    const { phone, purpose = 'login' } = req.body;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone is required' });
    }

    const windowStart = new Date(Date.now() - OTP_SEND_WINDOW_MS);
    const recent = await prisma.otp.findMany({
      where: { phone, purpose, createdAt: { gt: windowStart } },
      orderBy: { createdAt: 'desc' },
      take: OTP_MAX_SENDS_PER_WINDOW,
    });

    if (recent.length > 0 && Date.now() - recent[0].createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      return res.status(429).json({ success: false, message: 'Please wait before requesting another code' });
    }
    if (recent.length >= OTP_MAX_SENDS_PER_WINDOW) {
      return res.status(429).json({ success: false, message: 'Too many codes requested. Try again later.' });
    }

    // Invalidate every still-live code for this phone+purpose so at most one
    // code is ever valid at a time — otherwise each send widens the guessable
    // space instead of replacing it.
    await prisma.otp.updateMany({
      where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date() },
    });

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
//
// Attempts are tracked on the OTP row itself: every wrong guess against the
// current live code increments `attempts`, and the code is rejected outright
// once OTP_MAX_ATTEMPTS is hit — even if the correct code is later supplied —
// forcing a fresh sendOtp call. This closes the brute-force gap where the
// `attempts` column existed in schema but nothing ever read or wrote it.
//
// ADMIN accounts cannot authenticate via OTP at all. OTP is a password-free
// channel gated only by SMS delivery to a phone number — the seeded admin
// phone is published in this repo's own docs, so allowing OTP login for
// ADMIN would make the documented default phone number a full authentication
// bypass. Admins must use password login.
// ─────────────────────────────────────────────
exports.verifyOtp = async (req, res, next) => {
  try {
    const { phone, code, purpose = 'login', referralCode } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ success: false, message: 'Phone and code are required' });
    }

    const existingUser = await prisma.user.findUnique({ where: { phone } });
    if (existingUser && existingUser.role === 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Admin accounts must sign in with a password' });
    }

    // Latest live (unconsumed, unexpired) code for this phone+purpose,
    // matched on phone+purpose only — not on the submitted code — so a wrong
    // guess still resolves to a row whose attempts counter we can increment.
    const otp = await prisma.otp.findFirst({
      where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    if (otp.code !== code) {
      await prisma.otp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    // Mark OTP as consumed
    await prisma.otp.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    // Get or create user
    let user = existingUser;
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

    const token = signToken({ id: user.id, role: user.role, tokenVersion: user.tokenVersion });

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

    const token = signToken({ id: user.id, role: user.role, tokenVersion: user.tokenVersion });

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

// ─────────────────────────────────────────────
// Invalidate every JWT previously issued to this account. Bumping
// tokenVersion makes every existing token's embedded claim stale, so the
// next request on any of them hits requireAuth's version check and is
// rejected — including the token used to make this very call, which is why
// the response can't rely on being able to make another authenticated call
// right after.
// ─────────────────────────────────────────────
exports.logoutAll = async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    res.json({ success: true, message: 'Logged out of all sessions' });
  } catch (err) {
    next(err);
  }
};
