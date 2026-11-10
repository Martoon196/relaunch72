# 12 · Operator API for Claude (MCP + OAuth) — handoff for Codex

From: Claude (owner's branch `claude/gifted-lamport-i4bdio`). To: Codex, for review, integration and deploy sequencing.
Date: 10 Nov 2026. Owner: Martin Howard. Decision record: `docs/decisions.md` D-079.

Owner's request: "API access to RL72 and Growth HQ so normal Claude can operate the systems and amend and adjust."

**Do not deploy until reviewed.** Both endpoints 404 until their settings exist. No new paid account, no outreach,
no Apollo. Write tools are off by default on both systems.

## Relaunch72 (this repository)

Source `orchestrator/src/operator/` — `config.ts` (names), `tokens.ts` (signed blobs), `oauth.ts` (authorization
server), `mcp.ts` (JSON-RPC server), `tools.ts` (catalogue), `sessions.ts` (delegated sessions per brand),
`mount.ts` (HTTP). Wired in `postgres-platform.ts` (composition), `server/app.ts` (routes behind the portal
concurrency guard) and `server/index.ts` (mount with the canonical origin). Full description, tool list, settings
and limits: `docs/operator-api.md`.

Key review points:
* Authority: `OperatorSessions` mints a delegated session via `loginDelegated` (0147 function) for
  `R72_OPERATOR_USER_ID` on the brand workspace; the database refuses non-owners. Sessions are cached per brand,
  re-resolved every five minutes, replaced on expiry.
* Bearer: static `R72_OPERATOR_TOKEN` (timing-safe) or an OAuth access token whose subject equals the operator
  user. 401 carries `WWW-Authenticate … resource_metadata=`.
* OAuth consent: only a portal session cookie resolving to the operator user can grant; CSRF via the existing
  portal synchroniser token; redirect URIs must be https or loopback http; every failure is a page, never a redirect
  to an unregistered URI.
* No new dependency; the supply-chain gate is unchanged.

Tests: `test/operator.test.ts` (6 tests) and `test/db/operator.integration.test.ts` (actual roles). Full suite
green; see the commit message for totals.

Settings to create (names only): `R72_OPERATOR_USER_ID` (the owner's portal user id, same one as in
`R72_GROUP_HQ_SSO_USERS`), `R72_OPERATOR_OAUTH_SECRET` (for claude.ai), `R72_OPERATOR_TOKEN` (for Claude Code /
Desktop), `R72_OPERATOR_WRITES=enabled` once reads have been checked.

## Group HQ (`Martoon196/group-hq`) — patch

`docs/codex-handoff/group-hq-operator-api.patch` (one commit on top of the webinars front-door commit; apply both
patches in order with `git am`). It adds `/mcp`, `/oauth/register|authorize|token`, the two well-known documents
(plus `/mcp`-suffixed aliases), ten read tools, five write tools behind `GHQ_OPERATOR_WRITES=enabled`, audit rows
for write calls, `docs/operator-api.md`, and 16 unit checks (78 run, 77 pass, the one failure is the pre-existing
`crm_route` stub). Settings (names only): `GHQ_OPERATOR_TOKEN`, `GHQ_OPERATOR_OAUTH_SECRET`,
`GHQ_OPERATOR_USER_EMAIL`, `GHQ_OPERATOR_WRITES`. Known limit noted in its doc: the single-use code set is per
process, so with more than one instance a code could be exchanged once per instance within its two minutes.

## Release order

1. Deploy Relaunch72 (after 0147 is applied; the operator needs the delegated-session function). Set
   `R72_OPERATOR_USER_ID` and `R72_OPERATOR_OAUTH_SECRET`. In claude.ai add the connector URL
   `https://hq.propertypredator.com/api/operator/mcp`, sign in as the owner on the portal, Allow. Try
   `workspace_overview` for `pp`. Leave writes off until the owner has read a few results.
2. Deploy Group HQ with its two patches. Set `GHQ_OPERATOR_OAUTH_SECRET` (and the token/email pair for Claude
   Code). Add `https://group-hq.onrender.com/mcp` as a connector, sign in, Allow.
3. Turn on writes (`R72_OPERATOR_WRITES=enabled`, `GHQ_OPERATOR_WRITES=enabled`) only after the owner approves.
