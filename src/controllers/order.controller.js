// ═══════════════════════════════════════════════════════════
//  Order Controller
//  Place order (guest or auth), track, update status, list
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { generateOrderNumber } = require('../utils/generators');
const {
  sendOrderConfirmationSms, sendOrderAssignedSms,
  sendOrderOutForDeliverySms, sendOrderDeliveredSms, sendOrderCancelledSms,
} = require('../services/sms.service');
const {
  sendOrderConfirmationPush, sendOrderAssignedPush,
  sendOrderOutForDeliveryPush, sendOrderDeliveredPush, sendOrderCancelledPush,
} = require('../services/push.service');
const { createDeliveryLedgerEntries, round2 } = require('../services/ledger.service');
const {
  needsRider, tryAssignVendor, tryAssignRider, reassignIfExpired, findNextVendor,
  isZoneServiceable, recordZoneDemand,
} = require('../services/assignment.service');

// Mirrors the frontend's validatePhone (src/lib/utils.ts) so guest orders
// placed directly against the API get the same check the cart UI enforces.
const PK_PHONE_REGEX = /^(\+92|0)?3\d{9}$/;

// Whoever is fulfilling an order needs to be able to reach the customer, but
// only once the order is actually theirs — an open offer is visible to every
// eligible vendor/rider in the zone, and none of them needs a phone number to
// decide whether to take it. Strips the contact rather than never loading it,
// so the ownership rule lives in one obvious place.
function withCustomerContact(order, owned) {
  if (owned) return order;
  const { customer, guestName, guestPhone, guestAddress, ...rest } = order;
  return { ...rest, customer: null, guestName: null, guestPhone: null, guestAddress: null };
}

// Pay out a vendor referral once the referred vendor has delivered their first
// order. Where the money lands depends on who referred them: a vendor's balance
// is the ledger, a customer's is walletBalance.
//
// The claim is a compare-and-swap on status — two orders for the same new
// vendor being marked DELIVERED at once must not pay the bonus twice, and the
// loser of the race simply finds nothing left to claim.
async function creditVendorReferral(vendorId) {
  const referral = await prisma.referral.findUnique({ where: { refereeId: vendorId } });
  if (!referral || referral.kind !== 'VENDOR' || referral.status !== 'PENDING') return;

  const referrer = await prisma.user.findUnique({
    where: { id: referral.referrerId },
    select: { id: true, role: true, name: true },
  });
  if (!referrer) return;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.referral.updateMany({
      where: { id: referral.id, status: 'PENDING' },
      data: { status: 'CREDITED', creditedAt: new Date() },
    });
    if (claimed.count === 0) return; // another delivery got here first

    if (referrer.role === 'VENDOR') {
      await tx.ledgerEntry.create({
        data: {
          vendorId: referrer.id,
          type: 'REFERRAL_BONUS',
          amount: referral.referrerBonus,
          description: 'Referral bonus — referred vendor completed their first delivery',
        },
      });
    } else {
      await tx.user.update({
        where: { id: referrer.id },
        data: { walletBalance: { increment: referral.referrerBonus } },
      });
    }
  });
}

