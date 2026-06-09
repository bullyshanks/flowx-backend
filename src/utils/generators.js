// ── Generate a unique order number like FLW-2026-00042 ──
const generateOrderNumber = () => {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000); // 5-digit random
  return `FLW-${year}-${random}`;
};

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

module.exports = { generateOrderNumber, generateOtp };
