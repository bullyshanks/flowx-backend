// ── Generate a unique order number like FLW-2026-00042 ──
const generateOrderNumber = () => {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000); // 5-digit random
  return `FLW-${year}-${random}`;
};

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// ── Short, shareable referral code, e.g. "FLW7K2Q" ──
// Not cryptographically unique on its own — callers should retry on a
// unique-constraint conflict (astronomically rare at this scale, but cheap
// to guard against — see auth.controller's referral code generation).
const REFERRAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids lookalike confusion
const generateReferralCode = () => {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)];
  }
  return `FLW${code}`;
};

module.exports = { generateOrderNumber, generateOtp, generateReferralCode };
