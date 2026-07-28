// ── Subscription management ──
const prisma = require('../config/prisma');
const { cancelUnfulfilledOrders, advance } = require('../services/subscription.service');

// Methods that settle without the customer being present at a checkout.
// Anything gateway-backed needs a saved mandate we don't have — see create().
const SUBSCRIPTION_PAYMENT_METHODS = ['COD', 'BANK_TRANSFER'];

// Pausing never advances nextDeliveryDate (the sweep just skips non-ACTIVE
// subscriptions), so after a lapsed pause it's stale in the past. The sweep's
// advance() only steps one cycle at a time, so left as-is this would generate
// one catch-up order per sweep tick until the backlog clears — a customer
// resuming after a multi-day pause would get flooded with several real
// orders within the hour instead of just their next delivery. Fast-forward
// to the next cycle from now instead of replaying every missed one.
function resumeDeliveryDate(sub) {
  return sub.nextDeliveryDate <= new Date() ? advance(new Date(), sub.frequency) : sub.nextDeliveryDate;
}

exports.create = async (req, res, next) => {
  try {
    const {
      productId, zoneId, quantity, frequency,
      preferredTimeSlot, deliveryAddress, paymentMethod,
    } = req.body;

    if (!productId || !zoneId || !quantity || !frequency || !deliveryAddress || !paymentMethod) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Subscriptions used to skip every check placeOrder makes, and because
    // processSubscription writes its orders straight to the database rather
    // than going back through placeOrder, nothing downstream caught it either.
    // A subscription for 3 units of a 4-minimum product quietly generated an
    // invalid order every cycle, forever. Validate the same things here.
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Quantity must be a positive whole number' });
    }
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) {
      return res.status(400).json({ success: false, message: 'Frequency must be DAILY, WEEKLY or MONTHLY' });
    }
    // Recurring deliveries settle out of band only. The gateways collect a
    // single payment against a checkout the customer is present for — there is
    // no saved mandate or card on file, so a subscription paying by JazzCash,
    // Easypaisa or card generated an order every cycle that nobody was ever
    // asked to pay: delivered, unpaid, indefinitely. Offering the option was
    // worse than not having it. Revisit when recurring billing exists.
    if (!SUBSCRIPTION_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: 'Subscriptions can only be paid by Cash on Delivery or Bank Transfer',
      });
    }
    if (!String(deliveryAddress).trim()) {
      return res.status(400).json({ success: false, message: 'Delivery address is required' });
    }

    const product = await prisma.product.findFirst({ where: { id: productId, isActive: true } });
    if (!product) {
      return res.status(400).json({ success: false, message: 'Product not available' });
    }
    if (quantity < product.minQuantity) {
      return res.status(400).json({
        success: false,
        message: `${product.name} requires minimum ${product.minQuantity} units`,
      });
    }

    const zone = await prisma.zone.findFirst({ where: { id: zoneId, isActive: true } });
    if (!zone) {
      return res.status(400).json({ success: false, message: 'Invalid zone' });
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
        deliveryAddress: String(deliveryAddress).trim(),
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
    const existing = await prisma.subscription.findFirst({
      where: { id: req.params.id, customerId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Subscription not found' });
    }
    const sub = await prisma.subscription.update({
      where: { id: existing.id },
      data: { status: 'ACTIVE', nextDeliveryDate: resumeDeliveryDate(existing) },
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
    const existing = await prisma.subscription.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Subscription not found' });
    }
    const sub = await prisma.subscription.update({
      where: { id: existing.id },
      data: { status: 'ACTIVE', nextDeliveryDate: resumeDeliveryDate(existing) },
    });
    res.json({ success: true, subscription: sub });
  } catch (err) {
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
