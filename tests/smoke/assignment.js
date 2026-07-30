// Offer expiry and the re-offer sweep.
//
// The bug this suite exists for: in a zone with one eligible vendor, letting
// the 90-second accept window lapse excluded that vendor from their own zone's
// rotation, found no alternative, and cleared the offer. The order then sat
// with no vendor and no offer, in nobody's queue — a paid order invisible to
// everyone until an admin happened to look.
const {
  prisma, createReporter, get, post, json,
  otpLogin, adminLogin, findUncontestedZone, cleanupTestUsers,
} = require('./helpers');

const VENDOR = '03699555001';
const CUSTOMER = '03699555002';
const PHONES = [VENDOR, CUSTOMER];

const assignment = require('../../src/services/assignment.service');

// Drag the accept deadline into the past instead of waiting 90 real seconds.
const expireOffer = (orderId) => prisma.order.update({
  where: { id: orderId },
  data: { vendorAcceptDeadline: new Date(Date.now() - 1000) },
});

async function run() {
  const { check, summary } = createReporter('assignment');
  await cleanupTestUsers(PHONES);

  const zone = await findUncontestedZone();
  const products = (await json(await get('/products'))).products;
  const product = products.find((p) => p.minQuantity === 1) || products[0];
  const admin = await adminLogin();

  // ── A zone with exactly one eligible vendor: the case that used to orphan ──
  await post('/auth/register/vendor', {
    name: 'Sweep Vendor', phone: VENDOR, password: 'Test1234!', zoneId: zone.id,
  });
  const vendorUser = await prisma.user.findUnique({ where: { phone: VENDOR } });
  await post(`/vendors/${vendorUser.id}/approve`, {}, admin.token);
  await prisma.user.update({ where: { phone: VENDOR }, data: { kycStatus: 'APPROVED' } });

  const customer = await otpLogin(CUSTOMER);
  const placed = await json(await post('/orders', {
    items: [{ productId: product.id, quantity: product.minQuantity }],
    zoneId: zone.id, deliveryAddress: 'Sweep Test Address', paymentMethod: 'COD',
  }, customer.token));
  const orderId = placed.order.id;
  check('order offered to the only vendor in zone',
    (await prisma.order.findUnique({ where: { id: orderId } })).offeredVendorId === vendorUser.id);

  // ── Expiry must re-offer, not orphan ──
  await expireOffer(orderId);
  await assignment.sweepUnassignedOrders();
  const afterExpiry = await prisma.order.findUnique({ where: { id: orderId } });
  check('expired offer is re-offered to the same vendor, not cleared',
    afterExpiry.offeredVendorId === vendorUser.id,
    afterExpiry.offeredVendorId === null ? 'ORPHANED' : 'reassigned');
  check('  with a fresh accept window',
    afterExpiry.vendorAcceptDeadline > new Date(),
    String(afterExpiry.vendorAcceptDeadline));

  // Re-offering the same vendor is the window resetting, not a new event —
  // otherwise every sweep writes an identical line and buries the history.
  const offerLogs = await prisma.orderStatusLog.count({
    where: { orderId, notes: { contains: 'Offered to vendor' } },
  });
  check('  repeat offers do not spam the order history', offerLogs === 1, `${offerLogs} log(s)`);

  // ── With the only vendor closed, the order is stranded but visible ──
  await prisma.user.update({ where: { phone: VENDOR }, data: { isOpen: false } });
  await expireOffer(orderId);
  await assignment.sweepUnassignedOrders();
  const stranded = await prisma.order.findUnique({ where: { id: orderId } });
  check('no eligible vendor leaves the order unoffered', stranded.offeredVendorId === null);
  check('  and it is counted for the admin dashboard',
    (await assignment.countStrandedOrders()) > 0);
  const dash = await json(await get('/admin/dashboard', admin.token));
  check('  admin dashboard reports stranded orders',
    typeof dash.stats?.orders?.stranded === 'number' && dash.stats.orders.stranded > 0,
    String(dash.stats?.orders?.stranded));

  // A stranded order must not re-log "no vendors available" on every sweep.
  const before = await prisma.orderStatusLog.count({
    where: { orderId, notes: { contains: 'No vendors available' } },
  });
  await assignment.sweepUnassignedOrders();
  await assignment.sweepUnassignedOrders();
  const after = await prisma.orderStatusLog.count({
    where: { orderId, notes: { contains: 'No vendors available' } },
  });
  check('  repeated sweeps do not re-log the same dead end', after === before, `${before} -> ${after}`);

  // ── Reopening the zone picks the order back up, with nobody reading a queue ──
  await prisma.user.update({ where: { phone: VENDOR }, data: { isOpen: true } });
  await assignment.sweepUnassignedOrders();
  const recovered = await prisma.order.findUnique({ where: { id: orderId } });
  check('reopening the vendor recovers the stranded order',
    recovered.offeredVendorId === vendorUser.id,
    recovered.offeredVendorId ? 'offered' : 'STILL STRANDED');

  // ── The vendor can still accept it after all that ──
  const vendorLogin = await json(await post('/auth/login', { phone: VENDOR, password: 'Test1234!' }));
  const accepted = await json(await post(`/orders/${orderId}/accept`, {}, vendorLogin.token));
  check('vendor can accept the recovered order', accepted.success !== false,
    accepted.order?.status || accepted.message);

  // ── An accepted order is never touched by the sweep again ──
  const counts = await assignment.sweepUnassignedOrders();
  const settledOrder = await prisma.order.findUnique({ where: { id: orderId } });
  check('accepted orders are left alone by the sweep',
    settledOrder.vendorId === vendorUser.id && settledOrder.status === 'ASSIGNED',
    `${settledOrder.status} / vendor ${settledOrder.vendorId ? 'set' : 'null'}`);
  check('  sweep reports counts', typeof counts.orphaned === 'number',
    JSON.stringify(counts));

  // ── Zone serviceability ──
  // The distinction that matters: a zone with no vendor at all can never be
  // delivered to and must refuse orders; a zone whose vendor is merely closed
  // right now must still accept them, because the sweep recovers those.
  {
    const covered = await prisma.zone.findFirst({ where: { id: zone.id } });
    const zonesResp = await json(await get('/products/zones'));
    const coveredRow = zonesResp.zones.find((z) => z.id === covered.id);
    check('zone list flags a covered zone serviceable', coveredRow?.isServiceable === true,
      String(coveredRow?.isServiceable));

    // An uncovered zone: one with no approved vendor assigned to it at all.
    const allZones = await prisma.zone.findMany({ where: { isActive: true } });
    let uncovered = null;
    for (const z of allZones) {
      const n = await prisma.user.count({
        where: { role: 'VENDOR', vendorStatus: 'APPROVED', kycStatus: 'APPROVED', isFrozen: false, zoneId: z.id },
      });
      if (n === 0) { uncovered = z; break; }
    }

    if (!uncovered) {
      check('an uncovered zone exists to test against', false, 'every zone has a vendor — skipped');
    } else {
      const row = zonesResp.zones.find((z) => z.id === uncovered.id);
      check('zone list flags an uncovered zone unserviceable', row?.isServiceable === false,
        String(row?.isServiceable));

      const demandBefore = await prisma.zoneDemand.count({ where: { zoneId: uncovered.id } });
      const demandSince = new Date();

      const refused = await post('/orders', {
        items: [{ productId: product.id, quantity: product.minQuantity }],
        zoneId: uncovered.id, deliveryAddress: 'Unserved Area', paymentMethod: 'COD',
      }, customer.token);
      check('order to an unserved zone is refused', refused.status === 400, `HTTP ${refused.status}`);
      const refusedBody = await refused.json();
      check('  with a message naming the zone',
        (refusedBody.message || '').includes(uncovered.name), refusedBody.message);

      const subRefused = await post('/subscriptions', {
        productId: product.id, zoneId: uncovered.id, quantity: product.minQuantity,
        frequency: 'WEEKLY', deliveryAddress: 'Unserved Area', paymentMethod: 'COD',
      }, customer.token);
      check('subscription to an unserved zone is refused', subRefused.status === 400,
        `HTTP ${subRefused.status}`);

      // Scoped to this run's address — the zone may already hold unrelated
      // orders from before it lost coverage.
      check('  no order was created',
        (await prisma.order.count({
          where: { zoneId: uncovered.id, deliveryAddress: 'Unserved Area' },
        })) === 0);

      // The refusal has to leave a trace, or an uncovered zone with real demand
      // is indistinguishable from one nobody wants. Written fire-and-forget,
      // so allow a moment for it to land.
      await new Promise((r) => setTimeout(r, 300));
      const demandAfter = await prisma.zoneDemand.count({ where: { zoneId: uncovered.id } });
      check('  demand recorded for recruiting', demandAfter > demandBefore,
        `${demandBefore} -> ${demandAfter}`);
      check('  subscription refusal recorded separately',
        (await prisma.zoneDemand.count({
          where: { zoneId: uncovered.id, source: 'SUBSCRIPTION' },
        })) > 0);
      // Turning someone away is not a reason to keep their details.
      const sample = await prisma.zoneDemand.findFirst({ where: { zoneId: uncovered.id } });
      check('  demand rows hold no personal data',
        !('phone' in sample) && !('customerId' in sample),
        Object.keys(sample).join(','));

      const adminZones = await json(await get('/products/zones/admin/all', admin.token));
      const uncoveredAdmin = adminZones.zones.find((z) => z.id === uncovered.id);
      check('admin zone list reports coverage and demand',
        uncoveredAdmin?.activeVendors === 0 && uncoveredAdmin?.demandLast30d > 0,
        `${uncoveredAdmin?.activeVendors} vendors / ${uncoveredAdmin?.demandLast30d} turned away`);

      // Only this run's rows — real demand from real customers is not the
      // test's to delete.
      await prisma.zoneDemand.deleteMany({
        where: { zoneId: uncovered.id, createdAt: { gte: demandSince } },
      });
    }

    // A merely-closed vendor must NOT make the zone unserviceable — those
    // orders are recoverable, and refusing them loses a sale over a lunch break.
    await prisma.user.update({ where: { phone: VENDOR }, data: { isOpen: false, stockStatus: false } });
    const whileClosed = await json(await get('/products/zones'));
    check('a closed vendor still counts as coverage',
      whileClosed.zones.find((z) => z.id === zone.id)?.isServiceable === true);
    const acceptedAnyway = await post('/orders', {
      items: [{ productId: product.id, quantity: product.minQuantity }],
      zoneId: zone.id, deliveryAddress: 'Closed But Covered', paymentMethod: 'COD',
    }, customer.token);
    check('  and orders are still accepted while they are closed',
      acceptedAnyway.status === 201, `HTTP ${acceptedAnyway.status}`);
    await prisma.user.update({ where: { phone: VENDOR }, data: { isOpen: true, stockStatus: true } });
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
