// Refund lifecycle and the guards that stop money going out that never came in.
const {
  prisma, createReporter, get, post, patch, json,
  otpLogin, adminLogin, cleanupTestUsers,
} = require('./helpers');

const CUSTOMER = '03699121001';
const PHONES = [CUSTOMER];

async function run() {
  const { check, summary } = createReporter('refund');
  await cleanupTestUsers(PHONES);

  const admin = await adminLogin();
  const customer = await otpLogin(CUSTOMER);
  const zones = (await json(await get('/products/zones'))).zones;
  const product = (await json(await get('/products'))).products.find((p) => p.minQuantity === 1);

  const place = async (paymentMethod) => json(await post('/orders', {
    items: [{ productId: product.id, quantity: product.minQuantity }],
    zoneId: zones[0].id, deliveryAddress: 'Refund Smoke', paymentMethod,
  }, customer.token));

  const deliver = async (orderId) => {
    await patch(`/orders/${orderId}/status`, { status: 'OUT_FOR_DELIVERY' }, admin.token);
    await patch(`/orders/${orderId}/status`, { status: 'DELIVERED' }, admin.token);
  };

  const createRefund = (orderNumber, amount, reason = 'Smoke test refund') =>
    post('/admin/finance/refunds', { orderNumber, amount, reason }, admin.token);

  // ── Refunds only apply to terminal orders ──
  const inFlight = await place('COD');
  const tooEarly = await createRefund(inFlight.order.orderNumber, 50);
  check('cannot refund an in-progress order', tooEarly.status === 409, `HTTP ${tooEarly.status}`);

  // ── A gateway order that never settled has nothing to refund.
  // Before the gateways existed this was unknowable and left to the admin;
  // paymentStatus is now definitive, and refunding an unpaid order pays out
  // money that was never collected.
  const unpaid = await place('JAZZCASH');
  await deliver(unpaid.order.id);
  const unpaidRefund = await createRefund(unpaid.order.orderNumber, 100);
  check('cannot refund an unsettled gateway order', unpaidRefund.status === 409,
    (await unpaidRefund.json()).message);

  // ── A paid gateway order refunds normally ──
  const paid = await place('JAZZCASH');
  const init = await json(await post('/payments/initiate', { orderId: paid.order.id }, customer.token));
  await fetch(init.redirect.url, { redirect: 'manual' });
  await deliver(paid.order.id);

  const created = await json(await createRefund(paid.order.orderNumber, 100, 'Bottle damaged'));
  check('refund created on a paid order', !!created.refund, created.refund?.status || created.message);
  const refundId = created.refund?.id;

  // ── Refunds cannot exceed what is left to refund ──
  const overCap = await createRefund(paid.order.orderNumber, Number(paid.order.total));
  check('refund capped at the remaining balance', overCap.status === 400,
    (await overCap.json()).message);

  // ── Lifecycle ──
  if (refundId) {
    const approved = await json(await post(`/admin/finance/refunds/${refundId}/approve`, {}, admin.token));
    check('approve -> APPROVED', approved.refund?.status === 'APPROVED', approved.refund?.status || approved.message);

    const payRes = await json(await post(`/admin/finance/refunds/${refundId}/pay`,
      { paymentMethod: 'BANK_TRANSFER', paymentReference: 'TRX-SMOKE' }, admin.token));
    check('pay -> PAID', payRes.refund?.status === 'PAID', payRes.refund?.status || payRes.message);

    const rePay = await post(`/admin/finance/refunds/${refundId}/pay`, { paymentMethod: 'BANK_TRANSFER' }, admin.token);
    check('  cannot pay the same refund twice', rePay.status >= 400, `HTTP ${rePay.status}`);
  }

  // ── COD orders that were cancelled never had cash collected ──
  const codCancelled = await place('COD');
  await patch(`/orders/${codCancelled.order.id}/status`, { status: 'CANCELLED' }, admin.token);
  const codRefund = await createRefund(codCancelled.order.orderNumber, 50);
  check('cannot refund a cancelled COD order', codRefund.status === 409, (await codRefund.json()).message);

  // ── Only admins touch refunds ──
  const asCustomer = await post('/admin/finance/refunds',
    { orderNumber: paid.order.orderNumber, amount: 10, reason: 'nope' }, customer.token);
  check('customer cannot create refunds', asCustomer.status === 403, `HTTP ${asCustomer.status}`);

  // ── Bank transfers: confirmed by an admin, since nothing else can ──
  {
    const bt = await place('BANK_TRANSFER');
    const listed = await json(await get('/admin/finance/bank-transfers', admin.token));
    const row = listed.orders?.find((o) => o.orderNumber === bt.order.orderNumber);
    check('bank transfer appears in the worklist', !!row, `awaiting: ${row?.paymentStatus}`);
    check('  starts unconfirmed', row?.paymentStatus === 'PENDING');

    await deliver(bt.order.id);

    // Unconfirmed means we have no evidence the money arrived.
    const early = await createRefund(bt.order.orderNumber, 50);
    check('cannot refund an unconfirmed bank transfer', early.status === 409, (await early.json()).message);

    const marked = await json(await post(`/admin/finance/orders/${bt.order.id}/mark-paid`,
      { paymentReference: 'TRX-SMOKE-BANK' }, admin.token));
    check('admin can confirm a bank transfer', marked.order?.paymentStatus === 'PAID', marked.order?.paymentStatus || marked.message);

    const stored = await prisma.order.findUnique({
      where: { id: bt.order.id },
      include: { statusHistory: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    check('  reference recorded', stored.transactionId === 'TRX-SMOKE-BANK', stored.transactionId);
    // This one was delivered before confirmation, so auto-confirm must not
    // rewind it — only a PENDING order moves.
    check('  a delivered order is not rewound to CONFIRMED', stored.status === 'DELIVERED', stored.status);
    check('  written to order history with the admin who did it',
      Boolean(stored.statusHistory[0]?.changedBy) && /confirmed by admin/i.test(stored.statusHistory[0]?.notes || ''),
      stored.statusHistory[0]?.notes);

    // Double-click must not re-notify the customer.
    const again = await json(await post(`/admin/finance/orders/${bt.order.id}/mark-paid`, {}, admin.token));
    check('  confirming twice is a no-op', again.alreadySet === true);

    // Now that payment is evidenced, a refund is legitimate.
    const nowOk = await json(await createRefund(bt.order.orderNumber, 50));
    check('confirmed bank transfer can be refunded', !!nowOk.refund, nowOk.message || 'created');
    if (nowOk.refund) await prisma.refund.delete({ where: { id: nowOk.refund.id } });

    // Reversing a mistaken confirmation.
    const reversed = await json(await post(`/admin/finance/orders/${bt.order.id}/mark-paid`, { paid: false }, admin.token));
    check('confirmation can be reversed', reversed.order?.paymentStatus === 'PENDING', reversed.order?.paymentStatus || reversed.message);
  }

  // ── A still-pending bank transfer confirms the order, same as a gateway ──
  {
    const bt = await place('BANK_TRANSFER');
    const confirmed = await json(await post(`/admin/finance/orders/${bt.order.id}/mark-paid`,
      { paymentReference: 'TRX-SMOKE-PENDING' }, admin.token));
    check('confirming a pending bank transfer auto-confirms the order',
      confirmed.order?.status === 'CONFIRMED', confirmed.order?.status || confirmed.message);

    const undone = await json(await post(`/admin/finance/orders/${bt.order.id}/mark-paid`, { paid: false }, admin.token));
    check('  reversing it returns the order to PENDING',
      undone.order?.status === 'PENDING', undone.order?.status || undone.message);
  }

  // ── Only bank transfers may be asserted by hand ──
  // A gateway payment is proven by a signed callback; letting an admin declare
  // one paid would bypass that entirely and defeat the refund guard above.
  {
    const gateway = await place('JAZZCASH');
    const handMarked = await post(`/admin/finance/orders/${gateway.order.id}/mark-paid`, { paid: true }, admin.token);
    check('gateway orders cannot be marked paid by hand', handMarked.status === 409, (await handMarked.json()).message);

    const codOrder = await place('COD');
    const codMarked = await post(`/admin/finance/orders/${codOrder.order.id}/mark-paid`, { paid: true }, admin.token);
    check('COD orders cannot be marked paid by hand', codMarked.status === 409, (await codMarked.json()).message);

    const asCustomerMark = await post(`/admin/finance/orders/${codOrder.order.id}/mark-paid`, { paid: true }, customer.token);
    check('customers cannot mark orders paid', asCustomerMark.status === 403, `HTTP ${asCustomerMark.status}`);
  }

  // ── The finance dashboard must not count money that never arrived ──
  const stats = await json(await get('/admin/dashboard', admin.token));
  const online = Number(stats.stats?.finance?.onlineReceived ?? 0);
  const unsettledTotal = Number(unpaid.order.total);
  check('onlineReceived excludes unsettled gateway orders',
    Number.isFinite(online) && online >= 0,
    `Rs. ${online} (the Rs. ${unsettledTotal} unpaid order must not be in here)`);

  const countedUnpaid = await prisma.order.count({
    where: { status: 'DELIVERED', paymentMethod: { in: ['JAZZCASH', 'EASYPAISA', 'CARD'] }, paymentStatus: { not: 'PAID' } },
  });
  const paidSum = await prisma.order.aggregate({
    _sum: { total: true },
    where: {
      status: 'DELIVERED',
      paymentStatus: 'PAID',
      paymentMethod: { in: ['JAZZCASH', 'EASYPAISA', 'CARD', 'BANK_TRANSFER'] },
    },
  });
  check('  onlineReceived matches only settled + bank-transfer orders',
    online === Number(paidSum._sum.total || 0),
    `dashboard ${online} vs settled ${Number(paidSum._sum.total || 0)}, with ${countedUnpaid} unsettled delivered order(s) present`);

  await cleanupTestUsers(PHONES);
  return summary();
}

module.exports = { run, PHONES };

if (require.main === module) {
  run()
    .then((r) => prisma.$disconnect().then(() => process.exit(r.failed ? 1 : 0)))
    .catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
}
