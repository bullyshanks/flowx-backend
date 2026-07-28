// ═══════════════════════════════════════════════════════════
//  Payment Controller — initiate, gateway callbacks, status
// ═══════════════════════════════════════════════════════════

const prisma = require('../config/prisma');
const paymentService = require('../services/payment.service');
const { sendPaymentReceivedSms } = require('../services/sms.service');
const { sendPaymentReceivedPush } = require('../services/push.service');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim();

// Guests have no account, so ownership is proved by the phone they ordered
// with rather than a JWT. Order numbers are guessable (a 5-digit suffix), so
// the number alone must never be enough to act on someone else's order.
function canAccessOrder(order, req) {
  if (req.user) {
    if (req.user.role === 'ADMIN') return true;
    if (order.customerId && order.customerId === req.user.id) return true;
  }
  const claimed = String(req.body?.guestPhone || req.query?.guestPhone || '').trim();
  if (order.guestPhone && claimed && order.guestPhone === claimed) return true;
  return false;
}

// ─────────────────────────────────────────────
// POST /payments/initiate — start a gateway checkout
// ─────────────────────────────────────────────
exports.initiate = async (req, res, next) => {
  try {
    const { orderId, orderNumber } = req.body;
    if (!orderId && !orderNumber) {
      return res.status(400).json({ success: false, message: 'orderId or orderNumber is required' });
    }

    const order = await prisma.order.findFirst({
      where: orderId ? { id: orderId } : { orderNumber },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!canAccessOrder(order, req)) {
      return res.status(403).json({ success: false, message: 'Not your order' });
    }
    if (order.status === 'CANCELLED') {
      return res.status(409).json({ success: false, message: 'Order was cancelled' });
    }
    if (!paymentService.requiresGateway(order.paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: `${order.paymentMethod} orders are not paid online`,
      });
    }

    const result = await paymentService.initiatePayment(order, {
      returnUrl: `${FRONTEND_URL}/payment/result?order=${order.orderNumber}`,
      cancelUrl: `${FRONTEND_URL}/payment/result?order=${order.orderNumber}&cancelled=1`,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
};

// Shared tail for every settlement path: notify on a first-time success.
async function notifyIfNewlyPaid(result) {
  if (!result.settled || result.alreadySettled || !result.orderId) return;
  const order = await prisma.order.findUnique({
    where: { id: result.orderId },
    select: { orderNumber: true, total: true, customerId: true, guestPhone: true, customer: { select: { phone: true } } },
  });
  if (!order) return;
  const phone = order.guestPhone || order.customer?.phone;
  if (phone) sendPaymentReceivedSms(phone, order.orderNumber, order.total);
  if (order.customerId) sendPaymentReceivedPush(order.customerId, order.orderNumber, order.total);
}

// ─────────────────────────────────────────────
// POST/GET /payments/callback/:provider — gateway server-to-server + return URL
// ─────────────────────────────────────────────
// Always answers 200 once the callback has been processed, including when it
// is rejected. Gateways retry non-2xx responses, and endlessly retrying a
// forged or mismatched callback achieves nothing — the rejection is recorded
// on the Payment row instead.
exports.callback = async (req, res, next) => {
  try {
    const provider = String(req.params.provider || '').toUpperCase();
    if (!paymentService.ADAPTERS[provider]) {
      return res.status(404).json({ success: false, message: 'Unknown provider' });
    }

    const payload = req.method === 'GET' ? req.query : (req.parsedBody || req.body);
    const parsed = paymentService.parseProviderCallback(provider, payload, {
      rawBody: req.rawBody,
      signatureHeader: req.headers['x-sfpy-signature'] || req.headers['x-safepay-signature'],
    });

    const result = await paymentService.settlePayment(parsed, payload);
    await notifyIfNewlyPaid(result);

    // A browser landing on the return URL wants a page, not JSON.
    const isBrowserRedirect = req.method === 'GET';
    if (isBrowserRedirect) {
      const orderNumber = parsed.reference
        ? (await prisma.payment.findUnique({ where: { reference: parsed.reference }, select: { order: { select: { orderNumber: true } } } }))?.order?.orderNumber
        : null;
      const status = result.settled ? 'success' : 'failed';
      return res.redirect(
        `${FRONTEND_URL}/payment/result?status=${status}${orderNumber ? `&order=${orderNumber}` : ''}`
      );
    }

    res.json({ success: true, settled: result.settled, message: result.reason || 'Processed' });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /payments/status/:orderNumber — authoritative payment state
// ─────────────────────────────────────────────
// The result page reads this rather than trusting its own query string, so a
// customer editing ?status=success in the URL bar changes nothing.
exports.status = async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({
      where: { orderNumber: req.params.orderNumber },
      select: {
        id: true, orderNumber: true, total: true, paymentMethod: true, paymentStatus: true,
        status: true, customerId: true, guestPhone: true,
        payments: {
          select: { provider: true, status: true, failureReason: true, paidAt: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!canAccessOrder(order, req)) {
      return res.status(403).json({ success: false, message: 'Not your order' });
    }

    const { customerId, guestPhone, id, ...safe } = order;
    res.json({ success: true, order: safe });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────
// GET /payments/simulate/:reference — DEV ONLY
// ─────────────────────────────────────────────
// Stands in for the gateway's hosted checkout when no credentials are set, so
// the full redirect → settle → return journey is exercisable locally. Refuses
// to run in production, and refuses to run for a provider that IS configured
// — otherwise it would be a way to mark real orders paid for free.
exports.simulate = async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const payment = await prisma.payment.findUnique({ where: { reference: req.params.reference } });
    if (!payment) return res.status(404).json({ success: false, message: 'Unknown payment reference' });

    if (!paymentService.isDevMode(payment.provider)) {
      return res.status(403).json({
        success: false,
        message: `${payment.provider} has real credentials configured — refusing to simulate a payment`,
      });
    }

    const outcome = req.query.outcome === 'fail' ? 'fail' : 'success';
    const result = await paymentService.settlePayment(
      {
        signatureValid: true,
        reference: payment.reference,
        providerTxnId: `DEV-${payment.reference}`,
        amount: Number(payment.amount),
        paid: outcome === 'success',
        failureReason: outcome === 'fail' ? 'Simulated failure' : null,
      },
      { simulated: true, outcome }
    );
    await notifyIfNewlyPaid(result);

    const redirect = req.query.redirect;
    if (redirect) {
      const sep = redirect.includes('?') ? '&' : '?';
      return res.redirect(`${redirect}${sep}status=${result.settled ? 'success' : 'failed'}`);
    }
    res.json({ success: true, simulated: true, settled: result.settled, reason: result.reason });
  } catch (err) {
    next(err);
  }
};
