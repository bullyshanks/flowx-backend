# FlowX Backend

Water delivery platform API for FlowX (Karachi, Pakistan) — client project, brand: "Flow**X**" (X is always green + italic in UI).

## Tech Stack
- Node.js + Express (REST API)
- PostgreSQL + Prisma ORM
- JWT auth (`jsonwebtoken`), bcrypt for passwords
- Deployed on **Azure App Service** (Railway and Vercel were decommissioned 2026-08-14 — do not reference them, both projects/DBs are deleted)

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
- **User** — role enum: CUSTOMER / VENDOR / RIDER / ADMIN. Vendors/riders have `vendorStatus` (PENDING/APPROVED/REJECTED/SUSPENDED, shared field) and belong to a `Zone`. `tokenVersion` on User is bumped to revoke all previously-issued JWTs for that account (logout-all, freeze, suspend).
- **Zone** — delivery areas (North Karachi, DHA, Clifton, etc.) — 10 seeded zones.
- **Product** — 5 seeded products: 19L Dispenser (min 3, Rs.330), 19L Refill (min 4, Rs.90), 1.5L Set of 6 (Rs.300), 500ml Set of 12 (Rs.480), 1000L Tank (Rs.1400).
- **Order** — supports guest checkout (no account) or authed customer. Has `status` enum (PENDING→CONFIRMED→ASSIGNED→OUT_FOR_DELIVERY→DELIVERED/CANCELLED), zone-based vendor assignment, `OrderStatusLog` for audit trail, `discountAmount` for referral/wallet discounts.
- **Subscription** — recurring orders (DAILY/WEEKLY/MONTHLY frequency).
- **Otp** — phone OTP records with expiry and an `attempts` counter (enforced — see Auth below).
- **Referral** — referrer/referee link with a Rs.50 referee discount + referrer wallet bonus, credited once the referee's first order is delivered.
- **PushSubscription** — Web Push (VAPID) subscriptions, one per browser/device.

## Key Business Rules
- Vendors only see/accept orders in their own `zoneId` (enforced in order controller, not just UI).
- Vendor/rider must be `APPROVED` by admin before they can log in or accept orders.
- Admin can manually assign any vendor to any order.
- Guest orders allowed (no login required) — customerId is nullable, guestName/guestPhone used instead.

## Auth
- `requireAuth` — verifies JWT, attaches `req.user`, and rejects if the token's `tokenVersion` claim doesn't match the current DB value (revocation).
- `requireRole(...roles)` — role guard.
- `requireApprovedVendor` / `requireApprovedRider` — role + APPROVED status + KYC APPROVED guard.
- OTP login flow: send OTP → verify OTP → get JWT. Per-phone send throttle (30s cooldown, 5/15min cap) and a 5-attempt cap per code — both enforced server-side, not just rate-limited by IP. **ADMIN accounts cannot log in via OTP at all — password only.**
- Password login also supported (used mainly for vendors/riders/admin).
- `POST /api/auth/logout-all` — bumps `tokenVersion`, invalidating every previously-issued token for that account.

## Environment Variables (set on Azure — via Key Vault, see below)
```
DATABASE_URL=...      # Key Vault reference — Azure Postgres, sslmode=require
JWT_SECRET=...         # Key Vault reference — required at boot, no fallback
JWT_EXPIRES_IN=1d
NODE_ENV=production
ADMIN_PHONE=...
ADMIN_PASSWORD=...     # Key Vault reference — required for seed to run, no fallback
FRONTEND_URL=<exact deployed frontend origin, no trailing slash>   # CORS — required in production, no '*' fallback
SMS_SENDER_ID=FlowX
# SMS_PROVIDER / SMS_API_URL / SMS_API_KEY intentionally NOT set — leaves SMS in dev mode (logs OTP to console instead of sending). Add these later when client gets a real SMS gateway.
VAPID_PUBLIC_KEY=...    # Web Push — leave unset to keep push in dev-mode (logs instead of sending)
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=...
```

