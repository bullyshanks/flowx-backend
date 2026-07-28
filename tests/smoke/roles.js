// Vendor/rider onboarding gates, order assignment lifecycle, admin views,
// and the role guards protecting each portal.
const {
  prisma, createReporter, get, post, patch, json,
  otpLogin, adminLogin, findUncontestedZone, cleanupTestUsers,
} = require('./helpers');

const VENDOR = '03699333001';
const RIDER = '03699333002';
const CUSTOMER = '03699333003';
const PHONES = [VENDOR, RIDER, CUSTOMER];

// Asserts the approval gate blocks this account on BOTH login paths. OTP login
// used to skip the gate entirely, letting a suspended vendor in by switching
// tabs — keep both sides covered so that can't regress.
async function checkBlockedOnBothPaths(check, label, phone, password) {
  const viaPassword = await post('/auth/login', { phone, password });
  check(`${label} blocked (password login)`, viaPassword.status === 403, `HTTP ${viaPassword.status}`);

  await post('/auth/otp/send', { phone, purpose: 'login' });
  const otp = await prisma.otp.findFirst({ where: { phone, consumedAt: null }, orderBy: { createdAt: 'desc' } });
  const viaOtp = await post('/auth/otp/verify', { phone, code: otp.code, purpose: 'login' });
  check(`${label} blocked (OTP login)`, viaOtp.status === 403, `HTTP ${viaOtp.status}`);
}

async function run() {
  const { check, summary } = createReporter('roles');
  await cleanupTestUsers(PHONES);

  const zone = await findUncontestedZone();
  const zones = (await json(await get('/products/zones'))).zones;
  const products = (await json(await get('/products'))).products;
  const product = products.find((p) => p.hasRiderDelivery) || products[0];

  const admin = await adminLogin();
  check('admin password login', admin.success === true, `role ${admin.user?.role}`);

  // ── Vendor onboarding: PENDING accounts cannot hold a session ──
  const vendorReg = await json(await post('/auth/register/vendor', {
    name: 'Smoke Vendor', phone: VENDOR, password: 'Test1234!', zoneId: zone.id,
  }));
  check('vendor registration', vendorReg.success === true, vendorReg.message);
  await checkBlockedOnBothPaths(check, 'PENDING vendor', VENDOR, 'Test1234!');

  const vendorUser = await prisma.user.findUnique({ where: { phone: VENDOR } });
  const approved = await json(await post(`/vendors/${vendorUser.id}/approve`, {}, admin.token));
  check('admin approves vendor', approved.success === true, approved.message);

  const vendorLogin = await json(await post('/auth/login', { phone: VENDOR, password: 'Test1234!' }));
  check('approved vendor can log in', vendorLogin.success === true, `vendorStatus ${vendorLogin.user?.vendorStatus}`);
  const vendorToken = vendorLogin.token;

  // ── Rider onboarding ──
  const riderReg = await json(await post('/auth/register/rider', {
    name: 'Smoke Rider', phone: RIDER, password: 'Test1234!', zoneId: zone.id, vehicleDetails: 'Bike',
  }));
  check('rider registration', riderReg.success === true, riderReg.message);
  const riderUser = await prisma.user.findUnique({ where: { phone: RIDER } });
  await post(`/riders/${riderUser.id}/approve`, {}, admin.token);
  const riderLogin = await json(await post('/auth/login', { phone: RIDER, password: 'Test1234!' }));
  check('approved rider can log in', riderLogin.success === true, `vendorStatus ${riderLogin.user?.vendorStatus}`);
  const riderToken = riderLogin.token;

  // KYC gates order handling separately from login (see accountBlockedMessage);
  // approve it directly so the assignment flow below can actually run.
  await prisma.user.updateMany({ where: { phone: { in: [VENDOR, RIDER] } }, data: { kycStatus: 'APPROVED' } });
  await prisma.user.update({ where: { phone: RIDER }, data: { isOnline: true } });

  check('vendor dashboard', (await json(await get('/vendors/dashboard', vendorToken))).success !== false);
  check('rider dashboard', (await json(await get('/riders/dashboard', riderToken))).success !== false);

  // ── Order lifecycle: placed → offered → accepted → delivered ──
  const customer = await otpLogin(CUSTOMER);
  const order = await json(await post('/orders', {
    items: [{ productId: product.id, quantity: product.minQuantity }],
    zoneId: zone.id, deliveryAddress: 'Role Test Address', paymentMethod: 'COD',
  }, customer.token));
  check('customer order placed in vendor zone', order.success === true, order.order?.orderNumber);

  const queue = await json(await get('/orders/vendor/queue', vendorToken));
  check('order offered to zone vendor',
    queue.orders?.some((o) => o.orderNumber === order.order.orderNumber) === true,
    `${queue.orders?.length} in queue`);

  const accepted = await json(await post(`/orders/${order.order.id}/accept`, {}, vendorToken));
  check('vendor accepts order', accepted.success !== false, accepted.order?.status || accepted.message);

  // Reassigning a vendor's zone must not strip orders they already own.
  const otherZone = zones.find((z) => z.id !== zone.id);
  await prisma.user.update({ where: { phone: VENDOR }, data: { zoneId: otherZone.id } });
  const afterMove = await json(await get('/orders/vendor/queue', vendorToken));
  check('accepted order survives vendor zone change',
    afterMove.orders?.some((o) => o.orderNumber === order.order.orderNumber) === true);
  await prisma.user.update({ where: { phone: VENDOR }, data: { zoneId: zone.id } });

  check('rider queue reachable', (await json(await get('/orders/rider/queue', riderToken))).success !== false);

  const out = await json(await patch(`/orders/${order.order.id}/status`, { status: 'OUT_FOR_DELIVERY' }, admin.token));
  check('status -> OUT_FOR_DELIVERY', out.order?.status === 'OUT_FOR_DELIVERY', out.order?.status || out.message);
  const delivered = await json(await patch(`/orders/${order.order.id}/status`, { status: 'DELIVERED' }, admin.token));
  check('status -> DELIVERED', delivered.order?.status === 'DELIVERED', delivered.order?.status || delivered.message);

  const ledger = await prisma.ledgerEntry.count({ where: { vendorId: vendorUser.id } });
  check('delivery writes vendor ledger entries', ledger > 0, `${ledger} entries`);

  // ── Admin views ──
  const allOrders = await json(await get('/orders/admin/all', admin.token));
  check('admin sees all orders', Array.isArray(allOrders.orders), `${allOrders.orders?.length} orders`);
  check('admin vendor list', (await json(await get('/vendors', admin.token))).success !== false);
  check('admin rider list', (await json(await get('/riders', admin.token))).success !== false);

  // ── Cross-role guards ──
  check('vendor blocked from admin orders', (await get('/orders/admin/all', vendorToken)).status === 403);
  check('rider blocked from vendor queue', (await get('/orders/vendor/queue', riderToken)).status === 403);
  check('customer blocked from approving vendors',
    (await post(`/vendors/${vendorUser.id}/approve`, {}, customer.token)).status === 403);

  // ── Suspension revokes access on both login paths ──
  await prisma.user.update({ where: { phone: VENDOR }, data: { vendorStatus: 'SUSPENDED' } });
  await checkBlockedOnBothPaths(check, 'SUSPENDED vendor', VENDOR, 'Test1234!');

  await cleanupTestUsers(PHONES);
  return summary();
}

module.exports = { run, PHONES };

if (require.main === module) {
  run()
    .then((r) => prisma.$disconnect().then(() => process.exit(r.failed ? 1 : 0)))
    .catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
}
