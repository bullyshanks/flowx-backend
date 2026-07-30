// ═══════════════════════════════════════════════════════════
//  Payment Service — JazzCash / Easypaisa / Safepay
//  Plug real merchant credentials into .env; no code changes needed.
// ═══════════════════════════════════════════════════════════
//
// Same dev-mode contract as sms.service.js: with no credentials configured a
// provider runs in simulation, so the whole checkout flow is exercisable
// locally. The simulated path deliberately still writes Payment rows and
// still goes through settlePayment(), so the only untested thing when real
// credentials arrive is the gateway conversation itself.
//
// Three rules hold everywhere in here, because each one is a way to lose money:
//
//   1. Only a verified callback settles an order. Never the browser redirect,
//      never a client-supplied status.
//   2. The callback amount must match the order total. A gateway that reports
//      a smaller payment than we asked for has not paid the order.
//   3. Settling is idempotent. Gateways retry webhooks, and customers refresh
//      return URLs; the second delivery must change nothing.

const crypto = require('crypto');
const prisma = require('../config/prisma');
const jazzcash = require('./payments/jazzcash');
const easypaisa = require('./payments/easypaisa');
const safepay = require('./payments/safepay');

const ADAPTERS = { JAZZCASH: jazzcash, EASYPAISA: easypaisa, SAFEPAY: safepay };

// PaymentMethod on the order → the provider that collects it. COD and
// BANK_TRANSFER settle out of band and never reach a gateway.
const METHOD_TO_PROVIDER = {
  JAZZCASH: 'JAZZCASH',
  EASYPAISA: 'EASYPAISA',
  CARD: 'SAFEPAY',
};

const providerFor = (paymentMethod) => METHOD_TO_PROVIDER[paymentMethod] || null;
const requiresGateway = (paymentMethod) => Boolean(providerFor(paymentMethod));

function getAdapter(provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw Object.assign(new Error(`Unknown payment provider: ${provider}`), { status: 400 });
  return adapter;
}

