# 06 — BILLING & PROVISIONING

## The flow, traced against `payment/intake → workspace → user → build → login email → portal → subscription`

The real wiring is **two loosely-coupled flows joined only by email address**, not one linear pipeline. Be precise about this:

### Flow 1 — provisioning is triggered by INTAKE, not payment
```
POST /api/intake                              src/server/app.ts:164
  → runS0(intake)  (gate)                     src/intake/s0.ts:136 ; app.ts:166-167
  → kickPipeline(intake, sessionId)           app.ts:169  → spawns detached `tsx cli.ts` build  (src/server/index.ts:34-48)
  → if sessionId: orders.update(status:'building', run_dir)   app.ts:170
  → onIntakeAccepted(intake, email)  (fire-and-forget)        app.ts:171-175
        email = order.email (via orders.find) OR intake._email  app.ts:173
      → bundle.provision({ email, name:A1, intake })           src/server/index.ts:158-165
          → provisionTenant(...)                                src/portal/provision.ts:50-75
              tenantId = t-<slug(name)>-<sha256(email)[:6]>     provision.ts:41-42,57
              generateBrandBrain(intake, runDir)  (MOCK LLM)    provision.ts:66 → src/portal/run.ts:37
              store.upsertTenant({id, name, runDir})            provision.ts:70   ← WORKSPACE created
              password = tempPassword()                          provision.ts:73
              accounts.create(email, tenantId, password)        provision.ts:74  ← USER created
              runTickReal(store, tenantId)                       provision.ts (records first run)
          → onProvisioned(result)                               provision.ts:150-152
              → loginEmail(...) via Postmark                     src/server/index.ts:118-121 ; src/portal/emails.ts
  → client signs in at /portal                                  src/portal/router.ts:72 (login) → :85 (dashboard)
```

### Flow 2 — subscription is a SEPARATE action from inside the portal
```
GET /portal/billing        src/portal/router.ts:92   (shows plans + status)
POST /portal/subscribe     src/portal/router.ts:102  → deps.subscribeUrl(plan, tenant.email)
  → createSubscriptionCheckout(stripe, cfg, {plan,email})  src/server/stripe.ts (mode:'subscription')
  → redirect to Stripe Checkout
Stripe → POST /api/stripe/webhook   src/server/app.ts:126
  → subscriptionFromEvent(event, …)  src/server/subscriptions.ts:120-137
  → subscriptions.record(sub)        app.ts:147   (keyed by subscription_id; email carried in metadata)
```

**Critical coupling caveat:** the workspace/login are created by **Flow 1 (intake)**. The **Order** (`checkout.session.completed`) and the **Subscription** are recorded independently and linked to the workspace **only by matching email** (subscription email → `Account.email` → `Account.tenantId`, `src/portal/billing.ts:53-66`). Nothing enforces that a provisioned tenant has paid, or that a subscriber has a tenant. A mismatch in email between checkout and intake silently orphans billing from the workspace.

---

## Detailed answers

### Stripe products / prices
Code-defined, auto-created on boot (no dashboard clicking), idempotent by `lookup_key`:
- **One-off `CATALOG`** (`src/server/catalog.ts:16-21`, amounts in **USD cents**): `autopsy` 9700, `core` 99700, `core_bump` 114400, `pro` 249700.
- **Recurring `PLANS`** (`src/server/catalog.ts:33-37`, monthly): `platform_starter` 14900, `platform_growth` 29900, `platform_pro` 59900. **These amounts are placeholder pricing** (header comment `catalog.ts:24-32`) and are USD — note the currency vs the UK business.
- Provisioning: `ensureCatalogPrices` / `ensurePlanPrices` (`catalog.ts`), called on boot in `ensurePrices` (`src/server/index.ts:62`). If `STRIPE_PRICE_*` / `STRIPE_PLAN_*` are set, those are used verbatim; else prices are created from the key.

### Checkout
- One-off: `createCheckoutSession` `mode:'payment'` (`src/server/stripe.ts:31-52`), route `POST /api/checkout` (`app.ts:111-116`).
- Subscription: `createSubscriptionCheckout` `mode:'subscription'`, stamps `subscription_data.metadata = {plan, email}` so webhooks can resolve the account (`stripe.ts` ~`:60`), route `POST /api/subscription` (`app.ts:119-124`) and portal `POST /portal/subscribe` (`router.ts:102`).
- Both 503 until `STRIPE_SECRET_KEY` is set (`app.ts:112,120`).

