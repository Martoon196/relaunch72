# MHP-WA-121 — Send WhatsApp from Martin Howard Property, for any brand's contact

Branch `claude/whatsapp-contact-send`, base `codex/relaunch72-platform-foundation` at `8411a0b` (schema 0150).
One additive migration, `0151_mhp_whatsapp_owner_one_to_one.sql`. Not deployed. Off until switched on.
Open decisions for Martin: `docs/design/mhp-whatsapp-owner-121-20261112/MHP-WA-121-DECISION-PROPOSALS.md`.

## What it does

From a CRM contact in Growth HQ (brand `pp`, `mhp`, `kp`, `piuk`, …), the owner can send one WhatsApp
message to that one person from the shared Martin Howard Property (MHP) number, and see the real
outcome on the contact:

1. **Link the number.** A phone/WhatsApp point on the contact (or a number the owner types) is linked to
   the MHP sender. The original brand contact is never moved or edited.
   - *Who they are in MHP.* If exactly one MHP contact already carries that number (as a WhatsApp or phone
     point) or one of the original contact's e-mail addresses, that contact is reused and the number is
     added to it as an unverified WhatsApp point. If nobody matches, the person is mirrored (name and
     company only). If more than one MHP contact matches, the link is refused (`mhp_contact_ambiguous`:
     "merge them first") rather than adding a duplicate; a duplicate is what would later hold that
     person's webinar JOIN as `crm_ambiguous`. Residual: a person mirrored before MHP has ever seen their
     e-mail can still end up as two MHP contacts if another MHP flow later creates them by e-mail alone.
   - *Number forms.* `+44 (0)7700 900126` is read as `447700900126`; a UK number that still carries the
     trunk zero (`+4407700…`) is refused, never stored.
   - *The original brand can still say no.* Every phone/WhatsApp point of the original contact that
     carries the number counts, whether the owner picked the point or typed the number: an opt-out, or a
     current WhatsApp suppression (a WhatsApp STOP) on any of them, refuses the link, the queue and the
     send. It is read again at begin-call, so an opt-out recorded after queueing stops the send.
     From 0153 (owner rule: "any stop message only applies to that channel") an SMS STOP in the original
     brand no longer blocks a WhatsApp send; under 0151 it did. The point's own `consent_status='opted_out'`
     still blocks whatever channel it came from.
2. **Record permission** through the existing 0063 founder rail (purpose `mhp.owner-one-to-one`):
   lawful basis (`consent` or `legitimate_interests`), evidence kind and a short note. If the person has
   never messaged the MHP number, the owner must also confirm "this is their WhatsApp number" — recorded
   as `owner_attested`, never as `is_verified`. Withdrawing is the same action with `withdrawn`.
3. **Send an approved template.** Templates come only from the worker's server-side read of the MHP
   WABA. Body variables (named `{{first_name}}` or positional `{{1}}`) are checked against the template's
   real placeholders; the server renders the exact text; the send must quote that preview's SHA-256, so
   what is sent is exactly what the owner confirmed. Just before the call the worker re-reads the template
   from Meta: every component (header, body, footer, buttons) must be unchanged and the text rendered from
   the stored variables must still have the previewed SHA-256, otherwise nothing is sent (`preview_changed`).
   The rail keeps its own 0053 template row per Meta template id under a reserved name
   (`mhp_owner_121__<id>`), so an owner send never takes the real template name that a webinar programme
   pins when it is activated.
4. **Free text** is offered only while the 24-hour window is open (the person messaged the MHP number in
   the last 24 hours) and goes through the unchanged 0143 reply queue. It obeys the existing
   `MHP_WHATSAPP_MANUAL_REPLIES` switch exactly as the inbox reply does: without it on the web service the
   action answers 409 `reply_unavailable` and nothing is queued.
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
| `whatsappOwnerLink` | `contactId`, `pointId` **or** `number` | `linkId`, masked number, `mirrorCreated`, or a refusal (`opted_out`, `mhp_contact_ambiguous`, `number_not_international`, …) |
| `whatsappOwnerPermission` | `contactId`, `linkId`, `commandId`, `decision` (`granted`/`withdrawn`), `lawfulBasis`, `evidenceKind`, `note`, `attestNumber` | state, consent event, verification |
| `whatsappOwnerSendTemplate` | `contactId`, `linkId`, `idempotencyKey`, `metaTemplateId`, `variables`, `previewSha256` | `queued` (+ `dailyRemaining`) or a refusal |
| `whatsappOwnerSendText` | `contactId`, `linkId`, `idempotencyKey`, `body` | `queued` or `window_closed` / other refusal; 409 `reply_unavailable` unless `MHP_WHATSAPP_MANUAL_REPLIES=enabled` |
| `whatsappOwnerStatus` | `sendId` | state, `providerMessageId` (wamid), `errorCode`, receipts |

