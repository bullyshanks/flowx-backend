// ── JWT signing & verification ──
const jwt = require('jsonwebtoken');

// No fallback secret: a hardcoded default lets anyone who reads this file
// forge tokens for any role against a deployment that forgot to set
// JWT_SECRET. Fail at boot instead of silently signing with a known value.
// Tests set their own JWT_SECRET (see tests/smoke) so this doesn't affect
// the smoke suite.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required and must not be empty');
}
// Shortened from the old 7d default — with tokenVersion now providing real
// revocation (logout-all, freeze, suspend), long-lived tokens are no longer
// covering for the lack of one; a shorter window just bounds the damage from
// a token that leaks before anyone notices.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';

const signToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

module.exports = { signToken, verifyToken };