// ─────────────────────────────────────────────
// Place an order (guest or authenticated)
// ─────────────────────────────────────────────
exports.placeOrder = async (req, res, next) => {
  try {
    const {
      items,                    // [{ productId, quantity }]
      zoneId,
      deliveryAddress,
      deliveryDate,
      deliveryTimeSlot,
      paymentMethod,
      fulfillmentType = 'DELIVERY',
      // guest fields
      guestName, guestPhone,
    } = req.body;

    // ─── Validate ──
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item required' });
    }
    if (!items.every((i) => Number.isInteger(i.quantity) && i.quantity > 0)) {
      return res.status(400).json({ success: false, message: 'Each item requires a valid positive quantity' });
    }
    if (!zoneId || !deliveryAddress || !String(deliveryAddress).trim() || !paymentMethod) {
      return res.status(400).json({ success: false, message: 'Zone, address, and payment method required' });
    }
    if (!['COD', 'JAZZCASH', 'EASYPAISA', 'BANK_TRANSFER', 'CARD'].includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'Invalid payment method' });
    }
    if (!['SELF_PICKUP', 'DELIVERY'].includes(fulfillmentType)) {
      return res.status(400).json({ success: false, message: 'fulfillmentType must be SELF_PICKUP or DELIVERY' });
    }

    const isGuest = !req.user;
    if (isGuest) {
      if (!guestName || !String(guestName).trim()) {
        return res.status(400).json({ success: false, message: 'Guest name is required' });
      }
      if (!guestPhone || !PK_PHONE_REGEX.test(String(guestPhone).replace(/\s|-/g, ''))) {
        return res.status(400).json({ success: false, message: 'A valid Pakistani phone number is required' });
      }
    }

    // ─── Verify zone exists and can actually be served ──
    // Taking money for an area with no vendor produces an order nobody can
    // ever deliver. Serviceability ignores whether vendors are open right now
    // — a closed shop reopens and the sweep picks the order up — so this only
    // refuses zones where no approved vendor exists at all.
    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(400).json({ success: false, message: 'Invalid zone' });
    }
    if (!(await isZoneServiceable(zoneId))) {
      // Count the turned-away customer. A zone with no vendors and no demand
      // looks identical to one nobody wants; this is what tells them apart.
      recordZoneDemand(zoneId, 'ORDER');
      return res.status(400).json({
        success: false,
        message: `We don't deliver to ${zone.name} yet — we're still onboarding vendors there. Please choose another area.`,
      });
    }

    // ─── Fetch products & calculate total ──
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isActive: true },
    });

    if (products.length !== productIds.length) {
      return res.status(400).json({ success: false, message: 'One or more products not available' });
    }

    // ─── Resolve pricing vendor ──
    // Vendors set their own price/stock per product (VendorProduct override —
    // see schema). Whichever vendor would actually be offered this order gets
    // to set the price the customer pays; if none is available in the zone
    // right now, fall back to each product's catalog price (order still gets
    // created and offered once a vendor becomes available, same as before).
    // Price is locked in at placement — if this vendor's offer later expires
    // and the order reassigns to a different vendor, we don't re-price; the
    // customer already agreed to this total.
    const pricingVendor = await findNextVendor({ zoneId, productIds });
    const overrides = pricingVendor
      ? await prisma.vendorProduct.findMany({
          where: { vendorId: pricingVendor.id, productId: { in: productIds } },
        })
      : [];
    const priceOf = (product) => {
      const override = overrides.find((o) => o.productId === product.id);
      return override?.price != null ? Number(override.price) : Number(product.price);
    };

    let subtotal = 0;
    const orderItems = items.map((i) => {
      const product = products.find((p) => p.id === i.productId);
      if (i.quantity < product.minQuantity) {
        throw Object.assign(
          new Error(`${product.name} requires minimum ${product.minQuantity} units`),
          { status: 400 }
        );
      }
      const unitPrice = priceOf(product);
      const lineTotal = unitPrice * i.quantity;
      subtotal += lineTotal;
      return {
        productId: product.id,
        quantity: i.quantity,
        unitPrice,
        total: lineTotal,
      };
    });

    // ─── Referral / wallet discount — logged-in customers only, one or the
    // other, never both. A friend's referral code gets you Rs.50 off your
    // very first order; walletBalance (earned by referring others) is spent
    // on any later order. The referral side isn't credited to the referrer
    // yet — that only happens once this order is actually DELIVERED (see
    // updateStatus), same as vendor/rider ledger entries waiting for
    // delivery rather than placement.
    //
    // Eligibility (referral.discountUsed) and order creation happen inside
    // one transaction, and the claim itself is a compare-and-swap — the
    // UPDATE's WHERE requires discountUsed to still be false, so a
    // concurrent double-submit racing on the same referral can only ever
    // have one branch see count === 1; the loser falls through with no
    // discount instead of both applying it. Same pattern as the
    // subscription-claiming CAS in subscription.service.js. Wallet spend
    // gets the same treatment via a balance-guarded decrement. ──
    const trimmedAddress = String(deliveryAddress).trim();

    const order = await prisma.$transaction(async (tx) => {
      let discountAmount = 0;

      if (!isGuest) {
        const customer = await tx.user.findUnique({
          where: { id: req.user.id },
          select: { walletBalance: true, referredById: true },
        });
        const pendingReferral = customer.referredById
          ? await tx.referral.findUnique({ where: { refereeId: req.user.id } })
          : null;

        if (pendingReferral && pendingReferral.status === 'PENDING' && !pendingReferral.discountUsed) {
          const claim = await tx.referral.updateMany({
            where: { id: pendingReferral.id, discountUsed: false },
            data: { discountUsed: true },
          });
          if (claim.count === 1) {
            discountAmount = round2(Math.min(Number(pendingReferral.refereeDiscount), subtotal));
          }
        }

        if (discountAmount === 0 && Number(customer.walletBalance) > 0) {
          const wanted = round2(Math.min(Number(customer.walletBalance), subtotal));
          const spend = await tx.user.updateMany({
            where: { id: req.user.id, walletBalance: { gte: wanted } },
            data: { walletBalance: { decrement: wanted } },
          });
          if (spend.count === 1) {
            discountAmount = wanted;
          }
        }
      }

      const total = subtotal - discountAmount; // free delivery for now

      return tx.order.create({
        data: {
          orderNumber: generateOrderNumber(),
          customerId: isGuest ? null : req.user.id,
          guestName: isGuest ? String(guestName).trim() : null,
          guestPhone: isGuest ? String(guestPhone).trim() : null,
          guestAddress: isGuest ? trimmedAddress : null,
          zoneId,
          deliveryAddress: trimmedAddress,
          deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
          deliveryTimeSlot,
          paymentMethod,
          fulfillmentType,
          subtotal,
          discountAmount,
          total,
          status: 'PENDING',
          items: { create: orderItems },
          statusHistory: { create: [{ status: 'PENDING', notes: 'Order placed' }] },
        },
        include: { items: { include: { product: true } }, zone: true },
      });
    });

    // ─── Offer to the first eligible vendor in the zone ──
    // Self-pickup orders still need a vendor to prepare/hold the order.
    await tryAssignVendor(order.id);

    // ─── Send confirmation SMS + push (push only reaches logged-in customers —
    // guests have no account/subscription to push to) ──
    const phone = isGuest ? guestPhone : req.user.phone;
    sendOrderConfirmationSms(phone, order.orderNumber);
    if (!isGuest) sendOrderConfirmationPush(req.user.id, order.orderNumber);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        subtotal: order.subtotal,
        discountAmount: order.discountAmount,
        total: order.total,
        status: order.status,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Get order by order number (public — for tracking)
