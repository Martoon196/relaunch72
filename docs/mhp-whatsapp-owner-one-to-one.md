# MHP-WA-121 — Send WhatsApp from Martin Howard Property, for any brand's contact

Branch `claude/whatsapp-contact-send`, base `codex/relaunch72-platform-foundation` at `8411a0b` (schema 0150).
One additive migration, `0151_mhp_whatsapp_owner_one_to_one.sql`. Not deployed. Off until switched on.
Open decisions for Martin: `docs/design/mhp-whatsapp-owner-121-20261112/MHP-WA-121-DECISION-PROPOSALS.md`.

## What it does

From a CRM contact in Growth HQ (brand `pp`, `mhp`, `kp`, `piuk`, …), the owner can send one WhatsApp
message to that one person from the shared Martin Howard Property (MHP) number, and see the real
outcome on the contact:

1. **Link the number.** A phone/WhatsApp point on the contact (or a number the owner types) is linked to
   the MHP sender. The person is mirrored into the MHP workspace (or an existing MHP contact with the
   same WhatsApp number is reused). The original brand contact is never moved or edited.
2. **Record permission** through the existing 0063 founder rail (purpose `mhp.owner-one-to-one`):
   lawful basis (`consent` or `legitimate_interests`), evidence kind and a short note. If the person has
   never messaged the MHP number, the owner must also confirm "this is their WhatsApp number" — recorded
   as `owner_attested`, never as `is_verified`. Withdrawing is the same action with `withdrawn`.
3. **Send an approved template.** Templates come only from the worker's server-side read of the MHP
   WABA. Body variables (named `{{first_name}}` or positional `{{1}}`) are checked against the template's
   real placeholders; the server renders the exact text; the send must quote that preview's SHA-256, so
   what is sent is exactly what the owner confirmed.
4. **Free text** is offered only while the 24-hour window is open (the person messaged the MHP number in
   the last 24 hours) and goes through the unchanged 0143 reply queue.
5. **Outcome.** The worker sends at most one message per cycle. `accepted` only when Meta returned a
   `wamid` for exactly that recipient; then signed `sent`/`delivered`/`read`/`failed` receipts. Every step
   is an activity on the original brand contact and on the MHP contact. Meta restriction codes (368,
   131048, 131056, 131049, …) become holds that refuse new sends with a plain-English reason.

Idempotency: the Growth HQ request carries an `idempotencyKey` (UUID). The same key with the same
person, template, variables and preview returns the existing send (`replayed: true`); the same key with
anything different is `409 request_conflict`. A double submit sends once.

## Signed boundary contract (`POST /api/group-hq/inbox/crm`, same HMAC and scopes as today)

Every request: `actorEmail`, `brand`, `requestId` (UUID), `action`, plus the fields below. The actor must
be in the brand's scope **and** in the `mhp` scope; the call runs as the MHP owner
(`GHQ_MHP_WHATSAPP_OWNER_IDS[actorEmail]`, else the MHP scope owner) in the MHP workspace.

| action | fields | returns `result` |
|---|---|---|
| `whatsappOwnerState` | `contactId` | sender, daily cap, account hold, linked numbers (masked) with verification/permission/window/gate, CRM number candidates, last 20 sends with receipts |
| `whatsappOwnerTemplates` | — | current APPROVED templates: name, language, category, `parameterFormat`, `parameterNames`, `bodyText`, `previewText`, `sendable` / `unsupportedReason` |
| `whatsappOwnerPreview` | `metaTemplateId`, `variables` (object or array) | `text`, `sha256`, `parameters` or `{state:'refused', reason, message}` |
| `whatsappOwnerLink` | `contactId`, `pointId` **or** `number` | `linkId`, masked number |
| `whatsappOwnerPermission` | `contactId`, `linkId`, `commandId`, `decision` (`granted`/`withdrawn`), `lawfulBasis`, `evidenceKind`, `note`, `attestNumber` | state, consent event, verification |
| `whatsappOwnerSendTemplate` | `contactId`, `linkId`, `idempotencyKey`, `metaTemplateId`, `variables`, `previewSha256` | `queued` (+ `dailyRemaining`) or a refusal |
| `whatsappOwnerSendText` | `contactId`, `linkId`, `idempotencyKey`, `body` | `queued` or `window_closed` / other refusal |
| `whatsappOwnerStatus` | `sendId` | state, `providerMessageId` (wamid), `errorCode`, receipts |

