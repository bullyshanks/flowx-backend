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

// ── Zone serviceability ────────────────────────────────────
// Whether a zone can be served *at all*, as opposed to right now.
//
// Deliberately ignores isOpen and stockStatus: a vendor who is closed this
// minute will reopen, and sweepUnassignedOrders picks the order up when they
// do. Refusing the order over a temporary closure would turn a short wait into
// a lost sale. What no amount of retrying fixes is a zone with no approved
// vendor assigned to it at all — those orders can never be delivered, so the
// honest thing is to not take them.
const SERVICEABLE_VENDOR = {
  role: 'VENDOR',
  vendorStatus: 'APPROVED',
  kycStatus: 'APPROVED',
  isFrozen: false,
};

async function isZoneServiceable(zoneId) {
  return (await prisma.user.count({ where: { ...SERVICEABLE_VENDOR, zoneId } })) > 0;
}

// Record that someone tried to order somewhere we don't serve. Fire-and-forget
// on purpose: this is analytics, and failing to write it must never turn into
// a failed checkout for a customer who is already being told no.
function recordZoneDemand(zoneId, source) {
  prisma.zoneDemand
    .create({ data: { zoneId, source } })
    .catch((err) => console.error('[zone-demand] could not record:', err.message));
}

// Ids of every zone with at least one vendor able to serve it. One grouped
// query rather than one per zone, since the zone list is on the hot path for
// every checkout page load.
async function serviceableZoneIds() {
  const rows = await prisma.user.groupBy({
    by: ['zoneId'],
    where: { ...SERVICEABLE_VENDOR, zoneId: { not: null } },
    _count: { _all: true },
  });
  return new Set(rows.filter((r) => r._count._all > 0).map((r) => r.zoneId));
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

  const productIds = order.items.map((i) => i.productId);
  let candidate = await findNextVendor({ zoneId: order.zoneId, productIds }, excludeVendorId);

  // Nobody *else* is free. In a zone with a single vendor that used to orphan
  // the order permanently: the one vendor missed a 90-second window, was then
  // excluded from their own zone's rotation, and the order fell out of every
  // queue. Offering it back to them is far better than offering it to no one —
  // they may simply have been away from their phone.
  if (!candidate && excludeVendorId) {
    candidate = await findNextVendor({ zoneId: order.zoneId, productIds }, null);
  }

  const sameVendorAsBefore = candidate && candidate.id === order.offeredVendorId;
  const alreadyUnoffered = !candidate && !order.offeredVendorId;

  // Nothing changed — an order with no vendors available would otherwise write
  // an identical log line on every sweep, burying the real history.
  if (alreadyUnoffered) return order;

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: candidate
      ? { offeredVendorId: candidate.id, vendorAcceptDeadline: acceptDeadline() }
      : { offeredVendorId: null, vendorAcceptDeadline: null },
  });

  // Re-offering to the same vendor is just the window resetting, not news.
  if (!sameVendorAsBefore) {
    await prisma.orderStatusLog.create({
      data: {
        orderId: order.id,
        status: order.status,
        notes: candidate ? `Offered to vendor ${candidate.name}` : 'No vendors available in zone',
      },
    });
  }
  return updated;
}

// Offer the order to a rider (or leave unassigned + log if none available).
async function tryAssignRider(orderId, excludeRiderId = null) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } } },
  });
  if (!order || !needsRider(order)) return order;

  let candidate = await findNextRider(order, excludeRiderId);
  // Same single-candidate trap as vendors — see tryAssignVendor.
  if (!candidate && excludeRiderId) candidate = await findNextRider(order, null);

  const sameRiderAsBefore = candidate && candidate.id === order.riderId;
  if (!candidate && !order.riderId) return order; // already unoffered, don't re-log

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: candidate
      ? { riderId: candidate.id, riderAssignedAt: new Date(), riderAcceptDeadline: acceptDeadline() }
      : { riderId: null, riderAssignedAt: null, riderAcceptDeadline: null },
  });
  if (!sameRiderAsBefore) {
    await prisma.orderStatusLog.create({
      data: {
        orderId: order.id,
        status: order.status,
        notes: candidate ? `Offered to rider ${candidate.name}` : 'No riders available in zone',
      },
    });
  }
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

// Orders still waiting on a vendor. Also the admin worklist query — an order
// nobody has been offered is one nobody is going to deliver.
const AWAITING_VENDOR = {
  vendorId: null,
  status: { in: ['PENDING', 'CONFIRMED'] },
};

/**
 * Background re-offer sweep.
 *
 * reassignIfExpired only runs when someone reads a queue, and it only looks at
 * orders offered to *that* reader. So an order whose offer expired while no
 * other vendor was free ended up with offeredVendorId = null, in nobody's
 * queue, invisible until an admin went looking. A paid order could sit there
 * indefinitely.
 *
 * This closes that hole from the other side: it finds those orders on a timer
 * regardless of who is looking, and retries them. A zone whose vendors were
 * all closed at order time gets picked up as soon as one reopens.
 *
 * Returns counts rather than logging, so the caller decides how loud to be.
 */
async function sweepUnassignedOrders() {
  const now = new Date();
  let expiredOffers = 0;
  let orphaned = 0;
  let riderRetries = 0;

  // 1. Offers whose window has passed, whoever they were made to.
  const expired = await prisma.order.findMany({
    where: {
      ...AWAITING_VENDOR,
      offeredVendorId: { not: null },
      vendorAcceptDeadline: { lt: now },
    },
    select: { id: true, offeredVendorId: true },
  });
  for (const o of expired) {
    await tryAssignVendor(o.id, o.offeredVendorId);
    expiredOffers += 1;
  }

  // 2. Orders sitting with no offer at all — the case that used to be lost.
  const stranded = await prisma.order.findMany({
    where: { ...AWAITING_VENDOR, offeredVendorId: null },
    select: { id: true },
  });
  for (const o of stranded) {
    await tryAssignVendor(o.id, null);
    orphaned += 1;
  }

  // 3. Riders have the identical trap once a vendor has accepted.
  const riderExpired = await prisma.order.findMany({
    where: {
      status: 'ASSIGNED',
      riderId: { not: null },
      riderAcceptDeadline: { lt: now },
    },
    select: { id: true, riderId: true },
  });
  for (const o of riderExpired) {
    await tryAssignRider(o.id, o.riderId);
    riderRetries += 1;
  }

  return { expiredOffers, orphaned, riderRetries };
}

// Count for the admin dashboard: orders with no vendor and no live offer.
// If this is above zero, someone needs to open a zone or call a vendor.
async function countStrandedOrders() {
  return prisma.order.count({ where: { ...AWAITING_VENDOR, offeredVendorId: null } });
}

module.exports = {
  ACCEPT_WINDOW_SECONDS,
  needsRider,
  sweepUnassignedOrders,
  countStrandedOrders,
  isZoneServiceable,
  serviceableZoneIds,
  recordZoneDemand,
  findNextVendor,
  findNextRider,
  tryAssignVendor,
  tryAssignRider,
  reassignIfExpired,
  acceptDeadline,
  unassignVendorOrders,
  reassignRiderOrders,
};
