# Supply-chain gate and disposable recovery smoke proof

## Locked dependency boundary

`npm run supply-chain:check` delegates directly to the repository-owned, built-in-
only `node scripts/supply-chain.mjs --check`. It fails closed unless the root lockfile is version 3,
every downloaded package resolves from HTTPS `registry.npmjs.org`, every archive
has a single SHA-512 integrity digest, every workspace link remains inside this
repository, and the checked-in CycloneDX document exactly matches the lockfile.

Installs used for release evidence must be `npm ci --ignore-scripts`. The lockfile
currently records lifecycle declarations for only `esbuild@0.28.1` and the
Darwin-only optional `fsevents@2.3.3`; the gate pins that declaration list so a
new lifecycle-capable dependency cannot arrive unnoticed. The allowlist does not
authorise execution of either script. Root and workspace lifecycle hooks are
forbidden outright.

Regenerate `security/sbom.cdx.json` only with `npm run sbom:write`, review both
the lockfile and SBOM diff, then run `npm run supply-chain:check`, typecheck and
tests. The generator reads `package-lock.json` directly, adds no dependency, and
omits timestamps and random serial numbers, so identical lockfiles produce
byte-identical CycloneDX 1.5 JSON on Windows and Linux.

## One disposable-Neon recovery smoke proof

This is a narrow rehearsal, not a claim that retention, encrypted exports or
production disaster recovery are complete. Never run it against the production
Property Predator project.

1. Identify the already-approved disposable Neon project and its disposable
   source branch. Record project ID, branch ID, database name and UTC start time;
   never record a connection string.
2. On the source branch, read only these fingerprints:
   - `count(*)` plus an ordered SHA-256 digest of filename/checksum from
     `app_private.schema_migrations`;
   - `count(*)` from `app_private.workspace_table_registry`;
   - the opaque `installation_id` from
     `app_private.database_installation_identity`;
   - bounded row counts for `app.organizations`, `app.workspaces`, `app.users`,
     `app.contacts`, `app.opportunities` and `app.tasks`.
3. Create a temporary child branch named
   `codex-disposable-recovery-smoke-YYYYMMDD-HHMM` in that disposable project.
   State the returned child branch ID in the work log before every child query.
4. Run the same read-only fingerprint on the child and require an exact match.
   A mismatch is a failed rehearsal.
5. On the child only, create a uniquely named schema containing one sentinel row.
   Confirm it exists. Do not alter any application table.
6. Reset that child branch from its parent. This deliberately destroys only the
   temporary child's sentinel change and restores the parent's current state.
7. Prove the sentinel schema is absent and the complete application fingerprint
   once again matches step 2. Run `npm run db:check` and one read-only application
   readiness query against the child.
8. Delete only the exact temporary child branch after recording its ID, final
   fingerprint and UTC finish time. Confirm the disposable parent is unchanged.

The evidence record must contain branch IDs, timestamps, redacted fingerprints,
commands/check names and pass/fail only. It must contain no URL, password, token,
email, personal row data or raw application content. Provider effects and email
delivery remain off throughout.

### Completed limited smoke evidence — 27 August 2026

Only a limited subset of the fuller rehearsal above has been proven. In approved
disposable project `polished-wave-33495435` (`relaunch72-disposable-test`),
temporary child branch `br-gentle-queen-za915hr5` began with 37 migrations, latest
`0037`, and the `app.contacts` and `app.provider_operations` tables present. A
child-only `codex_recovery_smoke.proof` marker was created, the child was reset
from its parent, and the marker was then absent while those same three schema
observations remained true. The temporary child was deleted after verification.

This proves the disposable branch reset removed the child-only marker and retained
the observed schema markers. It does **not** yet prove row-data restoration,
historical point-in-time recovery, retention, encrypted export recovery, full
application readiness or production disaster recovery. No production project,
provider effect or secret was used.
