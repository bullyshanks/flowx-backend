# Smoke tests

End-to-end checks against a **running server and a real database**. Nothing is
mocked — they place real orders, approve real vendors, and read OTP codes back
out of the `Otp` table (there is no SMS gateway in dev, so that is the only way
to get a code).

```bash
DISABLE_RATE_LIMIT=true npm start   # in one terminal
npm run smoke                        # in another
```

`DISABLE_RATE_LIMIT` is required for a full run — see "the auth rate limiter"
below. It is ignored when `NODE_ENV=production`, so it cannot weaken the
deployed API.

Run a single suite:

```bash
node tests/smoke/customer.js
node tests/smoke/roles.js
node tests/smoke/referral.js
node tests/smoke/push.js
```

Point them at a different server with `SMOKE_API_URL`.

## Requirements

- `ADMIN_PHONE` and `ADMIN_PASSWORD` in `.env` — the suites log in as admin to
  approve vendors and drive order status. They are read from the environment,
  never hardcoded.
- A seeded database (`npm run seed`) so products and zones exist.

## Test data

Every test account uses a phone starting `0369`. `cleanupTestUsers()` refuses
to touch anything outside that prefix, and each suite cleans up before and
after itself, so a crashed run cannot leave real data damaged. Real accounts
are never modified.

## Two things that will bite you

**The auth rate limiter.** `/api/auth/*` allows 20 requests per 15 minutes
(`app.js`). A full run makes roughly 50, so without `DISABLE_RATE_LIMIT=true`
the run halts partway with HTTP 429. The limiter is in-memory, so restarting
the backend also clears it. The helpers turn a 429 into an explicit message
rather than a confusing JSON parse error on the plain-text 429 body.

**Zone contention.** `findNextVendor` offers each order to the first eligible
vendor in the zone, ordered by id. If a test vendor shares a zone with a real
approved vendor, the real one can win the offer and every assignment assertion
fails for reasons unrelated to the code under test. `findUncontestedZone()`
picks a zone with no eligible vendor for exactly this reason — use it rather
than hardcoding a zone.

## What is not covered

Actual push *delivery* to a browser. That needs a real notification permission
granted by a real user, which cannot be automated. `push.js` covers everything
the server owns — subscription storage, auth, idempotent re-subscribe, and
pruning of endpoints the push service rejects — and stops there.
