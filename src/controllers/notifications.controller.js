// ═══════════════════════════════════════════════════════════
//  Notifications Controller — Web Push subscription management.
//  Any logged-in role can subscribe (customer, vendor, rider, admin
//  all receive push notifications for their own events).
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');

// web-push hands `endpoint` to the underlying HTTP client verbatim with no
// host allowlist of its own — an unvalidated endpoint turns any event that
// triggers a push (placing an order, etc.) into a blind server-side request
// to a host of the caller's choosing. Restrict to the push services actually
// in use; add an origin here before shipping support for a new browser.
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome/Edge/Android
  // Legacy GCM host. Older Chrome builds still hand out
  // https://android.googleapis.com/gcm/send/<token> instead of the fcm.* one,
  // and leaving it out silently rejects those users at subscribe time — found
  // by driving the real subscribe flow in a browser rather than by reading.
  'android.googleapis.com',
  'updates.push.services.mozilla.com', // Firefox
  'notify.windows.com', 'wns2-*.notify.windows.com', // legacy Edge/WNS
  'push.apple.com', // Safari/WebKit (web.push.apple.com and *.push.apple.com subdomains)
];

function isAllowedPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return ALLOWED_PUSH_HOSTS.some((pattern) => {
    if (pattern.includes('*')) {
      const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$');
      return re.test(url.hostname);
    }
    return url.hostname === pattern || url.hostname.endsWith(`.${pattern}`);
  });
}

// ─────────────────────────────────────────────
// POST /notifications/subscribe — { endpoint, keys: { p256dh, auth } }
// Upsert by endpoint (same browser/device re-subscribing updates its own
// row). A different account can never take over an endpoint someone else
// already registered — without that check, learning another user's
// (high-entropy but not secret) endpoint URL would silently rebind their
// device to the attacker's notifications.
// ─────────────────────────────────────────────
exports.subscribe = async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, message: 'endpoint and keys.{p256dh,auth} are required' });
    }
    if (!isAllowedPushEndpoint(endpoint)) {
      return res.status(400).json({ success: false, message: 'Unrecognized push endpoint' });
    }

    const existing = await prisma.pushSubscription.findUnique({ where: { endpoint } });
    if (existing && existing.userId !== req.user.id) {
      return res.status(409).json({ success: false, message: 'This subscription belongs to another account' });
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
