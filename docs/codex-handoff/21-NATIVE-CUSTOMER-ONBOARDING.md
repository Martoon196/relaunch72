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

`app_private.provision_customer_workspace(...)` is executable only by the
function-only `r72_provisioning_command` role. In one transaction it:

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
7. records the immutable canonical IDs in a private receipt and returns
   `created_now=false` without duplicating rows on an identical replay.

Reusing the same idempotency key with a different business payload fails. A
pre-existing email also fails the whole transaction rather than silently
joining an existing global user to a newly selected workspace.

### Setup link to active owner and first session

`app_private.complete_native_account_setup(...)` is executable only by
`r72_identity_command`. It derives workspace authority solely from the hashed
setup token, locks the token and full active ownership chain, accepts only the
current salted scrypt encoding, and atomically:

- activates and email-verifies the pending owner;
- stores the new password hash;
- consumes the exact setup token and revokes any peer setup credentials;
- inserts a hashed, 14-day opaque browser session for that workspace.

Invalid, expired, revoked, already-consumed and concurrent losing claims return
no identity. A session-token collision rolls back activation and consumption
with the failed transaction.

## Runtime isolation

`PORTAL_POSTGRES_ENABLED=true` now requires four exact role URLs:

- `DATABASE_WEB_URL` as `r72_web`;
- `DATABASE_IDENTITY_COMMAND_URL` as `r72_identity_command`;
- `DATABASE_PROVISIONING_COMMAND_URL` as `r72_provisioning_command`;
- `DATABASE_CRM_COMMAND_URL` as `r72_crm_command`.

Every pool verifies `current_user`. The provisioning runtime receives no table
grants. A forward-only hardening migration removes ambient object-creation
permission in the shared `public` schema. The raw setup token, raw password and
raw browser session never become SQL parameters or stored database values.

PostgreSQL login and session resolution now return canonical user/email/workspace
identity only. Old SHA-256 password hashes are rejected with the same dummy
scrypt work used for unknown users; no imported-hash upgrade function remains.
Browser CRM calls pass only the opaque session token and request ID, then resolve
and revalidate the selected workspace inside the database transaction.

## Idempotency and delivery boundary

The intended provisioning key is the verified Stripe Checkout Session ID from
the server-side order—not an email, intake field, query value or browser body.
The Node adapter generates the raw setup token, sends only its hash to SQL and
returns that raw token only when `created_now=true`. A replay-generated token is
discarded because it does not match the first committed hash.

Transactional email cannot be rolled back with PostgreSQL. Automatic
PostgreSQL onboarding therefore remains operationally locked until setup-email
delivery has a durable outbox/reissue command. A provider failure must not lead
to deletion of an otherwise correct organisation/workspace transaction, and a
crash between commit and send must be recoverable without exposing stored raw
credentials.

## Proof boundary

The local suite currently reports 530 passing tests, zero failures and two
truthfully skipped real-PostgreSQL tests. TypeScript typechecking passes and the
production dependency audit reports zero known vulnerabilities. Static SQL
contracts, adapter tests and portal routing tests cover the intended shape;
they are not evidence that a real PostgreSQL server compiled the functions or
enforced the role/RLS/concurrency semantics.

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
pipeline shape, setup consumption, activation/session issuance, wrong-role
denial, token collision rollback and native null-legacy login/session
resolution. This database proof is necessary but not sufficient to open the
customer gate: automatic onboarding also stays off until durable setup-link
delivery/reissue and shared setup abuse controls exist.

## After database proof

The next launch work is deliberately narrower than “build all of GHL”:

1. durable setup-email outbox plus explicit token reissue;
2. database-native paid order/checkout provenance and atomic fulfilment claim;
3. shared login/setup abuse controls, including a global scrypt concurrency
   ceiling, plus restore/alert runbooks;
4. an explicit existing-owner/repeat-purchase workspace policy;
5. setup-link query redaction or a one-time exchange into a short-lived,
   HttpOnly cookie before the password form;
6. real browser acceptance for owner, sales and viewer;
7. provider modules through the existing capability/outbox boundary—social,
   listening, WhatsApp, webinar and automation are bolt-ons, not identity or CRM
   rewrites.

No white-label provider purchase is needed to complete this core proof.
