// ═══════════════════════════════════════════════════════════
//  Ledger Service
//  Creates vendor ledger entries when an order is delivered
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Create ledger entries for a delivered order — vendor side (product value +
 * commission) and, for DELIVERY orders with a rider, the rider's earning.
 * Idempotent — skips if entries already exist for the order.
 * Runs everything inside a transaction.
 *
 * COD cash-holder split: whoever physically collected the cash owes FlowX
 * for it, not whoever fulfilled the order.
 *   - SELF_PICKUP + COD: vendor collects from the customer directly → vendor
 *     owes FlowX the commission slice of that cash (as in v1).
 *   - DELIVERY + COD: the RIDER collects the cash, not the vendor → the rider
 *     owes FlowX the full amount collected (product value; they keep nothing
 *     upfront, their earning is paid out separately at settlement, same as
 *     how vendor commission always worked). Vendor's own codLiability is
 *     untouched since they never held any cash for this order.
 */
async function createDeliveryLedgerEntries(orderId) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: true } } },
    });
    if (!order || !order.vendorId) return null;

    const existingVendor = await tx.ledgerEntry.findFirst({ where: { orderId: order.id } });
    const existingRider = await tx.riderLedgerEntry.findFirst({ where: { orderId: order.id } });
    if (existingVendor || existingRider) return null;

    const settings = await tx.commissionSettings.findFirst();
    const defaultPct = settings ? Number(settings.defaultCommissionPct) : 20;

    let productValue = 0;
    let commission = 0;
    let riderEarning = 0;

    for (const item of order.items) {
      const lineTotal = Number(item.total);
      const pct = item.product.commissionPct != null
        ? Number(item.product.commissionPct)
        : defaultPct;
      productValue += lineTotal;
      commission += (lineTotal * pct) / 100;
      if (item.product.hasRiderDelivery) {
        riderEarning += item.quantity * Number(item.product.riderEarningPerUnit);
      }
    }

    productValue = round2(productValue);
    commission = round2(commission);
    riderEarning = round2(riderEarning);

    // ── Vendor ledger: product value credit + commission debit only ──
    await tx.ledgerEntry.createMany({
      data: [
        {
          vendorId: order.vendorId,
          orderId: order.id,
          type: 'PRODUCT_VALUE',
          amount: productValue,
          description: `Product value for order ${order.orderNumber}`,
        },
        {
          vendorId: order.vendorId,
          orderId: order.id,
          type: 'COMMISSION_DEDUCTED',
          amount: -commission,
          description: `Commission on order ${order.orderNumber}`,
        },
      ],
    });

    // ── Rider ledger: earning credit, only for DELIVERY orders with a rider ──
    const hasRider = order.fulfillmentType === 'DELIVERY' && order.riderId && riderEarning > 0;
    if (hasRider) {
      await tx.riderLedgerEntry.create({
        data: {
          riderId: order.riderId,
          orderId: order.id,
          type: 'RIDER_EARNING',
          amount: riderEarning,
          description: `Rider earning for order ${order.orderNumber}`,
        },
      });
    }

    // ── COD cash-holder liability ──
    if (order.paymentMethod === 'COD') {
      if (order.fulfillmentType === 'SELF_PICKUP') {
        await tx.user.update({
          where: { id: order.vendorId },
          data: { codLiability: { increment: commission } },
        });
      } else if (order.riderId) {
        await tx.user.update({
          where: { id: order.riderId },
          data: { codLiability: { increment: productValue } },
        });
      }
    }

    return { productValue, commission, riderEarning };
  });
}

/**
 * Wallet summary for a vendor: totals per entry type + net balance.
 */
async function getVendorWalletSummary(vendorId) {
  const grouped = await prisma.ledgerEntry.groupBy({
    by: ['type'],
    where: { vendorId },
    _sum: { amount: true },
  });

  const sumOf = (type) => {
    const row = grouped.find((g) => g.type === type);
    return row ? Number(row._sum.amount) : 0;
  };

  const totalProductValue = sumOf('PRODUCT_VALUE');
  const totalRiderEarning = sumOf('RIDER_EARNING');
  const totalCommission = -sumOf('COMMISSION_DEDUCTED'); // stored negative, report positive
  const netPayable = round2(grouped.reduce((acc, g) => acc + Number(g._sum.amount), 0));

  return {
    totalProductValue: round2(totalProductValue),
    totalRiderEarning: round2(totalRiderEarning),
    totalCommission: round2(totalCommission),
    netPayable,
  };
}

/**
 * Wallet summary for a rider: totals per entry type + net balance.
 * Mirrors getVendorWalletSummary but reads RiderLedgerEntry.
 */
async function getRiderWalletSummary(riderId) {
  const grouped = await prisma.riderLedgerEntry.groupBy({
    by: ['type'],
    where: { riderId },
    _sum: { amount: true },
  });

  const sumOf = (type) => {
    const row = grouped.find((g) => g.type === type);
    return row ? Number(row._sum.amount) : 0;
  };

  const totalEarning = sumOf('RIDER_EARNING');
  const netPayable = round2(grouped.reduce((acc, g) => acc + Number(g._sum.amount), 0));

  return {
    totalEarning: round2(totalEarning),
    netPayable,
  };
}

module.exports = {
  createDeliveryLedgerEntries, getVendorWalletSummary, getRiderWalletSummary, round2,
};
