# 21 — NATIVE CUSTOMER ONBOARDING

**Measured:** 2026-08-24 on the local Codex branch.
**Activation:** off by default and not approved for customer traffic.
**External effects:** only the explicitly disposable Neon test database was
migrated and reset. No production database or customer data, deployment, push,
purchase, email, provider account or customer record was touched.

## Decision

There is no legacy customer data to import. New customers therefore enter one
canonical PostgreSQL identity/workspace model from the start. The nullable
`legacy_tenant_key` column remains dormant for forward-compatible cleanup, but
it is not populated or consulted by PostgreSQL authentication, CRM routing or
provisioning.

The file-backed JSON portal remains an explicitly selected local-demo mode.
Production refuses to compose it. PostgreSQL mode constructs only database auth
and CRM services; it never opens the JSON account or CRM stores.

## Implemented transaction boundaries

### Verified paid order to complete workspace

Migration `0012_paid_checkout_provenance.sql` removes runtime access to the
inner `app_private.provision_customer_workspace_with_setup_delivery(...)`
primitive. The function-only `r72_provisioning_command` role can instead call
only the paid-order preflight and
`app_private.fulfil_paid_portal_checkout_with_setup_delivery(...)`. That wrapper
locks an exact paid Stripe Checkout order and its hash-only 256-bit browser
claim, then in the same transaction it:

1. validates and normalises the stable business request, including a real IANA
   timezone;
2. serialises on the trusted idempotency key and compares a SHA-256 request
   fingerprint that deliberately excludes credential material;
3. creates one active direct-customer organisation and one active native
   workspace with a null legacy key;
4. creates one pending owner with no password plus active organisation and
   workspace owner memberships;
5. stores only the SHA-256 hash of a 256-bit, 24-hour account-setup token;
6. creates one default Sales pipeline with New lead, Qualified, Proposal, Won
   and Lost in deterministic order;
7. inserts one delivery job containing the recipient hash and an AES-256-GCM
   envelope prepared in Node for the recipient and full setup URL; and
8. consumes the unexpired order claim, links the paid order to the canonical
   provisioning result and records immutable canonical IDs in a private
   receipt; and
9. returns
   `created_now=false` without duplicating rows or replacing the first committed
   delivery on an identical replay.

The verified Stripe Checkout Session ID is the provisioning idempotency key and
the database-authoritative paid receipt email is the setup recipient. Neither
can be supplied by intake. A wrong or expired claim returns no authority. A
lost-response replay can return only the previously linked canonical result
while that claim grant remains unexpired; it ignores replacement credential
material. The first successful fulfilment commits the normalized business
input. After that commit, replay deliberately ignores all replacement input and
returns only the canonical result while the claim remains unexpired. A
pre-existing email on the first attempt fails the whole transaction rather than
silently joining an existing global user to a newly selected workspace. The
inner primitive retains changed-input receipt rejection, but it is uncomposed
and unavailable to runtime roles.

### Setup link to active owner and first session

`app_private.complete_native_account_setup(...)` is executable only by
`r72_identity_command`. Before the expensive password derivation, the adapter
must obtain a short, hashed claim through
`app_private.reserve_native_account_setup(...)`. It then crosses the bounded,
process-wide scrypt ceiling. Completion derives workspace authority solely from
the hashed setup token, locks the token, claim and full active ownership chain,
accepts only the current salted scrypt encoding, and atomically:

- activates and email-verifies the pending owner;
- stores the new password hash;
- consumes the exact setup token and revokes any peer setup credentials;
- inserts a hashed, 14-day opaque browser session for that workspace.

Invalid, expired, revoked, already-consumed and concurrent losing claims return
no identity. Failed or capacity-rejected attempts release their reservation. A
session-token collision rolls back activation and consumption with the failed
transaction.

## Runtime isolation

`PORTAL_POSTGRES_ENABLED=true` composes the always-on portal with three exact
role URLs:

- `DATABASE_WEB_URL` as `r72_web`;
- `DATABASE_IDENTITY_COMMAND_URL` as `r72_identity_command`;
- `DATABASE_CRM_COMMAND_URL` as `r72_crm_command`.

Sensitive paid activation and delivery are deliberately separate. Calling
`buildPgOnboardingPlatform(...)` requires `DATABASE_WEB_URL` for a transient
migration-ledger check, plus five exact function-only role URLs:

- `DATABASE_PUBLIC_URL` as `r72_public`;
- `DATABASE_WEBHOOK_URL` as `r72_webhook`;
- `DATABASE_PROVISIONING_COMMAND_URL` as `r72_provisioning_command`;
- `DATABASE_SETUP_DELIVERY_COMMAND_URL` as
  `r72_setup_delivery_command`;
- `DATABASE_SETUP_REISSUE_COMMAND_URL` as `r72_setup_reissue_command`.

It additionally requires `SETUP_DELIVERY_ACTIVE_KEY_ID`,
`SETUP_DELIVERY_KEYS_JSON` and a canonical `PORTAL_BASE_URL`. Every pool verifies
`current_user`. None of the five onboarding roles receives table grants. The
builder returns a composed `PgPaidCheckoutService` and
`PgSetupDeliveryService`; it no longer exposes the direct inner provisioning
adapter. A
forward-only hardening migration removes ambient object-creation permission in
the shared `public` schema. The raw setup token, raw password, raw delivery lease
and raw browser session never become SQL parameters or stored database values.

PostgreSQL login and session resolution now return canonical user/email/workspace
identity only. Old SHA-256 password hashes are rejected with the same dummy
scrypt work used for unknown users; no imported-hash upgrade function remains.
Browser CRM calls pass only the opaque session token and request ID, then resolve
and revalidate the selected workspace inside the database transaction.

## Paid provenance, idempotency and durable delivery boundary

The Checkout adapter commits a private database intent before calling Stripe.
That intent freezes the product, price, amount, currency, mode and live/test
mode; supplies a stable provider idempotency key; and stores only the SHA-256
hash of the browser's random order claim. The Stripe Session carries only the
intent ID and metadata schema version. The raw signed webhook is verified first,
then the exact Session and one expanded line item are retrieved. PostgreSQL
accepts payment only when every signed/retrieved fact matches the bound intent.
An event ID replay with different signed bytes is rejected. A valid payment
with an unusable receipt email is retained as financially paid but blocked; it
is never silently discarded or provisioned.

The provisioning key is the verified Stripe Checkout Session ID from the
database order—not an email, intake field, query value or browser body.
The Node adapter generates the raw setup token, builds the exact setup URL and
encrypts that URL plus the canonical recipient with AES-256-GCM before the SQL
call. PostgreSQL receives only hashes and the encrypted envelope. Provisioning
returns canonical IDs, expiry, delivery ID/generation and `created_now`; it
never returns the raw setup credential. Replay-generated credential material is
discarded because the first committed token hash and delivery remain
authoritative.

The delivery service now exposes bounded claim, lease renewal,
provider-acceptance settlement, retry and explicit permanent rejection through
`r72_setup_delivery_command`. This is intentionally at-least-once, not
exactly-once: a crash after provider acceptance but before database settlement
can produce a retry. The delivery UUID is a stable correlation key, not a
provider-independent exactly-once guarantee. Successful settlement persists an
opaque provider reference and acceptance timestamp before erasing encrypted
payload fields. The database state called `delivered` currently means
**provider-accepted handoff**, not proof that the message reached an inbox;
delivery/bounce/complaint webhooks remain future work.

Trusted reissue is a separate idempotent command. It locks the pending owner and
active ownership chain, verifies the recipient hash against that user's
canonical database email, revokes the old credential, erases its live delivery
payload and creates the next 24-hour token/delivery generation. It is not a
public “forgot password” route.

The service can prove at startup which encryption-key IDs are still required by
claimable rows. Missing historical keys fail onboarding readiness; retired keys
must remain in `SETUP_DELIVERY_KEYS_JSON` until no live delivery needs them.

The dispatcher, timeout/lease-renewal/retry policy and provider-neutral contract
exist, but only a network-free test provider exists. No email provider is called
by platform construction and no delivery loop is auto-started. Unreadable
ciphertext or a missing key is a fatal readiness condition that preserves the
encrypted row for recovery. Automatic PostgreSQL onboarding therefore remains
locked pending an explicitly operated real provider adapter/supervisor and the
other launch gates below. See
[22-DURABLE-SETUP-DELIVERY.md](./22-DURABLE-SETUP-DELIVERY.md).

