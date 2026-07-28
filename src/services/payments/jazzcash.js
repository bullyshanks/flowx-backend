// ── JazzCash (HTTP POST redirect + IPN) ──
// The customer's browser POSTs a signed form to JazzCash, pays there, and is
// redirected back to pp_ReturnURL with the same field set plus a response
// code. JazzCash signs both directions with HMAC-SHA256 over the sorted
// field values, so the return payload is self-verifying — which matters,
// because the browser carries it and could otherwise be edited in transit.
//
// Docs: https://sandbox.jazzcash.com.pk/  (Merchant Portal → Integration)
const crypto = require('crypto');

const MERCHANT_ID = process.env.JAZZCASH_MERCHANT_ID;
const PASSWORD = process.env.JAZZCASH_PASSWORD;
const INTEGRITY_SALT = process.env.JAZZCASH_INTEGRITY_SALT;
const POST_URL = process.env.JAZZCASH_POST_URL
  || 'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform';

const isConfigured = () => Boolean(MERCHANT_ID && PASSWORD && INTEGRITY_SALT);

// JazzCash wants yyyyMMddHHmmss in PKT. Do the offset explicitly rather than
// relying on the server's local zone — Railway runs UTC, a developer's laptop
// usually doesn't, and a timestamp outside the expiry window is rejected.
function pktTimestamp(date = new Date()) {
  const pkt = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  return pkt.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// Signature = HMAC-SHA256(salt & value1 & value2 & ...) over every pp_* field
// with a non-empty value, sorted by key. Two exclusions matter:
//
//   - pp_SecureHash itself, or verifying a callback would hash the very field
//     being checked and never match what we produced when building.
//   - empty values, which produce a valid-looking hash JazzCash silently
//     rejects.
function sign(fields) {
  const ordered = Object.keys(fields)
    .filter((k) => (k.startsWith('pp_') || k.startsWith('ppmpf_')) && k !== 'pp_SecureHash')
    .sort()
    .map((k) => fields[k])
    .filter((v) => v !== undefined && v !== null && v !== '');

  const message = [INTEGRITY_SALT, ...ordered].join('&');
  return crypto.createHmac('sha256', INTEGRITY_SALT).update(message).digest('hex').toUpperCase();
}

// Amount is sent in paisa (lowest denomination), left-padded — sending rupees
// undercharges by 100x and the mistake is invisible until settlement.
const toPaisa = (rupees) => String(Math.round(Number(rupees) * 100));

function buildRequest({ reference, amount, returnUrl, description }) {
  const now = new Date();
  const expiry = new Date(now.getTime() + 60 * 60 * 1000); // 1h to complete

  const fields = {
    pp_Version: '1.1',
    pp_TxnType: 'MWALLET',
    pp_Language: 'EN',
    pp_MerchantID: MERCHANT_ID,
    pp_Password: PASSWORD,
    pp_TxnRefNo: reference,
    pp_Amount: toPaisa(amount),
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: pktTimestamp(now),
    pp_TxnExpiryDateTime: pktTimestamp(expiry),
    pp_BillReference: reference,
    pp_Description: description,
    pp_ReturnURL: returnUrl,
    ppmpf_1: reference,
  };

  fields.pp_SecureHash = sign(fields);
  return { url: POST_URL, method: 'POST', fields };
}

// '000' is success; '121' is the sandbox's "pending/in progress". Everything
// else is a failure, and pp_ResponseMessage carries the human-readable reason.
function parseCallback(payload) {
  const expected = sign(payload);
  const received = String(payload.pp_SecureHash || '').toUpperCase();
  const signatureValid = expected === received;

  const code = String(payload.pp_ResponseCode || '');
  return {
    signatureValid,
    reference: payload.pp_TxnRefNo || payload.ppmpf_1,
    providerTxnId: payload.pp_RetreivalReferenceNo || payload.pp_TxnRefNo,
    // Callback amount is in paisa too — convert back before comparing to the
    // order total, or every payment looks like a 100x overpayment.
    amount: payload.pp_Amount ? Number(payload.pp_Amount) / 100 : null,
    paid: signatureValid && code === '000',
    failureReason: code === '000' ? null : (payload.pp_ResponseMessage || `Response code ${code}`),
  };
}

module.exports = { name: 'JAZZCASH', isConfigured, buildRequest, parseCallback, sign };
