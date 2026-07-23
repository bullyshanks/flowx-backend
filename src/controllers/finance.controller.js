// ═══════════════════════════════════════════════════════════
//  Admin Finance Controller
//  Commission settings, product rates, vendor wallets,
//  COD limits, freeze, settlements
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { getVendorWalletSummary, getRiderWalletSummary, round2 } = require('../services/ledger.service');

// Current week: Monday 00:00 → next Monday 00:00
function currentWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun
  const diffToMonday = day === 0 ? 6 : day - 1;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

/**
 * Sum a vendor's ledger entries for a settlement period.
 * netPayable: product value is excluded only when the VENDOR physically held
 * the COD cash (self-pickup) — for delivery COD orders the rider held the
 * cash instead, so the vendor is still owed the full product value here.
 * A self-pickup-COD-heavy period can still come out negative — vendor owes
 * FlowX the commission on cash they collected themselves.
 */
function computePeriodTotals(entries) {
  let totalProductValue = 0;
  let totalRiderEarning = 0; // always 0 post rider-as-role split; kept for API shape
  let totalCommission = 0;
  let netPayable = 0;

  for (const e of entries) {
    const amount = Number(e.amount);
    const vendorHeldCash = e.order?.paymentMethod === 'COD' && e.order?.fulfillmentType === 'SELF_PICKUP';
    if (e.type === 'PRODUCT_VALUE') {
      totalProductValue += amount;
      if (!vendorHeldCash) netPayable += amount;
    } else if (e.type === 'RIDER_EARNING') {
      // No longer created on the vendor ledger — retained for older rows only.
      totalRiderEarning += amount;
      netPayable += amount;
    } else if (e.type === 'COMMISSION_DEDUCTED') {
      totalCommission += -amount;
      netPayable += amount;
    } else {
      // REFUND / ADJUSTMENT — signed, applied directly
      netPayable += amount;
    }
  }

  return {
    totalProductValue: round2(totalProductValue),
    totalRiderEarning: round2(totalRiderEarning),
    totalCommission: round2(totalCommission),
    netPayable: round2(netPayable),
  };
}

// Ledger entries for a period, grouped by vendor (settlement payouts excluded)
async function unsettledEntriesByVendor(periodStart, periodEnd) {
  const entries = await prisma.ledgerEntry.findMany({
    where: {
      createdAt: { gte: periodStart, lt: periodEnd },
      type: { not: 'SETTLEMENT_PAYOUT' },
    },
    include: { order: { select: { paymentMethod: true, fulfillmentType: true } } },
  });

  const byVendor = new Map();
  for (const e of entries) {
    if (!byVendor.has(e.vendorId)) byVendor.set(e.vendorId, []);
    byVendor.get(e.vendorId).push(e);
  }

  // Drop vendors already settled for an overlapping period
  const settled = await prisma.settlement.findMany({
    where: {
      vendorId: { in: [...byVendor.keys()] },
      periodStart: { lt: periodEnd },
      periodEnd: { gt: periodStart },
    },
    select: { vendorId: true },
  });
  for (const s of settled) byVendor.delete(s.vendorId);

  return byVendor;
}

// ─────────────────────────────────────────────
// Commission settings
// ─────────────────────────────────────────────
exports.getCommissionSettings = async (req, res, next) => {
  try {
    let settings = await prisma.commissionSettings.findFirst();
    if (!settings) {
      settings = await prisma.commissionSettings.create({ data: { defaultCommissionPct: 20 } });
    }
    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
};

exports.updateCommissionSettings = async (req, res, next) => {
  try {
    const { defaultCommissionPct } = req.body;
    const pct = Number(defaultCommissionPct);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ success: false, message: 'defaultCommissionPct must be between 0 and 100' });
    }

    let settings = await prisma.commissionSettings.findFirst();
    settings = settings
      ? await prisma.commissionSettings.update({ where: { id: settings.id }, data: { defaultCommissionPct: pct } })
      : await prisma.commissionSettings.create({ data: { defaultCommissionPct: pct } });

    res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// PATCH /products/:id/rates
