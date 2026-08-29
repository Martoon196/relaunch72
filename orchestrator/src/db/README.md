# PostgreSQL foundation

This directory is the isolated platform database foundation. Its CRM tables and
commands remain internal records only; their outbox does not unlock live money,
messages, publishing, or any external provider effect.

- `npm run db:migrate` uses `DATABASE_MIGRATOR_URL`, takes an advisory lock,
  verifies every applied SHA-256 checksum, and applies each pending SQL file in
  its own transaction.
- `npm run db:check` is read-only and fails unless the ledger exactly matches the
  migration files in this release.
- Production runtime URLs must authenticate as their matching least-privilege
  roles (`r72_web`, `r72_identity_command`, `r72_provisioning_command`,
  `r72_setup_delivery_command`, `r72_setup_reissue_command`,
  `r72_crm_command`, `r72_external_event_command`, `r72_worker`,
  `r72_webhook`, `r72_import_command`, `r72_public`, or `r72_readonly`). Every
  pool verifies `current_user` before checkout.
- Portal reads use `DATABASE_WEB_URL` / `r72_web`. That role can read CRM rows
  allowed by forced RLS but has no CRM table mutation grant or write policy.
- Portal password login, one-use account setup and opaque-session
  issuance/revocation use `DATABASE_IDENTITY_COMMAND_URL` /
  `r72_identity_command`. PostgreSQL mode accepts only the current salted scrypt
  format; there is no legacy-hash upgrade path. The role has no table privileges
  and can execute only the audited identity functions. Setup first reserves the
  indexed token with a short, hashed database claim, then crosses the bounded
  process-wide scrypt worker ceiling, and finally consumes that exact claim in
  the activation/session transaction. Invalid-token floods therefore cannot
  queue unbounded password work.
- Paid customer activation uses three isolated command identities.
  `DATABASE_PUBLIC_URL` / `r72_public` can create and bind a private Checkout
  intent but cannot record payment or read its tables. `DATABASE_WEBHOOK_URL` /
  `r72_webhook` can reconcile a signature-verified Stripe event to that exact
  intent. `DATABASE_PROVISIONING_COMMAND_URL` /
  `r72_provisioning_command` can authorize and fulfil only a paid portal order
  presented with its 256-bit browser claim. Fulfilment creates the organization,
  native workspace, pending owner, active owner memberships, hashed 24-hour
  setup credential, default Sales pipeline and encrypted durable delivery job
  in the same transaction that consumes the claim and links the paid order.
  None of these roles has table privileges. Direct runtime execution of the
  inner provisioning primitive is revoked; its adapter remains only as an
  uncomposed legacy/test primitive.
- Setup delivery uses `DATABASE_SETUP_DELIVERY_COMMAND_URL` /
  `r72_setup_delivery_command`. This function-only identity can inspect required
  encryption-key IDs and perform bounded claim, lease renewal,
  provider-acceptance settlement and retry/permanent-rejection transitions.
  Lease credentials are generated in the process and only their hashes enter
  PostgreSQL. Successful settlement requires an opaque provider ID/reference
  and provider-acceptance timestamp under the live lease fence; only then is
  ciphertext erased. The database state named `delivered` currently means
  **provider-accepted handoff**, not confirmed inbox delivery. Delivered,
  bounced and complained webhook states remain future provider work. The
  contract is at-least-once: a provider acceptance followed by a crash before
  database settlement can cause a retry. The delivery UUID is a stable
  correlation key, but no provider-independent exactly-once claim is made.
- Trusted setup reissue uses `DATABASE_SETUP_REISSUE_COMMAND_URL` /
  `r72_setup_reissue_command`. The function-only command is idempotent,
  restricted to a still-pending active owner, and binds the supplied recipient
  hash to that user's canonical database email before it revokes the old token
  and creates the next encrypted generation. It is an operator boundary, not a
  public recovery endpoint. For the internal Property Predator founder only,
  `npm run founder:reissue-setup` pins the canonical HQ origin and office email,
  verifies schema/current-user readiness, and reveals a newly created link only
  through a one-use loopback handoff. A replay never exposes a generated token.
- CRM command handlers use the separate `createCrmCommandDatabasePool` factory,
  `DATABASE_CRM_COMMAND_URL`, and `r72_crm_command`. The role is `NOINHERIT`,
  cannot assume an owner/security role, and is the only user-facing runtime
  identity allowed to mutate CRM state, append history/activity/outbox facts,
  or claim command receipts. Permissions and active membership are still
  checked by forced RLS for every statement.
- Legacy contact migration uses the separate
  `createImportCommandDatabasePool` factory,
  `DATABASE_IMPORT_COMMAND_URL`, and `r72_import_command`. This manager-only,
  forced-RLS role can rehearse, stage and append imported contacts and their
  provenance through the versioned import service. It cannot update an existing
  live contact. Exact source payloads and raw attribution remain private;
  ordinary portal reads see only sanitised provenance and typed attribution.
  Database guards own the actor/request/timestamps and legal lifecycle
  transitions rather than trusting caller-supplied audit values.
