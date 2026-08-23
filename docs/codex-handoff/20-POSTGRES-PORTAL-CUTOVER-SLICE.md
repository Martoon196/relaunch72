# 20 — POSTGRESQL PORTAL CUTOVER SLICE

**Measured:** 2026-08-24 on the local Codex branch.
**Activation:** off by default and operator-gated.
**External effects:** none. No database was created, migrated or contacted; no
deployment, push, purchase, message or provider action occurred.

---

## Outcome

The durable CRM now has a real PostgreSQL authentication and runtime-composition
seam. It no longer requires an unsafe interpretation of the legacy signed tenant
cookie.

The slice adds:

- a dedicated `r72_identity_command` login role with no direct table access;
- opaque 32-byte browser sessions whose raw token is never sent to PostgreSQL;
- scrypt password verification with dummy work for unknown accounts and a
  compare-and-swap upgrade path for imported legacy hashes;
- password-hash, active-user, active-workspace and active-membership checks at
  session issuance;
- session revalidation inside every CRM read or command transaction;
- deterministic command/logout ordering by holding a share lock on the session
  row for each write transaction;
- an exact, function-mediated runtime migration ledger;
- three independently verified runtime pools: `r72_web`,
  `r72_identity_command` and `r72_crm_command`;
- fail-closed server composition with no legacy-cookie fallback when PostgreSQL
  mode was explicitly requested;
- clean pool closure on partial construction, portal-composition failure and
  process shutdown;
- a signed, short-lived double-submit token on the pre-authentication login
  form, separate from the authenticated session CSRF token;
- bounded account-and-source login throttling with atomic in-process
  reservations, so concurrent guesses cannot all pass the same stale count;
- a post-authentication workspace bridge preflight before the browser cookie is
  issued, with immediate database-session revocation on a missing/mismatched
  legacy read-model bridge;
- a reciprocal tenant/email bridge attestation on every database-session
  request, so a valid but swapped legacy tenant key cannot expose another JSON
  workspace while the compatibility read model still exists;
- honest PostgreSQL setup handling: no active-looking legacy setup form is
  shown when the atomic database setup command does not exist;
- a branded, cache-disabled 503 workspace page plus explicit
  `portal_ready`/`portal_blockers` health fields when a required portal fails
  startup readiness;
- CSRF checks on logout, billing, manager-run and every CRM mutation;
- premium application-shell status pages instead of bare CRM error fragments;
- task read/write capability IDs and a more usable mobile CRM board, lead flow,
  safe-area navigation, read-only states and timezone copy.

This is an executable seam for an already provisioned and correctly migrated
identity graph. It is not permission to enable the portal for real customers.

## Database contracts

Migration `0004_portal_sessions.sql` adds the role and the following
`SECURITY DEFINER` functions. Each function has a fixed `pg_catalog` search path,
`PUBLIC` execution is revoked and only the named runtime role receives execute
permission.

| Function | Runtime caller | Purpose |
|---|---|---|
| `runtime_schema_migrations()` | `r72_web` | Return the exact private migration ledger without exposing its table |
| `portal_login_credential(email)` | `r72_identity_command` | Return one active imported credential and deterministic active bridged workspace |
| `create_portal_session(...)` | `r72_identity_command` | Compare the exact password hash, recheck membership and create a hashed 14-day session |
| `resolve_portal_session(token_hash)` | `r72_web` | Resolve one active opaque session before a request is routed |
| `active_portal_session(...)` | `r72_web` | Revalidate the exact session in a read-only snapshot transaction |
| `lock_active_portal_session(...)` | `r72_crm_command` | Revalidate and lock the session before CRM mutation SQL |
| `revoke_portal_session(token_hash)` | `r72_identity_command` | Revoke the exact browser session |
| `upgrade_portal_password_hash(...)` | `r72_identity_command` | Upgrade an imported hash with compare-and-swap semantics |

Session issuance locks the matched user row through its insert. A concurrent
password update therefore orders either before the expected-hash check or after
the new session exists; it cannot change the credential between the check and
insert. CRM write transactions similarly share-lock the active session, so a
logout either revokes first and prevents the command, or waits for the already
authorised command to finish.

Credential selection filters to the exact bridged, active workspace before it
chooses the deterministic membership. Email comparison is case-insensitive
without relying on the caller's search path. The migration also audits every
privileged role relationship: only the migrator may assume the owner role and
only the owner may assume the security-definer role; generic inbound identity
members are rejected.

