// Number(limit) with no bound turns a client-supplied query param directly
// into a Prisma `take` — NaN (bad input) throws a 500, and a large value
// (or an intentionally huge one) runs an unbounded query. Every list
// endpoint should route its `limit`/`offset` through this.
const clampTake = (value, { def = 20, max = 100 } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
};

const clampSkip = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
};

// A raw client-supplied string handed straight to Prisma as an enum-typed
// field value throws when it doesn't match a known variant, and that throw
// was reaching the client as a raw Prisma error message (see errorHandler).
// Returns the value only if it's one of the allowed variants, else undefined
// (i.e. "don't filter on it") — never lets an invalid value reach the query.
const validEnum = (value, allowed) => (allowed.includes(value) ? value : undefined);

module.exports = { clampTake, clampSkip, validEnum };
