// ── Subscription management ──
const prisma = require('../config/prisma');
const { cancelUnfulfilledOrders } = require('../services/subscription.service');

exports.create = async (req, res, next) => {
  try {
    const {
      productId, zoneId, quantity, frequency,
      preferredTimeSlot, deliveryAddress, paymentMethod,
    } = req.body;

    if (!productId || !zoneId || !quantity || !frequency || !deliveryAddress || !paymentMethod) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Calculate next delivery based on frequency
    const nextDelivery = new Date();
    if (frequency === 'DAILY') nextDelivery.setDate(nextDelivery.getDate() + 1);
    else if (frequency === 'WEEKLY') nextDelivery.setDate(nextDelivery.getDate() + 7);
    else if (frequency === 'MONTHLY') nextDelivery.setMonth(nextDelivery.getMonth() + 1);

    const subscription = await prisma.subscription.create({
      data: {
        customerId: req.user.id,
        productId,
        zoneId,
        quantity,
        frequency,
        preferredTimeSlot,
        deliveryAddress,
        paymentMethod,
        nextDeliveryDate: nextDelivery,
      },
      include: { product: true, zone: true },
    });

    res.status(201).json({ success: true, subscription });
  } catch (err) {
    next(err);
  }
};

exports.mySubscriptions = async (req, res, next) => {
  try {
    const subs = await prisma.subscription.findMany({
      where: { customerId: req.user.id },
      include: { product: true, zone: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, subscriptions: subs });
  } catch (err) {
    next(err);
  }
};

exports.pause = async (req, res, next) => {
  try {
    const sub = await prisma.subscription.update({
      where: { id: req.params.id, customerId: req.user.id },
      data: { status: 'PAUSED' },
    });
    res.json({ success: true, subscription: sub });
  } catch (err) {
    next(err);
  }
};

exports.resume = async (req, res, next) => {
  try {
    const sub = await prisma.subscription.update({
      where: { id: req.params.id, customerId: req.user.id },
      data: { status: 'ACTIVE' },
    });
    res.json({ success: true, subscription: sub });
  } catch (err) {
    next(err);
  }
};

exports.cancel = async (req, res, next) => {
  try {
    const sub = await prisma.subscription.update({
      where: { id: req.params.id, customerId: req.user.id },
      data: { status: 'CANCELLED', endDate: new Date() },
    });
    await cancelUnfulfilledOrders(sub.id);
    res.json({ success: true, subscription: sub });
  } catch (err) {
    next(err);
  }
};

// Admin: list all subscriptions
exports.adminList = async (req, res, next) => {
  try {
    const subs = await prisma.subscription.findMany({
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        product: true, zone: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, subscriptions: subs });
  } catch (err) {
    next(err);
  }
};

// Admin: pause/resume/cancel any customer's subscription — the customer-self
// endpoints above are scoped to req.user.id and can't reach these; admin
// needs to be able to act on a customer's behalf (support request, stuck
// subscription, etc).
exports.adminPause = async (req, res, next) => {
  try {
    const sub = await prisma.subscription.update({
      where: { id: req.params.id },
      data: { status: 'PAUSED' },
    });
    res.json({ success: true, subscription: sub });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Subscription not found' });
    next(err);
  }
};

exports.adminResume = async (req, res, next) => {
  try {
    const sub = await prisma.subscription.update({
      where: { id: req.params.id },
      data: { status: 'ACTIVE' },
    });
    res.json({ success: true, subscription: sub });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Subscription not found' });
    next(err);
  }
};

exports.adminCancel = async (req, res, next) => {
  try {
    const sub = await prisma.subscription.update({
      where: { id: req.params.id },
      data: { status: 'CANCELLED', endDate: new Date() },
    });
    await cancelUnfulfilledOrders(sub.id);
    res.json({ success: true, subscription: sub });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Subscription not found' });
    next(err);
  }
};
