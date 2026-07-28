// ═══════════════════════════════════════════════════════════
//  Push Notification Service — Web Push (VAPID), no Firebase/
//  third-party account needed. Same fire-and-forget shape as
//  sms.service.js: one generic sender + named wrapper functions,
//  called from the same sites SMS is called from.
//
//  Keyed by userId (not phone) — subscriptions are stored per
//  logged-in user/device (see PushSubscription model), so this
//  can only reach someone who has an account and granted browser
//  notification permission. Guest orders and OTP send/verify (no
//  account yet, or not logged in yet) have no possible subscriber
//  and are intentionally not wired up — see order/auth controllers.
// ═══════════════════════════════════════════════════════════

const webpush = require('web-push');
const prisma = require('../config/prisma');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:orders@flowx.pk';

const devMode = !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || VAPID_PRIVATE_KEY === 'your-vapid-private-key-here';

if (!devMode) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/**
 * Push a notification to every device a user has subscribed on.
 * In development (no VAPID keys set), it just logs to the console —
 * mirrors sendSms's dev-mode fallback exactly.
 */
async function sendPush(userId, title, body, data = {}) {
  if (!userId) return { success: false, error: 'No userId' };

  if (devMode) {
    console.log('\n┌─────────────── 🔔 PUSH (DEV MODE) ───────────────');
    console.log(`│ To:      user ${userId}`);
    console.log(`│ Title:   ${title}`);
    console.log(`│ Body:    ${body}`);
    console.log('└──────────────────────────────────────────────────\n');
    return { success: true, mode: 'dev' };
  }

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subscriptions.length === 0) return { success: true, sent: 0 };

  const payload = JSON.stringify({ title, body, data });
  let sent = 0;
  const expired = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent += 1;
    } catch (err) {
      // 404/410 = the browser/OS has invalidated this subscription (uninstalled,
      // permission revoked, endpoint expired) — clean it up rather than retrying
      // forever against a dead endpoint.
      if (err.statusCode === 404 || err.statusCode === 410) {
        expired.push(sub.id);
      } else {
        console.error(`✗ Push failed for user ${userId}:`, err.message);
      }
    }
  }

  if (expired.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: expired } } });
  }

  return { success: true, sent };
}

// ── Named wrappers — one per sms.service.js event, same copy adapted to a
// title/body pair. Kept 1:1 with the SMS function names for easy cross-reference. ──

const sendKycApprovedPush = (userId) =>
  sendPush(userId, 'KYC Approved', 'Your identity verification (KYC) is approved.');

const sendKycRejectedPush = (userId, reason) =>
  sendPush(
    userId,
    'KYC Not Approved',
    `Your identity verification was not approved${reason ? ` — ${reason}` : ''}. Please re-upload your documents.`
  );

const sendAccountFrozenPush = (userId) =>
  sendPush(
    userId,
    'Account Frozen',
    'Your account has been frozen. You cannot accept new orders, and any order currently assigned to you has been reassigned.'
  );

const sendAccountUnfrozenPush = (userId) =>
  sendPush(userId, 'Account Unfrozen', 'Your account has been unfrozen. You can accept new orders again.');

const sendAccountSuspendedPush = (userId, reason) =>
  sendPush(
    userId,
    'Account Suspended',
    `Your account has been suspended${reason ? ` — ${reason}` : ''}. You will not be able to log in until this is resolved.`
  );

const sendAccountReactivatedPush = (userId) =>
  sendPush(userId, 'Account Reactivated', 'Your account has been reactivated. You can log in again.');

const sendAccountRejectedPush = (userId, reason) =>
  sendPush(userId, 'Application Not Approved', `Your application was not approved${reason ? ` — ${reason}` : ''}.`);

const sendVendorApprovedPush = (userId) =>
  sendPush(userId, 'Vendor Account Approved', 'Your vendor account is approved! Log in to start receiving orders.');

const sendRiderApprovedPush = (userId) =>
  sendPush(userId, 'Rider Account Approved', 'Your rider account is approved! Log in to start accepting deliveries.');

const sendVendorSettlementPaidPush = (userId, amount) =>
  sendPush(userId, 'Settlement Paid', `Your settlement of Rs. ${amount} has been paid.`);

const sendRiderSettlementPaidPush = (userId, amount) =>
  sendPush(userId, 'Settlement Paid', `Your settlement of Rs. ${amount} has been paid.`);

const sendRefundPaidPush = (userId, orderNumber, amount) =>
  sendPush(userId, 'Refund Paid', `Rs. ${amount} refunded for order ${orderNumber}.`);

const sendRefundRejectedPush = (userId, orderNumber, reason) =>
  sendPush(
    userId,
    'Refund Not Approved',
    `Your refund request for order ${orderNumber} was not approved${reason ? ` — ${reason}` : ''}.`
  );

const sendOrderConfirmationPush = (userId, orderNumber) =>
  sendPush(userId, 'Order Confirmed', `Order ${orderNumber} confirmed! Track it any time.`);

const sendOrderAssignedPush = (userId, orderNumber, vendorName) =>
  sendPush(userId, 'Vendor Assigned', `Order ${orderNumber} assigned to ${vendorName}. Out for delivery soon.`);

const sendOrderOutForDeliveryPush = (userId, orderNumber) =>
  sendPush(userId, 'Out for Delivery', `Order ${orderNumber} is out for delivery!`);

const sendOrderDeliveredPush = (userId, orderNumber) =>
  sendPush(userId, 'Order Delivered', `Order ${orderNumber} has been delivered. Thank you for choosing FlowX!`);

const sendOrderCancelledPush = (userId, orderNumber) =>
  sendPush(userId, 'Order Cancelled', `Order ${orderNumber} has been cancelled.`);

const sendPaymentReceivedPush = (userId, orderNumber, amount) =>
  sendPush(userId, 'Payment Received', `Rs. ${Number(amount).toFixed(0)} received for order ${orderNumber}.`);

module.exports = {
  sendPush,
  sendPaymentReceivedPush,
  sendKycApprovedPush,
  sendKycRejectedPush,
  sendAccountFrozenPush,
  sendAccountUnfrozenPush,
  sendAccountSuspendedPush,
  sendAccountReactivatedPush,
  sendAccountRejectedPush,
  sendVendorApprovedPush,
  sendRiderApprovedPush,
  sendVendorSettlementPaidPush,
  sendRiderSettlementPaidPush,
  sendRefundPaidPush,
  sendRefundRejectedPush,
  sendOrderConfirmationPush,
  sendOrderAssignedPush,
  sendOrderOutForDeliveryPush,
  sendOrderDeliveredPush,
  sendOrderCancelledPush,
};