## Browser setup boundary

The first `GET /portal/setup?token=...` validates token shape, encrypts the
credential into a ten-minute `HttpOnly; SameSite=Lax` cookie scoped to
`/portal/setup`, and responds with a `303` to the clean URL. The password form
contains only a synchronizer CSRF token bound to that encrypted cookie; neither
the raw link token nor its cookie value appears in HTML or the form body.

This removes the credential from subsequent browser URLs, but the initial email
click still reaches the edge with `?token=`. CDN, proxy and application access
logs must redact that query before traffic is enabled. The exchange itself does
not consume the emailed token: database completion or trusted reissue is what
invalidates it.

Setup attempts use a bounded process-local token/source throttle and the
database reservation described above. Forwarded client-address headers are not
trusted by default; a deployment may add source throttling only through an
authenticated trusted-proxy resolver. A multi-instance launch still needs an
explicit shared/distributed throttle policy.

## Proven database boundary

On 2026-08-24, `npm run test:db:integration` passed **3 tests, 0 failures and
0 skips** against a freshly reset disposable direct Neon database. PostgreSQL
applied and verified the complete `0001`–`0013` ledger. The proof exercised tenant RLS,
same-workspace foreign keys, append-only facts, immediate membership/session
revocation, provisioning replay, changed-payload rejection, default pipeline
shape, encrypted delivery creation, lease fencing, ack/fail/redaction,
email-bound idempotent reissue, cheap setup reservation, single-use consumption,
activation/session issuance, exact Checkout reconciliation, price/amount
tamper rejection, changed-byte event replay rejection, paid-but-blocked email,
wrong/expired order-claim denial, concurrent claim-bound fulfilment, provider
acceptance evidence, delayed settlement, permanent rejection, wrong-role denial,
token-collision rollback and native null-legacy login/session resolution.

The first managed run also exposed portability defects that static contracts did
not: protected role attributes cannot be altered by Neon's project owner,
session `clock_timestamp()` defaults could invert by microseconds, `FOR UPDATE`
needed a minimum column-level privilege, PostgreSQL's special `LEAST` syntax
cannot be schema-qualified, and volatile lifecycle defaults could cross by
microseconds. The role bootstraps were corrected before their first successful
application; forward migrations `0009`–`0011` repair the runtime issues and the
full chronology-default class. A clean rerun passed both real-database tests.

The final sequential complete suite, including the real database tests, passed
**610 tests, 0 failures and 0 skips**. The 3/3 Neon result above is the
authoritative database proof for this slice.

## Reproducing the proof safely

Use one direct owner/admin connection to a fresh isolated Neon branch or project
in `TEST_DATABASE_URL`. The database name
must contain a standalone `test` segment and
`TEST_DATABASE_RESET_CONFIRM=reset-disposable-branch` must be explicitly set.
The suite truncates application tables and migrations create/alter roles across
that branch; never point it at a live branch or customer database. Neon URLs
with `channel_binding=require` are supported; pooled `-pooler` migration URLs
are rejected. Run:

```text
npm run test:db:integration
```

That database proof is necessary but not sufficient to open the customer gate.

## After database proof

The next launch work is deliberately narrower than “build all of GHL”:

1. provision passwords or managed identities for every runtime `LOGIN` role in
   the hosting secret/control plane, then supply and preflight each exact
   role-specific database URL; migrations intentionally create no credentials;
2. implement a real transactional-email provider adapter and an operational
   supervisor that treats key/decryption readiness as fatal; the dispatcher
   itself is implemented but inert and network-free by default;
3. wire the detached provenance Checkout/webhook/intake services and same-origin
   `sessionStorage` order claim into the browser behind an off-by-default gate;
4. distributed login/setup abuse controls for multi-instance deployment, plus
   restore, key-rotation and alert runbooks;
5. an explicit existing-owner/repeat-purchase workspace policy;
6. edge/access-log redaction for the initial setup-link query;
7. real browser acceptance for payment, recovery, owner, sales and viewer;
8. replace the remaining file-backed order/pipeline execution paths with durable
   database/job boundaries before live activation; and
9. provider modules through the existing capability/outbox boundary—social,
   listening, WhatsApp, webinar and automation are bolt-ons, not identity or CRM
   rewrites.

No white-label provider purchase is needed to complete this core proof.
