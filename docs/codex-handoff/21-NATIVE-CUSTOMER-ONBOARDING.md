# 21 — NATIVE CUSTOMER ONBOARDING

**Measured:** 2026-08-24 on the local Codex branch.
**Activation:** off by default and not approved for customer traffic.
**External effects:** none. No database, deployment, push, purchase, email,
provider account or production record was touched.

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

### Trusted order to complete workspace

`app_private.provision_customer_workspace_with_setup_delivery(...)` is
executable only by the function-only `r72_provisioning_command` role. It wraps
the canonical provisioning command and, in the same transaction, it:

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
8. records immutable canonical IDs in a private receipt and returns
   `created_now=false` without duplicating rows or replacing the first committed
   delivery on an identical replay.

Reusing the same idempotency key with a different business payload fails. A
pre-existing email also fails the whole transaction rather than silently
joining an existing global user to a newly selected workspace.

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

Sensitive provisioning and delivery are deliberately separate. Calling
`buildPgOnboardingPlatform(...)` requires `DATABASE_WEB_URL` for a transient
migration-ledger check, plus three exact function-only role URLs:

- `DATABASE_PROVISIONING_COMMAND_URL` as `r72_provisioning_command`;
- `DATABASE_SETUP_DELIVERY_COMMAND_URL` as
  `r72_setup_delivery_command`;
- `DATABASE_SETUP_REISSUE_COMMAND_URL` as `r72_setup_reissue_command`.

It additionally requires `SETUP_DELIVERY_ACTIVE_KEY_ID`,
`SETUP_DELIVERY_KEYS_JSON` and a canonical `PORTAL_BASE_URL`. Every pool verifies
`current_user`. None of the three onboarding roles receives table grants. A
forward-only hardening migration removes ambient object-creation permission in
the shared `public` schema. The raw setup token, raw password, raw delivery lease
and raw browser session never become SQL parameters or stored database values.

PostgreSQL login and session resolution now return canonical user/email/workspace
identity only. Old SHA-256 password hashes are rejected with the same dummy
scrypt work used for unknown users; no imported-hash upgrade function remains.
Browser CRM calls pass only the opaque session token and request ID, then resolve
and revalidate the selected workspace inside the database transaction.

## Idempotency and durable delivery boundary

The intended provisioning key is the verified Stripe Checkout Session ID from
the server-side order—not an email, intake field, query value or browser body.
The Node adapter generates the raw setup token, builds the exact setup URL and
encrypts that URL plus the canonical recipient with AES-256-GCM before the SQL
call. PostgreSQL receives only hashes and the encrypted envelope. Provisioning
returns canonical IDs, expiry, delivery ID/generation and `created_now`; it
never returns the raw setup credential. Replay-generated credential material is
discarded because the first committed token hash and delivery remain
authoritative.

The delivery service now exposes bounded claim, lease renewal,
acknowledgement, retry and dead-letter operations through
`r72_setup_delivery_command`. This is intentionally at-least-once, not
exactly-once: a crash after provider acceptance but before acknowledgement can
produce a retry. Delivery UUID is the stable provider idempotency key where the
chosen provider supports one. Delivered, superseded and dead-letter transitions
erase the IV, ciphertext and authentication tag.

Trusted reissue is a separate idempotent command. It locks the pending owner and
active ownership chain, verifies the recipient hash against that user's
canonical database email, revokes the old credential, erases its live delivery
payload and creates the next 24-hour token/delivery generation. It is not a
public “forgot password” route.

The service can prove at startup which encryption-key IDs are still required by
claimable rows. Missing historical keys fail onboarding readiness; retired keys
must remain in `SETUP_DELIVERY_KEYS_JSON` until no live delivery needs them.

No email provider is called by platform construction and no delivery loop is
auto-started. Automatic PostgreSQL onboarding therefore remains locked pending
the real-database proof, an explicitly operated provider dispatcher and the
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

## Proof boundary

The complete local run after the final fixes reported 571 passing tests, zero
failures and two truthfully skipped real-PostgreSQL tests (573 total).
TypeScript typechecking passed. Static SQL contracts, crypto/service tests and
portal routing tests cover the intended shape; they are not evidence that a
real PostgreSQL server compiled migration `0008` or enforced its
role/RLS/concurrency semantics.

The remaining database proof requires one direct owner/admin connection to a
fresh isolated Neon branch or project in `TEST_DATABASE_URL`. The database name
must contain a standalone `test` segment and
`TEST_DATABASE_RESET_CONFIRM=reset-disposable-branch` must be explicitly set.
The suite truncates application tables and migrations create/alter roles across
that branch; never point it at a live branch or customer database. Neon URLs
with `channel_binding=require` are supported; pooled `-pooler` migration URLs
are rejected. Run:

```text
npm run test:db:integration
```

That command must prove provisioning replay, changed-payload rejection, default
pipeline shape, encrypted delivery creation, delivery lease fencing,
ack/fail/redaction, email-bound idempotent reissue, setup reservation and
consumption, activation/session issuance, wrong-role denial, token collision
rollback and native null-legacy login/session resolution. It has not yet passed
against Neon. This database proof is necessary but not sufficient to open the
customer gate.

## After database proof

The next launch work is deliberately narrower than “build all of GHL”:

1. an explicitly operated and tested transactional-email dispatcher around the
   durable claim/lease/ack/fail service;
2. database-native paid order/checkout provenance and atomic fulfilment claim;
3. distributed login/setup abuse controls for multi-instance deployment, plus
   restore, key-rotation and alert runbooks;
4. an explicit existing-owner/repeat-purchase workspace policy;
5. edge/access-log redaction for the initial setup-link query;
6. real browser acceptance for owner, sales and viewer;
7. provider modules through the existing capability/outbox boundary—social,
   listening, WhatsApp, webinar and automation are bolt-ons, not identity or CRM
   rewrites.

No white-label provider purchase is needed to complete this core proof.
