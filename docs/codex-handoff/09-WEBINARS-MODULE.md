# 09 · Native webinars — handoff for Codex

Read `docs/webinars.md` first: it is the source of truth for behaviour, configuration names, release order,
recovery, evidence, the smallest live test and the MHP cutover plan. This page is the map.

## Branch and base

* Branch `claude/gifted-lamport-i4bdio`, merged with canonical trunk `codex/relaunch72-platform-foundation`.
* The earlier standalone `webinars/` Cloudflare Worker prototype is deleted on this branch (commit
  "Retire the standalone Cloudflare Worker webinar prototype"); do not resurrect it.

## Files

| Path | Role |
|---|---|
| `orchestrator/src/db/migrations/0144_native_webinars.sql` | Tables, RLS, definer functions, grants. |
| `orchestrator/src/db/webinar-schema.ts` | Migration filename + checksum (renumber here if 0144 collides). |
| `orchestrator/src/db/runtime-readiness.ts` | 144 cutover and 143 recovery clauses. |
| `orchestrator/src/webinars/` | `config` (env → blockers), `stream` (Cloudflare Stream client, JWT, webhook verify), `schedule` (DST + room state machine), `access` (attendee tokens/cookies), `service` (all reads/writes), `worker` (jobs: messages, provisioning, reconciliation), `messages` (copy, delivery decision, Postmark), `public-router`/`public-view`/`client-scripts` (attendee pages + room script), `http` (webhook, client key), `colour` (contrast-safe brand colours). |
| `orchestrator/src/portal/webinar-router.ts`, `webinar-view.ts` | Portal pages under `/portal/webinars`. |
| Wiring | `portal/router.ts`, `portal/ui.ts`, `portal/postgres-platform.ts`, `portal/provision.ts`, `portal/product-profile.ts`, `platform/modules.ts`, `server/app.ts`, `server/index.ts`, `mhp/mount.ts`. |
| Tests | `test/webinars.test.ts`, `test/db/native-webinars.integration.test.ts`, `test/db/native-webinars-http.integration.test.ts`, shared fixtures `test/db/webinar-harness.ts`, visual preview `test/manual-webinars-preview.ts`. |
| Dependency | `hls.js@1.6.19` (served from our origin; SBOM and lock regenerated). |

## Integration checklist

1. Resolve the 0144 number against Creative Studio at merge time (see docs/webinars.md).
2. Deploy order: capable release → migrator → verify ledger/checksum and `/ready` → restart.
3. Set configuration names on Render (never commit values). Email stays `off` until reviewed.
4. Owner runs the smallest live test. Record live-provider evidence separately from source evidence.
5. Keep unrelated email outreach, Apollo, paid advertising and budget optimisation off. Do not recreate the
   stopped Apollo automation.