Refusals are `{state:'refused', reason, message}` (HTTP 200) with a plain-English `message`; states carry
`stateLabel`; Meta codes carry `errorMessage`. Errors: 400 `invalid_request`, 403 `forbidden_scope`,
409 `request_conflict`, 409 `owner_send_unavailable` (switched off).

## Safeguards kept

0053 enqueue, the legacy owner-action caps, the 0141 event rail and every 0143 function are unchanged
(pinned by `mhp-event-whatsapp-legacy-compat.test.ts`). Owner template sends are a third 0053 authority
kind (`mhp_owner_direct`) with consent event, compliance subject, published owner review and PECR
sender/instigator routes, one authority and one job per send, a ten-minute authority, a fresh Meta read
right before begin-call, every gate re-proved at load and begin-call, the 0057 emergency pause, the 0053
lease/recovery rules (a begun call is never retried) and the shared 0053 settlement and signed status path.

## Deploy note for Codex (manual; autoDeploy is off)

Order matters: binaries first, then the migration, then the switches.

1. CI: `.github/workflows/ghq-inbox-crm-proof.yml` runs on this branch (typecheck, migration contract,
   boundary, WhatsApp transport/readiness suites, real-role integration including
   `test/db/mhp-wa-owner-one-to-one.integration.test.ts`). Merge only a green exact tree.
2. Deploy the exact tested commit to **HQ web**, **property-predator-meta-whatsapp-live-worker** and
   **property-predator-meta-whatsapp-live-webhook** *before* applying 0151. With 0151 pending, the
   readiness gate admits exactly this one pending file on top of the exact 0150 ledger; the owner actions
   answer `owner_send_unavailable` while `MHP_WHATSAPP_OWNER_SENDS` is unset.
3. Apply migration 0151 with the normal migration owner (`npm --prefix orchestrator run db:migrate`).
   It is additive. The released 0150 binaries stay ready after 0151 is applied.
4. Check `/ready` on HQ, and the worker and webhook readiness lines (the worker/webhook role boundaries
   admit the 0151 functions only when the exact 0151 checksum is in the ledger).
5. When Martin has ratified the proposals, set `MHP_WHATSAPP_OWNER_SENDS=enabled` on:
   - HQ web (Growth HQ boundary actions), which also needs an `mhp` entry in `R72_GROUP_HQ_INBOX_SCOPES`
     and the actor in it (and `GHQ_MHP_WHATSAPP_OWNER_IDS` if the MHP owner user differs);
   - the WhatsApp worker, which must already run the MHP mode
     (`PROPERTY_PREDATOR_WHATSAPP_MHP_EVENT_MODE=enabled`, `PROPERTY_PREDATOR_WHATSAPP_MHP_BINDING_ID`);
   - the WhatsApp webhook (records Meta's error code on failed statuses for owner sends).
   Then restart those services.
6. First real use is Martin's own decision, one person, from Growth HQ. Nothing in this release sends a
   message by itself.

Rollback: unset `MHP_WHATSAPP_OWNER_SENDS` everywhere (owner actions refuse, the worker skips owner jobs;
queued owner jobs expire after ten minutes and are recorded as `expired`, never sent). 0151 can stay
applied. Records already written stay as evidence.

Data volume: the template catalogue writes one row per template per refresh (every five minutes while
switched on). Add a retention job before large template libraries.

## Evidence on this branch (local, PostgreSQL 16, real roles)

- `test/db/mhp-wa-owner-one-to-one.integration.test.ts`: 2 pass (SQL rail end to end; Growth HQ
  service end to end under real login roles).
- Neighbours: 0053/0141/0143 contract, legacy-compat, direct inbox, Growth HQ inbox CRM, activation
  readiness — pass. `mhp-event-whatsapp.integration.test.ts` test 1 fails identically on the unchanged
  base (it still expects the pre-0143 `23503` for an unknown number); not caused by 0151.
- `npm --prefix orchestrator test`: all pass (database tests skip without the integration env).
