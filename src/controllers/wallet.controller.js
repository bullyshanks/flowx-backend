// ═══════════════════════════════════════════════════════════
//  Vendor Wallet Controller
//  Balance summary, transactions, settlement history (own account)
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { getVendorWalletSummary, getRiderWalletSummary } = require('../services/ledger.service');

// ─────────────────────────────────────────────
// GET /api/vendors/wallet — balance summary
// ─────────────────────────────────────────────
exports.getWallet = async (req, res, next) => {
  try {
    const summary = await getVendorWalletSummary(req.user.id);
    res.json({
      success: true,
      wallet: {
        ...summary,
        codLiability: Number(req.user.codLiability),
        codLimit: req.user.codLimit != null ? Number(req.user.codLimit) : null,
        isFrozen: req.user.isFrozen,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/vendors/wallet/transactions — paginated ledger
// ─────────────────────────────────────────────
exports.getTransactions = async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: { vendorId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
        include: { order: { select: { orderNumber: true, paymentMethod: true } } },
      }),
      prisma.ledgerEntry.count({ where: { vendorId: req.user.id } }),
    ]);

    res.json({ success: true, transactions: entries, total });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/vendors/wallet/settlements — settlement history
// ─────────────────────────────────────────────
exports.getSettlements = async (req, res, next) => {
  try {
    const settlements = await prisma.settlement.findMany({
      where: { vendorId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, settlements });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/riders/wallet — balance summary (mirrors vendor's getWallet)
// ─────────────────────────────────────────────
exports.getRiderWallet = async (req, res, next) => {
  try {
    const summary = await getRiderWalletSummary(req.user.id);
    res.json({
      success: true,
      wallet: {
        ...summary,
        codLiability: Number(req.user.codLiability),
        codLimit: req.user.codLimit != null ? Number(req.user.codLimit) : null,
        isFrozen: req.user.isFrozen,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/riders/wallet/transactions — paginated ledger
// ─────────────────────────────────────────────
exports.getRiderTransactions = async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const [entries, total] = await Promise.all([
      prisma.riderLedgerEntry.findMany({
        where: { riderId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
        include: { order: { select: { orderNumber: true, paymentMethod: true } } },
      }),
      prisma.riderLedgerEntry.count({ where: { riderId: req.user.id } }),
    ]);

    res.json({ success: true, transactions: entries, total });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /api/riders/wallet/settlements — settlement history
// ─────────────────────────────────────────────
exports.getRiderSettlements = async (req, res, next) => {
  try {
    const settlements = await prisma.riderSettlement.findMany({
      where: { riderId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, settlements });
  } catch (err) {
    next(err);
  }
};
