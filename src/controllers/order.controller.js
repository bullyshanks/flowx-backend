// ═══════════════════════════════════════════════════════════
//  Order Controller
//  Place order (guest or auth), track, update status, list
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const { generateOrderNumber } = require('../utils/generators');
const { sendOrderConfirmationSms, sendOrderAssignedSms } = require('../services/sms.service');

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
      // guest fields
      guestName, guestPhone,
    } = req.body;

    // ─── Validate ──
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item required' });
    }
    if (!zoneId || !deliveryAddress || !paymentMethod) {
      return res.status(400).json({ success: false, message: 'Zone, address, and payment method required' });
    }

    const isGuest = !req.user;
    if (isGuest && (!guestName || !guestPhone)) {
      return res.status(400).json({ success: false, message: 'Guest name and phone required' });
    }

    // ─── Verify zone exists ──
    const zone = await prisma.zone.findUnique({ where: { id: zoneId } });
    if (!zone) {
      return res.status(400).json({ success: false, message: 'Invalid zone' });
    }

    // ─── Fetch products & calculate total ──
    const productIds = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isActive: true },
    });

    if (products.length !== productIds.length) {
      return res.status(400).json({ success: false, message: 'One or more products not available' });
    }

    let subtotal = 0;
    const orderItems = items.map((i) => {
      const product = products.find((p) => p.id === i.productId);
      if (i.quantity < product.minQuantity) {
        throw Object.assign(
          new Error(`${product.name} requires minimum ${product.minQuantity} units`),
          { status: 400 }
        );
      }
      const lineTotal = Number(product.price) * i.quantity;
      subtotal += lineTotal;
      return {
        productId: product.id,
        quantity: i.quantity,
        unitPrice: product.price,
        total: lineTotal,
      };
    });

    const total = subtotal; // free delivery for now

    // ─── Create order ──
    const order = await prisma.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        customerId: isGuest ? null : req.user.id,
        guestName: isGuest ? guestName : null,
        guestPhone: isGuest ? guestPhone : null,
        guestAddress: isGuest ? deliveryAddress : null,
        zoneId,
        deliveryAddress,
        deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
        deliveryTimeSlot,
        paymentMethod,
        subtotal,
        total,
        status: 'PENDING',
        items: { create: orderItems },
        statusHistory: { create: [{ status: 'PENDING', notes: 'Order placed' }] },
      },
      include: { items: { include: { product: true } }, zone: true },
    });

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
// Vendor: get orders assigned to me OR available in my zone
// ─────────────────────────────────────────────
exports.vendorOrders = async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { vendorId: req.user.id },
          { vendorId: null, zoneId: req.user.zoneId, status: { in: ['PENDING', 'CONFIRMED'] } },
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
// Vendor: accept an order (assign to self)
// ─────────────────────────────────────────────
exports.acceptOrder = async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.zoneId !== req.user.zoneId) {
      return res.status(403).json({ success: false, message: 'Order is not in your zone' });
    }
    if (order.vendorId) {
      return res.status(409).json({ success: false, message: 'Order already assigned' });
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        vendorId: req.user.id,
        assignedAt: new Date(),
        status: 'ASSIGNED',
        statusHistory: { create: { status: 'ASSIGNED', changedBy: req.user.id, notes: 'Vendor accepted' } },
      },
    });

    // Notify customer
    const customerPhone = order.guestPhone || (await prisma.user.findUnique({ where: { id: order.customerId } }))?.phone;
    if (customerPhone) sendOrderAssignedSms(customerPhone, order.orderNumber, req.user.name);

    res.json({ success: true, order: updated });
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

    // Vendor can only update their own orders. Admin can update any.
    if (req.user.role === 'VENDOR' && order.vendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not your order' });
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
        assignedAt: new Date(),
        status: 'ASSIGNED',
        statusHistory: {
          create: { status: 'ASSIGNED', changedBy: req.user.id, notes: `Manually assigned to ${vendor.name}` },
        },
      },
    });

    res.json({ success: true, order });
  } catch (err) {
    next(err);
  }
};