// ─────────────────────────────────────────────
exports.updateProductRates = async (req, res, next) => {
  try {
    const { commissionPct, riderEarningPerUnit } = req.body;
    const data = {};

    if (commissionPct !== undefined) {
      if (commissionPct === null) {
        data.commissionPct = null; // revert to global default
      } else {
        const pct = Number(commissionPct);
        if (Number.isNaN(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ success: false, message: 'commissionPct must be between 0 and 100 (or null)' });
        }
        data.commissionPct = pct;
      }
    }
    if (riderEarningPerUnit !== undefined) {
      const amount = Number(riderEarningPerUnit);
      if (Number.isNaN(amount) || amount < 0) {
        return res.status(400).json({ success: false, message: 'riderEarningPerUnit must be >= 0' });
      }
      data.riderEarningPerUnit = amount;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const product = await prisma.product.update({ where: { id: req.params.id }, data });
    res.json({ success: true, product });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /vendors/:id/wallet
// ─────────────────────────────────────────────
exports.getVendorWallet = async (req, res, next) => {
  try {
    const vendor = await prisma.user.findFirst({
      where: { id: req.params.id, role: 'VENDOR' },
      select: {
        id: true, name: true, phone: true, vendorStatus: true,
        codLimit: true, codLiability: true, isFrozen: true,
        zone: { select: { name: true } },
      },
    });
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    const { limit = 20, offset = 0 } = req.query;
    const [summary, entries, total] = await Promise.all([
      getVendorWalletSummary(vendor.id),
      prisma.ledgerEntry.findMany({
        where: { vendorId: vendor.id },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
        include: { order: { select: { orderNumber: true, paymentMethod: true } } },
      }),
      prisma.ledgerEntry.count({ where: { vendorId: vendor.id } }),
    ]);

    res.json({
      success: true,
      vendor,
      wallet: {
        ...summary,
        codLiability: Number(vendor.codLiability),
        codLimit: vendor.codLimit != null ? Number(vendor.codLimit) : null,
        isFrozen: vendor.isFrozen,
      },
      transactions: entries,
      total,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /riders/:id/wallet
// ─────────────────────────────────────────────
exports.getRiderWallet = async (req, res, next) => {
  try {
    const rider = await prisma.user.findFirst({
      where: { id: req.params.id, role: 'RIDER' },
      select: {
        id: true, name: true, phone: true, vendorStatus: true, kycStatus: true, vehicleDetails: true,
        codLimit: true, codLiability: true, isFrozen: true,
        zone: { select: { name: true } },
      },
    });
    if (!rider) {
      return res.status(404).json({ success: false, message: 'Rider not found' });
    }

    const { limit = 20, offset = 0 } = req.query;
    const [summary, entries, total, settlements] = await Promise.all([
      getRiderWalletSummary(rider.id),
      prisma.riderLedgerEntry.findMany({
        where: { riderId: rider.id },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
        include: { order: { select: { orderNumber: true, paymentMethod: true } } },
      }),
      prisma.riderLedgerEntry.count({ where: { riderId: rider.id } }),
      prisma.riderSettlement.findMany({ where: { riderId: rider.id }, orderBy: { createdAt: 'desc' } }),
    ]);

    res.json({
      success: true,
      rider,
      wallet: {
        ...summary,
        codLiability: Number(rider.codLiability),
        codLimit: rider.codLimit != null ? Number(rider.codLimit) : null,
        isFrozen: rider.isFrozen,
      },
      transactions: entries,
      total,
      settlements,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// PATCH /vendors/:id/cod-limit
// ─────────────────────────────────────────────
exports.setCodLimit = async (req, res, next) => {
  try {
    const { codLimit } = req.body;
    let value = null;
    if (codLimit !== null && codLimit !== undefined && codLimit !== '') {
      value = Number(codLimit);
      if (Number.isNaN(value) || value < 0) {
        return res.status(400).json({ success: false, message: 'codLimit must be >= 0 (or null for unlimited)' });
      }
    }

    const vendor = await prisma.user.findFirst({ where: { id: req.params.id, role: 'VENDOR' } });
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    const updated = await prisma.user.update({
      where: { id: vendor.id },
      data: { codLimit: value },
      select: { id: true, name: true, codLimit: true, codLiability: true },
    });
    res.json({ success: true, vendor: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// PATCH /vendors/:id/freeze — toggle (or set via body.isFrozen)
// ─────────────────────────────────────────────
exports.toggleFreeze = async (req, res, next) => {
  try {
    const vendor = await prisma.user.findFirst({ where: { id: req.params.id, role: 'VENDOR' } });
    if (!vendor) {
      return res.status(404).json({ success: false, message: 'Vendor not found' });
    }

    const isFrozen = typeof req.body.isFrozen === 'boolean' ? req.body.isFrozen : !vendor.isFrozen;
    const updated = await prisma.user.update({
      where: { id: vendor.id },
      data: { isFrozen },
      select: { id: true, name: true, isFrozen: true },
    });
    res.json({ success: true, vendor: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /settlements/pending — unsettled balances, current week
// ─────────────────────────────────────────────
exports.pendingSettlements = async (req, res, next) => {
  try {
    const { start, end } = currentWeekRange();
    const byVendor = await unsettledEntriesByVendor(start, end);

    const vendors = await prisma.user.findMany({
      where: { id: { in: [...byVendor.keys()] } },
      select: { id: true, name: true, phone: true, codLiability: true, zone: { select: { name: true } } },
    });

    const unsettled = vendors.map((v) => ({
      vendor: v,
      period: { start, end },
      ...computePeriodTotals(byVendor.get(v.id)),
    })).filter((u) => u.totalProductValue !== 0 || u.totalRiderEarning !== 0 || u.netPayable !== 0);

    // Existing settlements awaiting approval / payment
    const awaiting = await prisma.settlement.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { createdAt: 'desc' },
      include: { vendor: { select: { id: true, name: true, phone: true } } },
    });

    res.json({ success: true, unsettled, awaiting });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /settlements/generate — { periodStart?, periodEnd? }
// ─────────────────────────────────────────────
exports.generateSettlements = async (req, res, next) => {
  try {
    const week = currentWeekRange();
    const periodStart = req.body.periodStart ? new Date(req.body.periodStart) : week.start;
    const periodEnd = req.body.periodEnd ? new Date(req.body.periodEnd) : week.end;
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodStart >= periodEnd) {
      return res.status(400).json({ success: false, message: 'Invalid period' });
    }

    const byVendor = await unsettledEntriesByVendor(periodStart, periodEnd);

    const created = [];
    for (const [vendorId, entries] of byVendor) {
      const totals = computePeriodTotals(entries);
      if (totals.totalProductValue === 0 && totals.totalRiderEarning === 0 && totals.netPayable === 0) continue;

      const settlement = await prisma.settlement.create({
        data: { vendorId, periodStart, periodEnd, ...totals },
        include: { vendor: { select: { id: true, name: true, phone: true } } },
      });
      created.push(settlement);
    }

    res.status(201).json({ success: true, message: `${created.length} settlement(s) generated`, settlements: created });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /settlements/:id/approve
// ─────────────────────────────────────────────
exports.approveSettlement = async (req, res, next) => {
  try {
    const settlement = await prisma.settlement.findUnique({ where: { id: req.params.id } });
    if (!settlement) {
      return res.status(404).json({ success: false, message: 'Settlement not found' });
    }
    if (settlement.status !== 'PENDING') {
      return res.status(409).json({ success: false, message: `Settlement is already ${settlement.status}` });
    }

    const updated = await prisma.settlement.update({
      where: { id: settlement.id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    res.json({ success: true, settlement: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /settlements/:id/pay — { paymentMethod, paymentReference }
// ─────────────────────────────────────────────
exports.paySettlement = async (req, res, next) => {
  try {
    const { paymentMethod, paymentReference } = req.body;
    if (!paymentMethod) {
      return res.status(400).json({ success: false, message: 'paymentMethod required' });
    }

    const settlement = await prisma.settlement.findUnique({ where: { id: req.params.id } });
    if (!settlement) {
      return res.status(404).json({ success: false, message: 'Settlement not found' });
    }
    if (settlement.status !== 'APPROVED') {
      return res.status(409).json({ success: false, message: `Settlement must be APPROVED first (currently ${settlement.status})` });
    }

    // COD commission covered by this settlement — the codLiability portion being cleared
    const codCommissionEntries = await prisma.ledgerEntry.findMany({
      where: {
        vendorId: settlement.vendorId,
        type: 'COMMISSION_DEDUCTED',
        createdAt: { gte: settlement.periodStart, lt: settlement.periodEnd },
        order: { paymentMethod: 'COD' },
      },
    });
    const codCommission = round2(codCommissionEntries.reduce((acc, e) => acc + -Number(e.amount), 0));

    const paid = await prisma.$transaction(async (tx) => {
      const vendor = await tx.user.findUnique({ where: { id: settlement.vendorId } });
      const liabilityCleared = Math.min(codCommission, Number(vendor.codLiability));

      if (liabilityCleared > 0) {
        await tx.user.update({
          where: { id: settlement.vendorId },
          data: { codLiability: { decrement: liabilityCleared } },
        });
      }

      await tx.ledgerEntry.create({
        data: {
          vendorId: settlement.vendorId,
          type: 'SETTLEMENT_PAYOUT',
          amount: -Number(settlement.netPayable),
          description: `Settlement ${settlement.id} paid via ${paymentMethod}${paymentReference ? ` (${paymentReference})` : ''}`,
        },
      });

      return tx.settlement.update({
        where: { id: settlement.id },
        data: { status: 'PAID', paidAt: new Date(), paymentMethod, paymentReference: paymentReference || null },
      });
    });

    res.json({ success: true, settlement: paid });
  } catch (err) {
    next(err);
  }
};