- Conversion definitions, enrollments, milestone facts, explainable score
  snapshots and endpoint-bound consent/suppression evidence use the same
  forced-RLS workspace boundary. Published definition versions are frozen,
  activation is monotonic, Sale requires a same-enrollment collected-payment
  fact, and trigger sources are constrained by a positive database allowlist.
  The reviewed Property Predator route pair installs atomically. Readiness and
  replay deeply compare stored score JSON and journey settings as well as
  hashes/topology, and the locked command transaction rechecks conflicts before
  writing.
- Authenticated Property Predator source ingress uses
  `DATABASE_EXTERNAL_EVENT_COMMAND_URL` / `r72_external_event_command`. That
  login has no table grants and can execute only the request-context helpers
  plus the receipt recorder owned by a separate NOLOGIN definer. The route is
  disabled by default. When explicitly enabled it also requires
  `DATABASE_WEBHOOK_URL` / `r72_webhook`; the application composes replay-safe
  Growth and Journey projectors behind the immutable shadow receipt. The
  webhook login is table-blind for this domain and supplies only the accepted
  event ID to those separately reviewed definer functions. This can derive
  CRM, evidence, enrolment, milestone, score, consent, commerce and pending
  outbox facts, but it cannot call a provider or produce an external effect.
- The migrator needs permission to create roles and extensions, but does not
  need true PostgreSQL superuser authority. Role bootstraps rely on safe
  `CREATE ROLE` defaults and audit every protected capability instead of trying
  to alter superuser-only attributes. Migrations never contain passwords;
  provision runtime role passwords or managed identities in the hosting
  secret/control plane.
- The internal Property Predator founder bootstrap is an explicit offline
  migrator operation, not a runtime or public onboarding route. Migration
  `0027` exposes its one-shot SECURITY DEFINER wrapper only to `r72_owner`,
  requires an empty database plus the exact 27-file checksum ledger and
  installation UUID, and reuses the established native workspace primitive.
  Its logical `mailgun_eu` live connection contains no credential. The first
  control event pins provider effects and delivery OFF with emergency pause ON;
  no contact, endpoint, inbox, consent, message, operation or delivery row is
  created. `npm run founder:bootstrap` returns the raw account-setup link only
  through a one-use, no-store loopback page held in memory.
- The ordinary suite always skips the eight live PostgreSQL tests, even when a
  developer keeps a test URL in `.env`. `npm run test:db:integration` is the
  only command that opens their explicit opt-in gate, and it is intentionally
  stricter: it
  fails unless `TEST_DATABASE_URL` names an explicitly disposable database
  containing a standalone `test` segment, so a green integration command can
  never mean “skipped”. It also requires
  `TEST_DATABASE_RESET_CONFIRM=reset-disposable-branch`. Use a fresh isolated
  branch/project, not merely a test-named database beside production: migrations
  create/alter PostgreSQL roles as well as truncating application tables.

Migrations `0001` and `0002` establish role separation, forced RLS, global users,
white-label organisations, isolated workspaces, sourced/revocable memberships,
opaque sessions, and hashed single-use identity tokens. Migration `0003` adds
the new command role plus the first CRM loop and keeps the web/read pool
physically separate from its command/write pool. Migration `0004` adds the
isolated identity-command role, opaque portal session functions, in-transaction
session guards and a safe runtime migration-ledger function. Migration `0005`
removes the temporary JSON tenant key from effective PostgreSQL authentication
and returns only canonical user/workspace identity. Migration `0006` adds the
function-only provisioning role, atomic native workspace creation and atomic
setup-token consumption plus first-session issuance. Migration `0007` removes
ambient object-creation permission in the shared `public` schema. Migration
`0008` adds function-only setup-delivery and reissue roles, encrypted delivery
jobs, idempotent reissue receipts, fenced claim/lease/ack/fail commands,
terminal ciphertext erasure and the cheap setup reservation required before
scrypt. Migration `0009` stabilises session timestamp defaults and grants the
security definer one inert column-level capability required for row locking.
Migration `0010` recreates delivery lease renewal with portable PostgreSQL
`LEAST` syntax. Migration `0011` makes lifecycle creation/update defaults
statement-stable wherever a same-row chronology constraint compares them with
an explicitly supplied lifecycle timestamp; event/outbox fact clocks retain
their original paired ordering. Migration `0012` adds private Checkout intents,
hash-only order claims, signed-event replay evidence, canonical paid orders and
an atomic claim-bound fulfilment wrapper while removing direct runtime access to
the inner provisioning primitive. Migration `0013` persists provider acceptance
evidence, makes unattributed acknowledgement unavailable to the worker, caps the
initial lease to setup-token expiry and adds an explicit fenced permanent
provider-rejection command.
Migration `0014` adds the forced-RLS Conversion Journey, scoring, consent,
suppression, commerce and milestone foundation with immutable publication and
payment-backed Sale authority. Migration `0015` adds the isolated receipt-only
Property Predator external-event command/definer roles and replay-safe shadow
ledger. Migration `0016` adds forced-RLS Property Predator source identities,
content consumption, offer, attribution and private projection evidence.
Migration `0017` adds the table-blind, event-ID-only Growth evidence projector
and its independent idempotency receipts. Migration `0018` adds the exact v2
self-serve and Agency LAPS Journey runtime: automatic enrolment, monotonic
milestones, model-derived score snapshots, endpoint-bound consent, routed
commerce facts, transactionally matched outbox facts and separate replay
receipts behind a NOLOGIN/NOINHERIT definer. Migration `0019` adds the isolated
legacy-import command role, immutable/hash-pinned staging, replay receipts,
verified-identity dedupe, quarantine, public sanitised contact provenance,
typed affiliate attribution with private raw payloads, canonical unresolved
attribution receipts across batches, and database-owned audit/lifecycle guards.
Migrations `0020` through `0023` add legacy-lead board materialisation, immutable
company-content approval/version evidence, the workspace-isolated inbox and
provider-operation core, and test-only dispatch claims. Migration `0024` adds
signed, replay-safe Mailgun webhook evidence. Migration `0025` adds the atomic,
function-only controlled email-pilot boundary and durable spend/volume controls.
Migration `0026` adds one opaque installation UUID exposed through a table-blind
runtime proof. Migration `0027` adds the append-only, one-shot internal founder
bootstrap receipt and its fixed dark Mailgun EU configuration.

