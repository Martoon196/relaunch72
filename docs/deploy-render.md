# Deploying the Relaunch72 test payments API to Render

This blueprint creates a **test-only sandbox** for the static funnel at
`relaunch72.com`. It can exercise Stripe test checkout, verified webhooks, paid
entitlement claiming, intake QA and the current pipeline.

It is deliberately **not a live-money deployment guide**. Live and unknown Stripe
keys activate hardened mode and checkout remains locked until the PostgreSQL
durable-job foundation is implemented and verified.

## Current boundary

```text
 relaunch72.com                 Render test service                  Stripe test mode
 checkout ── POST /api/checkout ──────────────────────────────────► Checkout Session
          ◄──────────────────── verified test URL ─────────────────
 intake ── POST /api/intake ──► paid-order claim ──► S0 ──► test build process
                                      ▲
 Stripe ── signed webhook ────────────┘
```

The current build process is detached and file-backed. That is useful for test
work, but it is not a durable production queue. A process restart can interrupt it.

`PUBLIC_BASE_URL` is the static site origin Stripe returns to. Automatic customer
portal provisioning and outbound email are deliberately outside this sandbox.

## 1. Create the test service

1. In Render, choose **New + → Blueprint**.
2. Connect `Martoon196/relaunch72`.
3. Select branch **`codex/relaunch72-platform-foundation`**.
4. Review the `relaunch72-payments` service from `render.yaml`.
5. Before the first production-mode boot, supply a dedicated random
   `SESSION_SECRET` of at least 32 characters. The server intentionally refuses
   to start without it when `NODE_ENV=production`.

The free instance and its ephemeral filesystem are suitable only for this test
sandbox. Do not use them for real orders.

## 2. Start unconfigured and inspect readiness

The server can start without Stripe or Anthropic once `SESSION_SECRET` is valid.
`GET /health` stays HTTP 200 for host liveness, but reports explicit blockers and
`accepting_checkout:false` until every checkout dependency is present.

This distinction matters: a green Render health check means “the process is
alive”, not “Relaunch72 is ready to charge or fulfil”.

## 3. Configure the complete Stripe test path

Add these environment variables:

| Key | Required for | Value |
|---|---|---|
| `STRIPE_SECRET_KEY` | Test checkout | A Stripe `sk_test_…` or `rk_test_…` key |
| `STRIPE_WEBHOOK_SECRET` | Verified fulfilment | The test endpoint's `whsec_…` secret |
| `SESSION_SECRET` | Admin and portal cookies | Dedicated random value, 32+ characters |
| `SANDBOX_ACCESS_TOKEN` | Private browser access | Dedicated random value, 24+ characters |

The production test sandbox forces `build_mode:mock` and caps concurrent builds,
so it does not spend Anthropic credits. `ANTHROPIC_API_KEY` is only needed for a
deliberately run private/local live-model build; it never makes live Stripe safe.

Register the test webhook at:

```text
https://<your-service>.onrender.com/api/stripe/webhook
```

Subscribe it to `checkout.session.completed`. Subscription lifecycle events can
remain disabled because recurring platform checkout is preview-only.

When all four one-off price IDs are blank, test mode may create the complete test
catalogue automatically. If you pin prices manually, set **all four**:

- `STRIPE_PRICE_AUTOPSY`
- `STRIPE_PRICE_CORE`
- `STRIPE_PRICE_CORE_BUMP`
- `STRIPE_PRICE_PRO`

A partial catalogue is fail-closed: health remains not ready and no checkout is
created. Automatic catalogue writes never run against a live Stripe key.

Recurring plans remain non-purchasable with:

```text
PLATFORM_SUBSCRIPTIONS_ENABLED=false
```

Public Brevo capture also remains off with `PUBLIC_LEAD_CAPTURE_ENABLED=false`.
Do not enable it until consent/double-opt-in and shared abuse controls exist.

## 4. Keep customer outbound messaging locked

Do not add Brevo or Postmark credentials to the Render test service. A Stripe test
buyer can enter any email address; that is sandbox input, not a verified customer.
The server therefore does not sync test payers to marketing lists, send setup
emails, or automatically provision customer portal accounts. Portal onboarding
will be integration-tested after the durable server-created checkout-intent model
can prove which workspace and recipient a live purchase belongs to.

## 5. Point the static test funnel at the service

In `site/checkout-config.js`, set:

```js
apiBase: 'https://relaunch72-payments.onrender.com',
```

Publish the static site only after `/health` reports `accepting_checkout:true` and
`build_mode:mock`. The first checkout attempt asks for the founder-only sandbox
code and keeps it only for that browser tab/session. Use a Stripe test card and
confirm all of the following:

1. Checkout creates a test-mode hosted session.
2. The signed webhook records one paid order.
3. A replayed webhook does not duplicate it.
4. Intake without that paid session is refused.
5. Valid intake claims it once and a browser retry returns the existing run.
6. Autopsy stops at its paid scope and never provisions the full portal.

## Live-money gate

Swapping in an `sk_live_…` key does **not** enable payments. It produces a
`LIVE LOCKED` service and leaves checkout unavailable by design.

Before changing that lock, Relaunch72 still needs:

- PostgreSQL tenancy, orders, CRM records and immutable entitlements;
- transactional webhook idempotency and entitlement claiming;
- a durable jobs/outbox worker with retry and recovery;
- complete fulfilment tests for every advertised tier;
- verified discount/credit rules and subscription lifecycle behaviour;
- a persistent paid host, monitoring, backups and an operator runbook;
- an explicit founder go-live decision after a live-readiness review.

Until that work is complete, use test keys only.