// ─────────────────────────────────────────────
exports.trackOrder = async (req, res, next) => {
  try {
    const { orderNumber } = req.params;

    const existing = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true } });
    if (existing) await reassignIfExpired(existing.id);

    // This endpoint is public and unauthenticated — order numbers are only a
    // 5-digit random suffix (~90k possibilities/year, see generateOrderNumber),
    // guessable/enumerable at scale. Keep the response to what a tracking page
    // actually needs: no statusHistory (internal ops notes + raw changedBy
    // user ids — unused by the frontend anyway, see track/page.tsx) and no
    // vendor/rider phone numbers (real PII that would otherwise be harvestable
    // by anyone willing to guess order numbers). Names alone are enough
    // context ("your rider is Ali") without exposing a way to contact them.
    const order = await prisma.order.findUnique({
      where: { orderNumber },
      select: {
        orderNumber: true,
        status: true,
        deliveryDate: true,
        deliveryTimeSlot: true,
        total: true,
        createdAt: true,
        zone: { select: { name: true } },
        items: {
          include: { product: { select: { name: true, unit: true, imageUrl: true } } },
        },
        vendor: { select: { name: true } },
        rider: { select: { name: true } },
        // REJECTED refunds were never actually going to happen from the
        // customer's perspective (they never requested one) — showing that
        // would just confuse, not inform, so it's excluded here.
        refunds: {
          where: { status: { in: ['PENDING', 'APPROVED', 'PAID'] } },
          select: { amount: true, status: true, reason: true, paidAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Get current user's orders
// ─────────────────────────────────────────────
exports.myOrders = async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { customerId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: { items: { include: { product: true } }, zone: true },
    });
    res.json({ success: true, orders });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: get orders assigned to me OR currently offered to me
// ─────────────────────────────────────────────
exports.vendorOrders = async (req, res, next) => {
  try {
    // Sweep: expire any offers sitting with me before listing, so a dead
    // offer doesn't linger in my queue and a fresh one gets a chance.
    const pending = await prisma.order.findMany({
      where: { offeredVendorId: req.user.id, vendorId: null },
      select: { id: true },
    });
    for (const o of pending) await reassignIfExpired(o.id);

    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { vendorId: req.user.id },
          { offeredVendorId: req.user.id, vendorId: null },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { product: true } },
        zone: true,
        customer: { select: { name: true, phone: true } },
      },
    });

    // A vendor fulfilling an order needs a name to ask for and a number to
    // call when the address is unclear. Guest orders always carried that on
    // the order row, but registered-customer orders exposed nothing, leaving
    // the vendor with an address and nobody to contact.
    //
    // Only once the order is actually theirs, though: while it is merely
    // offered, every eligible vendor in the zone can see it, and none of them
    // needs the customer's phone number to decide whether to accept.
    res.json({
      success: true,
      orders: orders.map((o) => withCustomerContact(o, o.vendorId === req.user.id)),
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: accept an order currently offered to me
// ─────────────────────────────────────────────
exports.acceptOrder = async (req, res, next) => {
  try {
    await reassignIfExpired(req.params.id);
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.vendorId) {
      return res.status(409).json({ success: false, message: 'Order already assigned' });
    }
    if (order.offeredVendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This order is not currently offered to you' });
    }
    if (req.user.isFrozen) {
      return res.status(403).json({ success: false, message: 'Account frozen — contact FlowX admin' });
    }
    if (
      order.paymentMethod === 'COD' &&
      req.user.codLimit != null &&
      Number(req.user.codLiability) + Number(order.total) > Number(req.user.codLimit)
    ) {
      return res.status(403).json({
        success: false,
        message: 'COD limit exceeded — settlement required before accepting more COD orders.',
      });
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        vendorId: req.user.id,
        offeredVendorId: null,
        vendorAcceptDeadline: null,
        assignedAt: new Date(),
        status: 'ASSIGNED',
        statusHistory: { create: { status: 'ASSIGNED', changedBy: req.user.id, notes: 'Vendor accepted' } },
      },
    });

    // Delivery orders (except bulky items like the 1000L tank) need a rider next
    const withItems = await prisma.order.findUnique({
      where: { id: order.id },
      include: { items: { include: { product: true } } },
    });
    if (needsRider(withItems)) {
      await tryAssignRider(order.id);
    }

    // Notify customer
    if (order.customerId) sendOrderAssignedPush(order.customerId, order.orderNumber, req.user.name);
    const customerPhone = order.guestPhone || (await prisma.user.findUnique({ where: { id: order.customerId } }))?.phone;
    if (customerPhone) sendOrderAssignedSms(customerPhone, order.orderNumber, req.user.name);

    const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
    res.json({ success: true, order: finalOrder });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: explicitly decline an order offered to me (immediate reassignment,
// doesn't wait for the deadline)
// ─────────────────────────────────────────────
exports.rejectOrder = async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.offeredVendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This order is not currently offered to you' });
    }

    await tryAssignVendor(order.id, req.user.id);
    res.json({ success: true, message: 'Order declined and passed to the next vendor' });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Rider: get orders currently offered to me OR assigned to me
// ─────────────────────────────────────────────
exports.riderOrders = async (req, res, next) => {
  try {
    const pending = await prisma.order.findMany({
      where: { riderId: req.user.id, riderAcceptDeadline: { not: null } },
      select: { id: true },
    });
    for (const o of pending) await reassignIfExpired(o.id);

    const orders = await prisma.order.findMany({
      where: { riderId: req.user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { product: true } },
        zone: true,
        vendor: { select: { name: true, phone: true } },
        customer: { select: { name: true, phone: true } },
      },
    });

    // Riders already got the vendor's number, to collect the order — but not
    // the customer's, to actually deliver it. A rider standing outside a
    // building with no one answering had no way to reach anyone.
    //
    // Revealed on acceptance, not on offer: riderAcceptDeadline is cleared
    // when a rider accepts (see riderAcceptOrder), so a still-pending offer
    // keeps the contact hidden.
    res.json({
      success: true,
      orders: orders.map((o) => withCustomerContact(o, o.riderAcceptDeadline === null)),
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Rider: accept a delivery offered to me
// ─────────────────────────────────────────────
exports.riderAcceptOrder = async (req, res, next) => {
  try {
    await reassignIfExpired(req.params.id);
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.riderId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This delivery is not currently offered to you' });
    }
    if (order.riderAcceptDeadline === null) {
      return res.status(409).json({ success: false, message: 'Already accepted' });
    }
    if (req.user.isFrozen) {
      return res.status(403).json({ success: false, message: 'Account frozen — contact FlowX admin' });
    }
    if (
      order.paymentMethod === 'COD' &&
      req.user.codLimit != null &&
      Number(req.user.codLiability) + Number(order.total) > Number(req.user.codLimit)
    ) {
      return res.status(403).json({
        success: false,
        message: 'COD limit exceeded — settlement required before accepting more COD deliveries.',
      });
    }

    // Accepted = deadline cleared, riderId stays set
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        riderAcceptDeadline: null,
        statusHistory: { create: { status: order.status, changedBy: req.user.id, notes: 'Rider accepted' } },
      },
    });

    res.json({ success: true, order: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Rider: explicitly decline a delivery offered to me
// ─────────────────────────────────────────────
exports.riderRejectOrder = async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.riderId !== req.user.id || order.riderAcceptDeadline === null) {
      return res.status(403).json({ success: false, message: 'This delivery is not currently offered to you' });
    }

    await tryAssignRider(order.id, req.user.id);
    res.json({ success: true, message: 'Delivery declined and passed to the next rider' });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Vendor: update order status (out_for_delivery, delivered)
// ─────────────────────────────────────────────
exports.updateStatus = async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const allowed = ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // DELIVERED and CANCELLED are terminal — nothing changes the status of an
    // order after that (no cancelling an order the customer already got, no
    // un-cancelling, no bouncing between statuses). Ledger entries created on
    // delivery aren't reversed by anything, so letting a delivered order flip
    // to cancelled (or back) would desync order status from money already paid.
    if (order.status === 'DELIVERED' || order.status === 'CANCELLED') {
      return res.status(409).json({
        success: false,
        message: `Order is already ${order.status.toLowerCase()} — status cannot be changed`,
      });
    }

    // Vendor/rider can only update their own orders. Admin can update any.
    if (req.user.role === 'VENDOR' && order.vendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not your order' });
    }
    if (req.user.role === 'RIDER' && order.riderId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not your delivery' });
    }
    if ((req.user.role === 'VENDOR' || req.user.role === 'RIDER') && req.user.isFrozen) {
      return res.status(403).json({ success: false, message: 'Account frozen — contact FlowX admin' });
    }
    // Suspension must block status changes on orders already in hand too, not
    // just new offers/accepts — otherwise a suspended vendor/rider can still
    // finish a delivery already assigned to them (and earn ledger credit for it).
    if ((req.user.role === 'VENDOR' || req.user.role === 'RIDER') && req.user.vendorStatus !== 'APPROVED') {
      return res.status(403).json({ success: false, message: 'Account suspended — contact FlowX admin' });
    }
    // KYC is a separate gate from vendorStatus — a re-submission can flip an
    // already-approved account's kycStatus back to PENDING/REJECTED without
    // touching vendorStatus, so this needs its own check alongside the one
    // above (otherwise a KYC-rejected vendor/rider can still finish an order
    // already in hand and earn ledger credit for it).
    if ((req.user.role === 'VENDOR' || req.user.role === 'RIDER') && req.user.kycStatus !== 'APPROVED') {
      return res.status(403).json({ success: false, message: 'KYC not approved — contact FlowX admin' });
    }

    const updateData = {
      status,
      statusHistory: { create: { status, changedBy: req.user.id, notes } },
    };
    if (status === 'DELIVERED') updateData.deliveredAt = new Date();

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: updateData,
    });

    // Ledger entries are created once per order (service is idempotent)
    if (status === 'DELIVERED' && order.status !== 'DELIVERED') {
      await createDeliveryLedgerEntries(order.id);

      // Referral bonus: credited to the referrer once the referee's first
      // order actually completes, not at signup or checkout — avoids paying
      // out on a referral whose first order gets cancelled. Referral.status
      // only ever leaves PENDING once, so this is naturally idempotent
      // against the same order (or a later one) re-triggering DELIVERED.
      if (order.customerId) {
        const referral = await prisma.referral.findUnique({ where: { refereeId: order.customerId } });
        if (referral && referral.status === 'PENDING' && referral.kind === 'CUSTOMER') {
          await prisma.$transaction([
            prisma.user.update({
              where: { id: referral.referrerId },
              data: { walletBalance: { increment: referral.referrerBonus } },
            }),
            prisma.referral.update({
              where: { id: referral.id },
              data: { status: 'CREDITED', creditedAt: new Date() },
            }),
          ]);
        }
      }

      // Vendor referral: paid when the referred vendor completes their FIRST
      // delivery, not when they are approved. Approval is a form review; a
      // delivery is proof the vendor is real and actually serving customers,
      // and it cannot be faked without genuinely delivering water. Paying at
      // approval would reward volume of signups instead of supply.
      if (order.vendorId) await creditVendorReferral(order.vendorId);
    }

    // Notify customer of the status change
    if (order.customerId) {
      if (status === 'OUT_FOR_DELIVERY') sendOrderOutForDeliveryPush(order.customerId, order.orderNumber);
      else if (status === 'DELIVERED') sendOrderDeliveredPush(order.customerId, order.orderNumber);
      else if (status === 'CANCELLED') sendOrderCancelledPush(order.customerId, order.orderNumber);
    }
    const customerPhone = order.guestPhone
      || (order.customerId && (await prisma.user.findUnique({ where: { id: order.customerId } }))?.phone);
    if (customerPhone) {
      if (status === 'OUT_FOR_DELIVERY') sendOrderOutForDeliverySms(customerPhone, order.orderNumber);
      else if (status === 'DELIVERED') sendOrderDeliveredSms(customerPhone, order.orderNumber);
      else if (status === 'CANCELLED') sendOrderCancelledSms(customerPhone, order.orderNumber);
    }

    res.json({ success: true, order: updated });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: list all orders (filterable)
// ─────────────────────────────────────────────
exports.adminListOrders = async (req, res, next) => {
  try {
    const { status, zoneId, vendorId, limit = 50, offset = 0 } = req.query;

    const orders = await prisma.order.findMany({
      where: {
        ...(status && { status }),
        ...(zoneId && { zoneId }),
        ...(vendorId && { vendorId }),
      },
      orderBy: { createdAt: 'desc' },
      take: Number(limit),
      skip: Number(offset),
      include: {
        items: { include: { product: true } },
        zone: true,
        vendor: { select: { id: true, name: true, phone: true } },
        rider: { select: { id: true, name: true, phone: true } },
        customer: { select: { id: true, name: true, phone: true } },
      },
    });

    const total = await prisma.order.count({
      where: {
        ...(status && { status }),
        ...(zoneId && { zoneId }),
        ...(vendorId && { vendorId }),
      },
    });

    res.json({ success: true, orders, total });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// Admin: manually assign vendor to an order
// ─────────────────────────────────────────────
exports.assignVendor = async (req, res, next) => {
  try {
    const { vendorId } = req.body;

    const vendor = await prisma.user.findFirst({
      where: { id: vendorId, role: 'VENDOR', vendorStatus: 'APPROVED' },
    });
    if (!vendor) {
      return res.status(400).json({ success: false, message: 'Invalid or unapproved vendor' });
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: {
        vendorId,
        offeredVendorId: null,
        vendorAcceptDeadline: null,
        assignedAt: new Date(),
        status: 'ASSIGNED',
        statusHistory: {
          create: { status: 'ASSIGNED', changedBy: req.user.id, notes: `Manually assigned to ${vendor.name}` },
        },
      },
      include: { items: { include: { product: true } } },
    });

    if (needsRider(order)) {
      await tryAssignRider(order.id);
    }

    const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
    res.json({ success: true, order: finalOrder });
  } catch (err) {
    next(err);
  }
};
