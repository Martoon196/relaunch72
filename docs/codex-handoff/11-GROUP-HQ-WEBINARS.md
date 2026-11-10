# 11 · Webinars run from Group HQ — handoff for Codex

From: Claude (owner's webinar branch). To: Codex, for review, integration and deploy sequencing.
Date: 10 Nov 2026. Owner: Martin Howard.

Owner's decision: "the webinar side should be in Group HQ as the leads go there from the marketing
produced by RL72 and the webinar is for MHP", and "all the accounts I'm logged in in Group HQ should be
logged in under the same login in RL72". Decision record: `docs/decisions.md` D-078.

The engine was **not** rewritten in Python. Group HQ becomes the front door: it lists both brands' webinars
and opens any page on the brand host already signed in. Two repositories change; this page carries both.

**Do not deploy until reviewed.** Nothing here authorises production rollout, a new paid account, Apollo,
outreach or advertising. Migration 0147 is additive; the released 146 binary stays ready after it.

## Relaunch72 (this repository, branch `claude/gifted-lamport-i4bdio`)

1. **Sign-in handoff** `src/portal/group-hq-sso.ts` + route `/portal/auth/group-hq` in `src/portal/router.ts`
   on both hosts. HMAC-SHA256 token (`base64url(json).base64url(mac)`, domain prefix `group-hq-handoff\0`),
   bound to version, email, brand, exact host, exact `/portal/...` path, iat/exp (≤ 120 s), nonce (single use
   per process, 5000 cap). The email maps to a user only through `R72_GROUP_HQ_SSO_USERS`. Brand must match the
   host (MHP cookie name ⇒ `mhp`). Abuse class `auth.sso`. Neutral 400/401/404/405/503 login pages.
2. **Migration `0147_group_hq_delegated_session.sql`** (SHA-256
   `7bd7caf7c10edfbb2fc0db2b2af09e9ba02550e7187f445f3c0f03b0a78f680e`, pinned in `src/db/group-hq-sso-schema.ts`):
   * `app_private.create_group_hq_delegated_session(user, workspace, audience, token_hash, csrf_hash, ip_hash,
     ua_hash)` owned by `r72_security_definer` (same pattern as the PP SSO session function), execute to
     `r72_identity_command`. Refuses unless the user is an active owner/admin of an active workspace in an active
     organisation, passes `can_manage_workspace`, holds the source-org membership when present, and for the MHP
     audience passes `mhp_marketing_workspace_allowed`. Inserts `app.user_sessions` with the host's audience and a
     12-hour expiry. No row on refusal.
   * `GRANT EXECUTE ON app_private.mhp_marketing_workspace_allowed TO r72_security_definer` (done as its owner,
     `r72_mhp_member_definer`).
   * `app_private.webinar_crm_handoff_workspaces()` for the worker (execute to `r72_content_command`).
3. **`loginDelegated`** on `PortalAuthService` (optional), implemented by `PgPortalAuthService` (audience
   `property_predator_growth`) and `PgMhpAuthService` (audience `martin_howard_property`).
4. **MHP host serves webinars**: `src/mhp/mount.ts` `portalPath` admits `/portal/webinars…` and the handoff
   route; `src/server/index.ts` passes `webinars`, `webinarSetup`, `webinarStudio`, `groupHqSso` to the MHP
   portal. Before this, MHP webinars could not be managed on the MHP host at all.
5. **Webinar listing bridge** `src/integrations/group-hq-crm/webinars.ts`, `GET /api/group-hq/webinars?brand=`,
   bearer `R72_GROUP_HQ_CRM_TOKEN`, read-only under the configured owner's RLS context on the content pool,
   `webinar_workspace_profile` must say canManage for that workspace. Mounted in `src/server/app.ts` behind the
   portal concurrency guard. Composed only when webinars are composed.
6. **Automatic CRM handoff**: `settings.crmAutoHandoff` (default true; checkbox on the webinar form).
   `PgWebinarService.autoHandoff(workspaceId)` runs the existing handoff core as the webinar's `created_by_user_id`
   under `requestDatabaseContext({workspaceId, userId})`; `WebinarWorker` gets `webinars` and unions
   `webinar_crm_handoff_workspaces()` into its tick, with a ten-minute mute per workspace after a failing pass.
   `sendToCrm` (manual button) is unchanged in behaviour.
7. **Email setup**: `setupChecklist` prints the exact `WEBINAR_EMAIL_SENDERS` entry for the workspace
   (`MHP_POSTMARK_SERVER_TOKEN` for the MHP marketing workspace, `POSTMARK_SERVER_TOKEN` otherwise) plus the
   current parse blockers. Names only, never a token.
8. **Readiness** (`src/db/runtime-readiness.ts`): 146 release stays ready after exactly 147 is applied; 147
   release is ready with exactly 147 pending on the applied 146 ledger, and after it.
9. **Env names** (`.env.example`): `R72_GROUP_HQ_SSO_SECRET`, `R72_GROUP_HQ_SSO_USERS`.

Tests: `test/group-hq-sso.test.ts` (token, config, nonce, router on both hosts, shared vector with the Python
signer), `test/db/group-hq-handoff.integration.test.ts` (actual roles: delegated sessions both audiences,
bridge, worker auto-handoff, consent, manual fallback), ledger tests updated for 147. Full suite 4417 / 0 fail /
74 skipped (DB tests skipped without `TEST_DATABASE_URL`; run separately, all green on a disposable Postgres 16).

## Group HQ (`Martoon196/group-hq`) — patch to apply

This session had read access to `group-hq` but was not granted push access, so the change is here as
`docs/codex-handoff/group-hq-webinars-front-door.patch` (one commit on top of `f631527`). Apply with
`git am` on a branch and review:

* `app/config.py`: `R72_SSO_SECRET`, `R72_PP_HOST`, `R72_MHP_HOST` (defaults to the live hosts).
* `app/services/relaunch72_sso.py`: signer byte-identical to the TypeScript verifier (shared test vector in
  `unit_checks/relaunch72_sso.py` and `test/group-hq-sso.test.ts`). Lifetime 90 s.
* `app/services/relaunch72_webinars.py`: validated read of `/api/group-hq/webinars` with `R72_CRM_TOKEN`.
* `app/routers/webinars.py`: `GET /webinars?brand=` page; `GET /webinars/open?brand=&path=` → 303 to
  `https://<brand host>/portal/auth/group-hq?t=…` (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`);
  foreign paths 400; unconfigured secret → flash error, page still lists.
* `app/templates/webinars.html`, nav link in `app_base.html` (after Inbox), `main.py` router, `.env.example`,
  `render.yaml` (web service only; never copied to a cron), `docs/relaunch72-webinars.md`.
* `_crm_workspaces.html` is untouched (its template test pins exact hrefs).

`python -m unittest discover -s unit_checks -p '*.py' -v`: 61 pass; the one failure, `crm_route`, is
pre-existing on `f631527` (the stub calls `crm(request, user)` but the router now takes `db` too).

## Configuration to set (names only)

Relaunch72 web service: `R72_GROUP_HQ_SSO_SECRET` (32–256 random chars), `R72_GROUP_HQ_SSO_USERS`
(`{"<group hq login email>":"<portal user id>"}`), existing `R72_GROUP_HQ_CRM_MHP_WORKSPACE_ID` +
`R72_GROUP_HQ_CRM_MHP_ORGANIZATION_ID` so `brand=mhp` lists. The PP workspace is
`R72_GROUP_HQ_CRM_PP_WORKSPACE_ID` (already set for the CRM bridge). The portal user must be an owner/admin of
that PP workspace and, for MHP, the MHP marketing owner.

Group HQ web service: `R72_SSO_SECRET` (same value). Hosts default.

Email for the MHP land webinar: `WEBINAR_EMAIL_MODE=live` and a `WEBINAR_EMAIL_SENDERS` entry for workspace
`2789228d-55a6-4688-b1e8-2f70abca990b` with `tokenEnv: "MHP_POSTMARK_SERVER_TOKEN"` and a verified MHP `from`;
`WEBINAR_WORKSPACE_ORIGINS` mapping that workspace to `https://app.martinhowardproperty.co.uk`. Restart after
changing them (startup configuration).

## Release order

1. Merge and deploy Relaunch72 with 0147 **pending** (route 404s, worker handoff off). `/ready` green on PP and MHP.
2. Apply 0147 with the migrator; verify the ledger and `/ready`; restart so the content pool probe recomposes.
3. Set the two secrets and the allowlist. Deploy Group HQ. Open `/webinars`, press **Host** on one webinar, land
   signed in. Replay the link: neutral refusal. Remove the email from the allowlist: next click refused.
4. Turn email on for MHP as above; the setup panel shows the sender as Ready.

## Open items for the owner

* Date and time of the unregistered-land webinar (MHP) — needed to create it.
* The `from` address for MHP webinar emails (must be a verified Postmark sender on the MHP server).
* The Group HQ login email to list in `R72_GROUP_HQ_SSO_USERS`.
