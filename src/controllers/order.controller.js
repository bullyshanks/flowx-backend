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
const { createDeliveryLedgerEntries } = require('../services/ledger.service');
const {
  needsRider, tryAssignVendor, tryAssignRider, reassignIfExpired, findNextVendor,
} = require('../services/assignment.service');

// Mirrors the frontend's validatePhone (src/lib/utils.ts) so guest orders
// placed directly against the API get the same check the cart UI enforces.
const PK_PHONE_REGEX = /^(\+92|0)?3\d{9}$/;

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

    // ─── Verify zone exists ──
    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(400).json({ success: false, message: 'Invalid zone' });
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

    const total = subtotal; // free delivery for now

    // ─── Create order ──
    const trimmedAddress = String(deliveryAddress).trim();
    const order = await prisma.order.create({
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
        total,
        status: 'PENDING',
        items: { create: orderItems },
        statusHistory: { create: [{ status: 'PENDING', notes: 'Order placed' }] },
      },
      include: { items: { include: { product: true } }, zone: true },
    });

    // ─── Offer to the first eligible vendor in the zone ──
    // Self-pickup orders still need a vendor to prepare/hold the order.
    await tryAssignVendor(order.id);

    // ─── Send confirmation SMS ──
    const phone = isGuest ? guestPhone : req.user.phone;
    sendOrderConfirmationSms(phone, order.orderNumber);

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
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
        statusHistory: { orderBy: { createdAt: 'asc' } },
        vendor: { select: { name: true, phone: true } },
        rider: { select: { name: true, phone: true } },
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
      include: { items: { include: { product: true } }, zone: true },
    });
    res.json({ success: true, orders });
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
      include: { items: { include: { product: true } }, zone: true, vendor: { select: { name: true, phone: true } } },
    });
    res.json({ success: true, orders });
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
    }

    // Notify customer of the status change
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
