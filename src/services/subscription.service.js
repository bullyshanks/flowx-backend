// ═══════════════════════════════════════════════════════════
//  Subscription Service
//  Turns due ACTIVE subscriptions into real Orders. No queue/cron
//  package — a simple in-process interval, same "check on a beat"
//  style as assignment.service's reassignIfExpired.
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { generateOrderNumber } = require('../utils/generators');
const { sendOrderConfirmationSms } = require('./sms.service');
const { tryAssignVendor } = require('./assignment.service');

function advance(date, frequency) {
  const next = new Date(date);
  if (frequency === 'DAILY') next.setDate(next.getDate() + 1);
  else if (frequency === 'WEEKLY') next.setDate(next.getDate() + 7);
  else if (frequency === 'MONTHLY') next.setMonth(next.getMonth() + 1);
  return next;
}

// Create the order + advance nextDeliveryDate for one due subscription.
//
// Claiming is a compare-and-swap: the UPDATE's WHERE clause requires
// nextDeliveryDate to still equal the value we read. Postgres executes a
// single UPDATE atomically, so if two callers (two instances, or two
// overlapping ticks) race on the same subscription, only one of them can
// ever match that WHERE and get count === 1 — the loser sees 0 and backs
// off instead of creating a duplicate order. This is what actually closes
// the window; running in one process was never what made it safe.
async function processSubscription(sub) {
  const product = sub.product;
  if (!product.isActive) return null; // skip silently; admin can pause/cancel manually

  const lineTotal = Number(product.price) * sub.quantity;

  const order = await prisma.$transaction(async (tx) => {
    const claim = await tx.subscription.updateMany({
      where: { id: sub.id, nextDeliveryDate: sub.nextDeliveryDate },
      data: { nextDeliveryDate: advance(sub.nextDeliveryDate, sub.frequency) },
    });
    if (claim.count === 0) return null; // another instance/tick already claimed this cycle

    return tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        customerId: sub.customerId,
        zoneId: sub.zoneId,
        deliveryAddress: sub.deliveryAddress,
        deliveryTimeSlot: sub.preferredTimeSlot,
        paymentMethod: sub.paymentMethod,
        fulfillmentType: 'DELIVERY',
        subtotal: lineTotal,
        total: lineTotal,
        status: 'PENDING',
        subscriptionId: sub.id,
        items: {
          create: [{
            productId: product.id,
            quantity: sub.quantity,
            unitPrice: product.price,
            total: lineTotal,
          }],
        },
        statusHistory: { create: [{ status: 'PENDING', notes: 'Auto-generated from subscription' }] },
      },
    });
  });

  if (!order) return null;

  await tryAssignVendor(order.id);

  if (sub.customer?.phone) sendOrderConfirmationSms(sub.customer.phone, order.orderNumber);

  return order;
}

// Find every ACTIVE subscription whose nextDeliveryDate has arrived and
// turn each into an order. Safe to call repeatedly — a subscription only
// shows up here once per cycle since processSubscription always advances
// nextDeliveryDate into the future before returning.
async function processDueSubscriptions() {
  const due = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', nextDeliveryDate: { lte: new Date() } },
    include: { product: true, customer: { select: { phone: true } } },
  });

  const results = { processed: 0, failed: 0 };
  for (const sub of due) {
    try {
      const order = await processSubscription(sub);
      if (order) results.processed += 1;
    } catch (err) {
      results.failed += 1;
      console.error(`[subscription.service] Failed to process subscription ${sub.id}:`, err.message);
    }
  }
  return results;
}

module.exports = { processDueSubscriptions, advance };
