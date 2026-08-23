# PostgreSQL foundation

This directory is an isolated platform foundation. No current checkout, intake,
portal, or CRM request uses it yet, and its presence does not unlock live money.

- `npm run db:migrate` uses `DATABASE_MIGRATOR_URL`, takes an advisory lock,
  verifies every applied SHA-256 checksum, and applies each pending SQL file in
  its own transaction.
- `npm run db:check` is read-only and fails unless the ledger exactly matches the
  migration files in this release.
- Production runtime URLs must authenticate as their matching least-privilege
  roles (`r72_web`, `r72_worker`, `r72_webhook`, `r72_public`, or
  `r72_readonly`). The pool verifies `current_user` before checkout.
- The migrator needs permission to create roles and extensions. Migrations never
  contain passwords; provision runtime role passwords or managed identities in
  the hosting secret/control plane.
- The ordinary suite skips the real PostgreSQL test when no database is
  configured. `npm run test:db:integration` is intentionally stricter: it
  fails unless `TEST_DATABASE_URL` names an explicitly disposable database
  containing a standalone `test` segment, so a green integration command can
  never mean “skipped”. It truncates foundation identity tables and must never
  point at customer data.

Migrations `0001` and `0002` establish role separation, forced RLS, global users,
white-label organisations, isolated workspaces, sourced/revocable memberships,
opaque sessions, and hashed single-use identity tokens. Feature cutover begins
only in a later reviewed slice.
