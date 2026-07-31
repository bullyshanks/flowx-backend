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
// Vendor-referral cast: an existing vendor referring a new one, plus customers
// to place the orders that trigger (and must not trigger) the payout.
const V_REFERRER = '03699444020';
const V_REFEREE = '03699444021';
const V_CUSTOMER = '03699444022';
const V_CUSTOMER2 = '03699444023';
const PHONES = [
  REFERRER, REFEREE, BOGUS, RACER,
  V_REFERRER, V_REFEREE, V_CUSTOMER, V_CUSTOMER2,
];

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

  // ── Vendor referrals ──
  // Same model, different trigger: paid when the referred VENDOR completes
  // their first delivery, not when they sign up or get approved. Approval is a
  // form review; a delivery cannot be faked without actually delivering water.
  {
    const { findUncontestedZone } = require('./helpers');
    const vzone = await findUncontestedZone();
    const products = (await json(await get('/products'))).products;
    const vproduct = products.find((p) => p.minQuantity === 1) || products[0];

    // The referrer is an existing vendor, so their bonus lands in the ledger.
    await post('/auth/register/vendor', {
      name: 'Referrer Vendor', phone: V_REFERRER, password: 'Test1234!', zoneId: vzone.id,
    });
    const vr = await prisma.user.findUnique({ where: { phone: V_REFERRER } });
    await post(`/vendors/${vr.id}/approve`, {}, admin.token);
    await prisma.user.update({ where: { phone: V_REFERRER }, data: { kycStatus: 'APPROVED' } });
    check('vendor gets a referral code on registration', /^FLW[A-Z0-9]{6}$/.test(vr.referralCode || ''),
      vr.referralCode);

    const vrLogin = await json(await post('/auth/login', { phone: V_REFERRER, password: 'Test1234!' }));
    const refInfo = await json(await get('/vendors/referral', vrLogin.token));
    check('  vendor referral endpoint reachable', refInfo.success === true, refInfo.message);
    check('  reward amount published', refInfo.rewardPerVendor > 0, String(refInfo.rewardPerVendor));

    // A new vendor signs up with that code.
    await post('/auth/register/vendor', {
      name: 'Referred Vendor', phone: V_REFEREE, password: 'Test1234!',
      zoneId: vzone.id, referralCode: vr.referralCode,
    });
    const ve = await prisma.user.findUnique({ where: { phone: V_REFEREE } });
    const link = await prisma.referral.findUnique({ where: { refereeId: ve.id } });
    check('vendor referral linked at signup', link?.kind === 'VENDOR', link?.kind);
    check('  referee gets no customer discount', Number(link?.refereeDiscount) === 0,
      String(link?.refereeDiscount));

    const bonusOf = async () => Number((await prisma.ledgerEntry.aggregate({
      where: { vendorId: vr.id, type: 'REFERRAL_BONUS' }, _sum: { amount: true },
    }))._sum.amount || 0);

    // Approval alone must pay nothing — that is the whole anti-abuse point.
    await post(`/vendors/${ve.id}/approve`, {}, admin.token);
    await prisma.user.update({ where: { phone: V_REFEREE }, data: { kycStatus: 'APPROVED' } });
    check('approval alone pays no bonus', (await bonusOf()) === 0,
      `PKR ${await bonusOf()}`);
    check('  referral still pending',
      (await prisma.referral.findUnique({ where: { id: link.id } })).status === 'PENDING');

    // Both vendors sit in the same zone, and offers go to the first eligible
    // vendor by id — so without this the order could land on the referrer and
    // the test would pass or fail on uuid ordering. Close the referrer: they
    // are only here to hold the code, not to compete for the order.
    await prisma.user.update({ where: { phone: V_REFERRER }, data: { isOpen: false } });

    // The referred vendor delivers their first order.
    const vcustomer = await otpLogin(V_CUSTOMER);
    const vorder = await json(await post('/orders', {
      items: [{ productId: vproduct.id, quantity: vproduct.minQuantity }],
      zoneId: vzone.id, deliveryAddress: 'Vendor Referral Test', paymentMethod: 'COD',
    }, vcustomer.token));
    const veLogin = await json(await post('/auth/login', { phone: V_REFEREE, password: 'Test1234!' }));
    const accepted = await json(await post(`/orders/${vorder.order.id}/accept`, {}, veLogin.token));
    check('  referred vendor accepts the order', accepted.success !== false,
      accepted.order?.status || accepted.message);
    await patch(`/orders/${vorder.order.id}/status`, { status: 'OUT_FOR_DELIVERY' }, admin.token);
    await patch(`/orders/${vorder.order.id}/status`, { status: 'DELIVERED' }, admin.token);

    const paid = await bonusOf();
    check('bonus paid on the referred vendor\'s first delivery', paid === Number(link.referrerBonus),
      `PKR ${paid} of ${link.referrerBonus}`);
    check('  referral marked CREDITED',
      (await prisma.referral.findUnique({ where: { id: link.id } })).status === 'CREDITED');

    // A second delivery must not pay again.
    const vorder2 = await json(await post('/orders', {
      items: [{ productId: vproduct.id, quantity: vproduct.minQuantity }],
      zoneId: vzone.id, deliveryAddress: 'Second Delivery', paymentMethod: 'COD',
    }, vcustomer.token));
    await post(`/orders/${vorder2.order.id}/accept`, {}, veLogin.token);
    await patch(`/orders/${vorder2.order.id}/status`, { status: 'OUT_FOR_DELIVERY' }, admin.token);
    await patch(`/orders/${vorder2.order.id}/status`, { status: 'DELIVERED' }, admin.token);
    check('  a second delivery does not pay twice', (await bonusOf()) === paid, `PKR ${await bonusOf()}`);

    const after = await json(await get('/vendors/referral', vrLogin.token));
    check('referrer sees the credited invite',
      after.signedUp === 1 && after.credited === 1 && after.totalEarned === paid,
      `${after.signedUp} invited / ${after.credited} credited / PKR ${after.totalEarned}`);
    check('  invite list withholds the referee phone number',
      after.referrals?.[0] && !('phone' in after.referrals[0]),
      Object.keys(after.referrals?.[0] || {}).join(','));

    // A vendor must not be able to hand out customer discount codes.
    const selfCust = await otpLogin(V_CUSTOMER2, vr.referralCode);
    const custLink = await prisma.referral.findUnique({
      where: { refereeId: (await prisma.user.findUnique({ where: { phone: V_CUSTOMER2 } })).id },
    });
    check('a vendor code cannot create a customer referral', !custLink,
      custLink ? 'LINKED' : 'ignored');
    check('  but signup still succeeds', selfCust.success === true);
  }

  await cleanupTestUsers(PHONES);
  return summary();
}

module.exports = { run, PHONES };

if (require.main === module) {
  run()
    .then((r) => prisma.$disconnect().then(() => process.exit(r.failed ? 1 : 0)))
    .catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
}