Before the first successful managed-PostgreSQL application, the pre-launch role
bootstraps in `0001`, `0003`, `0004`, `0006` and `0008` were amended to support
Neon's non-superuser project owner; `0002` remained unchanged. The migration
ledger through `0019` has now been replayed and checksum-verified from zero on
the disposable Neon database. Any later database change must be a new forward
migration.

The always-on PostgreSQL portal and sensitive onboarding process are composed
separately:

- `PORTAL_POSTGRES_ENABLED=true` mounts the read/login/CRM portal only after
  exact `DATABASE_WEB_URL` / `r72_web`,
  `DATABASE_IDENTITY_COMMAND_URL` / `r72_identity_command` and
  `DATABASE_CRM_COMMAND_URL` / `r72_crm_command` connections pass role and
  migration-ledger readiness. It does not need a provisioning or email-worker
  credential. Failure leaves the portal unmounted; requested PostgreSQL mode
  never falls back to legacy signed cookies or JSON CRM.
- `buildPgOnboardingPlatform(...)` is an explicit, separate composition. It
  uses `DATABASE_WEB_URL` only for startup ledger readiness, then closes that
  pool and retains exact public-checkout, webhook, claim-bound provisioning,
  delivery and reissue role pools. It returns a composed
  `PgPaidCheckoutService` plus `PgSetupDeliveryService`; it does not expose the
  unrestricted inner provisioning adapter. It also fails closed unless
  `PORTAL_BASE_URL` is a bare HTTPS origin (loopback HTTP is allowed only in
  development), `SETUP_DELIVERY_ACTIVE_KEY_ID` names an active key, and
  `SETUP_DELIVERY_KEYS_JSON` contains canonical base64url-encoded 32-byte AES
  keys for every still-claimable delivery generation. Construction calls no
  provider and starts no worker.

The application encrypts the canonical recipient and full `/portal/setup`
link with AES-256-GCM before the database call. PostgreSQL stores the setup-token
hash, recipient hash, key ID, IV, ciphertext and authentication tag—not the raw
email link—and erases encrypted fields when a delivery becomes delivered,
superseded or dead-lettered. Retired decrypt keys must remain configured until
startup readiness reports that no claimable row needs them.

`npm run test:db:integration` passed **8/8** against a freshly reset disposable
direct Neon database on 2026-08-25 after replaying migrations `0001`–`0019`.
The proof covers RLS/revocation, atomic onboarding/setup, exact paid-Checkout
reconciliation, conversion publication and Journey projection, endpoint-bound
consent, payment-backed Sale, source allowlisting, receipt-only external-event
replay, Growth read models, and the isolated legacy lead import boundary. The
ordinary non-destructive suite discovered **801 tests: 793 passed, 0 failed and
8 skipped**; those skips are exactly the gated live tests. The focused strike
suite passed **174/174**. TypeScript checking passed after the final Journey
Manager CSS adjustment.
Automatic PostgreSQL onboarding nevertheless remains locked. The detached
Checkout/dispatcher modules are not wired into `server/app.ts`, no real email
provider adapter exists, and no worker starts automatically. Keep this path out
of customer traffic until route/browser storage wiring is explicitly enabled,
a real provider adapter and supervisor are operated, ingress logs redact the
initial `?token=` query, distributed abuse controls and operational
restore/key/alert runbooks are approved, repeat-purchase policy is defined, and
real-browser acceptance is complete.
