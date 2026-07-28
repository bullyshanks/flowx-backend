// ═══════════════════════════════════════════════════════════
//  Admin Finance Controller
//  Commission settings, product rates, vendor wallets,
//  COD limits, freeze, settlements
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { getVendorWalletSummary, getRiderWalletSummary, round2 } = require('../services/ledger.service');
const { unassignVendorOrders } = require('../services/assignment.service');
const {
  sendRefundPaidSms, sendRefundRejectedSms, sendVendorSettlementPaidSms, sendRiderSettlementPaidSms,
  sendAccountFrozenSms, sendAccountUnfrozenSms, sendPaymentReceivedSms,
} = require('../services/sms.service');
const {
  sendRefundPaidPush, sendRefundRejectedPush, sendVendorSettlementPaidPush, sendRiderSettlementPaidPush,
  sendAccountFrozenPush, sendAccountUnfrozenPush, sendPaymentReceivedPush,
} = require('../services/push.service');

// Settled by a signature-verified gateway callback. An admin must never set
// these by hand — see markOrderPaid.
const GATEWAY_METHODS = ['JAZZCASH', 'EASYPAISA', 'CARD'];

// Everything paid before delivery, where paymentStatus is a real record of
// whether money arrived: gateways confirm it themselves, bank transfers are
// confirmed by an admin. COD is absent on purpose — delivery is its payment
// event, tracked through the ledger, so its paymentStatus carries no meaning.
const PREPAID_METHODS = [...GATEWAY_METHODS, 'BANK_TRANSFER'];

