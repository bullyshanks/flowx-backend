// ── Safepay (cards + wallets) ──
// Unlike JazzCash/Easypaisa, Safepay is API-first: we create a tracker
// server-side, then send the customer to a checkout URL carrying that token.
// Nothing sensitive rides in the browser, so buildRequest here is async and
// makes a real outbound call.
//
// Settlement is confirmed by webhook, not by the browser redirect. The
// redirect only tells us where to put the customer next — treating it as
// proof of payment would let anyone mark an order paid by visiting a URL.
//
// Docs: https://getsafepay.readme.io/
const crypto = require('crypto');
const axios = require('axios');

const API_KEY = process.env.SAFEPAY_API_KEY;
const WEBHOOK_SECRET = process.env.SAFEPAY_WEBHOOK_SECRET;
const API_URL = process.env.SAFEPAY_API_URL || 'https://sandbox.api.getsafepay.com';
const CHECKOUT_URL = process.env.SAFEPAY_CHECKOUT_URL || 'https://sandbox.getsafepay.com/embedded';
const ENVIRONMENT = process.env.SAFEPAY_ENVIRONMENT || 'sandbox';

const isConfigured = () => Boolean(API_KEY && WEBHOOK_SECRET);

async function buildRequest({ reference, amount, returnUrl, cancelUrl }) {
  const { data } = await axios.post(
    `${API_URL}/order/v1/init`,
    {
      merchant_api_key: API_KEY,
      intent: 'CYBERSOURCE',
      mode: 'payment',
      currency: 'PKR',
      amount: Number(amount),
    },
    { timeout: 15000 }
  );

  const tracker = data?.data?.tracker;
  if (!tracker) throw new Error('Safepay did not return a tracker');

  const params = new URLSearchParams({
    tracker,
    env: ENVIRONMENT,
    source: 'flowx',
    order_id: reference,
    redirect_url: returnUrl,
    ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
  });

  // GET redirect rather than a form POST — the token is already server-side.
  return { url: `${CHECKOUT_URL}?${params}`, method: 'GET', fields: {}, providerTxnId: tracker };
}

// Webhooks are signed over the raw request body, so the signature must be
// checked against the exact bytes received — re-serialising the parsed JSON
// reorders keys and the comparison fails for reasons that look like tampering.
// See the express.raw() mount in payment.routes.js.
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha512', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const received = String(signatureHeader);
  // Constant-time compare; timingSafeEqual throws on length mismatch.
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function parseCallback(payload, { signatureValid = false } = {}) {
  const state = String(payload?.data?.state || payload?.state || '').toLowerCase();
  const tracker = payload?.data?.tracker || payload?.tracker;
  return {
    signatureValid,
    hasSignature: true,
    reference: payload?.data?.order_id || payload?.order_id,
    providerTxnId: tracker,
    amount: payload?.data?.amount != null ? Number(payload.data.amount) : null,
    paid: state === 'paid' || state === 'completed' || state === 'tracker_ended',
    failureReason: ['paid', 'completed', 'tracker_ended'].includes(state) ? null : `State ${state || 'unknown'}`,
  };
}

module.exports = {
  name: 'SAFEPAY', isConfigured, buildRequest, parseCallback, verifyWebhookSignature,
};
