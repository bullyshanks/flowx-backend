// ═══════════════════════════════════════════════════════════
//  Assignment Service
//  Vendor/rider offer-and-accept flow with a timed window and
//  check-on-read expiry (no cron/queue yet — see reassignIfExpired).
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { ACCEPT_WINDOW_SECONDS } = require('../config/assignment');

const acceptDeadline = () => new Date(Date.now() + ACCEPT_WINDOW_SECONDS * 1000);

// A rider is needed only for DELIVERY orders, and only when every item in the
// order wants rider delivery. Any item with hasRiderDelivery=false (currently
// just the 1000L tank) means the vendor delivers the whole order themselves —
// bulky/self-delivered items can't be split onto a rider's bike.
function needsRider(order) {
  return order.fulfillmentType === 'DELIVERY' && order.items.every((i) => i.product.hasRiderDelivery);
}

// Next eligible vendor in the zone carrying every one of productIds in stock
// (a vendor with no VendorProduct row for a product is assumed to carry it —
// opt-out model, see schema), excluding one id (the vendor whose offer just
// expired/was rejected). Simple id-order cycling — good enough for a
// check-on-read pattern; a real dispatcher can replace this later.
async function findNextVendor({ zoneId, productIds = [] }, excludeId) {
  const candidates = await prisma.user.findMany({
    where: {
      role: 'VENDOR',
      vendorStatus: 'APPROVED',
      kycStatus: 'APPROVED',
      isFrozen: false,
      isOpen: true,
      stockStatus: true,
      zoneId,
      ...(excludeId && { id: { not: excludeId } }),
    },
    orderBy: { id: 'asc' },
    include: {
      vendorProducts: { where: { productId: { in: productIds }, inStock: false } },
    },
  });
  return candidates.find((v) => v.vendorProducts.length === 0) || null;
}

async function findNextRider(order, excludeId) {
  return prisma.user.findFirst({
    where: {
      role: 'RIDER',
      vendorStatus: 'APPROVED',
      kycStatus: 'APPROVED',
      isOnline: true,
      isFrozen: false,
      zoneId: order.zoneId,
      ...(excludeId && { id: { not: excludeId } }),
    },
    orderBy: { id: 'asc' },
  });
}

// Offer the order to a vendor (or clear the offer if none available).
async function tryAssignVendor(orderId, excludeVendorId = null) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.vendorId) return order; // already accepted, nothing to do

  const candidate = await findNextVendor(
    { zoneId: order.zoneId, productIds: order.items.map((i) => i.productId) },
    excludeVendorId
  );
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: candidate
      ? { offeredVendorId: candidate.id, vendorAcceptDeadline: acceptDeadline() }
      : { offeredVendorId: null, vendorAcceptDeadline: null },
  });
  await prisma.orderStatusLog.create({
    data: {
      orderId: order.id,
      status: order.status,
      notes: candidate ? `Offered to vendor ${candidate.name}` : 'No vendors available in zone',
    },
  });
  return updated;
}

// Offer the order to a rider (or leave unassigned + log if none available).
async function tryAssignRider(orderId, excludeRiderId = null) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } } },
  });
  if (!order || !needsRider(order)) return order;

  const candidate = await findNextRider(order, excludeRiderId);
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: candidate
      ? { riderId: candidate.id, riderAssignedAt: new Date(), riderAcceptDeadline: acceptDeadline() }
      : { riderId: null, riderAssignedAt: null, riderAcceptDeadline: null },
  });
  await prisma.orderStatusLog.create({
    data: {
      orderId: order.id,
      status: order.status,
      notes: candidate ? `Offered to rider ${candidate.name}` : 'No riders available in zone',
    },
  });
  return updated;
}

/**
 * Check-on-read expiry: call before acting on an order fetched for
 * tracking/queues/accept. If the current vendor or rider offer has expired,
 * reassign to the next candidate (or clear it for admin to handle manually).
 * Idempotent / cheap when nothing has expired.
 */
async function reassignIfExpired(orderId) {
  let order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status === 'DELIVERED' || order.status === 'CANCELLED') return order;

  const now = Date.now();

  // Vendor offer expired and never accepted
  if (!order.vendorId && order.offeredVendorId && order.vendorAcceptDeadline && order.vendorAcceptDeadline.getTime() < now) {
    order = await tryAssignVendor(order.id, order.offeredVendorId);
  }

  // Rider offer expired and never accepted (accepted = riderAcceptDeadline cleared to null)
  if (order.riderId && order.riderAcceptDeadline && order.riderAcceptDeadline.getTime() < now) {
    order = await tryAssignRider(order.id, order.riderId);
  }

  return order;
}

// Called when a vendor is suspended or frozen mid-order — both are a hard
// stop on delivery capability (see updateStatus's vendorStatus/isFrozen
// checks), so both need the same in-flight cleanup. Their in-flight orders
// (already accepted, not yet delivered/cancelled) can't just sit pointed at
// an unavailable account forever — clear the assignment and log why, so the
// order shows up as "Unassigned" in the admin orders table and the existing
// Assign-vendor action picks it up. Not auto-reassigned to a random vendor —
// they may have already prepared/packed the order, so this is an admin call.
async function unassignVendorOrders(vendorId, reason = 'suspended') {
  const orders = await prisma.order.findMany({
    where: { vendorId, status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } },
    select: { id: true, status: true },
  });
  for (const order of orders) {
    await prisma.order.update({
      where: { id: order.id },
      data: { vendorId: null, assignedAt: null },
    });
    await prisma.orderStatusLog.create({
      data: {
        orderId: order.id,
        status: order.status,
        notes: `Vendor ${reason} — order flagged for admin reassignment`,
      },
    });
  }
  return orders.length;
}

// Called when a rider is suspended or frozen mid-delivery. Unlike a vendor
// (who may have already prepared physical goods), a rider's leg can be
// handed to another eligible rider in the same zone automatically — reuses
// the same offer/accept path as an expired offer. Falls back to
// "Unassigned" (visible in the admin orders table) if no other rider is
// available right now.
async function reassignRiderOrders(riderId, reason = 'suspended') {
  const orders = await prisma.order.findMany({
    where: { riderId, status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } },
    select: { id: true, status: true },
  });
  for (const order of orders) {
    await prisma.orderStatusLog.create({
      data: {
        orderId: order.id,
        status: order.status,
        notes: `Rider ${reason} — order flagged for admin reassignment`,
      },
    });
    await tryAssignRider(order.id, riderId);
  }
  return orders.length;
}

module.exports = {
  ACCEPT_WINDOW_SECONDS,
  needsRider,
  findNextVendor,
  findNextRider,
  tryAssignVendor,
  tryAssignRider,
  reassignIfExpired,
  acceptDeadline,
  unassignVendorOrders,
  reassignRiderOrders,
};
