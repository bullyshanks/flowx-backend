// ═══════════════════════════════════════════════════════════
//  SMS Service — works with any local PK SMS gateway
//  Plug in your real Jazz/Telenor API credentials in .env
// ═══════════════════════════════════════════════════════════

const axios = require('axios');

const PROVIDER = process.env.SMS_PROVIDER || 'jazz';
const API_URL = process.env.SMS_API_URL;
const API_KEY = process.env.SMS_API_KEY;
const SENDER_ID = process.env.SMS_SENDER_ID || 'FlowX';

/**
 * Send an SMS to a Pakistani phone number.
 * In development (no API key set), it just logs to the console.
 */
async function sendSms(phone, message) {
  // Dev mode — log to console
  if (!API_KEY || API_KEY === 'your-sms-api-key-here') {
    console.log('\n┌─────────────── 📱 SMS (DEV MODE) ───────────────');
    console.log(`│ To:      ${phone}`);
    console.log(`│ Message: ${message}`);
    console.log('└──────────────────────────────────────────────────\n');
    return { success: true, mode: 'dev' };
  }

  try {
    // ── Generic POST request — adapt per your provider ──
    // Most PK SMS gateways accept: { to, from, text, api_key }
    const response = await axios.post(
      API_URL,
      {
        to: phone,
        from: SENDER_ID,
        text: message,
        api_key: API_KEY,
      },
      { timeout: 10000 }
    );

    console.log(`✓ SMS sent to ${phone}`);
    return { success: true, data: response.data };
  } catch (err) {
    console.error(`✗ SMS failed to ${phone}:`, err.message);
    return { success: false, error: err.message };
  }
}

const sendOtpSms = (phone, code) =>
  sendSms(
    phone,
    `Your FlowX verification code is: ${code}. Valid for 5 minutes. Do not share.`
  );

const sendOrderConfirmationSms = (phone, orderNumber) =>
  sendSms(
    phone,
    `FlowX: Order ${orderNumber} confirmed! Track at flowx.pk/track. Thank you!`
  );

const sendOrderAssignedSms = (phone, orderNumber, vendorName) =>
  sendSms(
    phone,
    `FlowX: Order ${orderNumber} assigned to vendor ${vendorName}. Out for delivery soon.`
  );

const sendVendorApprovedSms = (phone) =>
  sendSms(
    phone,
    `FlowX: Your vendor account is approved! Login at flowx.pk/vendor to start receiving orders.`
  );

const sendRefundPaidSms = (phone, orderNumber, amount) =>
  sendSms(
    phone,
    `FlowX: Rs. ${amount} refunded for order ${orderNumber}. Track at flowx.pk/track. Thank you for your patience!`
  );

const sendOrderOutForDeliverySms = (phone, orderNumber) =>
  sendSms(
    phone,
    `FlowX: Order ${orderNumber} is out for delivery! Track at flowx.pk/track.`
  );

const sendOrderDeliveredSms = (phone, orderNumber) =>
  sendSms(
    phone,
    `FlowX: Order ${orderNumber} has been delivered. Thank you for choosing FlowX!`
  );

const sendOrderCancelledSms = (phone, orderNumber) =>
  sendSms(
    phone,
    `FlowX: Order ${orderNumber} has been cancelled. Contact us on WhatsApp at +92 315 8374442 if you have questions.`
  );

const sendVendorSettlementPaidSms = (phone, amount) =>
  sendSms(
    phone,
    `FlowX: Your settlement of Rs. ${amount} has been paid. Check your wallet at flowx.pk for details.`
  );

const sendRiderSettlementPaidSms = (phone, amount) =>
  sendSms(
    phone,
    `FlowX: Your settlement of Rs. ${amount} has been paid. Check your wallet at flowx.pk for details.`
  );

// Shared across vendor and rider — same account-level concept, same wording.
const sendAccountFrozenSms = (phone) =>
  sendSms(
    phone,
    `FlowX: Your account has been frozen and cannot accept new orders. Contact us on WhatsApp at +92 315 8374442 to resolve this.`
  );

const sendAccountUnfrozenSms = (phone) =>
  sendSms(
    phone,
    `FlowX: Your account has been unfrozen. You can accept new orders again.`
  );

const sendAccountSuspendedSms = (phone, reason) =>
  sendSms(
    phone,
    `FlowX: Your account has been suspended${reason ? ` — ${reason}` : ''}. You will not be able to log in until this is resolved. Contact us on WhatsApp at +92 315 8374442.`
  );

const sendAccountReactivatedSms = (phone) =>
  sendSms(
    phone,
    `FlowX: Your account has been reactivated. You can log in again.`
  );

module.exports = {
  sendSms,
  sendOtpSms,
  sendOrderConfirmationSms,
  sendOrderAssignedSms,
  sendVendorApprovedSms,
  sendRefundPaidSms,
  sendOrderOutForDeliverySms,
  sendOrderDeliveredSms,
  sendVendorSettlementPaidSms,
  sendRiderSettlementPaidSms,
  sendOrderCancelledSms,
  sendAccountFrozenSms,
  sendAccountUnfrozenSms,
  sendAccountSuspendedSms,
  sendAccountReactivatedSms,
};