## Deployment (Azure App Service)
- **API live**: https://app-flowx-api-sh42.azurewebsites.net/api/health
- **Web live**: https://app-flowx-web-sh42.azurewebsites.net (the frontend repo, also deployed to Azure App Service — see its own CLAUDE.md)
- **Resource group**: `rg-flowx` (Azure for Students subscription)
- **Deploy**: push to `azure-deployment` → GitHub Actions (`.github/workflows/azure-deploy.yml`). The job polls `/api/health` after deploying, so a green run means the app actually booted and reached Postgres, not just that the zip landed.
- Auth is OIDC federated credentials **pinned to that exact branch**. Merging to `main` needs a new credential for `refs/heads/main` plus `main` in the workflow's `branches:`, or pushes silently stop deploying.

### Secrets come from Key Vault, not app settings
`DATABASE_URL`, `JWT_SECRET` and `ADMIN_PASSWORD` are `@Microsoft.KeyVault(...)` references in `kv-flowx-sh42`, resolved at startup via the app's system-assigned managed identity. No plaintext in app settings. If a reference fails to resolve the app sees the literal `@Microsoft.KeyVault(...)` string — Prisma then throws a URL parse error, which is the giveaway.

**Use name-based references (`@Microsoft.KeyVault(VaultName=kv-flowx-sh42;SecretName=X)`), not version-pinned `SecretUri` ones.** A version-pinned reference does NOT auto-follow secret rotations — updating the Key Vault secret silently has no effect until the app setting itself is repointed at the new version, which caused a full outage on 2026-08-13 (DB password rotated, Key Vault secret updated, but the app kept trying the old password until the reference was fixed). Check with `az webapp config appsettings list -n app-flowx-api-sh42 -g rg-flowx` after any credential rotation.

### No `prisma migrate deploy` on boot
Migrations are a deliberate manual step, run from an allowlisted machine — the CI pipeline does not run them, because that would mean opening the Postgres firewall to GitHub's rotating IPs. **After pushing a migration file, it does not apply itself** — someone has to run `migrate deploy` against Azure by hand (see below) or the app will crash on startup referencing columns/tables that don't exist yet.

The seed (`npm run seed`) also only ever runs manually — not on every deploy, unlike the old Railway setup.

### Running migrations / seed against Azure
From a machine whose IP is in the Postgres firewall (`az postgres flexible-server firewall-rule list -s psql-flowx-sh42 -g rg-flowx`):
```
mv .env .env.local.bak
export DATABASE_URL="postgresql://flowxadmin:PASSWORD@psql-flowx-sh42.postgres.database.azure.com:5432/flowx_db?sslmode=require"
npx prisma migrate deploy
# and/or, with ADMIN_PHONE/ADMIN_PASSWORD also exported:
npm run seed
mv .env.local.bak .env
```
`?sslmode=require` is mandatory — Azure Postgres rejects unencrypted connections. Home IPs rotate, so re-add the firewall rule if this starts timing out.

### Rotating credentials (DB password, admin password, JWT secret)
1. Update the actual credential (`az postgres flexible-server update --admin-password ...` for DB, or just decide a new value for admin password).
2. Update the matching Key Vault secret (`az keyvault secret set --vault-name kv-flowx-sh42 --name <NAME> --value ...`).
3. Confirm the app setting referencing it is name-based, not version-pinned (see above).
4. `az webapp restart -n app-flowx-api-sh42 -g rg-flowx` and check `/api/health`.
5. If it's the DB password: also re-run migrations/seed with the new `DATABASE_URL` if anything needs to write (e.g. admin password rotation needs `npm run seed` afterward — Key Vault rotation alone doesn't touch the actual bcrypt hash in the DB).

### Gotchas
- Both the API and web app share one B1 plan (1 vCore). A heavy build on either can starve the other.
- `GET /` returns 404 constantly in logs: that's Always On pinging the site root, which mounts no route. Harmless, but it inflates the failure count in App Insights.
- App Insights records nothing during a total outage — it instruments the process, so a dead process reports nothing. Availability tests (`avail-flowx-api`) cover that gap and email on failure.
- Multiple admin accounts can exist — `prisma.user.upsert` in seed.js is keyed on `ADMIN_PHONE`, so changing that env var and re-seeding *adds* a new admin rather than renaming the old one. Demote the old one manually (role → CUSTOMER, bump tokenVersion) if you don't want it active.