Refusals are `{state:'refused', reason, message}` (HTTP 200) with a plain-English `message`; states carry
`stateLabel`; Meta codes carry `errorMessage`. Errors: 400 `invalid_request`, 403 `forbidden_scope`,
409 `request_conflict`, 409 `owner_send_unavailable` (switched off), 409 `reply_unavailable` (free text
while manual replies are switched off).

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
2. Deploy the exact tested commit to **HQ web** and to **every WhatsApp worker and every WhatsApp webhook
   that uses this database, for Martin Howard Property and for Property Predator** (in the blueprint:
   `property-predator-meta-whatsapp-live-worker` and `property-predator-meta-whatsapp-live-webhook`, plus
   any other service that logs in as `r72_whatsapp_live_worker_command` or
   `r72_whatsapp_live_webhook_command`) *before* applying 0151, and confirm each one is live on that exact
   commit. With 0151 pending, the readiness gate admits exactly this one pending file on top of the exact
   0150 ledger; the owner actions answer `owner_send_unavailable` while `MHP_WHATSAPP_OWNER_SENDS` is unset.
   **This order is not optional.** 0151 grants the worker and webhook roles new functions, and a WhatsApp
   worker or webhook build from before this commit checks at start-up that its role can run nothing beyond
   its own list. Once 0151 is applied such a build fails that check ("database boundary is not exact") the
   next time it starts, which would stop webinar follow-ups, inbox replies and STOP intake. Other services
   (web, SMS, e-mail, social, SEO) only read the migration ledger, and their released 0150 builds stay
   ready after 0151.
3. Apply migration 0151 with the normal migration owner (`npm --prefix orchestrator run db:migrate`).
   It is additive and runs in one transaction. It sets `lock_timeout` to five seconds: if it cannot get its
   brief locks on the shared tables behind live traffic it fails cleanly, having changed nothing; run it
   again. **After 0151 is applied, roll forward only:** never roll a WhatsApp worker or webhook back to a
   build from before this commit (see step 2). There is no down migration.
4. Check `/ready` on HQ, and the worker and webhook readiness lines (the worker/webhook role boundaries
   admit the 0151 functions only when the exact 0151 checksum is in the ledger).
5. When Martin has ratified the proposals, set `MHP_WHATSAPP_OWNER_SENDS=enabled` on the three services
   below. The value must be exactly `enabled`: anything else (unset, empty, `true`, a typo, stray spaces)
   means off, and no value of this switch can stop a service from starting. Before switching on, confirm
   **`MHP_EVENT_WHATSAPP_INBOUND=enabled` on the WhatsApp webhook**: a person's STOP reply is recorded (and
   then refuses every later owner send, at queue and at begin-call) only through that signed JOIN/STOP
   path. Free text additionally needs the existing `MHP_WHATSAPP_MANUAL_REPLIES=enabled` on HQ web and on
   the worker. Set the owner switch on:
   - HQ web (Growth HQ boundary actions), which also needs an `mhp` entry in `R72_GROUP_HQ_INBOX_SCOPES`
     and the actor in it (and `GHQ_MHP_WHATSAPP_OWNER_IDS` if the MHP owner user differs);
   - the WhatsApp worker, which must already run the MHP mode
     (`PROPERTY_PREDATOR_WHATSAPP_MHP_EVENT_MODE=enabled`, `PROPERTY_PREDATOR_WHATSAPP_MHP_BINDING_ID`);
   - the WhatsApp webhook (records Meta's error code, and any pause it calls for, on failed statuses for
     owner sends; also when Meta delivers the same signed status again).
   Then restart those services.
6. First real use is Martin's own decision, one person, from Growth HQ. Nothing in this release sends a
   message by itself.

Rollback: unset `MHP_WHATSAPP_OWNER_SENDS` everywhere; 0151 stays applied (roll forward only, step 3).
Owner actions then refuse and the worker neither claims nor sends owner jobs. What happens to sends
already queued:

- A queued template send can only be handed to Meta while its ten-minute authority is current (the claim
  and begin-call both check it), so with the worker switch off it is never sent. It is *shown* as
  `expired` and stops counting against the daily limit and the 24-hour pacing as soon as the ten minutes
  pass. The stored row, its cancelled job and the "expired" activity on the contact are written by
  whichever comes first: the worker's next owner claim (switch on), or the owner's next queue attempt on
  the web service. With every switch off nothing writes them; the row stays `queued` in the table, still
  unsendable, until one of those runs.
- A send whose Meta call had already begun is never called expired. When its lease lapses the same two
  paths record it as `outcome_unknown` ("not confirmed by Meta — check before resending"), and it keeps
  counting against the limit and the pacing.
- A queued free-text reply is sent only by a worker with `MHP_WHATSAPP_MANUAL_REPLIES=enabled`, and only
  while the 24-hour window is still open; otherwise that worker records it as expired.

Records already written stay as evidence.

Data volume: the template catalogue keeps one row per distinct content Meta has returned for a template.
The five-minute refresh (and the read before each send) updates `observed_at`/`expires_at` on that row
when nothing changed; a new row is written only when the template's status, text or components change.

## Evidence on this branch (local, PostgreSQL 16, real roles)

- `test/db/mhp-wa-owner-one-to-one.integration.test.ts`: 3 pass (SQL rail end to end; Growth HQ
  service end to end under real login roles; safeguards: original-brand opt-out at link, queue and
  begin-call, number forms and STOP, unchanged-template refresh, exact previewed message, expiry with
  no worker).
- `test/db/mhp-event-whatsapp.integration.test.ts`: 4 pass, including "owner one-to-one first": the same
  template then activates for the webinar and that person's JOIN is not held as ambiguous.
- Neighbours: 0053/0141/0143 contract, legacy-compat, direct inbox, Growth HQ inbox CRM, activation
  readiness — pass. The stale pre-0143 assertion in `mhp-event-whatsapp.integration.test.ts` (it expected
  `23503` for an ordinary message from an unknown number, which 0143 now receives into the direct inbox)
  is corrected, so the whole webinar flow runs again, and the file is part of the CI gate.
- `npm --prefix orchestrator test`: all pass (database tests skip without the integration env).
