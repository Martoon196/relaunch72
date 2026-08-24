# 23 — PAID CUSTOMER ACTIVATION

**Measured:** 2026-08-24 on the local Codex branch.

**Status:** implemented and proven against a disposable Neon database; detached
from the live HTTP server and off by default.

**External effects:** no real Stripe Session, charge, email, customer account,
deployment, production database, push or paid service was used.

## The authority chain

Customer activation is no longer allowed to start from an email address or
browser intake body. The authority chain is:

```text
database Checkout intent
  → Stripe Session bound to that intent
  → signature-verified event + freshly retrieved exact Session facts
  → canonical paid platform order
  → same-origin 256-bit order claim
  → one atomic paid-order fulfilment transaction
  → encrypted durable setup delivery
```

After Node verifies Stripe's signature and retrieves provider facts, every
commercial and provisioning fact is rechecked at the database boundary. A
browser cannot turn a Stripe Session ID, email address or intake payload into
provisioning authority.

## Migration `0012`: paid provenance

Private tables hold four different kinds of evidence:

- `checkout_intents`: immutable product entitlement, price, amount, currency,
  mode, live/test mode, stable provider idempotency key and bound Stripe Session;
- `order_claim_grants`: only the SHA-256 hash of a random 256-bit same-origin
  claim, with bounded expiry and consumption time;
- `stripe_checkout_events`: Stripe event ID plus SHA-256 of the exact signed raw
  bytes, reconciliation disposition and safe reason code; and
- `platform_orders`: the canonical financially paid order, authoritative receipt
  email, block/provisioning status and linked workspace/setup result.

The new `r72_commerce_definer` is `NOLOGIN NOINHERIT`. Runtime roles receive
only exact function execution:

- `r72_public`: begin an intent and bind the returned Stripe Session;
- `r72_webhook`: record a verified completion after server-side retrieval; and
- `r72_provisioning_command`: preflight and atomically fulfil a paid portal
  order with its claim.

All direct table access is denied. Runtime execution of the old inner
`provision_customer_workspace_with_setup_delivery(...)` command is revoked.

## Checkout creation

`createProvenantCheckoutSession(...)` commits the database intent before calling
Stripe. The database chooses the long-lived Stripe idempotency key and freezes
the product facts from the local catalog. Stripe receives exactly one card line
item, quantity one, payment mode, the intent ID as `client_reference_id`, and
only intent/schema metadata.

The raw order claim stays in same-origin browser `sessionStorage`; only its hash
enters PostgreSQL. The service returns the Checkout URL, intent ID and storage
key, never a copy of the claim. Retrying the same request reuses both database
and Stripe idempotency authority and verifies the returned Session is still the
one bound to the intent.

## Webhook reconciliation

`processProvenantCheckoutWebhook(...)` verifies the signature against the raw
request bytes before any trust is granted. It then retrieves the referenced
Stripe Session with its expanded line item. PostgreSQL checks:

- exact event type, event/session live mode and provider timestamp;
- metadata schema, intent ID, client reference and bound Session ID;
- payment mode/status;
- exactly one line item, quantity one;
- exact price, amount and currency; and
- receipt-email validity for portal activation.

An event ID may replay only with the same signed-byte digest and event type. A
different digest raises a data exception. Product/amount/session tampering is
recorded as rejected and creates no order. A verified payment with missing or
invalid receipt email becomes a financially paid **blocked** order for support;
it is not lost and cannot provision.

## Claim-bound atomic fulfilment

The browser must present both the bound Stripe Session ID and the original
256-bit claim. Node hashes the claim before SQL. The preflight returns the
database-authoritative product and receipt email only for an awaiting paid order
or an unexpired canonical replay.

`fulfil_paid_portal_checkout_with_setup_delivery(...)` locks in order:

1. Checkout intent;
2. canonical paid order; and
3. order-claim grant.