// Our reference to the gateway. Unique per attempt (not per order) so a retry
// after an abandoned checkout doesn't collide with the abandoned attempt —
// gateways key idempotency on this and would otherwise replay the old result.
function buildReference(orderNumber) {
  return `${orderNumber.replace(/-/g, '')}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function isDevMode(provider) {
  return !getAdapter(provider).isConfigured();
}

// Where the GATEWAY sends its result. This must be our own API and never the
// frontend: /payments/callback/:provider verifies the signature before settling
// anything, then redirects the customer on to the result page. Handing a
// gateway the frontend URL instead means nothing verifies the callback and no
// order ever settles — the customer pays and the order stays PENDING.
//
// Distinct from returnUrl, which is where the customer's BROWSER should end up.
// For JazzCash and Easypaisa those are the same hop, so the callback URL does
// both jobs; Safepay reports out of band by webhook and only needs the browser
// destination.
function callbackUrlFor(provider) {
  const base = (process.env.API_PUBLIC_URL || 'http://localhost:4000/api').replace(/\/$/, '');
  return `${base}/payments/callback/${provider.toLowerCase()}`;
}

// ── Start a payment ────────────────────────────────────────
// Returns what the frontend needs to hand the customer to the gateway:
// either a GET redirect or a form to auto-POST.
async function initiatePayment(order, { returnUrl, cancelUrl }) {
  const provider = providerFor(order.paymentMethod);
  if (!provider) {
    throw Object.assign(new Error(`${order.paymentMethod} is not settled through a gateway`), { status: 400 });
  }
  if (order.paymentStatus === 'PAID') {
    throw Object.assign(new Error('Order is already paid'), { status: 409 });
  }

  const adapter = getAdapter(provider);
  const reference = buildReference(order.orderNumber);
  const amount = Number(order.total);

  const payment = await prisma.payment.create({
    data: { orderId: order.id, provider, amount, reference, status: 'INITIATED' },
  });

  // ── Dev mode: no credentials, so there is no gateway to send anyone to.
  // Hand back a URL on our own API that settles the attempt when visited,
  // which keeps the frontend's redirect handling identical either way.
  if (isDevMode(provider)) {
    console.log('\n┌─────────────── 💳 PAYMENT (DEV MODE) ───────────────');
    console.log(`│ Provider:  ${provider}`);
    console.log(`│ Order:     ${order.orderNumber}`);
    console.log(`│ Amount:    Rs. ${amount}`);
    console.log(`│ Reference: ${reference}`);
    console.log('│ No credentials set — simulating gateway checkout.');
    console.log('└─────────────────────────────────────────────────────\n');

    const base = process.env.API_PUBLIC_URL || 'http://localhost:4000/api';
    return {
      mode: 'dev',
      provider,
      paymentId: payment.id,
      reference,
      redirect: {
        url: `${base}/payments/simulate/${reference}?redirect=${encodeURIComponent(returnUrl)}`,
        method: 'GET',
        fields: {},
      },
    };
  }

  try {
    const request = await adapter.buildRequest({
      reference,
      amount,
      // Verified server-side settlement target (JazzCash, Easypaisa).
      callbackUrl: callbackUrlFor(provider),
      // Browser destination after checkout (Safepay).
      returnUrl,
      cancelUrl,
      description: `FlowX order ${order.orderNumber}`,
    });

    if (request.providerTxnId) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { providerTxnId: request.providerTxnId },
      });
    }

    return {
      mode: 'live',
      provider,
      paymentId: payment.id,
      reference,
      redirect: { url: request.url, method: request.method, fields: request.fields },
    };
  } catch (err) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failureReason: `Initiation failed: ${err.message}`.slice(0, 500) },
    });
    throw Object.assign(new Error(`Could not reach ${provider}. Please try again or choose Cash on Delivery.`), { status: 502 });
  }
}

// ── Settle a payment ───────────────────────────────────────
// The single place an order becomes PAID. Everything else (callbacks, the
// dev simulator) funnels through here so the idempotency and amount checks
// can't be bypassed by adding a new entry point later.
//
// Returns { settled, alreadySettled, reason } rather than throwing on a
// rejected callback: gateways retry anything that isn't a 200, and retrying
// a forged or mismatched callback forever helps nobody.
async function settlePayment(parsed, rawPayload) {
  const { reference, paid, providerTxnId, amount, failureReason, signatureValid } = parsed;

  if (!reference) return { settled: false, reason: 'Callback carried no reference' };

  const payment = await prisma.payment.findUnique({
    where: { reference },
    include: { order: true },
  });
  if (!payment) return { settled: false, reason: `No payment attempt for reference ${reference}` };

  // Record the gateway's account of events even when we reject it — an
  // unexplained failed payment is a support ticket, and this is the evidence.
  const audit = { rawCallback: rawPayload ?? undefined, providerTxnId: providerTxnId || payment.providerTxnId };

  if (!signatureValid) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { ...audit, status: 'FAILED', failureReason: 'Signature verification failed' },
    });
    return { settled: false, reason: 'Signature verification failed' };
  }

  // Terminal already — a retried webhook, or the customer refreshing the
  // return URL. Report success so the gateway stops retrying, change nothing.
  if (payment.status === 'PAID') {
    return { settled: true, alreadySettled: true, orderId: payment.orderId };
  }

  if (!paid) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { ...audit, status: 'FAILED', failureReason: (failureReason || 'Payment not completed').slice(0, 500) },
    });
    return { settled: false, reason: failureReason || 'Payment not completed', orderId: payment.orderId };
  }

  // Underpayment must never mark an order paid. Allow a 1-rupee tolerance for
  // gateways that round paisa, but nothing beyond that.
  if (amount != null && Math.abs(Number(amount) - Number(payment.amount)) > 1) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        ...audit,
        status: 'FAILED',
        failureReason: `Amount mismatch: gateway reported ${amount}, expected ${payment.amount}`,
      },
    });
    return { settled: false, reason: 'Amount mismatch', orderId: payment.orderId };
  }

  // Claim the attempt with a compare-and-swap so two callbacks arriving at
  // once can't both mark the order paid — same pattern as the referral
  // discount claim in order.controller.
  const claimed = await prisma.payment.updateMany({
    where: { id: payment.id, status: { not: 'PAID' } },
    data: { ...audit, status: 'PAID', paidAt: new Date(), failureReason: null },
  });
  if (claimed.count === 0) {
    return { settled: true, alreadySettled: true, orderId: payment.orderId };
  }

  await prisma.order.update({
    where: { id: payment.orderId },
    data: {
      paymentStatus: 'PAID',
      transactionId: providerTxnId || reference,
      statusHistory: { create: { status: payment.order.status, notes: `Payment received via ${payment.provider}` } },
    },
  });

  return { settled: true, alreadySettled: false, orderId: payment.orderId, provider: payment.provider };
}

// Parse a provider's callback into the shape settlePayment expects.
// Safepay verifies against the raw body, the other two sign their fields.
function parseProviderCallback(provider, payload, { rawBody, signatureHeader } = {}) {
  const adapter = getAdapter(provider);
  if (provider === 'SAFEPAY') {
    const signatureValid = adapter.verifyWebhookSignature(rawBody, signatureHeader);
    return adapter.parseCallback(payload, { signatureValid });
  }
  return adapter.parseCallback(payload);
}

module.exports = {
  ADAPTERS,
  providerFor,
  requiresGateway,
  isDevMode,
  initiatePayment,
  settlePayment,
  parseProviderCallback,
  buildReference,
};
