// Payment initiation, the dev-mode settlement path, and the three rules that
// keep money safe: only verified callbacks settle, amounts must match, and
// settling twice must change nothing.
//
// Signature verification is exercised in-process against the adapters with
// credentials injected, because with no credentials configured the providers
// run in simulation and never sign anything.
const {
  prisma, createReporter, get, post, json, otpLogin, cleanupTestUsers, BASE,
} = require('./helpers');

const CUSTOMER = '03699666001';
const OTHER = '03699666002';
const PHONES = [CUSTOMER, OTHER];

// Load an adapter with credentials present. Adapters read env at require time,
// so the cache entry has to go before re-requiring.
function loadAdapterWithCredentials(relPath, env) {
  const saved = {};
  Object.entries(env).forEach(([k, v]) => { saved[k] = process.env[k]; process.env[k] = v; });
  const resolved = require.resolve(relPath);
  delete require.cache[resolved];
  const adapter = require(relPath);
  return {
    adapter,
    restore() {
      Object.entries(saved).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      });
      delete require.cache[resolved];
    },
  };
}

async function run() {
  const { check, summary } = createReporter('payment');
  await cleanupTestUsers(PHONES);

  const paymentService = require('../../src/services/payment.service');
  const customer = await otpLogin(CUSTOMER);
  const zones = (await json(await get('/products/zones'))).zones;
  const product = (await json(await get('/products'))).products.find((p) => p.minQuantity === 1);

  const placeOrder = async (paymentMethod, token = customer.token) => json(await post('/orders', {
    items: [{ productId: product.id, quantity: product.minQuantity }],
    zoneId: zones[0].id, deliveryAddress: 'Payment Smoke', paymentMethod,
  }, token));

  // ── COD never touches a gateway ──
  const cod = await placeOrder('COD');
  const codInit = await post('/payments/initiate', { orderId: cod.order.id }, customer.token);
  check('COD order cannot be paid online', codInit.status === 400, `HTTP ${codInit.status}`);

  // ── Initiation ──
  const order = await placeOrder('JAZZCASH');
  const init = await json(await post('/payments/initiate', { orderId: order.order.id }, customer.token));
  check('POST /payments/initiate returns a redirect', Boolean(init.redirect?.url), init.mode);
  check('  attempt recorded as INITIATED',
    (await prisma.payment.count({ where: { orderId: order.order.id, status: 'INITIATED' } })) === 1);
  check('  order still unpaid until the gateway confirms',
    (await prisma.order.findUnique({ where: { id: order.order.id } })).paymentStatus === 'PENDING');

  // ── Another customer must not be able to pay, or even inspect, this order ──
  const other = await otpLogin(OTHER);
  const stolen = await post('/payments/initiate', { orderId: order.order.id }, other.token);
  check('another customer cannot initiate payment', stolen.status === 403, `HTTP ${stolen.status}`);
  const peeked = await get(`/payments/status/${order.order.orderNumber}`, other.token);
  check('another customer cannot read payment status', peeked.status === 403, `HTTP ${peeked.status}`);

  // ── Dev-mode settlement, following the redirect exactly as a browser would ──
  const settled = await fetch(init.redirect.url, { redirect: 'manual' });
  check('dev checkout redirects back to the site', settled.status === 302,
    `HTTP ${settled.status}`);
  const afterPay = await prisma.order.findUnique({ where: { id: order.order.id } });
  check('order marked PAID after settlement', afterPay.paymentStatus === 'PAID', afterPay.paymentStatus);
  check('  transactionId recorded', Boolean(afterPay.transactionId), afterPay.transactionId);

  // ── Replay must not create a second successful payment ──
  await fetch(init.redirect.url, { redirect: 'manual' });
  check('replayed settlement is idempotent',
    (await prisma.payment.count({ where: { orderId: order.order.id, status: 'PAID' } })) === 1);

  // ── Status endpoint reflects the truth ──
  const status = await json(await get(`/payments/status/${order.order.orderNumber}`, customer.token));
  check('GET /payments/status reports PAID', status.order?.paymentStatus === 'PAID');
  check('  status response omits internal ids', status.order?.customerId === undefined && status.order?.id === undefined);

  // ── Paying an already-paid order is refused ──
  const again = await post('/payments/initiate', { orderId: order.order.id }, customer.token);
  check('cannot re-pay a settled order', again.status === 409, `HTTP ${again.status}`);

  // ── Rule: an unverified callback settles nothing ──
  const unsignedOrder = await placeOrder('JAZZCASH');
  const unsignedInit = await json(await post('/payments/initiate', { orderId: unsignedOrder.order.id }, customer.token));
  const forged = await paymentService.settlePayment({
    signatureValid: false,
    reference: unsignedInit.reference,
    providerTxnId: 'FORGED',
    amount: Number(unsignedOrder.order.total),
    paid: true,
  }, { forged: true });
  check('unsigned callback rejected', forged.settled === false, forged.reason);
  check('  order left unpaid',
    (await prisma.order.findUnique({ where: { id: unsignedOrder.order.id } })).paymentStatus === 'PENDING');

  // ── Rule: underpayment never marks an order paid ──
  const shortOrder = await placeOrder('JAZZCASH');
  const shortInit = await json(await post('/payments/initiate', { orderId: shortOrder.order.id }, customer.token));
  const short = await paymentService.settlePayment({
    signatureValid: true,
    reference: shortInit.reference,
    providerTxnId: 'SHORT',
    amount: 1, // gateway claims Rs.1 against a Rs.300 order
    paid: true,
  }, { tampered: true });
  check('amount mismatch rejected', short.settled === false, short.reason);
  check('  order left unpaid',
    (await prisma.order.findUnique({ where: { id: shortOrder.order.id } })).paymentStatus === 'PENDING');

  // ── Callback for an unknown reference is ignored, not crashed on ──
  const unknown = await paymentService.settlePayment({
    signatureValid: true, reference: 'NOT-A-REAL-REFERENCE', paid: true, amount: 100,
  }, {});
  check('unknown reference ignored', unknown.settled === false, unknown.reason);

  // ── JazzCash signing round-trip, and tamper detection ──
  {
    const { adapter, restore } = loadAdapterWithCredentials('../../src/services/payments/jazzcash', {
      JAZZCASH_MERCHANT_ID: 'TESTMERCHANT',
      JAZZCASH_PASSWORD: 'testpassword',
      JAZZCASH_INTEGRITY_SALT: 'testsalt123456',
    });
    const built = adapter.buildRequest({
      reference: 'SMOKE123', amount: 300, returnUrl: 'https://example.com/r', description: 'test',
    });
    check('JazzCash builds a signed request', Boolean(built.fields.pp_SecureHash), built.method);
    check('  amount sent in paisa', built.fields.pp_Amount === '30000', built.fields.pp_Amount);

    // JazzCash signs the payload it actually returns, so build the response
    // field set first and sign that — appending a field after signing would
    // invalidate the hash for reasons that say nothing about the adapter.
    const signResponse = (extra) => {
      const { pp_SecureHash: _drop, ...rest } = built.fields;
      const response = { ...rest, pp_ResponseCode: '000', pp_ResponseMessage: 'Success', ...extra };
      response.pp_SecureHash = adapter.sign(response);
      return response;
    };

    const good = adapter.parseCallback(signResponse());
    check('  valid signature accepted', good.signatureValid === true && good.paid === true,
      `signatureValid=${good.signatureValid} paid=${good.paid}`);
    check('  callback amount converted back from paisa', good.amount === 300, String(good.amount));

    const tampered = signResponse();
    tampered.pp_Amount = '1'; // edited in flight, after the gateway signed it
    check('  tampered amount breaks the signature',
      adapter.parseCallback(tampered).signatureValid === false);

    const failed = adapter.parseCallback(signResponse({ pp_ResponseCode: '999', pp_ResponseMessage: 'Declined' }));
    check('  non-zero response code is not a payment', failed.paid === false, failed.failureReason);
    restore();
  }

  // ── Safepay webhook signature is checked over the raw body ──
  {
    const { adapter, restore } = loadAdapterWithCredentials('../../src/services/payments/safepay', {
      SAFEPAY_API_KEY: 'test-key',
      SAFEPAY_WEBHOOK_SECRET: 'test-secret',
    });
    const crypto = require('crypto');
    const body = JSON.stringify({ data: { state: 'paid', order_id: 'SMOKE123', tracker: 'trk_1' } });
    const validSig = crypto.createHmac('sha512', 'test-secret').update(body).digest('hex');
    check('Safepay accepts a correctly signed webhook',
      adapter.verifyWebhookSignature(Buffer.from(body), validSig) === true);
    check('  rejects a wrong signature',
      adapter.verifyWebhookSignature(Buffer.from(body), 'deadbeef') === false);
    check('  rejects a missing signature',
      adapter.verifyWebhookSignature(Buffer.from(body), undefined) === false);
    check('  rejects a modified body under a valid signature',
      adapter.verifyWebhookSignature(Buffer.from(body.replace('paid', 'fail')), validSig) === false);
    restore();
  }

  // ── A guest must be able to read their own payment result.
  // The gateway returns them with no JWT, so the phone they ordered under is
  // the only proof of ownership they have. Without this, a guest who paid
  // successfully was shown an error page — money taken, failure displayed.
  {
    const guestPhone = '03699666003';
    const guestOrder = await json(await post('/orders', {
      items: [{ productId: product.id, quantity: product.minQuantity }],
      zoneId: zones[0].id, deliveryAddress: 'Guest Payment', paymentMethod: 'EASYPAISA',
      guestName: 'Smoke Guest', guestPhone,
    }));
    check('guest can place an online-payment order', guestOrder.success === true, guestOrder.order?.orderNumber);

    const guestInit = await json(await post('/payments/initiate', {
      orderId: guestOrder.order.id, guestPhone,
    }));
    check('  guest can initiate payment with their phone', Boolean(guestInit.redirect?.url));

    await fetch(guestInit.redirect.url, { redirect: 'manual' });

    const withPhone = await json(await get(`/payments/status/${guestOrder.order.orderNumber}?guestPhone=${guestPhone}`));
    check('  guest reads their own status with the right phone',
      withPhone.order?.paymentStatus === 'PAID', withPhone.order?.paymentStatus || withPhone.message);

    const wrongPhone = await get(`/payments/status/${guestOrder.order.orderNumber}?guestPhone=03000000000`);
    check('  a different phone is refused', wrongPhone.status === 403, `HTTP ${wrongPhone.status}`);

    const noPhone = await get(`/payments/status/${guestOrder.order.orderNumber}`);
    check('  no phone at all is refused', noPhone.status === 403, `HTTP ${noPhone.status}`);

    const gOrderIds = [guestOrder.order.id];
    await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: gOrderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: gOrderIds } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: gOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: gOrderIds } } });
  }

  // ── The dev simulator must be unreachable once a provider is real ──
  const simulateUnknown = await fetch(`${BASE}/payments/simulate/NOT-A-REFERENCE`, { redirect: 'manual' });
  check('simulator 404s on an unknown reference', simulateUnknown.status === 404, `HTTP ${simulateUnknown.status}`);

  await cleanupTestUsers(PHONES);
  return summary();
}

module.exports = { run, PHONES };

if (require.main === module) {
  run()
    .then((r) => prisma.$disconnect().then(() => process.exit(r.failed ? 1 : 0)))
    .catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
}
