# Payment Gateway Onboarding — What Each Application Needs

FlowX has working integrations for **JazzCash**, **Easypaisa** and **Safepay**, all
currently running in dev-simulation mode. This is what's needed to turn each one on.

> **On accuracy:** the technical sections below (env vars, URLs, field formats) come
> from FlowX's own code and are exact. The business-side requirements are what these
> providers typically ask for — onboarding processes change, so treat the document
> lists as a preparation checklist, not gospel, and confirm against whatever the
> provider's current form actually asks.

---

## 0. Before you apply — get these in order once

All three providers are asking the same underlying question: *is this a real
registered business with a bank account we can settle into?* Sorting this out once
covers all three applications.

| Item | Notes |
|---|---|
| **Business registration** | Sole proprietorship is usually acceptable — a full company isn't required. A sole proprietorship needs a business bank account, which needs a letterhead + stamp and often a chamber-of-commerce membership. |
| **NTN** (National Tax Number) | FBR registration for the business. Non-negotiable for all three. |
| **Business bank account** | In the **business's** name, not your personal account. Settlement goes here. This is usually the longest step if you don't have one. |
| **CNIC** | Owner/director, front and back. |
| **Proof of address** | Utility bill or tenancy agreement for the business premises. |
| **Live website** | They will open it. It needs visible **pricing**, **contact details**, and reachable **Terms**, **Privacy** and **Refund** pages. |

**FlowX already has the website side covered** — `/terms`, `/privacy` and `/refund`
exist and are linked. But the site must be **live and functional** at review time,
which means Railway and Vercel both need to be up before you apply. A reviewer
opening a paused Vercel deployment sees a dead site and declines.

---

## 1. Safepay — start here

**Why first:** self-serve signup, sandbox credentials in minutes, no waiting on a
bank. You can validate the entire payment code path against a real gateway while the
other two applications are still in review.

**Apply at:** getsafepay.com → sign up → Developers section

**What you get:**

| Credential | Where it goes |
|---|---|
| Merchant API key | `SAFEPAY_API_KEY` |
| Webhook secret | `SAFEPAY_WEBHOOK_SECRET` |

**Webhook URL to register** in their dashboard:

```
https://flowx-backend-production.up.railway.app/api/payments/callback/safepay
```

Keep `SAFEPAY_API_URL`, `SAFEPAY_CHECKOUT_URL` and `SAFEPAY_ENVIRONMENT` on their
sandbox values until you've run a real test transaction, then swap all three to
production together.

**FlowX notes:**
- Safepay backs the `CARD` payment method (Visa/Mastercard via Cybersource).
- It is the only one of the three that settles by **server-to-server webhook**,
  signed with HMAC-SHA512 over the raw request bytes. That's why
  `/api/payments/callback` is mounted with `express.raw()` ahead of the JSON parser.
- Going live requires the full business documentation above; sandbox does not.

---

## 2. JazzCash

**Why it matters:** JazzCash is the dominant mobile wallet in Pakistan. For a Karachi
water-delivery business this is likely your highest-volume online method.

**Apply at:** the JazzCash merchant/business portal, or through a Mobilink Microfinance
Bank branch. Expect a sales contact rather than pure self-serve.

**What you get:**

| Credential | Where it goes | Format |
|---|---|---|
| Merchant ID | `JAZZCASH_MERCHANT_ID` | |
| Password | `JAZZCASH_PASSWORD` | |
| Integrity salt | `JAZZCASH_INTEGRITY_SALT` | HMAC-SHA256 signing key — **treat as a secret** |

You should be issued **separate sandbox and production sets**. Do not skip sandbox.

**Return URL to register / confirm:**

```
https://flowx-backend-production.up.railway.app/api/payments/callback/jazzcash
```

> **This must be the backend URL, not the frontend result page.** The backend endpoint
> verifies `pp_SecureHash` before settling anything, then redirects the customer on to
> `/payment/result`. Pointing it at the frontend means nothing verifies the signature
> and no order ever settles. (See the open fix noted at the bottom of this file.)