## Payments
- Three gateways wired: **JazzCash**, **Easypaisa** (both signed form POST + return callback) and **Safepay** (API-created tracker + signed webhook, used for `CARD`). Signature comparisons use `crypto.timingSafeEqual` (see `src/utils/safeCompare.js`).
- `PaymentMethod` → provider: `JAZZCASH`→JazzCash, `EASYPAISA`→Easypaisa, `CARD`→Safepay. `COD` and `BANK_TRANSFER` never touch a gateway.
- **Dev mode**: with no credentials in `.env`, checkout is simulated via `/api/payments/simulate/:reference` — the whole flow works locally without a merchant account. Fill in credentials and the same code talks to the real gateway. See `.env.example`.
- Three rules enforced in `payment.service.settlePayment()`, each one a way to lose money: only a **signature-verified** callback settles an order (never the browser redirect), the callback **amount must match** the order total, and settling is **idempotent** (gateways retry webhooks).
- `Payment` rows are the audit trail — one per attempt, keeping failures and the verbatim `rawCallback` for reconciliation. `Order.paymentStatus` stays the field the rest of the app reads.
- Safepay's webhook is signed over **raw bytes**, so `/api/payments/callback` is mounted with `express.raw()` *ahead* of `express.json()` in `app.js`. Moving it below silently breaks verification.
- Guest payment status/initiate (`/api/payments/status/:orderNumber`, `/api/payments/initiate`) is authorized by a full phone-number match, not a login — has its own rate limiter (app.js) separate from the general API budget.

## Push Notifications
- Web Push (VAPID), not Firebase — `src/services/push.service.js` mirrors `sms.service.js`'s shape (generic sender + named event wrappers, dev-mode console fallback if VAPID keys are unset).
- `PushSubscription.endpoint` is validated against an allowlist of known push-service hosts (`notifications.controller.js`) before being stored — an unvalidated endpoint would let `web-push` be driven to POST to an attacker-chosen host (blind SSRF). A subscription can only be claimed by the account that registered it (no cross-account takeover of someone else's endpoint).

## Referrals
- Every customer gets a `referralCode`. A referred customer's first order gets a Rs.50 discount (applied at order creation, guarded against double-application via a `discountUsed` compare-and-swap on the `Referral` row); the referrer's `walletBalance` gets +Rs.50 once that first order is DELIVERED. Vendor referrals are a separate, one-sided reward (no discount) configured via `CommissionSettings.vendorReferralReward`.

## Error Tracking (Sentry)
- `src/instrument.js` **must** be required before `./app` in `server.js` — Sentry patches express/prisma at require-time. Moving it later doesn't error, it just silently stops collecting request context.
- **Dev mode**: no `SENTRY_DSN` ⇒ completely inert, no account needed. Same convention as SMS, push, and the payment adapters.
- `beforeSend` scrubs PII on every event: phones, addresses, OTP codes, CNIC images, tokens and gateway secrets are redacted, query strings dropped, headers/cookies deleted, and `user` reduced to `{ id, role }`. Add any new sensitive field name to `SENSITIVE_KEYS`.
- Expected 4xx rejections (bad OTP, wrong role, rate limits) are filtered out — only 5xx and unhandled crashes are reported.
- Explicitly captured beyond the request cycle: **startup failures** (the P1001 that took production down) and the **subscription sweep**, which runs on a timer where a swallowed error would otherwise be invisible until a customer complained.

## Testing
- `npm run smoke` runs the end-to-end suite (`tests/smoke/`) against a live server + real DB. Start the server with `DISABLE_RATE_LIMIT=true` or the run halts on the tightened auth/OTP rate limits. See `tests/smoke/README.md`.

## Known Gotchas (already hit these — don't repeat)
- CORS: `FRONTEND_URL` must be the exact deployed frontend origin (not `*`, which is now refused outright in production) or login/API calls fail with CORS preflight errors.
- No real SMS gateway configured — OTPs are visible only in the app's log stream during testing.
- Key Vault secret rotation needs the app setting to be name-based, not version-pinned — see Deployment section above. This has already caused one outage.

## Live URLs
- API base: `https://app-flowx-api-sh42.azurewebsites.net/api`
- Health check: `/api/health`
- Web app: `https://app-flowx-web-sh42.azurewebsites.net`
