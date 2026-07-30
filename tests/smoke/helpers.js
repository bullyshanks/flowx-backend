// Shared plumbing for the smoke suites. These run against a *live* server
// (default http://localhost:4000) and a real database — they are end-to-end
// checks, not unit tests, so there is no mocking anywhere in here.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({ log: [] });
const BASE = process.env.SMOKE_API_URL || 'http://localhost:4000/api';

// Every test phone lives in this block so cleanup can find them by prefix
// without any risk of touching real accounts.
const TEST_PREFIX = '0369';

function createReporter(suiteName) {
  const results = [];
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
      return ok;
    },
    summary() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${suiteName}: ${results.length - failed.length}/${results.length} passed`);
      if (failed.length) {
        console.log('FAILURES:\n' + failed.map((f) => `  - ${f.name}  ${f.detail}`).join('\n'));
      }
      return { total: results.length, failed: failed.length };
    },
  };
}

// The API rate-limits /api/auth/* to 20 requests per 15 minutes (see app.js).
// A full suite run sits close to that ceiling, and the limiter is in-memory,
// so a 429 here means "restart the server", not "the code is broken" — say so
// rather than surfacing a JSON parse error from the plain-text 429 body.
async function request(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 429) {
    throw new Error(
      'Rate limited (HTTP 429). The auth limiter is in-memory — restart the backend and re-run.'
    );
  }
  return res;
}

const get = (path, token) => request('GET', path, null, token);
const post = (path, body, token) => request('POST', path, body, token);
const patch = (path, body, token) => request('PATCH', path, body, token);
const json = async (res) => res.json();

// OTP codes never leave the database in dev (no SMS gateway configured), so
// read the code back out rather than trying to intercept a message.
async function otpLogin(phone, referralCode) {
  await post('/auth/otp/send', { phone, purpose: 'login' });
  const otp = await prisma.otp.findFirst({
    where: { phone, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) throw new Error(`No OTP issued for ${phone}`);
  const body = { phone, code: otp.code, purpose: 'login' };
  if (referralCode) body.referralCode = referralCode;
  return json(await post('/auth/otp/verify', body));
}

async function adminLogin() {
  const phone = process.env.ADMIN_PHONE;
  const password = process.env.ADMIN_PASSWORD;
  if (!phone || !password) {
    throw new Error('ADMIN_PHONE and ADMIN_PASSWORD must be set in .env to run the smoke suite');
  }
  const res = await json(await post('/auth/login', { phone, password }));
  if (!res.token) throw new Error('Admin login failed: ' + (res.message || JSON.stringify(res)));
  return res;
}

// Order assignment offers each order to the first eligible vendor in the zone
// (findNextVendor, ordered by id). If a real vendor already covers the zone a
// test vendor is placed in, that vendor wins the offer and every downstream
// assertion fails for reasons that have nothing to do with the code under
// test. Always stage assignment tests in a zone nobody else serves.
async function findUncontestedZone() {
  const zones = await prisma.zone.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  for (const zone of zones) {
    const competitors = await prisma.user.count({
      where: {
        role: 'VENDOR',
        vendorStatus: 'APPROVED',
        kycStatus: 'APPROVED',
        isFrozen: false,
        isOpen: true,
        stockStatus: true,
        zoneId: zone.id,
      },
    });
    if (competitors === 0) return zone;
  }
  throw new Error('Every active zone already has an eligible vendor — cannot stage assignment tests');
}

// A zone orders can actually be placed in. Order creation refuses zones with
// no approved vendor (see isZoneServiceable), so suites that only need a valid
// order — referrals, payments, refunds — must not use findUncontestedZone,
// which returns the opposite by design. Suites testing assignment itself stage
// their own vendor in an uncontested zone instead.
async function findServiceableZone() {
  const zone = await prisma.zone.findFirst({
    where: {
      isActive: true,
      users: {
        some: { role: 'VENDOR', vendorStatus: 'APPROVED', kycStatus: 'APPROVED', isFrozen: false },
      },
    },
    orderBy: { name: 'asc' },
  });
  if (!zone) {
    throw new Error('No zone has an approved vendor — seed one before running order-placing suites');
  }
  return zone;
}

// Deletes test accounts and everything hanging off them, in FK-safe order.
// Scoped to phones under TEST_PREFIX so it can never reach real data.
async function cleanupTestUsers(phones) {
  const safe = phones.filter((p) => p.startsWith(TEST_PREFIX));
  if (safe.length !== phones.length) {
    throw new Error(`Refusing to clean up non-test phones: ${phones.filter((p) => !p.startsWith(TEST_PREFIX))}`);
  }

  const ids = (await prisma.user.findMany({ where: { phone: { in: safe } }, select: { id: true } }))
    .map((u) => u.id);
  if (!ids.length) {
    await prisma.otp.deleteMany({ where: { phone: { in: safe } } });
    return 0;
  }

  const orderIds = (await prisma.order.findMany({
    where: {
      OR: [
        { customerId: { in: ids } },
        { vendorId: { in: ids } },
        { riderId: { in: ids } },
        { offeredVendorId: { in: ids } },
        { guestPhone: { in: safe } },
      ],
    },
    select: { id: true },
  })).map((o) => o.id);

  await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.ledgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { vendorId: { in: ids } }] } });
  await prisma.riderLedgerEntry.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: ids } }] } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.subscription.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.referral.deleteMany({ where: { OR: [{ referrerId: { in: ids } }, { refereeId: { in: ids } }] } });
  await prisma.vendorProduct.deleteMany({ where: { vendorId: { in: ids } } });
  await prisma.pushSubscription.deleteMany({ where: { userId: { in: ids } } });
  await prisma.settlement.deleteMany({ where: { vendorId: { in: ids } } });
  await prisma.riderSettlement.deleteMany({ where: { riderId: { in: ids } } });
  await prisma.user.updateMany({ where: { referredById: { in: ids } }, data: { referredById: null } });
  await prisma.otp.deleteMany({ where: { phone: { in: safe } } });
  const deleted = await prisma.user.deleteMany({ where: { id: { in: ids } } });
  return deleted.count;
}

module.exports = {
  prisma, BASE, TEST_PREFIX,
  createReporter, request, get, post, patch, json,
  otpLogin, adminLogin, findUncontestedZone, findServiceableZone, cleanupTestUsers,
};
