# Prompt for Codex — Group HQ webinars front door + Operator API (10 Nov 2026)

Codex, please review and integrate the owner's branch `claude/gifted-lamport-i4bdio` in `Martoon196/relaunch72`
(head `52ea7dc`, two commits on top of your trunk `codex/relaunch72-platform-foundation` at `e70df31`), and apply
the two Group HQ patches it carries to `Martoon196/group-hq` (on top of `f631527`). Do not deploy anything until
you have reviewed it and the owner has approved the release steps below. No new paid accounts, no Apollo, no
outreach, no advertising changes. Report back with what you merged, what you changed, and what is still blocked.

## 1. What the branch does (read `docs/codex-handoff/11-GROUP-HQ-WEBINARS.md` and `12-OPERATOR-API.md` first)

Commit `cab0fd0` — webinars run from Group HQ, one sign-in:
- `/portal/auth/group-hq` on both brand hosts: a two-minute, single-use, host- and path-bound HMAC handoff token
  from Group HQ; the email is mapped to a user only through the server-owned allowlist `R72_GROUP_HQ_SSO_USERS`;
  migration `0147_group_hq_delegated_session.sql` (SHA-256
  `7bd7caf7c10edfbb2fc0db2b2af09e9ba02550e7187f445f3c0f03b0a78f680e`) adds `create_group_hq_delegated_session`
  (owner/admin of the workspace only; MHP marketing owner for the MHP audience; 12-hour session) and
  `webinar_crm_handoff_workspaces`. Readiness: the released 146 binary stays ready after exactly 147; 147 is ready
  with exactly 147 pending.
- The MHP host now serves `/portal/webinars` (it never did; MHP webinars could not be managed on the MHP host).
- `GET /api/group-hq/webinars?brand=pp|mhp` read bridge, same bearer as the CRM read bridge.
- Automatic CRM handoff: per-webinar switch, default on; the worker sends new registrants as the webinar's creator.
- Setup panel prints the exact `WEBINAR_EMAIL_SENDERS` entry for the workspace (names only).

Commit `52ea7dc` — Operator API so Claude can operate both systems over MCP:
- `orchestrator/src/operator/`: stateless MCP endpoint `/api/operator/mcp` on the canonical host, bounded tool
  catalogue over existing CRM and webinar services, acting as `R72_OPERATOR_USER_ID` through a 0147 delegated
  session; minimal OAuth 2.1 server (dynamic registration, PKCE S256) because claude.ai connectors only accept
  OAuth; static bearer for Claude Code/Desktop; write tools only behind `R72_OPERATOR_WRITES=enabled`. No new
  npm dependency. Full description: `docs/operator-api.md`.

Group HQ patches (apply in order with `git am` on a branch, then review and open your own PR there):
1. `docs/codex-handoff/group-hq-webinars-front-door.patch` — Webinars page listing both brands, `/webinars/open`
   303 to the brand host handoff, `R72_SSO_SECRET`, `R72_PP_HOST`, `R72_MHP_HOST`, docs, unit checks.
2. `docs/codex-handoff/group-hq-operator-api.patch` — `/mcp`, `/oauth/*`, well-known documents, ten read tools,
   five write tools behind `GHQ_OPERATOR_WRITES=enabled`, audit rows, docs, 16 unit checks.
   Known limit documented inside: the single-use OAuth code set is per process.
   The pre-existing `unit_checks/crm_route.py` failure (stale stub, `crm()` now takes `db`) was left alone;
   fix it if you like.

## 2. Review focus

- 0147's role pattern: `GRANT EXECUTE ON mhp_marketing_workspace_allowed TO r72_security_definer` is done as its
  owner `r72_mhp_member_definer`; the session function is created as `r72_security_definer` with a temporary
  `GRANT CREATE ON SCHEMA app_private` that is revoked, exactly like 0029. Confirm you are happy with the extra
  execute grant.
- The handoff and operator routes refuse neutrally (400/401/404/405/503 login pages or JSON) and never redirect
  to an unregistered URI. Abuse class `auth.sso` covers the handoff.
- OAuth tokens are stateless signed blobs: one-hour access, 30-day refresh, no per-token revocation (rotate the
  secret). Say if you want a stored-token table instead; that would be a further migration.
