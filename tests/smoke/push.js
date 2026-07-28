// Push subscription storage, auth guards, and the send path's handling of a
// dead endpoint. Delivering to a real browser needs a real granted permission,
// so that last mile is not covered here — what is covered is everything the
// server owns: storing subscriptions, refusing anonymous ones, surviving a
// send with no subscribers, and pruning endpoints the push service rejects.
const crypto = require('crypto');
const {
  prisma, createReporter, get, post, request, json, otpLogin, cleanupTestUsers,
} = require('./helpers');

const CUSTOMER = '03699555001';
const PHONES = [CUSTOMER];

// web-push encrypts the payload against the subscription's real ECDH key
// before it ever makes a network call, so a placeholder string would fail
// locally for the wrong reason. Generate a structurally valid P-256 key.
function fakeSubscription(id) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/smoke-test-${id}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

async function run() {
  const { check, summary } = createReporter('push');
  await cleanupTestUsers(PHONES);

  const customer = await otpLogin(CUSTOMER);
  const user = await prisma.user.findUnique({ where: { phone: CUSTOMER } });

  // ── Sending with no subscribers must be a silent no-op, never a throw:
  // every call site is fire-and-forget inside a request handler.
  const push = require('../../src/services/push.service');
  let threw = false;
  try {
    await push.sendPush(user.id, 'No Subscribers', 'should not throw');
  } catch { threw = true; }
  check('sendPush with no subscriptions does not throw', threw === false);

  // ── Subscribe ──
  const sub = fakeSubscription('a');
  const subscribed = await post('/notifications/subscribe', sub, customer.token);
  check('POST /notifications/subscribe', subscribed.status === 200 || subscribed.status === 201,
    `HTTP ${subscribed.status}`);
  check('  subscription stored',
    (await prisma.pushSubscription.count({ where: { userId: user.id } })) === 1);

  // ── Re-subscribing with the same endpoint upserts rather than duplicating
  // (registerPush runs on every layout mount, so this happens constantly).
  await post('/notifications/subscribe', sub, customer.token);
  check('re-subscribe is idempotent',
    (await prisma.pushSubscription.count({ where: { userId: user.id } })) === 1);

  // ── Anonymous callers must not be able to register endpoints ──
  check('subscribe requires auth',
    (await post('/notifications/subscribe', fakeSubscription('b'))).status === 401);

  // ── A rejected endpoint gets pruned, so dead installs don't accumulate ──
  await push.sendPush(user.id, 'Prune Test', 'endpoint is bogus and will 404');
  await new Promise((r) => setTimeout(r, 2500));
  const remaining = await prisma.pushSubscription.count({ where: { userId: user.id } });
  check('dead endpoint pruned after failed send', remaining === 0, `${remaining} left`);

  // ── Unsubscribe ──
  const sub2 = fakeSubscription('c');
  await post('/notifications/subscribe', sub2, customer.token);
  const removed = await request('DELETE', '/notifications/subscribe', { endpoint: sub2.endpoint }, customer.token);
  check('DELETE /notifications/subscribe', removed.status === 200, `HTTP ${removed.status}`);
  check('  subscription removed',
    (await prisma.pushSubscription.count({ where: { userId: user.id } })) === 0);

  await cleanupTestUsers(PHONES);
  return summary();
}

module.exports = { run, PHONES };

if (require.main === module) {
  run()
    .then((r) => prisma.$disconnect().then(() => process.exit(r.failed ? 1 : 0)))
    .catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
}
