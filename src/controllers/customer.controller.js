// ═══════════════════════════════════════════════════════════
//  Customer Controller — referral info (code, wallet, history)
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');

// ─────────────────────────────────────────────
// GET /customer/referral
// ─────────────────────────────────────────────
exports.getReferral = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { referralCode: true, walletBalance: true },
    });

    const referralsCount = await prisma.referral.count({ where: { referrerId: req.user.id } });
    const creditedCount = await prisma.referral.count({ where: { referrerId: req.user.id, status: 'CREDITED' } });

    res.json({
      success: true,
      referralCode: user.referralCode,
      walletBalance: user.walletBalance,
      referralsCount,
      creditedCount,
    });
  } catch (err) {
    next(err);
  }
};
