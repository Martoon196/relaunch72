# Operator API: Relaunch72 over MCP for Claude

The orchestrator speaks the Model Context Protocol (MCP) at
`https://hq.propertypredator.com/api/operator/mcp`, so Claude (a claude.ai custom connector,
Claude Desktop or Claude Code) can read and, when a deployment switches it on, change CRM,
webinar and follow-up data for both brands. Every call acts as **one configured portal user**
through a delegated session (migration 0147's `create_group_hq_delegated_session`), so the same
row-level security and ownership checks the portal applies decide what the operator can see and
do. Nothing reaches outside the two brand workspaces, and no token, secret or password is ever
returned by a tool.

The server is Streamable HTTP, stateless and JSON only: `POST` JSON-RPC 2.0 (one request or a
batch of up to 20), notifications get `202`, `GET` is `405`. It is mounted on the canonical
Property Predator host only, and only when the settings below are set; otherwise its paths return
404. Source: `orchestrator/src/operator/`.

## Two ways to connect

**claude.ai custom connector (OAuth).** Add a custom connector with the URL
`https://hq.propertypredator.com/api/operator/mcp`. claude.ai reads
`/.well-known/oauth-protected-resource`, registers itself at `POST /api/operator/oauth/register`
and opens `/api/operator/oauth/authorize`. Sign in to Growth HQ as the operator account (same tab
or another), press **Continue** if asked, read the consent page and press **Allow**. Needs
`R72_OPERATOR_OAUTH_SECRET` and migration 0148. Only the configured operator user can grant
consent; any other portal user is refused.

**Claude Code or Claude Desktop (static bearer).** Needs `R72_OPERATOR_TOKEN` (0147 only):

```bash
claude mcp add --transport http relaunch72 https://hq.propertypredator.com/api/operator/mcp --header "Authorization: Bearer <the R72_OPERATOR_TOKEN value>"
```

## Settings (web service; names only, never values)

| Name | Purpose |
|---|---|
| `R72_OPERATOR_USER_ID` | The portal user every operator call acts as. Must be an active owner or admin of the PP workspace and, for MHP, the MHP marketing owner. Required. |
| `R72_OPERATOR_OAUTH_SECRET` | Signs registered client ids (32–256 characters). Needed for claude.ai. |
| `R72_OPERATOR_TOKEN` | Static bearer for Claude Code / Desktop (32–256 characters, different from the secret). Optional. |
| `R72_OPERATOR_WRITES` | `enabled` offers the write and draft tools. Anything else (default) is read only. |
| `R72_GROUP_HQ_CRM_PP_WORKSPACE_ID` | Existing: the PP workspace the `pp` brand maps to. The `mhp` brand is the fixed MHP marketing workspace. |

## Tools

Every CRM, webinar and follow-up tool takes `brand`: `pp` or `mhp`.

Read tools, always offered: `workspace_overview`, `crm_contacts`, `crm_pipeline`, `crm_tasks`,
`crm_lead_360`, `webinars_list`, `webinar_get`, `webinar_registrants`, `webinar_results`,
`webinar_messages`, `followups_overview`, `followup_sequence_get`, `followup_sequence_check`,
`owner_emails_overview`, `owner_email_get`, `owner_email_preview`.

Write and draft tools, only with `R72_OPERATOR_WRITES=enabled`: `crm_create_lead`,
`crm_move_opportunity`, `crm_complete_task`, `webinar_create`, `webinar_update`,
`webinar_set_status`, `webinar_send_to_crm`, `followup_sequence_save_draft`,
`owner_email_save_draft`.

### Follow-up sequences and owner emails

Post-webinar sequences (MHP) and owner follow-up flows (PP) are written as plain steps and
converted to the exact stored definition, which the existing services validate in full:

```json
{ "title": "After the land webinar", "entry": "webinar_signup", "retryWindowHours": 48,
  "stopOn": { "reply": false, "booked": false, "purchased": false },
  "steps": [
    { "email": { "subject": "Thanks for joining, {{FIRSTNAME}}", "body": "Replay: {{LINK}}\n\n{{UNSUBSCRIBE}}" } },
    { "wait": { "days": 2 } },
    { "sms": { "body": "Questions, {{FIRSTNAME}}? {{LINK}}" } },
    { "saved": { "channel": "email", "contentItemId": "…", "contentVersionId": "…", "contentSha256": "…" } }
  ] }
```

`followup_sequence_get` returns a saved sequence in the same shape (with each message's current
text), so Claude can edit and resubmit it; `replaces` on an email or SMS step writes a new version
of a message already in the sequence. `followup_sequence_check` renders, lays out the timeline,
lists blockers and simulates a recipient without saving.

**What Claude cannot do, by design:** publish (approve) a sequence or email, enrol anyone, switch
on automatic webinar entry, schedule a send or send a test. Those are the owner's explicit
approval and stay in the portal (`/hq/marketing/sequences`, `/hq/marketing/emails` on the MHP host;
`/portal/follow-ups` on PP). Every draft result says so and links there.

## OAuth design (migration 0148)

Registered client ids are signed, stateless descriptions of their redirect URIs (registration is
unauthenticated and must not grow a table). Codes, access tokens and refresh tokens are opaque
random values; only their SHA-256 hashes are stored, through security-definer functions on
`r72_identity_command`:

- a **code** lives two minutes and is redeemed once **across every instance**: redemption locks
  its row, and a second presentation revokes the connection the first one created;
- a **refresh** rotates: the presented token is spent and a new pair issued. Presenting a spent
  token again, or one with another client's id, revokes the whole connection;
- **access tokens** (one hour) are resolved against the database on every MCP call, so a revoked
  connection or a suspended user stops at once.

Revocation: the owner's **Connected apps** page (`/api/operator/connections`, linked from the
consent page), RFC 7009 `POST /api/operator/oauth/revoke` by the client, suspending the user, or
rotating `R72_OPERATOR_OAUTH_SECRET` (every registered client must register again). A network retry
of a refresh whose answer was lost presents a spent token and ends the connection; the connector
asks for consent again. That is deliberate.

## Release and recovery

- 148 is ready with exactly 0148 pending on the applied 147 ledger (OAuth routes 404 until it is
  applied; the static bearer works on 0147 alone) and after 0148.
- **Recovery:** the released 11a1045 refuses a ledger with 0148 applied. The prepared recovery
  build is branch `claude/recovery-147-admits-0148` (`9feee4c`): 11a1045 plus one readiness clause
  admitting exactly the reviewed 0148. Never roll back to an older binary.
- CI gate: `.github/workflows/operator-api-proof.yml` (typecheck, supply chain, unit and contract
  tests, actual-role integration with two pools racing one code, and the recovery proof
  `scripts/operator-oauth-recovery-proof.mjs` on a real 148 ledger).
