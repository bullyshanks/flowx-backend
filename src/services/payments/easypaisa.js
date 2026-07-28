// ── Easypaisa (Hosted Checkout) ──
// Same shape as JazzCash — signed form POST, customer pays, gateway redirects
// back — but the signing differs in two ways worth knowing before debugging a
// rejected request:
//
//   1. Easypaisa signs a key=value& string (JazzCash signs values only).
//   2. It uses AES-128-ECB, not HMAC, and the result is base64 not hex.
//
// Amounts here are in rupees with two decimals, NOT paisa like JazzCash.
//
// Docs: https://easypay.easypaisa.com.pk/  (Merchant Integration Guide)
const crypto = require('crypto');

const STORE_ID = process.env.EASYPAISA_STORE_ID;
const HASH_KEY = process.env.EASYPAISA_HASH_KEY;
const POST_URL = process.env.EASYPAISA_POST_URL
  || 'https://easypay.easypaisa.com.pk/easypay/Index.jsf';

const isConfigured = () => Boolean(STORE_ID && HASH_KEY);

// Easypaisa expects yyyy-MM-dd HH:mm:ss in PKT.
function pktExpiry(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const pkt = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  return pkt.toISOString().replace('T', ' ').slice(0, 19);
}

// The hash key is a 16-byte AES key. Fields are sorted, joined as
// key1=value1&key2=value2, encrypted, and base64-encoded.
function sign(fields) {
  const message = Object.keys(fields)
    .filter((k) => k !== 'merchantHashedReq')
    .sort()
    .filter((k) => fields[k] !== undefined && fields[k] !== null && fields[k] !== '')
    .map((k) => `${k}=${fields[k]}`)
    .join('&');

  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(HASH_KEY, 'utf8'), null);
  return Buffer.concat([cipher.update(message, 'utf8'), cipher.final()]).toString('base64');
}

function buildRequest({ reference, amount, returnUrl }) {
  const fields = {
    storeId: STORE_ID,
    orderRefNum: reference,
    // Rupees with 2dp here — unlike JazzCash, which wants paisa.
    amount: Number(amount).toFixed(2),
    postBackURL: returnUrl,
    expiryDate: pktExpiry(),
    paymentMethod: 'MA_PAYMENT_METHOD', // mobile account
    autoRedirect: '1',
  };

  fields.merchantHashedReq = sign(fields);
  return { url: POST_URL, method: 'POST', fields };
}

// Easypaisa returns status in `status`, with '0000' meaning success.
function parseCallback(payload) {
  // The postback echoes a hash over the response fields. Some Easypaisa
  // deployments omit it entirely; treat a missing hash as unverified rather
  // than as valid, so a forged callback can never settle an order.
  const received = payload.merchantHashedReq || payload.hashedResponse;
  let signatureValid = false;
  if (received) {
    try {
      signatureValid = sign(payload) === received;
    } catch {
      signatureValid = false;
    }
  }

  const code = String(payload.status || payload.responseCode || '');
  return {
    signatureValid,
    hasSignature: Boolean(received),
    reference: payload.orderRefNum || payload.orderRefNumber,
    providerTxnId: payload.transactionId || payload.paymentToken,
    amount: payload.transactionAmount ? Number(payload.transactionAmount) : null,
    paid: code === '0000',
    failureReason: code === '0000' ? null : (payload.desc || payload.responseDesc || `Status ${code}`),
  };
}

module.exports = { name: 'EASYPAISA', isConfigured, buildRequest, parseCallback, sign };
