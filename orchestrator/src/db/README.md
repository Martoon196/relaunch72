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
  roles (`r72_web`, `r72_crm_command`, `r72_worker`, `r72_webhook`,
  `r72_public`, or `r72_readonly`). The pool verifies `current_user` before
  checkout.
- Portal reads use `DATABASE_WEB_URL` / `r72_web`. That role can read CRM rows
  allowed by forced RLS but has no CRM table mutation grant or write policy.
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
  never mean “skipped”. It truncates foundation identity tables and must never
  point at customer data.

Migrations `0001` and `0002` establish role separation, forced RLS, global users,
white-label organisations, isolated workspaces, sourced/revocable memberships,
opaque sessions, and hashed single-use identity tokens. Migration `0003` adds
the new command role plus the first CRM loop, without changing the issued
`0001`/`0002` checksums, and keeps the web/read pool physically separate from
its command/write pool.
