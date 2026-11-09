# 009B/009C open decisions — proposals for Astra (1 November 2026)

PROPOSALS ONLY. Nothing here is implemented, ratified or authorised. These answer the three open items in
`009B-009C-OPEN-DECISIONS.md` so Astra can record a decision. The 009B source candidate on
`claude/009b-r3` keeps the existing behaviour for each open item and says so; it does not
pre-empt these decisions.

## 1. Signed SMS STOP from a number with no contact point (implemented in the second round, 1 November 2026)

**Status:** Astra asked for this as a bounded fix; it is implemented on `claude/009b-r3` (SMS, 0131) and `claude/009c-r3` (WhatsApp, 0132) as described in the two R3 handoffs. The implemented shape differs from the text below in three small ways: the table is `app_private.mhp_unlinked_opt_events` with a `channel` column shared by both channels under per-channel RLS; the key is the same phone digest the intents use (sha256 of the E.164 number); and the unlinked `stop` is not copied onto a later point, because a JOIN is held while the latest event is `stop`, so a point can only be created after a signed START. The original proposal follows for the record.


**Today (0056 and the 009B candidate unchanged):** `record_sms_live_inbound_projection` requires
a verified contact point. A signed STOP from any other number raises `23503`, the webhook answers 503,
and nothing durable is written in our database. Separately, Twilio's default Messaging Service
opt-out handling refuses later sends from that service to a number that replied STOP (provider error
21610). That is a provider-side safety net, not our evidence.

**Where 009B can meet it:** a registrant who chose a number but has not yet texted JOIN, or whose
JOIN was held, can reply STOP before any contact point exists.

**Proposal (smallest key, no contact created):**
- New append-only `app_private.sms_signed_unlinked_opt_events`, written by
  `r72_sms_definer` in webhook context only. Columns: the workspace, connection and binding;
  `provider_event_id`, unique per connection; `phone_identity_sha256` = sha256 of the E.164 number,
  the same digest `mhp_event_phone_intents` uses; `opt_evidence` (`stop` or `start`); the payload,
  signature, body and event-identity digests; and the occurred and recorded timestamps.
  No contact, no point, no message body, no task.
- `mhp_record_event_sms_inbound` (and only it) catches the projection's `23503` for
  `opt_evidence IN ('stop','start')` and appends this row. All other unknown-sender texts keep the
  existing refusal.
- Effect: a pending event intent for that number moves to `held/suppressed`. A later JOIN for that
  number is refused while the latest unlinked event is `stop`. The event eligibility check (prepare
  and begin) also refuses a point whose phone digest has a latest unlinked `stop`. A signed START
  appends `start` and releases only this unlinked key, never a manual or legal suppression.
- When a point is later created for that number (signed JOIN), the latest unlinked `stop` is
  copied once as a normal NULL-purpose suppression event for that point. The existing gates then
  apply unchanged.
- No change to 0056 function bytes. The legacy owner path never sees the new table, and the
  existing unknown-number behaviour for ordinary texts is preserved.

## 2. WhatsApp STOP projection (0055) (implemented; linked behaviour accepted in principle by Astra)

**Status:** the linked WhatsApp STOP is implemented in 0132 and accepted in principle. The unlinked WhatsApp STOP is implemented in the second round using item 1's table with `channel='whatsapp'`; WhatsApp has no START release in this packet (a linked WhatsApp STOP has none either).


**Today:** `record_whatsapp_live_inbound_projection` (0055) writes no suppression or consent
withdrawal for a WhatsApp "STOP". It is projected as an ordinary inbound message.

**Proposal:** do not change 0055 bytes.
- A 009C wrapper `mhp_record_event_whatsapp_inbound` (`r72_whatsapp_live_webhook`), the same shape
  as the SMS wrapper, recognises the WhatsApp STOP keywords after the existing signed projection.
- It appends a `channel='whatsapp'`, NULL-purpose suppression and a withdrawal of the event
  WhatsApp grant for that point.
- An unlinked WhatsApp STOP uses the item 1 table keyed by the WhatsApp sender digest with
  `channel='whatsapp'`.
- SMS STOP never writes WhatsApp suppression, and WhatsApp STOP never writes SMS suppression. The
  two channels are tracked separately; neither opt-out is inferred from the other.

## 3. Meta template read and token custody (implemented; accepted in principle by Astra)

**Status:** implemented as a worker-only, WABA-specific read: `GET /v24.0/{waba-id}/message_templates?name=<name>&fields=id,name,language,status,category,components&limit=50`, matched by template id, so the template must belong to this sender's own WhatsApp Business Account. Any header, footer or button makes the body digest unmatchable. Since the second round a failed read is itself recorded as a `READ_FAILED` observation and the worker never begins a call without a fresh successful read. The text below is the original proposal.


**Proposal:**
- **Operation:** `GET https://graph.facebook.com/v21.0/{template-id}?fields=id,name,language,status,category,components`
  for template ID `1441099094827445`.
- **Caller:** only the WhatsApp worker process (`property-predator-meta-whatsapp-live`). Never the
  web process, never the browser.
- **Token:** a Meta system-user token scoped to the MHP WABA with `whatsapp_business_management`
  (read), held only as that worker's secret. Rotation follows the existing provider-secret
  procedure. The token is never logged, stored in the database or shown to the owner.
- **Evidence:** a worker-only function `record_whatsapp_template_observation` appends an immutable
  row. It records template id, name, language and category, and the status Meta returned
  (`APPROVED` required). It also records `components_sha256`, the canonical body text hash and
  parameter count, the response digest, and `observed_at`. Expiry is 15 minutes.
- **Use:** owner activation and each begin require a current `APPROVED` observation whose body hash
  equals the approved local WhatsApp draft. An owner-typed reference or "approved" tick is never
  accepted. A non-approved, paused or changed template holds unprepared work.

## 4. Caps (decision for Astra and the founder)

No increase is proposed by Claude:
- WhatsApp stays at 1 send a day and 3 a month per workspace (0053).
- SMS stays at 10 segments a day and 50 a month per connection (0056).

With those caps the 009C follow-up journey can serve at most 3 owned or allow-listed recipients a
month. A larger audience needs an explicit founder and Astra cap decision. The code would then
change only the constants and their tests.
