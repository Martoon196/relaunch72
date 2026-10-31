# 30 · MHP WhatsApp owner test (009C): source candidate handoff

Written 31 Oct 2026. Stacked on handoff 29 (009B webinar texts).

| Stage | State |
|---|---|
| Source-complete | **Yes**, on `claude/009c-mhp-whatsapp` at `ae87d135ba319a2d6c903e38e7b77d34b974077a` (tree `64b3068feb67bb05ca5865cabb22882e6e6822fb`) |
| Independently reviewed | **Yes**: independent agent review; verdict "ready for ratification as a source candidate"; its two medium findings fixed, low findings fixed or recorded |
| Ratified (Astra) | **No** |
| Integrated / published / deployed / live | **No** |
| External effects caused by this work | **None** |
| Meta prerequisites | **Not done**: founder walkthrough (see `docs/mhp-whatsapp-owner-test.md`) |

## Exact source

- Base: the 009B candidate `602fb5a1d15da7c26c8bcda916ab48c21659c3ed`.
- Migration `0132_mhp_owned_whatsapp_pilot.sql`, checksum `8b49aee27155955002bd303c16d9e2ad079fb6fbf09bf78b4e2cb2c4ccd8138a`.
- Second bridge: `claude/009c-readiness-bridge` at `1c24c2b27b14ce8dbf46d6c617dc8f0752ac13c4` (tree `4fedee6aeb4e0b17ca3503e89e5f9e47af33c09b`) =
  the 009B candidate plus one allowance for exactly 0132. Deploy this instead of the
  plain 009B candidate in handoff 29's step 6, so 0132 can be applied later with no
  red `/ready`.

## Evidence

| Check | Result |
|---|---|
| Full suite at `ae87d135ba319a2d6c903e38e7b77d34b974077a` | 3676 pass / 0 fail / 44 skip |
| Typecheck, supply-chain gate | pass, pass |
| 0132 contract + exact repair compatibility | 5 / 0 |
| WhatsApp unit tests (seal tool, service, page) | 6 / 0 |
| Disposable Postgres, all 132 migrations | applied cleanly |
| 0132 integration proof through the real WhatsApp login roles | 1 / 1: connect, pin, owned send, 1/day cap, replay, worker claim, lease recovery, unchanged pre-call check |
| Integration suite | 62 pass / 6 fail / 1 skip: the five baseline failures plus the known email-pilot timing flake |
| Bridge 2 | full suite 3666 / 0 / 43; the 009B candidate REJECTS a 132-row ledger, bridge 2 ACCEPTS it |

## Key findings

1. **The 0053 WhatsApp rail could never have worked.** Latent defects found by
   running it for the first time. Two are repaired: template names were bounded with `{0,511}` (over
   PostgreSQL's 255 limit), and `claim_whatsapp_live_job` had three ambiguous
   references (the defect 0130 R8 fixed for SMS). Both are repaired exactly in 0132,
   with tests proving nothing else changed. A third (`'^\\+'` never strips a plus,
   so CRM-style `+44` WhatsApp points are invisible to the rail) is declared and
   worked around, not repaired; it belongs in the audit backlog. Property Predator's
   dark WhatsApp rail shares all three.
2. **No public WhatsApp yet.** Inbound STOP is never recorded as a suppression by the
   unchanged 0055 projection. That rail change must come before any non-owner
   WhatsApp recipient.
3. **The access token never reaches the web app.** It is sealed off-web by
   `mhp:whatsapp:seal` (stdin only) where the worker's key lives.

## Release order (after handoff 29 phase A, with bridge 2 deployed)

1. Gates: independent review, Astra ratification, Linux CI green on `ae87d135ba319a2d6c903e38e7b77d34b974077a` and `1c24c2b27b14ce8dbf46d6c617dc8f0752ac13c4`.
2. Founder Meta steps 1–4 (template Approved, number registered, system user access, token).
3. Create the two MHP WhatsApp Render services (worker, webhook), both dark.
4. `db:check` shows 131; `db:migrate` applies exactly 0132; read back `8b49aee27155955002bd303c16d9e2ad079fb6fbf09bf78b4e2cb2c4ccd8138a`.
5. Deploy `ae87d135ba319a2d6c903e38e7b77d34b974077a` to every service that checks the ledger. Web gets
   `DATABASE_WHATSAPP_LIVE_COMMAND_URL` and `MHP_WHATSAPP_PILOT_ENABLED=true`.
6. Founder runs the seal tool with Root on the worker host, pastes the sealed text
   on `/hq/marketing/whatsapp`, then pins the approved template.
7. Set the worker's connection id and the webhook's binding id from the sealed text;
   founder Meta step 5 (webhook subscription).
8. Only with the founder's explicit approval of one test: switch the worker and
   webhook live, then set `MHP_WHATSAPP_WORKER_LIVE_CONFIRMED=true` on web, then
   press Send once. Confirm delivery and a signed inbound reply.

Recovery: switches off; roll code back to `1c24c2b27b14ce8dbf46d6c617dc8f0752ac13c4` (never earlier) once 0132 is
applied; no down-migration.
