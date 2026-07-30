// Referral codes, the referee's first-order discount, the referrer's
// delivery-gated bonus, wallet spend, and the concurrency guard on all of it.
const {
  prisma, createReporter, get, post, patch, json,
  otpLogin, adminLogin, findServiceableZone, cleanupTestUsers,
} = require('./helpers');

const REFERRER = '03699444001';
const REFEREE = '03699444002';
const BOGUS = '03699444009';
const RACER = '03699444010';
const PHONES = [REFERRER, REFEREE, BOGUS, RACER];

async function run() {
  const { check, summary } = createReporter('referral');
  await cleanupTestUsers(PHONES);

  // Referral discounts don't care who fulfils the order, but order creation
  // now refuses zones with no vendor — so this needs a covered zone, not an
  // uncontested one.
  const zone = await findServiceableZone();
  const products = (await json(await get('/products'))).products;
  const product = products.find((p) => p.minQuantity === 1) || products[0];
  const orderBody = (address) => ({
    items: [{ productId: product.id, quantity: product.minQuantity }],
    zoneId: zone.id, deliveryAddress: address, paymentMethod: 'COD',
  });

  // ── Every customer gets a code ──
  const referrer = await otpLogin(REFERRER);
  const info = await json(await get('/customer/referral', referrer.token));
  check('referrer issued a code', /^FLW[A-Z0-9]{6}$/.test(info.referralCode || ''), info.referralCode);
  check('  wallet starts empty', Number(info.walletBalance) === 0, String(info.walletBalance));
  check('  referralsCount starts at 0', info.referralsCount === 0, String(info.referralsCount));

  // ── A bad code must never block signup — referrals are best-effort ──
  const bogus = await otpLogin(BOGUS, 'FLWNOPE1');
  const bogusUser = await prisma.user.findUnique({ where: { phone: BOGUS } });
  check('invalid code ignored, signup still succeeds',
    bogus.success === true && bogusUser.referredById === null);

  // ── Referred signup links the referral as PENDING ──
  const referee = await otpLogin(REFEREE, info.referralCode);
  check('referred signup succeeds', referee.success === true, `role ${referee.user?.role}`);
  const refereeUser = await prisma.user.findUnique({ where: { phone: REFEREE } });
  const referrerUser = await prisma.user.findUnique({ where: { phone: REFERRER } });
  check('  referredById linked', refereeUser.referredById === referrerUser.id);
  const referral = await prisma.referral.findUnique({ where: { refereeId: refereeUser.id } });
  check('  Referral row created PENDING', referral?.status === 'PENDING', `discountUsed=${referral?.discountUsed}`);

  // ── Discount applies once, to the first order only ──
  const first = await json(await post('/orders', orderBody('Referral First'), referee.token));
  check('first order discounted Rs.50', Number(first.order?.discountAmount) === 50,
    `discount ${first.order?.discountAmount}, total ${first.order?.total}`);

  const second = await json(await post('/orders', orderBody('Referral Second'), referee.token));
  check('second order not discounted', Number(second.order?.discountAmount) === 0,
    `discount ${second.order?.discountAmount}`);

  // ── Referrer is paid on delivery, not on placement ──
  const beforeDelivery = await json(await get('/customer/referral', referrer.token));
  check('referrer uncredited before delivery', Number(beforeDelivery.walletBalance) === 0,
    `wallet ${beforeDelivery.walletBalance}`);

  const admin = await adminLogin();
  await patch(`/orders/${first.order.id}/status`, { status: 'OUT_FOR_DELIVERY' }, admin.token);
  await patch(`/orders/${first.order.id}/status`, { status: 'DELIVERED' }, admin.token);
  await new Promise((r) => setTimeout(r, 800));

  const afterDelivery = await json(await get('/customer/referral', referrer.token));
  check('referrer credited Rs.50 on delivery', Number(afterDelivery.walletBalance) === 50,
    `wallet ${afterDelivery.walletBalance}`);
  check('  referralsCount updated', afterDelivery.referralsCount === 1, String(afterDelivery.referralsCount));
  const credited = await prisma.referral.findUnique({ where: { refereeId: refereeUser.id } });
  check('  Referral marked CREDITED', credited?.status === 'CREDITED', credited?.creditedAt ? 'creditedAt set' : 'creditedAt null');

  // ── Crediting is idempotent: re-entering DELIVERED must not pay twice ──
  await prisma.order.update({ where: { id: first.order.id }, data: { status: 'OUT_FOR_DELIVERY' } });
  await patch(`/orders/${first.order.id}/status`, { status: 'DELIVERED' }, admin.token);
  await new Promise((r) => setTimeout(r, 800));
  const afterRedelivery = await json(await get('/customer/referral', referrer.token));
  check('re-delivery does not double-credit', Number(afterRedelivery.walletBalance) === 50,
    `wallet ${afterRedelivery.walletBalance}`);

  // ── Earned balance is spendable, and only once ──
  const walletOrder = await json(await post('/orders', orderBody('Wallet Spend'), referrer.token));
  check('referrer spends wallet balance', Number(walletOrder.order?.discountAmount) === 50,
    `discount ${walletOrder.order?.discountAmount}`);
  const drained = await json(await get('/customer/referral', referrer.token));
  check('  wallet drained to 0', Number(drained.walletBalance) === 0, `wallet ${drained.walletBalance}`);

  // ── Concurrency: a double-submit must not claim the discount twice.
  // Referral.discountUsed is claimed via compare-and-swap inside the same
  // transaction that creates the order, so exactly one racer can win.
  const racer = await otpLogin(RACER, info.referralCode);
  const [a, b] = await Promise.all([
    json(await post('/orders', orderBody('Race A'), racer.token)),
    json(await post('/orders', orderBody('Race B'), racer.token)),
  ]);
  const discounts = [Number(a.order?.discountAmount), Number(b.order?.discountAmount)].sort((x, y) => x - y);
  check('concurrent orders discount exactly once',
    discounts[0] === 0 && discounts[1] === 50, `got [${discounts}]`);

  await cleanupTestUsers(PHONES);
  return summary();
}

module.exports = { run, PHONES };

if (require.main === module) {
  run()
    .then((r) => prisma.$disconnect().then(() => process.exit(r.failed ? 1 : 0)))
    .catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
}