Read-only CRM snapshots cannot take a row lock. They revalidate in the same
repeatable-read snapshot, giving a clear before/after view of revocation, but a
read that began before logout may finish. No external effect is attached to a
read.

## Exact activation gate

PostgreSQL portal composition occurs only when all of these are true:

1. `PORTAL_POSTGRES_ENABLED=true` is explicitly set;
2. `DATABASE_WEB_URL` authenticates exactly as `r72_web`;
3. `DATABASE_IDENTITY_COMMAND_URL` authenticates exactly as
   `r72_identity_command`;
4. `DATABASE_CRM_COMMAND_URL` authenticates exactly as `r72_crm_command`;
5. production database transport is encrypted;
6. the safe runtime ledger exactly equals every bundled migration filename and
   SHA-256 checksum;
7. all three role-specific pools connect and verify `current_user`;
8. the portal dependencies compose successfully.

If any check fails after the gate was requested, the PostgreSQL portal remains
unmounted. The server does not downgrade to legacy signed cookies or JSON CRM.
The gate defaults to false.

## Still blocked before a customer pilot

The following remain non-negotiable:

1. **Canonical provisioning.** A trusted order/idempotency key must atomically
   create or reconcile organization, workspace, user, active memberships,
   one-time setup token, default Sales pipeline and its ordered stages.
2. **Atomic account setup.** One unexpired setup token must be consumed exactly
   once while choosing the password and issuing the first opaque session.
3. **Legacy import.** A dry-run-first importer must report ambiguous users,
   workspaces and contacts rather than guessing. Legacy tenant IDs are
   compatibility keys, never authority.
4. **Real PostgreSQL proof.** This machine has no PostgreSQL, `psql`, Docker,
   Podman or usable WSL engine and no `TEST_DATABASE_URL`. Static SQL assertions
   and fake pool tests are not proof that PostgreSQL accepted the migration.
5. **Real browser/device acceptance.** Owner, sales and viewer journeys still
   require desktop/mobile, keyboard and assistive-technology checks against a
   running application.
6. **Pagination and richer identity.** The first snapshot remains default-
   pipeline-only and unpaginated; owner, assignee and activity actor display
   data is still deliberately thin.
7. **Operational controls.** Restore drill, database alerts, login abuse controls
   suitable for multiple instances, support procedure and an audited deployment
   runbook remain required. The new bounded throttle is correct for one process;
   a shared store or edge control is still required when the service scales out.

Automatic portal onboarding is therefore locked whenever PostgreSQL mode is
selected. Account setup is unavailable unless a database implementation is
explicitly supplied; it never falls back to the JSON account store.

## Verification boundary

The ordinary TypeScript suite covers:

- strict gate/configuration parsing and exact role URLs;
- runtime-ledger comparison and fail-closed mismatches;
- SQL ownership, search-path, grant and role contracts;
- raw-token exclusion and strict opaque-token parsing;
- correct and incorrect password paths, dummy verification and legacy upgrades;
- password/membership races at the adapter boundary;
- in-transaction read/write session guards and rollback on an inactive token;
- legacy-cookie rejection in PostgreSQL mode;
- stale-cookie login/setup recovery and explicit sign-out failure that preserves
  the browser session when durable revocation cannot complete;
- login and authenticated CSRF coverage, concurrent throttle reservations,
  post-login bridge preflight, branded readiness failure and premium
  error/empty/read-only UX.

The final ordinary run on this branch reports **511 passing tests, zero failures
and one explicit PostgreSQL integration skip**. TypeScript typechecking passes.

`npm run test:db:integration` remains the hard evidence gate. It deliberately
fails when no explicitly disposable test database is supplied; the ordinary
suite reports that integration test as skipped rather than pretending it ran.

## Next executable slice

The next migration/application slice should be canonical provisioning plus
single-use account setup, followed by a dry-run legacy importer. Only after a
real PostgreSQL run proves setup → login → CRM read/create/move/complete →
logout → old-token rejection for owner, sales and viewer should
`PORTAL_POSTGRES_ENABLED` be considered for a private pilot.

Provider work remains separate. Social, WhatsApp, webinar, email and automation
rails connect through the outbox/capability boundary and do not need to be
purchased to finish this cutover. See
[17-WHITE-LABEL-PROVIDER-MATRIX.md](./17-WHITE-LABEL-PROVIDER-MATRIX.md) and
[18-LAUNCH-COST-MODEL.md](./18-LAUNCH-COST-MODEL.md).