// ─────────────────────────────────────────────
// GET /admin/finance/bank-transfers — orders awaiting bank confirmation
// ─────────────────────────────────────────────
// The reconciliation worklist: someone with a bank statement open needs to
// find the order a transfer belongs to. Unconfirmed first, since those are
// the ones needing action; cancelled orders are excluded as there is nothing
// left to confirm.
exports.listBankTransfers = async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { paymentMethod: 'BANK_TRANSFER', status: { not: 'CANCELLED' } },
      select: {
        id: true, orderNumber: true, total: true, status: true,
        paymentStatus: true, transactionId: true, createdAt: true,
        guestName: true, guestPhone: true,
        customer: { select: { name: true, phone: true } },
      },
      orderBy: [{ paymentStatus: 'asc' }, { createdAt: 'desc' }], // PAID sorts after PENDING
      take: 200,
    });

    res.json({
      success: true,
      orders: orders.map(({ customer, guestName, guestPhone, ...o }) => ({
        ...o,
        customerName: customer?.name || guestName || 'Guest',
        customerPhone: customer?.phone || guestPhone || null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /admin/finance/orders/:id/mark-paid — record an out-of-band payment
// ─────────────────────────────────────────────
// Bank transfers land in a bank account, not through any system we control,
// so nothing could ever mark them paid. They sat PENDING forever, which meant
// real revenue was invisible and legitimate refunds looked unrefundable.
// This is the human confirmation step that closes that loop.
//
// Deliberately limited to BANK_TRANSFER:
//   - Gateway methods are settled by a signature-verified callback. Letting an
//     admin assert payment by hand would bypass that authority entirely and
//     defeat the refund guard that trusts it.
//   - COD is collected at delivery and already tracked through the vendor/rider
//     ledger and codLiability. Delivery IS the payment event there; a second
//     manual flag would just be a way to disagree with the ledger.
exports.markOrderPaid = async (req, res, next) => {
  try {
    const { paymentReference, paid = true } = req.body;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (GATEWAY_METHODS.includes(order.paymentMethod)) {
      return res.status(409).json({
        success: false,
        message: `${order.paymentMethod} payments are confirmed by the gateway and cannot be set by hand`,
      });
    }
    if (order.paymentMethod !== 'BANK_TRANSFER') {
      return res.status(409).json({
        success: false,
        message: `Only bank transfers are marked paid here — ${order.paymentMethod} is collected on delivery`,
      });
    }
    if (order.status === 'CANCELLED') {
      return res.status(409).json({ success: false, message: 'Order was cancelled' });
    }

    const wantPaid = paid !== false;

    // Already in the requested state — report it and change nothing, so a
    // double-click doesn't send the customer a second "payment received".
    if ((wantPaid && order.paymentStatus === 'PAID') || (!wantPaid && order.paymentStatus !== 'PAID')) {
      return res.json({ success: true, alreadySet: true, order: { id: order.id, orderNumber: order.orderNumber, paymentStatus: order.paymentStatus } });
    }

    // Reversing is allowed because this is a human judgement about money and
    // humans mistype order numbers — but every flip is written to the order's
    // history with who did it, so the record shows the correction.
    const reference = paymentReference ? String(paymentReference).trim() : null;
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: wantPaid ? 'PAID' : 'PENDING',
        transactionId: wantPaid ? (reference || order.transactionId) : null,
        statusHistory: {
          create: {
            status: order.status,
            changedBy: req.user.id,
            notes: wantPaid
              ? `Bank transfer confirmed by admin${reference ? ` (ref ${reference})` : ''}`
              : 'Bank transfer confirmation reversed by admin',
          },
        },
      },
      select: { id: true, orderNumber: true, total: true, paymentStatus: true, customerId: true, guestPhone: true, customer: { select: { phone: true } } },
    });

    if (wantPaid) {
      const phone = updated.guestPhone || updated.customer?.phone;
      if (phone) sendPaymentReceivedSms(phone, updated.orderNumber, updated.total);
      if (updated.customerId) sendPaymentReceivedPush(updated.customerId, updated.orderNumber, updated.total);
    }

    const { customerId, guestPhone, customer, ...safe } = updated;
    res.json({ success: true, order: safe });
  } catch (err) {
    next(err);
  }
};

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

/**
 * Sum a rider's ledger entries for a settlement period. Riders don't pay
 * commission — their earning (flat riderEarningPerUnit per delivery) is
 * owed regardless of who ends up holding the COD cash, so unlike vendors
 * there's no COD carve-out here. Cash a rider collected on a COD delivery
 * is tracked separately via codLiability (incremented directly at delivery,
 * not through a ledger entry), so it isn't part of this period-totals calc —
 * see payRiderSettlement, which clears it directly from delivered COD orders.
 */
function computeRiderPeriodTotals(entries) {
  let totalEarning = 0;
  let netPayable = 0;

  for (const e of entries) {
    const amount = Number(e.amount);
    if (e.type === 'RIDER_EARNING') {
      totalEarning += amount;
      netPayable += amount;
    } else {
      // REFUND / ADJUSTMENT — signed, applied directly
      netPayable += amount;
    }
  }

  return {
    totalEarning: round2(totalEarning),
    netPayable: round2(netPayable),
  };
}

// RiderLedgerEntry rows for a period, grouped by rider (settlement payouts excluded)
async function unsettledEntriesByRider(periodStart, periodEnd) {
  const entries = await prisma.riderLedgerEntry.findMany({
    where: {
      createdAt: { gte: periodStart, lt: periodEnd },
      type: { not: 'SETTLEMENT_PAYOUT' },
    },
  });

  const byRider = new Map();
  for (const e of entries) {
    if (!byRider.has(e.riderId)) byRider.set(e.riderId, []);
    byRider.get(e.riderId).push(e);
  }

  // Drop riders already settled for an overlapping period
  const settled = await prisma.riderSettlement.findMany({
    where: {
      riderId: { in: [...byRider.keys()] },
      periodStart: { lt: periodEnd },
      periodEnd: { gt: periodStart },
    },
    select: { riderId: true },
  });
  for (const s of settled) byRider.delete(s.riderId);

  return byRider;
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
      select: { id: true, name: true, phone: true, isFrozen: true },
    });

    if (isFrozen) sendAccountFrozenPush(updated.id);
    else sendAccountUnfrozenPush(updated.id);

    if (updated.phone) {
      if (isFrozen) sendAccountFrozenSms(updated.phone);
      else sendAccountUnfrozenSms(updated.phone);
    }

    // Financial hold and delivery capability are separate concerns — a frozen
    // vendor shouldn't be able to hold a customer's order hostage. Mirrors
    // vendor.controller.toggleSuspend.
    if (isFrozen) await unassignVendorOrders(updated.id, 'frozen');

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

    // A negative netPayable means the vendor owed FlowX (COD case), not a
    // payout — nothing to congratulate them on, so no SMS in that case.
    if (Number(settlement.netPayable) > 0) {
      sendVendorSettlementPaidPush(settlement.vendorId, settlement.netPayable);
      const vendor = await prisma.user.findUnique({ where: { id: settlement.vendorId }, select: { phone: true } });
      if (vendor?.phone) sendVendorSettlementPaidSms(vendor.phone, settlement.netPayable);
    }

    res.json({ success: true, settlement: paid });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /riders/settlements/pending — unsettled balances, current week
// ─────────────────────────────────────────────
exports.pendingRiderSettlements = async (req, res, next) => {
  try {
    const { start, end } = currentWeekRange();
    const byRider = await unsettledEntriesByRider(start, end);

    const riders = await prisma.user.findMany({
      where: { id: { in: [...byRider.keys()] } },
      select: { id: true, name: true, phone: true, codLiability: true, zone: { select: { name: true } } },
    });

    const unsettled = riders.map((r) => ({
      rider: r,
      period: { start, end },
      ...computeRiderPeriodTotals(byRider.get(r.id)),
    })).filter((u) => u.totalEarning !== 0 || u.netPayable !== 0);

    // Existing settlements awaiting approval / payment
    const awaiting = await prisma.riderSettlement.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { createdAt: 'desc' },
      include: { rider: { select: { id: true, name: true, phone: true } } },
    });

    res.json({ success: true, unsettled, awaiting });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /riders/settlements/generate — { periodStart?, periodEnd? }
// ─────────────────────────────────────────────
exports.generateRiderSettlements = async (req, res, next) => {
  try {
    const week = currentWeekRange();
    const periodStart = req.body.periodStart ? new Date(req.body.periodStart) : week.start;
    const periodEnd = req.body.periodEnd ? new Date(req.body.periodEnd) : week.end;
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime()) || periodStart >= periodEnd) {
      return res.status(400).json({ success: false, message: 'Invalid period' });
    }

    const byRider = await unsettledEntriesByRider(periodStart, periodEnd);

    const created = [];
    for (const [riderId, entries] of byRider) {
      const totals = computeRiderPeriodTotals(entries);
      if (totals.totalEarning === 0 && totals.netPayable === 0) continue;

      const settlement = await prisma.riderSettlement.create({
        data: { riderId, periodStart, periodEnd, ...totals },
        include: { rider: { select: { id: true, name: true, phone: true } } },
      });
      created.push(settlement);
    }

    res.status(201).json({ success: true, message: `${created.length} settlement(s) generated`, settlements: created });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /riders/settlements/:id/approve
// ─────────────────────────────────────────────
exports.approveRiderSettlement = async (req, res, next) => {
  try {
    const settlement = await prisma.riderSettlement.findUnique({ where: { id: req.params.id } });
    if (!settlement) {
      return res.status(404).json({ success: false, message: 'Settlement not found' });
    }
    if (settlement.status !== 'PENDING') {
      return res.status(409).json({ success: false, message: `Settlement is already ${settlement.status}` });
    }

    const updated = await prisma.riderSettlement.update({
      where: { id: settlement.id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    res.json({ success: true, settlement: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /riders/settlements/:id/pay — { paymentMethod, paymentReference }
// ─────────────────────────────────────────────
exports.payRiderSettlement = async (req, res, next) => {
  try {
    const { paymentMethod, paymentReference } = req.body;
    if (!paymentMethod) {
      return res.status(400).json({ success: false, message: 'paymentMethod required' });
    }

    const settlement = await prisma.riderSettlement.findUnique({ where: { id: req.params.id } });
    if (!settlement) {
      return res.status(404).json({ success: false, message: 'Settlement not found' });
    }
    if (settlement.status !== 'APPROVED') {
      return res.status(409).json({ success: false, message: `Settlement must be APPROVED first (currently ${settlement.status})` });
    }

    // COD cash the rider collected this period — this is exactly what codLiability
    // was incremented by at delivery time (see ledger.service.createDeliveryLedgerEntries),
    // so paying the rider out settles that debt too.
    const codDeliveries = await prisma.order.findMany({
      where: {
        riderId: settlement.riderId,
        paymentMethod: 'COD',
        fulfillmentType: 'DELIVERY',
        deliveredAt: { gte: settlement.periodStart, lt: settlement.periodEnd },
      },
      select: { subtotal: true },
    });
    const codCollected = round2(codDeliveries.reduce((acc, o) => acc + Number(o.subtotal), 0));

    const paid = await prisma.$transaction(async (tx) => {
      const rider = await tx.user.findUnique({ where: { id: settlement.riderId } });
      const liabilityCleared = Math.min(codCollected, Number(rider.codLiability));

      if (liabilityCleared > 0) {
        await tx.user.update({
          where: { id: settlement.riderId },
          data: { codLiability: { decrement: liabilityCleared } },
        });
      }

      await tx.riderLedgerEntry.create({
        data: {
          riderId: settlement.riderId,
          type: 'SETTLEMENT_PAYOUT',
          amount: -Number(settlement.netPayable),
          description: `Settlement ${settlement.id} paid via ${paymentMethod}${paymentReference ? ` (${paymentReference})` : ''}`,
        },
      });

      return tx.riderSettlement.update({
        where: { id: settlement.id },
        data: { status: 'PAID', paidAt: new Date(), paymentMethod, paymentReference: paymentReference || null },
      });
    });

    if (Number(settlement.netPayable) > 0) {
      sendRiderSettlementPaidPush(settlement.riderId, settlement.netPayable);
      const rider = await prisma.user.findUnique({ where: { id: settlement.riderId }, select: { phone: true } });
      if (rider?.phone) sendRiderSettlementPaidSms(rider.phone, settlement.netPayable);
    }

    res.json({ success: true, settlement: paid });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Refunds — admin-initiated. No payment gateway exists, so "paying" a
// refund is the same manual method+reference record as Settlement pay.
// Clawback (deducting the vendor's/rider's ledger for this order) is an
// explicit choice at approval time, not automatic — whether the vendor,
// the rider, or FlowX eats the cost is a business judgment call the admin
// makes per-refund (customer changed their mind vs. vendor sent a bad
// product are very different cases).
// ─────────────────────────────────────────────

// What a vendor/rider actually received for this order — the ceiling on
// what can be clawed back from each of them. Must subtract clawbacks already
// reserved/taken by other refunds on the same order (APPROVED reserves the
// amount, PAID has already moved it), or approving multiple refunds on one
// order lets each claw back the full original amount independently.
async function orderClawbackCeilings(orderId) {
  const [vendorEntries, riderEntries, otherRefunds] = await Promise.all([
    prisma.ledgerEntry.findMany({ where: { orderId, type: 'PRODUCT_VALUE' } }),
    prisma.riderLedgerEntry.findMany({ where: { orderId, type: 'RIDER_EARNING' } }),
    prisma.refund.findMany({
      where: { orderId, status: { in: ['APPROVED', 'PAID'] } },
      select: { vendorClawbackAmount: true, riderClawbackAmount: true },
    }),
  ]);
  const vendorEarned = vendorEntries.reduce((acc, e) => acc + Number(e.amount), 0);
  const riderEarned = riderEntries.reduce((acc, e) => acc + Number(e.amount), 0);
  const vendorReserved = otherRefunds.reduce((acc, r) => acc + Number(r.vendorClawbackAmount || 0), 0);
  const riderReserved = otherRefunds.reduce((acc, r) => acc + Number(r.riderClawbackAmount || 0), 0);
  return {
    vendorCeiling: Math.max(0, round2(vendorEarned - vendorReserved)),
    riderCeiling: Math.max(0, round2(riderEarned - riderReserved)),
  };
}

// ─────────────────────────────────────────────
// GET /refunds — { status? }
// ─────────────────────────────────────────────
exports.listRefunds = async (req, res, next) => {
  try {
    const { status } = req.query;
    const refunds = await prisma.refund.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { orderNumber: true, total: true, status: true, vendorId: true, riderId: true } },
        customer: { select: { id: true, name: true, phone: true } },
      },
    });
    res.json({ success: true, refunds });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /refunds — { orderNumber, amount, reason }
// ─────────────────────────────────────────────
exports.createRefund = async (req, res, next) => {
  try {
    const { orderNumber, amount, reason } = req.body;
    if (!orderNumber) {
      return res.status(400).json({ success: false, message: 'orderNumber required' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: 'reason required' });
    }

    const order = await prisma.order.findUnique({ where: { orderNumber } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    // Nothing to refund until money has actually been collected (DELIVERED)
    // or the order is CANCELLED (a prepaid order that never got fulfilled).
    // Anything still in progress has no confirmed payment to refund yet.
    if (order.status !== 'DELIVERED' && order.status !== 'CANCELLED') {
      return res.status(409).json({
        success: false,
        message: `Cannot refund an order with status ${order.status} — must be DELIVERED or CANCELLED`,
      });
    }
    // COD cash is only ever collected at delivery (see createDeliveryLedgerEntries,
    // which only fires on the DELIVERED transition) — DELIVERED and CANCELLED are
    // mutually exclusive terminal states, so a CANCELLED COD order is guaranteed
    // to have never had any cash collected. Nothing to refund.
    if (order.paymentMethod === 'COD' && order.status === 'CANCELLED') {
      return res.status(409).json({
        success: false,
        message: 'Cannot refund a cancelled COD order — no cash was ever collected',
      });
    }

    // Refunding an order that was never paid pays out cash we never took.
    // paymentStatus is now trustworthy for both prepaid routes: gateways set
    // it from a signature-verified callback, and bank transfers are confirmed
    // by an admin through markOrderPaid. COD is excluded — it has no such
    // marker, since delivery is the payment event and the ledger tracks it.
    if (PREPAID_METHODS.includes(order.paymentMethod) && order.paymentStatus !== 'PAID') {
      return res.status(409).json({
        success: false,
        message: `Cannot refund this order — payment via ${order.paymentMethod} was never completed (status: ${order.paymentStatus}). Nothing was collected.`,
      });
    }

    const value = Number(amount);
    if (Number.isNaN(value) || value <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a number > 0' });
    }

    // Cap against the order's remaining refundable balance, not just its
    // total — otherwise multiple refunds can each go up to the full total.
    const existingRefunds = await prisma.refund.findMany({
      where: { orderId: order.id, status: { in: ['PENDING', 'APPROVED', 'PAID'] } },
      select: { amount: true },
    });
    const alreadyRequested = existingRefunds.reduce((acc, r) => acc + Number(r.amount), 0);
    const remaining = round2(Number(order.total) - alreadyRequested);
    if (value > remaining) {
      return res.status(400).json({
        success: false,
        message: `amount cannot exceed the remaining refundable balance (Rs. ${remaining})`,
      });
    }

    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        customerId: order.customerId,
        amount: value,
        reason: String(reason).trim(),
      },
      include: { order: { select: { orderNumber: true, total: true } } },
    });

    res.status(201).json({ success: true, refund });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /refunds/:id/approve — { clawbackVendor?: boolean, clawbackRider?: boolean }
// ─────────────────────────────────────────────
exports.approveRefund = async (req, res, next) => {
  try {
    const refund = await prisma.refund.findUnique({ where: { id: req.params.id } });
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found' });
    }
    if (refund.status !== 'PENDING') {
      return res.status(409).json({ success: false, message: `Refund is already ${refund.status}` });
    }

    const clawbackVendor = req.body.clawbackVendor === true;
    const clawbackRider = req.body.clawbackRider === true;
    const { vendorCeiling, riderCeiling } = await orderClawbackCeilings(refund.orderId);

    const updated = await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        clawbackVendor,
        clawbackRider,
        vendorClawbackAmount: clawbackVendor ? Math.min(vendorCeiling, Number(refund.amount)) : null,
        riderClawbackAmount: clawbackRider ? Math.min(riderCeiling, Number(refund.amount)) : null,
      },
    });

    res.json({ success: true, refund: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /refunds/:id/reject — { reason }
// ─────────────────────────────────────────────
exports.rejectRefund = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const refund = await prisma.refund.findUnique({
      where: { id: req.params.id },
      include: { order: { select: { orderNumber: true, guestPhone: true } }, customer: { select: { phone: true } } },
    });
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found' });
    }
    if (refund.status !== 'PENDING') {
      return res.status(409).json({ success: false, message: `Refund is already ${refund.status}` });
    }

    const updated = await prisma.refund.update({
      where: { id: refund.id },
      data: { status: 'REJECTED', rejectedReason: reason ? String(reason).trim() : null },
    });

    if (refund.customerId) sendRefundRejectedPush(refund.customerId, refund.order.orderNumber, reason);
    const phone = refund.customer?.phone || refund.order.guestPhone;
    if (phone) sendRefundRejectedSms(phone, refund.order.orderNumber, reason);

    res.json({ success: true, refund: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// POST /refunds/:id/pay — { paymentMethod, paymentReference }
// ─────────────────────────────────────────────
exports.payRefund = async (req, res, next) => {
  try {
    const { paymentMethod, paymentReference } = req.body;
    if (!paymentMethod) {
      return res.status(400).json({ success: false, message: 'paymentMethod required' });
    }

    const refund = await prisma.refund.findUnique({
      where: { id: req.params.id },
      include: { order: true, customer: { select: { phone: true } } },
    });
    if (!refund) {
      return res.status(404).json({ success: false, message: 'Refund not found' });
    }
    if (refund.status !== 'APPROVED') {
      return res.status(409).json({ success: false, message: `Refund must be APPROVED first (currently ${refund.status})` });
    }

    const paid = await prisma.$transaction(async (tx) => {
      if (refund.clawbackVendor && refund.order.vendorId && Number(refund.vendorClawbackAmount) > 0) {
        await tx.ledgerEntry.create({
          data: {
            vendorId: refund.order.vendorId,
            orderId: refund.orderId,
            type: 'REFUND',
            amount: -Number(refund.vendorClawbackAmount),
            description: `Refund ${refund.id} clawback on order ${refund.order.orderNumber}`,
          },
        });
      }
      if (refund.clawbackRider && refund.order.riderId && Number(refund.riderClawbackAmount) > 0) {
        await tx.riderLedgerEntry.create({
          data: {
            riderId: refund.order.riderId,
            orderId: refund.orderId,
            type: 'REFUND',
            amount: -Number(refund.riderClawbackAmount),
            description: `Refund ${refund.id} clawback on order ${refund.order.orderNumber}`,
          },
        });
      }

      return tx.refund.update({
        where: { id: refund.id },
        data: { status: 'PAID', paidAt: new Date(), paymentMethod, paymentReference: paymentReference || null },
      });
    });

    if (refund.customerId) sendRefundPaidPush(refund.customerId, refund.order.orderNumber, refund.amount);
    const phone = refund.customer?.phone || refund.order.guestPhone;
    if (phone) sendRefundPaidSms(phone, refund.order.orderNumber, refund.amount);

    res.json({ success: true, refund: paid });
  } catch (err) {
    next(err);
  }
};