It rechecks payment, portal entitlement, receipt email, claim hash, purpose,
consumption and expiry. It then invokes the native provisioning primitive,
consumes the claim and links the exact order/workspace/setup-delivery result in
one transaction. Failure rolls everything back. Concurrent contenders serialize:
one creates the workspace, the other receives the same canonical result.

If the committed HTTP response is lost, a replay can return the already linked
canonical IDs while the bounded claim grant remains live. It does not validate
or commit newly prepared setup-token/ciphertext material. When the grant expires,
both preflight and fulfilment return no authority—even after prior success.

## Migration `0013`: provider evidence

The durable setup worker settles success only with an opaque provider
ID/reference and provider-acceptance timestamp under the current lease. Provider
references are uniqueness constrained per provider and restricted to an opaque
identifier alphabet. Application validation rejects identifiers containing the
recipient, URL, token, lease or common encodings of those secrets.

Only an accepted settlement erases ciphertext as successful. A permanent
provider rejection has its own fenced terminal command. Missing keys or
unreadable ciphertext preserve the payload and stop the in-process worker for
operator recovery.

The legacy database state name `delivered` means **provider accepted the
handoff**. It does not prove inbox delivery. Bounce, complaint and confirmed
delivery webhooks require future provider-specific state.

## Application composition

`buildPgOnboardingPlatform(...)` now constructs exactly five runtime pools after
a transient `r72_web` ledger check:

- public Checkout;
- Stripe webhook;
- paid claim-bound provisioning;
- setup delivery; and
- trusted setup reissue.

It returns `checkout: PgPaidCheckoutService` and
`setupDelivery: PgSetupDeliveryService`. It exposes no direct provisioning
service, calls no external provider and starts no dispatcher.

The following modules are deliberately detached from `server/app.ts`:

- `src/server/paid-checkout-pg-service.ts`;
- `src/server/provenant-stripe-checkout.ts`;
- `src/portal/setup-email-provider.ts`; and
- `src/portal/setup-email-dispatcher.ts`.

This prevents the old file-backed Checkout/order path from accidentally mixing
with the new database authority before the route cutover is designed and tested.

## Disposable Neon proof

After a guarded reset of only the explicitly disposable test database,
`npm run test:db:integration` passed **3/3, 0 failures, 0 skips** across the
complete `0001`–`0013` ledger. The third real-PostgreSQL suite specifically
proved:

- exact intent creation/replay/binding;
- price and amount tamper rejection;
- raw-event replay conflict rejection;
- financially paid but blocked invalid email;
- wrong and expired claim denial;
- direct-inner-function and wrong-role denial;
- atomic concurrent fulfilment and canonical lost-response replay;
- provider acceptance persistence and ciphertext erasure;
- wrong-lease/malformed evidence preservation;
- settlement after a simulated database outage; and
- explicit permanent provider rejection.

The tests used generated fake Stripe identifiers, encrypted fake delivery data
and a disposable database only. They made no network provider call or charge.
The final sequential repository suite, including all three real database tests,
passed **610/610 with 0 failures and 0 skips**.

## Remaining before customer traffic

1. Add off-by-default HTTP route wiring for Checkout creation, raw webhook body
   handling, success/intake claim recovery and fulfilment.
2. Store the raw claim only in same-origin `sessionStorage`, remove it after
   successful fulfilment and design clear lost-tab/expired-claim support UX.
3. Preserve the current quarantine rule for live/unknown Stripe mode until a
   controlled acceptance run is explicitly approved.
4. Implement a real email adapter with a fixed endpoint, bounded timeout and
   opaque provider references; do not promise exactly-once unless that provider
   contract genuinely supplies it.
5. Operate the dispatcher under a supervisor with fatal readiness latching,
   alerts, key rotation, restore drills and log-redaction checks.
6. Define repeat-purchase/existing-email/support-refund policy and replace the
   remaining file-backed order/pipeline execution boundaries.
7. Add distributed edge abuse limiting, redact initial setup-token query strings
   and complete real-browser payment/recovery/owner acceptance.

No Neon Auth dependency is introduced. Identity remains app-owned PostgreSQL
sessions, roles and audited functions.
