# Operator API: Relaunch72 over MCP for Claude

The orchestrator speaks the Model Context Protocol (MCP) at
`https://hq.propertypredator.com/api/operator/mcp`, so Claude (a claude.ai custom
connector, Claude Desktop or Claude Code) can read and, when a deployment switches it
on, change CRM and webinar data for both brands. Every call acts as **one configured
portal user** through a delegated session (migration 0147's
`create_group_hq_delegated_session`), so the same row-level security and ownership
checks the portal applies decide what the operator can see and do. Nothing here
reaches outside the two brand workspaces, and no token, secret or password is ever
returned by a tool.

The server is Streamable HTTP, stateless and JSON only: `POST` JSON-RPC 2.0 (one
request or a batch of up to 20), notifications get `202`, `GET` is `405`. It is mounted
on the canonical Property Predator host only, and only when the settings below are set;
otherwise its paths return 404. Source: `orchestrator/src/operator/`.

## Two ways to connect

**claude.ai custom connector (OAuth).** Add a custom connector with the URL
`https://hq.propertypredator.com/api/operator/mcp`. claude.ai reads
`/.well-known/oauth-protected-resource`, registers itself at
`POST /api/operator/oauth/register` and opens `/api/operator/oauth/authorize` in your
browser. Sign in to Growth HQ as the operator account (same tab or another), press
**Continue** if asked, read the consent page and press **Allow**. claude.ai then
exchanges the code with PKCE at `POST /api/operator/oauth/token`. Needs
`R72_OPERATOR_OAUTH_SECRET`. Only the configured operator user can grant consent; any
other portal user sees a refusal.

**Claude Code or Claude Desktop (static bearer).** Needs `R72_OPERATOR_TOKEN`:

```bash
claude mcp add --transport http relaunch72 https://hq.propertypredator.com/api/operator/mcp --header "Authorization: Bearer <the R72_OPERATOR_TOKEN value>"
```

A request without an acceptable bearer gets `401 {"error":"unauthorised"}` with
`WWW-Authenticate: Bearer realm="Relaunch72 operator", resource_metadata=".../.well-known/oauth-protected-resource"`.

## Settings (web service; names only, never values)

| Name | Purpose |
|---|---|
| `R72_OPERATOR_USER_ID` | The portal user every operator call acts as. Must be an active owner or admin of the PP workspace and, for MHP, the MHP marketing owner. Required. |
| `R72_OPERATOR_TOKEN` | Static bearer for Claude Code / Desktop (32–256 random characters). Optional. |
| `R72_OPERATOR_OAUTH_SECRET` | Signs OAuth client ids, codes, access and refresh tokens (32–256 characters, different from the token). Optional; needed for claude.ai. |
| `R72_OPERATOR_WRITES` | `enabled` offers the write tools. Anything else (default) is read only. |
| `R72_GROUP_HQ_CRM_PP_WORKSPACE_ID` | Existing: the PP workspace the `pp` brand maps to. The `mhp` brand is the fixed MHP marketing workspace. |

At least one of the token or the secret must be set with the user id; a partial or
malformed configuration logs one warning and leaves the API off.

## Tools

Every tool takes `brand`: `pp` (Property Predator / Growth HQ) or `mhp` (Martin Howard
Property marketing workspace). Read tools, always offered:

| Tool | Returns |
|---|---|
| `workspace_overview` | Workspace, CRM stages, latest contacts, opportunities, tasks and timeline. |
| `crm_contacts` (`cursor`) | Contacts, newest first, paged. |
| `crm_pipeline` (`cursor`) | Stages and open opportunities with `rowVersion`. |
| `crm_tasks` (`filter` open/all/completed, `cursor`) | Tasks with `rowVersion`. |
| `crm_lead_360` (`contactId`) | The contact's full case file. |
| `webinars_list`, `webinar_get` (`id`) | Webinars and one webinar in full with `rowVersion`. |
| `webinar_registrants` (`id`, `limit`) | Registrants with consent and CRM link. |
| `webinar_results` (`id`), `webinar_messages` (`id`) | Attendance figures; email delivery status. |

Write tools, offered only when `R72_OPERATOR_WRITES=enabled` (otherwise hidden, and a
call answers that writes are disabled):

| Tool | Does |
|---|---|
| `crm_create_lead` | Contact + opportunity in a stage + optional first task. Idempotent per `commandKey`; a generated key is used when none is given. |
| `crm_move_opportunity`, `crm_complete_task` | Optimistic (`expectedRowVersion`) moves and completions. |
| `webinar_create`, `webinar_update`, `webinar_set_status`, `webinar_send_to_crm` | Create a draft, change fields (omitted fields keep their value), publish/unpublish/cancel/archive, send unlinked registrants to the CRM now. |

Results are the services' own JSON. A tool failure comes back as `isError: true` with a
plain sentence (the service's refusal), never a stack trace. Each call writes one log
line: tool, brand, ok or failed; arguments are not logged.

## Security model and limits

* Authority is the operator user's workspace membership, checked by the database on
  every delegated session; the API cannot widen it. Removing that user's ownership stops
  the operator immediately for new sessions (cached sessions are re-verified at least
  every five minutes and expire after twelve hours).
* OAuth tokens are stateless, signed blobs: access tokens live one hour, refresh tokens
  30 days, codes two minutes and are single use per process. There is no per-token
  revocation; rotating `R72_OPERATOR_OAUTH_SECRET` invalidates every issued token, and
  clearing `R72_OPERATOR_TOKEN` stops static access. Both take effect on restart.
* Redirect URIs must be `https://` (no fragment) or loopback `http://` for local MCP
  clients. Client ids are signed descriptions of the registered redirect URIs.
* The MCP endpoint shares the portal's per-process concurrency guard. Bodies are
  capped at 256 KB.
* Nothing is deployed by this change; the paths 404 until the settings exist.

Tests: `orchestrator/test/operator.test.ts` (config, tokens, OAuth, MCP, HTTP mount) and
`orchestrator/test/db/operator.integration.test.ts` (actual roles: delegated sessions,
CRM and webinar tools, non-owner refusals).