### Webhooks
- `POST /api/stripe/webhook` (`app.ts:126-150`): `verifyEvent` checks the signature (400 on bad sig, `:131-133`); `orderFromEvent` handles `checkout.session.completed` → `Order` (`stripe.ts` `orderFromEvent`); `subscriptionFromEvent` handles `customer.subscription.created|updated|deleted`, `invoice.paid|payment_succeeded|payment_failed` → `Subscription` (`src/server/subscriptions.ts:120-137`).
- **No idempotency / replay protection.** Stripe delivers at-least-once and retries; this handler reprocesses duplicates (orders append again, subscriptions upsert again). No event-id dedup store. Tested only for signature + single-delivery recording, not replay (see `07-TEST-MAP.md`).

### Subscription state
`Subscription = { subscription_id, customer_id, email, plan, status, current_period_end, updated_at }` (`src/server/subscriptions.ts:26-35`). Statuses normalized to `trialing|active|past_due|canceled|unpaid|incomplete|incomplete_expired|paused` (`:20-24`); unknowns → `incomplete`. `isActive` = `active|trialing` (`:39-42`). Store upsert-merges by `subscription_id`, indexes by email (`:180-206`).

### Failed payments
`invoice.payment_failed` → status `past_due` (`subscriptions.ts:120-137`). **That's all** — no dunning emails, no retry schedule of our own (Stripe's own retries aside), no notification. A `past_due`/`canceled` sub only has an effect if `BILLING_ENFORCED` is on (then the portal Run button is gated, `src/portal/router.ts:127-131`); otherwise it is cosmetic (status pill on the billing screen).

### Plan changes
`POST /portal/subscribe` with a different `plan` starts a **new subscription Checkout** — it does **not** call Stripe's subscription-update/proration API (there is no update-subscription code). True self-service plan change / proration is only available via the **Stripe billing portal** (`createBillingPortalUrl`, `POST /portal/manage`, `router.ts:115`), which is key-guarded and hidden at £0.

### Usage limits
**None.** No metering, quotas, or per-plan feature flags. The only gate is the optional `BILLING_ENFORCED` on the Run button (all-or-nothing, `src/portal/router.ts:127-131`, `src/server/index.ts` reads `BILLING_ENFORCED`). Plans differ in price/description only, not in enforced capability.

### Workspace ownership
The `Tenant` (workspace) is created during intake provisioning and owned via the single-`tenantId` `Account`. **Subscriptions carry no `tenantId`** — ownership of a subscription by a workspace is inferred by email at read time (`src/portal/billing.ts`). No billing-owner concept, no seats, no transfer.

### Cancellation
`customer.subscription.deleted` → `Subscription.status = 'canceled'` in the store (`subscriptions.ts:120-137`). **No downstream action:** the tenant, account, login, run dir, and generated assets all remain; the client can still log in and see their dashboard. Access is only affected if `BILLING_ENFORCED` is on (Run blocked, redirect to `/portal/billing?need=1`).

### Export / deletion behaviour
**Not implemented.** No data-export endpoint, no account/workspace deletion, no GDPR erasure path (grep confirms none). Deleting a tenant would mean hand-editing `portal-crm.json` / `portal-accounts.json` / removing the run dir.

### What happens to generated assets after cancellation
**Nothing is removed.** Brand brain and deliverables live in the tenant's run dir on disk and are never cleaned up on cancel; the CRM record and login persist. There is no retention policy, archival, or "your data will be deleted in N days" behaviour. (Roadmap framing "theirs to use, never to keep" is a **product intention, not implemented** — nothing revokes access to already-generated assets on cancellation today.)

---

## Summary for the auditor
Billing **records** state correctly and the checkout/portal/manage plumbing is real and tested with a fake Stripe. The **lifecycle consequences** of billing (provision-on-payment, dunning, access revocation on cancel, plan-change proration, usage limits, export/delete) are largely **absent or cosmetic**, and provisioning is coupled to **intake**, not payment, joined to billing only by email. Treat billing as "state capture done, business rules to build."
