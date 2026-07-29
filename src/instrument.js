// ═══════════════════════════════════════════════════════════
//  Sentry error tracking — MUST be required before anything else
// ═══════════════════════════════════════════════════════════
//
// Sentry patches Express, Prisma and http at require-time, so this file has to
// run before `./app` (and therefore before express) is ever required. That is
// why server.js requires it on line 2 and not from inside app.js. Moving it
// later doesn't error — it just silently stops collecting request context and
// database spans, which is worse.
//
// Same dev-mode convention as sms.service.js and the payment adapters: with no
// SENTRY_DSN set, this is completely inert. Nothing is sent anywhere, no
// account is needed, and local development is unaffected.

require('dotenv').config();

const DSN = process.env.SENTRY_DSN;

// ── PII scrubbing ──
// FlowX handles phone numbers, delivery addresses, OTP codes, CNIC images and
// gateway credentials. None of that belongs in a third-party error tracker, and
// under no circumstances should an OTP or a payment secret leave this process.
// Sentry's own `sendDefaultPii` is off by default; this list is the second
// layer, applied to every event regardless of where the data came from.
const SENSITIVE_KEYS = [
  'password', 'currentpassword', 'newpassword',
  'token', 'accesstoken', 'refreshtoken', 'authorization', 'cookie',
  'code', 'otp',
  'cnic', 'cnicfront', 'cnicback', 'selfie', 'image', 'images',
  'phone', 'guestphone', 'customerphone', 'riderphone', 'vendorphone',
  'address', 'deliveryaddress', 'guestaddress',
  'pp_securehash', 'securehash', 'integritysalt', 'apikey', 'api_key',
  'secret', 'clientsecret', 'webhooksecret', 'hashkey',
];

const REDACTED = '[redacted]';

function scrub(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.includes(key.toLowerCase()) ? REDACTED : scrub(v, depth + 1);
  }
  return out;
}

// Query strings can carry a phone or a payment reference. We keep the path —
// which is the useful part for grouping — and drop everything after the "?".
function stripQuery(url) {
  if (typeof url !== 'string') return url;
  const i = url.indexOf('?');
  return i === -1 ? url : `${url.slice(0, i)}?${REDACTED}`;
}

// Errors we deliberately raise to reject bad input aren't defects — a customer
// mistyping an OTP is not something anyone should be paged about. Filtering
// them here keeps the signal worth looking at.
const IGNORED_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);

function init() {
  if (!DSN) {
    console.log('ℹ  Sentry DEV MODE (SENTRY_DSN unset) — errors log to console only');
    return;
  }

  const Sentry = require('@sentry/node');

  Sentry.init({
    dsn: DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,

    // Never opt into Sentry's automatic PII collection (IPs, headers, bodies).
    sendDefaultPii: false,

    // Performance sampling is off unless explicitly dialled up. Traces cost
    // quota, and FlowX's free-tier budget is better spent on actual errors.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),

    beforeSend(event, hint) {
      const status = hint?.originalException?.status;
      if (IGNORED_STATUSES.has(status)) return null;

      if (event.request) {
        event.request.url = stripQuery(event.request.url);
        delete event.request.cookies;
        delete event.request.headers;
        if (event.request.data) event.request.data = scrub(event.request.data);
        if (event.request.query_string) event.request.query_string = REDACTED;
      }
      if (event.extra) event.extra = scrub(event.extra);
      if (event.contexts) event.contexts = scrub(event.contexts);

      // A user id is enough to find the account in our own database; the phone
      // number is not needed and is the one identifier a leak would expose.
      if (event.user) event.user = { id: event.user.id };

      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.url) breadcrumb.data.url = stripQuery(breadcrumb.data.url);
      return breadcrumb;
    },
  });

  console.log(`✓ Sentry enabled (${process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV})`);
}

init();

// Callers get a no-op-safe handle: when the DSN is unset these are the real
// SDK functions on a client that was never initialised, so they do nothing.
module.exports = {
  enabled: Boolean(DSN),
  Sentry: DSN ? require('@sentry/node') : null,
};
