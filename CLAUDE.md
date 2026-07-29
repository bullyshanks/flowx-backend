# FlowX Backend

Water delivery platform API for FlowX (Karachi, Pakistan) — client project, brand: "Flow**X**" (X is always green + italic in UI).

## Tech Stack
- Node.js + Express (REST API)
- PostgreSQL + Prisma ORM
- JWT auth (`jsonwebtoken`), bcrypt for passwords
- Deployed on **Railway** (same project as the Postgres DB — must stay in same Railway project for `${{Postgres.DATABASE_URL}}` reference to work)

## Folder Structure
```
src/
  routes/        Express route definitions
  controllers/   Route handlers / business logic
  middleware/    auth.js (JWT + role guards), errorHandler.js
  services/      sms.service.js (dev mode logs OTP to console — no real SMS gateway configured yet)
  utils/         jwt.js, generators.js (order numbers, OTP codes)
  config/        prisma.js (Prisma client singleton)
  app.js         Express app + middleware wiring
  server.js      Entry point
prisma/
  schema.prisma  Full DB schema
  seed.js        Seeds zones, products, admin user
```

## Data Model (Prisma)
- **User** — role enum: CUSTOMER / VENDOR / ADMIN. Vendors have `vendorStatus` (PENDING/APPROVED/REJECTED/SUSPENDED) and belong to a `Zone`.
- **Zone** — delivery areas (North Karachi, DHA, Clifton, etc.) — 10 seeded zones.
- **Product** — 5 seeded products: 19L Dispenser (min 3, Rs.330), 19L Refill (min 4, Rs.90), 1.5L Set of 6 (Rs.300), 500ml Set of 12 (Rs.480), 1000L Tank (Rs.1400).
- **Order** — supports guest checkout (no account) or authed customer. Has `status` enum (PENDING→CONFIRMED→ASSIGNED→OUT_FOR_DELIVERY→DELIVERED/CANCELLED), zone-based vendor assignment, `OrderStatusLog` for audit trail.
- **Subscription** — recurring orders (DAILY/WEEKLY/MONTHLY frequency).
- **Otp** — phone OTP records with expiry.

## Key Business Rules
- Vendors only see/accept orders in their own `zoneId` (enforced in order controller, not just UI).
- Vendor must be `APPROVED` by admin before they can log in or accept orders.
- Admin can manually assign any vendor to any order.
- Guest orders allowed (no login required) — customerId is nullable, guestName/guestPhone used instead.

## Auth
- `requireAuth` — verifies JWT, attaches `req.user`.
- `requireRole(...roles)` — role guard.
- `requireApprovedVendor` — vendor role + APPROVED status guard.
- OTP login flow: send OTP → verify OTP → get JWT. Password login also supported (used mainly for vendors/admin).

## Environment Variables (set on Railway)
```
DATABASE_URL=${{Postgres.DATABASE_URL}}   # must reference DB in same Railway project
JWT_SECRET=...
JWT_EXPIRES_IN=7d
NODE_ENV=production
ADMIN_PHONE=03158374442
ADMIN_PASSWORD=...
FRONTEND_URL=<exact Vercel URL, no trailing slash>   # CORS — code does .split(',') so comma-separate multiple origins
SMS_SENDER_ID=FlowX
# SMS_PROVIDER / SMS_API_URL / SMS_API_KEY intentionally NOT set — leaves SMS in dev mode (logs OTP to console instead of sending). Add these later when client gets a real SMS gateway.
```

## Deployment (Railway)
- Custom start command (Settings → Deploy):
  ```
  npx prisma db push --accept-data-loss && npm run seed && npm start
  ```
  (Using `db push` not `migrate deploy` — no migration files exist yet, schema pushed directly.)
- Runs on Railway-assigned `PORT` (currently 8080) — must match the target port set in Settings → Networking → domain, or you get 502s.
- Backend + Postgres **must be in the same Railway project** to use `${{Postgres.DATABASE_URL}}` variable reference.

## Payments
- Three gateways wired: **JazzCash**, **Easypaisa** (both signed form POST + return callback) and **Safepay** (API-created tracker + signed webhook, used for `CARD`).
- `PaymentMethod` → provider: `JAZZCASH`→JazzCash, `EASYPAISA`→Easypaisa, `CARD`→Safepay. `COD` and `BANK_TRANSFER` never touch a gateway.
- **Dev mode**: with no credentials in `.env`, checkout is simulated via `/api/payments/simulate/:reference` — the whole flow works locally without a merchant account. Fill in credentials and the same code talks to the real gateway. See `.env.example`.
- Three rules enforced in `payment.service.settlePayment()`, each one a way to lose money: only a **signature-verified** callback settles an order (never the browser redirect), the callback **amount must match** the order total, and settling is **idempotent** (gateways retry webhooks).
- `Payment` rows are the audit trail — one per attempt, keeping failures and the verbatim `rawCallback` for reconciliation. `Order.paymentStatus` stays the field the rest of the app reads.
- Safepay's webhook is signed over **raw bytes**, so `/api/payments/callback` is mounted with `express.raw()` *ahead* of `express.json()` in `app.js`. Moving it below silently breaks verification.

## Error Tracking (Sentry)
- `src/instrument.js` **must** be required before `./app` in `server.js` — Sentry patches express/prisma at require-time. Moving it later doesn't error, it just silently stops collecting request context.
- **Dev mode**: no `SENTRY_DSN` ⇒ completely inert, no account needed. Same convention as SMS and the payment adapters.
- `beforeSend` scrubs PII on every event: phones, addresses, OTP codes, CNIC images, tokens and gateway secrets are redacted, query strings dropped, headers/cookies deleted, and `user` reduced to `{ id, role }`. Add any new sensitive field name to `SENSITIVE_KEYS`.
- Expected 4xx rejections (bad OTP, wrong role, rate limits) are filtered out — only 5xx and unhandled crashes are reported.
- Explicitly captured beyond the request cycle: **startup failures** (the P1001 that took production down) and the **subscription sweep**, which runs on a timer where a swallowed error would otherwise be invisible until a customer complained.

## Testing
- `npm run smoke` runs the end-to-end suite (`tests/smoke/`) against a live server + real DB. Start the server with `DISABLE_RATE_LIMIT=true` or the run halts on the 20-request auth limit. See `tests/smoke/README.md`.

## Known Gotchas (already hit these — don't repeat)
- CORS: `FRONTEND_URL` must be the exact deployed frontend origin (not `*`) or login/API calls fail with CORS preflight errors.
- If Railway shows "Deployment successful" but the app 502s, check Deploy Logs (not HTTP Logs) for the real crash reason.
- No real SMS gateway configured — OTPs are visible only in Railway deploy logs during testing.

## Live URLs
- API base: `https://flowx-backend-production.up.railway.app/api`
- Health check: `/api/health`
- Default admin login: `03158374442` / (see Railway env var)
