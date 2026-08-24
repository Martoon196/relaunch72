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
  `r72_crm_command`, `r72_worker`, `r72_webhook`, `r72_public`, or
  `r72_readonly`). Every pool verifies `current_user` before checkout.
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
- Atomic customer creation uses `DATABASE_PROVISIONING_COMMAND_URL` /
  `r72_provisioning_command`. It has no table privileges and can execute only
  `provision_customer_workspace_with_setup_delivery`, which creates an
  organization, native workspace, pending owner, active owner memberships,
  hashed 24-hour setup credential, default Sales pipeline and encrypted durable
  delivery job in one transaction. The verified Stripe Checkout Session id is
  the intended idempotency key. The adapter returns canonical IDs and delivery
  metadata, never the raw setup credential.
- Setup delivery uses `DATABASE_SETUP_DELIVERY_COMMAND_URL` /
  `r72_setup_delivery_command`. This function-only identity can inspect required
  encryption-key IDs and perform bounded claim, lease renewal, acknowledgement
  and retry/dead-letter transitions. Lease credentials are generated in the
  process and only their hashes enter PostgreSQL. The contract is at-least-once:
  a provider acceptance followed by a crash before acknowledgement can cause a
  retry, so the delivery UUID is also exposed as the stable provider idempotency
  key where a provider supports one.
- Trusted setup reissue uses `DATABASE_SETUP_REISSUE_COMMAND_URL` /
  `r72_setup_reissue_command`. The function-only command is idempotent,
  restricted to a still-pending active owner, and binds the supplied recipient
  hash to that user's canonical database email before it revokes the old token
  and creates the next encrypted generation. It is an operator boundary, not a
  public recovery endpoint.
- CRM command handlers use the separate `createCrmCommandDatabasePool` factory,
  `DATABASE_CRM_COMMAND_URL`, and `r72_crm_command`. The role is `NOINHERIT`,
  cannot assume an owner/security role, and is the only user-facing runtime
  identity allowed to mutate CRM state, append history/activity/outbox facts,
  or claim command receipts. Permissions and active membership are still
  checked by forced RLS for every statement.
- The migrator needs permission to create roles and extensions. Migrations never
  contain passwords; provision runtime role passwords or managed identities in
  the hosting secret/control plane.
- The ordinary suite skips the real PostgreSQL test when no database is
  configured. `npm run test:db:integration` is intentionally stricter: it
  fails unless `TEST_DATABASE_URL` names an explicitly disposable database
  containing a standalone `test` segment, so a green integration command can
  never mean “skipped”. It also requires
  `TEST_DATABASE_RESET_CONFIRM=reset-disposable-branch`. Use a fresh isolated
  branch/project, not merely a test-named database beside production: migrations
  create/alter PostgreSQL roles as well as truncating application tables.

Migrations `0001` and `0002` establish role separation, forced RLS, global users,
white-label organisations, isolated workspaces, sourced/revocable memberships,
opaque sessions, and hashed single-use identity tokens. Migration `0003` adds
the new command role plus the first CRM loop, without changing the issued
`0001`/`0002` checksums, and keeps the web/read pool physically separate from
its command/write pool. Migration `0004` adds the isolated identity-command
role, opaque portal session functions, in-transaction session guards and a safe
runtime migration-ledger function without changing any issued migration.
Migration `0005` removes the temporary JSON tenant key from effective
PostgreSQL authentication and returns only canonical user/workspace identity.
Migration `0006` adds the function-only provisioning role, atomic native
workspace creation and atomic setup-token consumption plus first-session
issuance. Migration `0007` removes ambient object-creation permission in the
shared `public` schema. Migration `0008` adds function-only setup-delivery and
reissue roles, encrypted delivery jobs, idempotent reissue receipts, fenced
claim/lease/ack/fail commands, terminal ciphertext erasure and the cheap setup
reservation required before scrypt. Existing migration files remain
forward-only and checksum-immutable.

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
  pool and retains exact provisioning, delivery and reissue role pools. It also
  fails closed unless `PORTAL_BASE_URL` is a bare HTTPS origin (loopback HTTP is
  allowed only in development), `SETUP_DELIVERY_ACTIVE_KEY_ID` names an active
  key, and `SETUP_DELIVERY_KEYS_JSON` contains canonical base64url-encoded
  32-byte AES keys for every still-claimable delivery generation. Construction
  calls no provider and starts no worker.

The application encrypts the canonical recipient and full `/portal/setup`
link with AES-256-GCM before the database call. PostgreSQL stores the setup-token
hash, recipient hash, key ID, IV, ciphertext and authentication tag—not the raw
email link—and erases encrypted fields when a delivery becomes delivered,
superseded or dead-lettered. Retired decrypt keys must remain configured until
startup readiness reports that no claimable row needs them.

Automatic PostgreSQL onboarding remains locked. Keep it out of customer traffic
until `npm run test:db:integration` passes against a disposable real PostgreSQL
project/branch, the provider dispatcher is deliberately implemented and tested,
edge/access logs redact the initial `?token=` query, and the remaining launch
runbooks and checkout-provenance gate are approved.