- The automatic CRM handoff acts as `created_by_user_id` under that user's RLS context; a failing workspace is
  muted for ten minutes. Check the worker's new union of `webinar_crm_handoff_workspaces()` into its tick.

Tests on the branch: full suite 4425 / 0 failed / 75 skipped (the DB tests skip without `TEST_DATABASE_URL`; run
them on a disposable Postgres 16 with `RELAUNCH72_DATABASE_INTEGRATION=explicit-disposable-run` and
`TEST_DATABASE_RESET_CONFIRM=reset-disposable-branch`: `test/db/group-hq-handoff.integration.test.ts`,
`test/db/operator.integration.test.ts`, `test/db/runtime-readiness.test.ts`, `test/db/sql-contract.test.ts` and
the four `native-webinars*` tests all pass there).

## 3. Settings to create (names only; generate each value yourself, never paste one into chat or a file)

Relaunch72 web service:
- `R72_GROUP_HQ_SSO_SECRET` (32–256 chars) and `R72_GROUP_HQ_SSO_USERS` = `{"<owner's Group HQ login email>":"<owner's portal user id>"}`.
- `R72_GROUP_HQ_CRM_MHP_WORKSPACE_ID` = `2789228d-55a6-4688-b1e8-2f70abca990b`,
  `R72_GROUP_HQ_CRM_MHP_ORGANIZATION_ID` = `ba41b1a4-9752-4dbf-8312-d04a0f03d0b8` (so `brand=mhp` lists).
- `R72_OPERATOR_USER_ID` (the same portal user id), `R72_OPERATOR_OAUTH_SECRET` (32–256 chars, different from
  every other secret), optionally `R72_OPERATOR_TOKEN` (32–256 chars) for Claude Code; leave
  `R72_OPERATOR_WRITES` unset until the owner approves writes.
- Webinar email for MHP: `WEBINAR_EMAIL_MODE=live`; `WEBINAR_EMAIL_SENDERS` entry
  `{"workspaceId":"2789228d-55a6-4688-b1e8-2f70abca990b","from":"<verified MHP Postmark sender>","tokenEnv":"MHP_POSTMARK_SERVER_TOKEN","messageStream":"outbound"}`;
  `WEBINAR_WORKSPACE_ORIGINS` mapping that workspace to `https://app.martinhowardproperty.co.uk`. Restart after
  changing them. The owner still has to confirm the `from` address.

Group HQ web service: `R72_SSO_SECRET` (same value as `R72_GROUP_HQ_SSO_SECRET`), `GHQ_OPERATOR_OAUTH_SECRET`,
optionally `GHQ_OPERATOR_TOKEN` + `GHQ_OPERATOR_USER_EMAIL`; leave `GHQ_OPERATOR_WRITES` disabled for now.

## 4. Release order (each step only after the previous one is green)

1. Merge and deploy Relaunch72 with 0147 pending: handoff route 404s, operator 404s, worker handoff off.
   `/ready` green on PP and MHP.
2. Apply 0147 with the migrator; verify ledger, checksum and `/ready`; restart so the content-pool probe recomposes.
3. Set the Relaunch72 secrets and allowlist. Deploy Group HQ with both patches and its secrets.
4. Owner test: open Group HQ → Webinars, press Host on a webinar, land signed in on the brand host; replay the
   link (neutral refusal); remove the email from the allowlist (next click refused), put it back.
5. Owner test: in claude.ai add custom connectors for `https://hq.propertypredator.com/api/operator/mcp` and
   `https://group-hq.onrender.com/mcp`, sign in, Allow, try `workspace_overview` (brand `pp`) and
   `group_hq_overview`. Only then consider `R72_OPERATOR_WRITES=enabled` / `GHQ_OPERATOR_WRITES=enabled`.
6. Turn MHP webinar email on as above; the Webinars setup panel on the MHP host should show the sender as Ready.

## 5. Open items for the owner (not for you to invent)

- Date and time of the unregistered-land webinar (MHP), and the MHP `from` email address for webinar emails.
- Approval before any write tools are enabled, and before anything is deployed.
