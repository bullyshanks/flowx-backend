// Math.random() is not a CSPRNG and its state is recoverable from observed
// outputs. Order numbers are handed to any guest, referral codes are
// returned over the API, and OTP codes gate authentication itself — all
// three must come from crypto.randomInt, matching the primitive already
// used for payment references (payment.service.js).
const crypto = require('crypto');

// ── Generate a unique order number like FLW-2026-00042 ──
const generateOrderNumber = () => {
  const year = new Date().getFullYear();
  const random = crypto.randomInt(10000, 100000); // 5-digit random
  return `FLW-${year}-${random}`;
};

const generateOtp = () =>
  crypto.randomInt(100000, 1000000).toString();

// ── Short, shareable referral code, e.g. "FLW7K2Q" ──
// Not cryptographically unique on its own — callers should retry on a
// unique-constraint conflict (astronomically rare at this scale, but cheap
// to guard against — see auth.controller's referral code generation).
const REFERRAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids lookalike confusion
const generateReferralCode = () => {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += REFERRAL_CODE_CHARS[crypto.randomInt(0, REFERRAL_CODE_CHARS.length)];
  }
  return `FLW${code}`;
};

module.exports = { generateOrderNumber, generateOtp, generateReferralCode };
