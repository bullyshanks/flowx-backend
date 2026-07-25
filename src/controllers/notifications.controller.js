// ═══════════════════════════════════════════════════════════
//  Notifications Controller — Web Push subscription management.
//  Any logged-in role can subscribe (customer, vendor, rider, admin
//  all receive push notifications for their own events).
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');

// ─────────────────────────────────────────────
// POST /notifications/subscribe — { endpoint, keys: { p256dh, auth } }
// Upsert by endpoint (same browser/device re-subscribing, or a different
// user taking over a shared device, both just update the row).
// ─────────────────────────────────────────────
exports.subscribe = async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, message: 'endpoint and keys.{p256dh,auth} are required' });
    }

    const subscription = await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth },
      create: { userId: req.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });

    res.status(201).json({ success: true, subscription: { id: subscription.id } });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// DELETE /notifications/subscribe — { endpoint }
// ─────────────────────────────────────────────
exports.unsubscribe = async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ success: false, message: 'endpoint is required' });
    }

    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};
