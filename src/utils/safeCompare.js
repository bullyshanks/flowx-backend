const crypto = require('crypto');

// Plain === on a signature short-circuits on the first differing byte, which
// theoretically leaks timing information about how much of a guess was
// correct. Not the most severe class of bug (remote HMAC timing attacks are
// impractical in almost all real network conditions), but cheap to close and
// safepay.js already does it — the other two gateway adapters should match
// rather than being the odd one out.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { safeCompare };