**FlowX notes:**
- Backs the `JAZZCASH` payment method, transaction type `MWALLET`.
- **Amounts are sent in paisa**, not rupees — `toPaisa()` in the adapter. Sending
  rupees undercharges by 100× and the mistake is invisible until settlement.
- Signing excludes `pp_SecureHash` itself and sorts the remaining `pp_*` / `ppmpf_*`
  fields alphabetically. A signature mismatch is the single most likely first-run
  failure; if the sandbox rejects the hash, that ordering is where to look.
- Timestamps are Pakistan-time formatted (`pktTimestamp`). Transactions expire after
  one hour.
- Ask specifically whether your account is provisioned for **wallet only** or also
  **cards** — it affects whether you need Safepay at all.

---

## 3. Easypaisa

**Apply at:** Telenor Microfinance Bank / Easypaisa merchant services. Same shape as
JazzCash — a branch or sales-led process, not self-serve.

**What you get:**

| Credential | Where it goes | Format |
|---|---|---|
| Store ID | `EASYPAISA_STORE_ID` | |
| Hash key | `EASYPAISA_HASH_KEY` | **Exactly 16 characters** — AES-128 key. If yours isn't 16 chars, you have the wrong value. |

**Post-back URL to register / confirm:**

```
https://flowx-backend-production.up.railway.app/api/payments/callback/easypaisa
```

Same rule as JazzCash — backend, not frontend.

**FlowX notes:**
- Backs the `EASYPAISA` payment method.
- **Amounts are in rupees here**, unlike JazzCash's paisa. The two adapters
  deliberately differ; don't "fix" one to match the other.
- Signing is AES-128-ECB over a `key=value&` string, base64-encoded — a different
  scheme from JazzCash's HMAC. Also a likely first-run failure point.

---

## 4. What happens once credentials arrive

Each provider switches on independently — filling in one provider's credentials
leaves the other two in dev mode. No code changes are needed; the adapters read the
env vars and stop simulating.

**Sequence per provider:**

1. Add the credentials to Railway as environment variables (never commit them).
2. Register the callback URL in the provider's dashboard.
3. Restart the backend, and confirm the boot log **no longer** prints
   `PAYMENT (DEV MODE)` for that provider.
4. Place a **real sandbox order** end to end and confirm:
   - the gateway accepts the signature (no rejection at handoff)
   - the callback arrives and passes verification
   - `Order.paymentStatus` flips to `PAID`
   - the amount charged matches the order total exactly
   - the customer gets the SMS/push confirmation
5. Re-run the same order and confirm settling is **idempotent** — gateways retry
   webhooks, and double-settling is a real way to corrupt the books.
6. Only then swap sandbox URLs for production ones.

I can drive steps 3–6 against sandbox credentials and report exactly what the gateway
accepted or rejected.

**Three rules the code enforces**, each one a way to lose money — worth knowing so you
recognise the symptoms:

- Only a **signature-verified callback** settles an order. The browser redirect never
  does, because a customer can edit their own URL bar.
- The **callback amount must match** the order total, within Rs. 1.
- Settling is **idempotent** and claimed via compare-and-swap.

---

## 5. One important detail, now enforced by tests

`pp_ReturnURL` (JazzCash) and `postBackURL` (Easypaisa) **must** be FlowX's own
`/api/payments/callback/:provider` endpoint, never the frontend result page. That
endpoint verifies the signature, settles the order, and only then redirects the
customer on to `/payment/result`.

This was wrong once — both pointed at the frontend, meaning nothing verified the
callback and a live payment would have been taken without the order ever settling.
The smoke suite missed it because dev mode settles through
`/payments/simulate/:reference` and skips the return-URL path entirely.

Fixed, and now covered by three regression tests in `tests/smoke/payment.js`:
each adapter is checked for the right URL, and the service is checked for passing
it. If someone reroutes these again, the suite fails.

Both URLs are therefore what section 2 and 3 tell you to register. If a provider's
onboarding form asks separately for a "return URL" and an "IPN/webhook URL", give
the same `/api/payments/callback/<provider>` value for both.
