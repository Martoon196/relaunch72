# 009B (agreed design) source candidate — cutover and recovery procedure

Candidate only. Nothing here has been deployed, migrated or sent. Root performs every step below
after Astra ratifies the exact SHAs; each step is gated on the one before it.

## Exact identities

| Item | Value |
|---|---|
| Live base | `ea1903f` (130 migrations; 0130 sha256 `e6bb5be3…5b239797`) |
| Design | `1e28980:docs/design/mhp-webinar-multichannel-20261031/009B-SQL-DESIGN.md` sha256 `30486ff7…cbc7c` |
| Candidate branch | `claude/009b-r3` (see the handoff for the final head SHA) |
| New migration | `0131_mhp_event_phone_programme.sql`, see the handoff for its final sha256 |
| Readiness bridge | `claude/009b-r3-readiness-bridge` = `ea1903f` plus an allowance for that exact 0131 only |
| Switches, all default OFF | `MHP_EVENT_PHONE_PUBLIC`, `MHP_EVENT_PHONE_OWNER` (web), `MHP_EVENT_PHONE_INBOUND` (SMS webhook), `PROPERTY_PREDATOR_SMS_MHP_EVENT_MODE` (SMS worker); each takes the value `enabled` |

## Cutover (ordered; stop at any red)

1. **Bridge fleet.** Publish and deploy the bridge build to web, SMS worker and SMS webhook.
   - Behaviour is identical to `ea1903f`.
   - `/ready` stays green on 130 and would stay green on 130 + exact 0131.
   - Smoke-test the email capture, the owner email and the 009A owned SMS pages.
2. **Migration.** Apply 0131 with the guarded migrator (`DATABASE_MIGRATOR_URL`) only after step 1
   is verified live. Read back:
   - `runtime_schema_migrations` row 131 has the exact checksum;
   - `has_function_privilege` for each login role matches `sms-live-pg/readiness.ts`;
   - the runtime roles are still table-blind;
   - no `delivery_channel='sms'` rows exist yet.
   The bridge fleet stays ready.
3. **Candidate build.** Deploy `claude/009b-r3` with every switch still OFF.
   - `/ready` green on exact 131.
   - Email capture, the owner email, sequences and the 009A owned test are unchanged.
   - The legacy SMS worker claims nothing new.
4. **Webhook first.** Set `MHP_EVENT_PHONE_INBOUND=enabled` on the SMS webhook. Its start-up
   proves the wrapper EXECUTE boundary. Ordinary inbound and STOP keep working; JOIN is inert
   until an intent exists.
5. **Owned acceptance on a near-term TEST programme**, never a faked clock in production.
   1. Set `MHP_EVENT_PHONE_OWNER=enabled` and `MHP_EVENT_PHONE_PUBLIC=enabled` on web, and
      `PROPERTY_PREDATOR_SMS_MHP_EVENT_MODE=enabled` on the SMS worker. Leave the existing
      `PROPERTY_PREDATOR_SMS_LIVE_*` safety switches as ratified for 009A.
   2. The owner saves and approves a programme whose `dueAt` is a few minutes ahead. Its campaign
      must be one that has the owner's own registration.
   3. The owner requests the email link, opens it, chooses their own mobile and texts JOIN. They
      then review a batch containing only themselves and schedule it.
   4. Observe: no authority or job exists before the due time. At the due time there is exactly one
      `mhp_event` authority and one worker-provenance job, then `calling` and then
      `awaiting_receipt`, and the handset receives exactly one text. Reply STOP, then confirm event
      withdrawal and suppression.
6. **Real 4 November programme.** Only after step 5 is accepted, the owner saves and approves the
   real programme (`dueAt` 2026-11-04T18:30:00Z, `providerDeadline` at or before 19:30Z) and opens
   public entry. Each batch is a separate owner review within the unchanged caps of 10 segments a
   day and 50 a month.
   - With caps at 10/day, at most 10 one-segment reminders fit on 4 November. Any larger audience
     needs a cap decision first.

## Recovery

- **Stop new admission:** unset `MHP_EVENT_PHONE_PUBLIC` (no new link, choose or JOIN pages).
- **Stop scheduled sending:** run `mhp_hold_event_sms()` as `r72_sms_worker_command`.
  - It holds every unprepared calendar row and cancels queued event jobs.
  - It reports leased, calling, awaiting and needs-attention counts truthfully.
  - Then unset `PROPERTY_PREDATOR_SMS_MHP_EVENT_MODE`.
  - The 009A owner rail, email and inbound STOP stay up.
- **In-flight or unknown:** a job in `calling` or `awaiting_receipt` is never retried. Reconcile it
  only against its exact lease and Twilio receipt (existing 0056 procedure).
- **Inbound:** unset `MHP_EVENT_PHONE_INBOUND` to return to the exact 0056 projection. JOIN texts are
  then ordinary inbound.
- **Code rollback:** redeploy the bridge build. It stays ready on 131. Nothing new is created,
  because the old code calls only the owner-kind functions, which 0131 fenced.
- **Never** do any of the following:
  - run a down-migration;
  - delete or alter intents, receipts or consent events;
  - renew an authority;
  - catch up after the deadline;
  - mark a held or cancelled pre-materialised delivery as sent or unknown.
  Reserved deliveries without a job stay reserved and are reported as not sent.

## Evidence still owed before live use

- Astra ratification of the exact SHAs and the open decisions in
  `009B-009C-DECISION-PROPOSALS-R3.md`. Unlinked STOP is a release blocker.
- Independent review of the exact final head.
- The step 5 owned acceptance, and production read-back for steps 1–4.
