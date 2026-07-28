// Public catalogue, guest checkout, customer signup, subscriptions, auth guards.
const {
  prisma, createReporter, get, post, json, otpLogin, cleanupTestUsers,
} = require('./helpers');

const GUEST = '03699222001';
const PHONES = [GUEST];

async function run() {
  const { check, summary } = createReporter('customer');
  await cleanupTestUsers(PHONES);

  const products = (await json(await get('/products'))).products;
  check('GET /products', Array.isArray(products) && products.length > 0, `${products?.length} products`);

  const zones = (await json(await get('/products/zones'))).zones;
  check('GET /products/zones', Array.isArray(zones) && zones.length > 0, `${zones?.length} zones`);

  const single = products.find((p) => p.minQuantity === 1) || products[0];
  const bulk = products.find((p) => p.minQuantity > 1);
  const zone = zones[0];

  // ── Guest checkout ──
  const guest = await json(await post('/orders', {
    items: [{ productId: single.id, quantity: single.minQuantity }],
    zoneId: zone.id,
    deliveryAddress: 'Smoke Test Address, Karachi',
    paymentMethod: 'COD',
    guestName: 'Smoke Guest',
    guestPhone: GUEST,
  }));
  check('POST /orders (guest)', guest.success === true, guest.order?.orderNumber || guest.message);

  // ── Public tracking withholds PII ──
  // This endpoint is unauthenticated and order numbers are guessable, so it
  // must not expose vendor/rider phone numbers or internal status notes.
  const track = await json(await get(`/orders/track/${guest.order.orderNumber}`));
  check('GET /orders/track/:orderNumber', track.success === true, `status ${track.order?.status}`);
  check('  withholds vendor/rider phone', track.order?.vendor?.phone === undefined && track.order?.rider?.phone === undefined);
  check('  withholds statusHistory', track.order?.statusHistory === undefined);

  // ── Server-side validation (the UI enforces these too; the API must not trust it) ──
  if (bulk) {
    const badQty = await json(await post('/orders', {
      items: [{ productId: bulk.id, quantity: 1 }],
      zoneId: zone.id, deliveryAddress: 'x', paymentMethod: 'COD',
      guestName: 'g', guestPhone: GUEST,
    }));
    check('minQuantity enforced server-side', badQty.success === false, badQty.message);
  }

  const badPhone = await json(await post('/orders', {
    items: [{ productId: single.id, quantity: single.minQuantity }],
    zoneId: zone.id, deliveryAddress: 'x', paymentMethod: 'COD',
    guestName: 'g', guestPhone: '12345',
  }));
  check('guest phone validated', badPhone.success === false, badPhone.message);

  const badZone = await json(await post('/orders', {
    items: [{ productId: single.id, quantity: single.minQuantity }],
    zoneId: '00000000-0000-0000-0000-000000000000',
    deliveryAddress: 'x', paymentMethod: 'COD', guestName: 'g', guestPhone: GUEST,
  }));
  check('invalid zone rejected', badZone.success === false, badZone.message);

  // ── Signup adopts prior guest orders placed on the same phone ──
  const customer = await otpLogin(GUEST);
  check('customer OTP signup', customer.success === true, `role ${customer.user?.role}`);
  check('  session carries vendorStatus/kycStatus', 'vendorStatus' in (customer.user || {}),
    'portal guards read these off the persisted store');

  const mine = await json(await get('/orders/my-orders', customer.token));
  check('guest order backfilled on signup',
    mine.orders?.some((o) => o.orderNumber === guest.order.orderNumber) === true,
    `${mine.orders?.length} visible`);

  const authed = await json(await post('/orders', {
    items: [{ productId: single.id, quantity: single.minQuantity }],
    zoneId: zone.id, deliveryAddress: 'Authed Address', paymentMethod: 'COD',
  }, customer.token));
  check('POST /orders (authenticated)', authed.success === true, authed.order?.orderNumber || authed.message);

  // ── Subscription validation ──
  // Subscriptions used to accept anything, and because processSubscription
  // writes orders straight to the database rather than going back through
  // placeOrder, an invalid subscription generated an invalid order every
  // cycle, forever. These must fail at creation, not at delivery time.
  if (bulk) {
    const belowMin = await json(await post('/subscriptions', {
      productId: bulk.id, zoneId: zone.id, quantity: bulk.minQuantity - 1,
      frequency: 'WEEKLY', deliveryAddress: 'Sub Address', paymentMethod: 'COD',
    }, customer.token));
    check('subscription enforces minQuantity', belowMin.success === false, belowMin.message);
  }

  const badFrequency = await json(await post('/subscriptions', {
    productId: single.id, zoneId: zone.id, quantity: single.minQuantity,
    frequency: 'HOURLY', deliveryAddress: 'Sub Address', paymentMethod: 'COD',
  }, customer.token));
  check('subscription rejects invalid frequency', badFrequency.success === false, badFrequency.message);

  const badSubZone = await json(await post('/subscriptions', {
    productId: single.id, zoneId: '00000000-0000-0000-0000-000000000000', quantity: single.minQuantity,
    frequency: 'WEEKLY', deliveryAddress: 'Sub Address', paymentMethod: 'COD',
  }, customer.token));
  check('subscription rejects invalid zone', badSubZone.success === false, badSubZone.message);

  const fractionalQty = await json(await post('/subscriptions', {
    productId: single.id, zoneId: zone.id, quantity: 1.5,
    frequency: 'WEEKLY', deliveryAddress: 'Sub Address', paymentMethod: 'COD',
  }, customer.token));
  check('subscription rejects fractional quantity', fractionalQty.success === false, fractionalQty.message);

  // ── Subscription lifecycle ──
  const sub = await json(await post('/subscriptions', {
    productId: single.id, zoneId: zone.id, quantity: single.minQuantity,
    frequency: 'WEEKLY', deliveryAddress: 'Sub Address', paymentMethod: 'COD',
  }, customer.token));
  check('POST /subscriptions', !!sub.subscription, sub.subscription?.status || sub.message);

  if (sub.subscription) {
    const id = sub.subscription.id;
    const paused = await json(await post(`/subscriptions/${id}/pause`, {}, customer.token));
    check('  pause', paused.subscription?.status === 'PAUSED', paused.subscription?.status || paused.message);
    const resumed = await json(await post(`/subscriptions/${id}/resume`, {}, customer.token));
    check('  resume', resumed.subscription?.status === 'ACTIVE', resumed.subscription?.status || resumed.message);
    const cancelled = await json(await post(`/subscriptions/${id}/cancel`, {}, customer.token));
    check('  cancel', cancelled.subscription?.status === 'CANCELLED', cancelled.subscription?.status || cancelled.message);
  }

  // ── Auth guards ──
  check('my-orders requires auth', (await get('/orders/my-orders')).status === 401);
  check('invalid token rejected', (await get('/orders/my-orders', 'garbage')).status === 401);
  check('customer blocked from vendor queue', (await get('/orders/vendor/queue', customer.token)).status === 403);

  await cleanupTestUsers(PHONES);
  return summary();
}

module.exports = { run, PHONES };

if (require.main === module) {
  run()
    .then((r) => prisma.$disconnect().then(() => process.exit(r.failed ? 1 : 0)))
    .catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
}
