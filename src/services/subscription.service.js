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
// The advance happens in the same transaction as order creation, so a
// subscription is never left pointing at a past date after this runs —
// the next scheduler tick won't see it again until its new date arrives.
async function processSubscription(sub) {
  const product = sub.product;
  if (!product.isActive) return null; // skip silently; admin can pause/cancel manually

  const lineTotal = Number(product.price) * sub.quantity;

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
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

    await tx.subscription.update({
      where: { id: sub.id },
      data: { nextDeliveryDate: advance(sub.nextDeliveryDate, sub.frequency) },
    });

    return created;
  });

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
