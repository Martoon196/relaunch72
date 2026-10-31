# 29 · MHP webinar texts (009B): source candidate handoff

Written 31 Oct 2026. Truth ladder for this work:

| Stage | State |
|---|---|
| Source-complete | **Yes**, on `claude/009b-public-phone-programme` at `602fb5a1d15da7c26c8bcda916ab48c21659c3ed` |
| Independently reviewed | **Yes**: three passes by an independent agent; final verdict "ready for ratification as a source candidate" |
| Ratified (Astra) | **No** |
| Integrated into the release branch | **No** |
| Published / deployed / live | **No** |
| External effects caused by this work | **None** (no provider call, no production read or write) |

## Exact source

- Base: `cd8aa8f47b21ebe88b329de4bcc2814f1faf74e1`, tree `42429022f0f316c98c98bfd7489c6c893c882778` (live today).
- Release candidate code: `602fb5a1d15da7c26c8bcda916ab48c21659c3ed`, tree `d2220762ca7ccb35baf40af46f0504da5eb7372c`. The commit adding this note changes documentation only.
- Readiness bridge: `claude/009b-readiness-bridge` at `5bb62cb58aea92f80b962b4335f7f6ca79cce63c`, tree `4a9ae4ef9e13991530290de436c3d8f8cb704a13`
  (`cd8aa8f` plus one exact-0131 readiness allowance and its test; no behaviour change).
- Migration `0131_mhp_event_sms_programme.sql`, checksum `c3bf409ea54d4311d0c750ba58719db905988d21878c8760fe041f56d25ef278`.
- Built without the ratified `009B-SQL-DESIGN.md` (SHA `30486ff7…cbc7c`), which was not
  available to this session. Assumptions are listed in `docs/mhp-event-sms-programme.md`.

## Evidence

| Check | Result |
|---|---|
| Baseline full suite at `cd8aa8f` (this container) | 3641 pass / 0 fail / 41 skip |
| Full suite at `602fb5a1d15da7c26c8bcda916ab48c21659c3ed` | 3665 pass / 0 fail / 43 skip |
| Typecheck | pass |
| Supply-chain gate | pass (115 packages, SBOM current) |
| 0131 SQL contract tests | 7 / 0 |
| New unit tests (public, owner, worker) | 17 / 0 (24 including the SQL contract tests) |
| Disposable Postgres 16, all 131 migrations | applied cleanly |
| 0131 integration proof through real login roles | 2 / 2 (full path, plus a concurrent double-send race) |
| Bridge readiness tests | 26 / 0; bridge full suite 3642 / 0 / 41; live `cd8aa8f` readiness REJECTS a 131-row ledger, the bridge ACCEPTS it |
| Integration suite, local baseline at `cd8aa8f` | 60 pass / 5 fail / 1 skip |
| Integration suite at `602fb5a1d15da7c26c8bcda916ab48c21659c3ed` | 62 pass / 5 fail / 1 skip: the same five as baseline; the email-pilot test also flakes on timing in some runs |

The five baseline integration failures (company assets, Growth evidence, 0090/0091
Creator Watch, 0092 LinkedIn) exist on the untouched live commit in this local
Postgres and are outside SMS. `property-predator-email-pilot` flakes when run alone
(passes one run in three): it floors a webhook timestamp to whole seconds. Neither is
caused by 0131. The integration suite is not part of the 3641-test CI run. The repo's Linux CI has
not been run on these exact SHAs from this container; that is the first gate below.

## Key findings for Astra

1. **Delayed sending cannot be truthful on the unchanged rail.** The compliance
   permission receipt every send needs is valid for at most five minutes (0032 CHECK)
   and must be recorded by the operating owner (`begin_sms_live_call`). A worker
   sending later would have to write a fresh decision in the owner's name. This build
   therefore makes the owner's one exact-batch review the send. Scheduling needs a
   rail decision.
2. **0131 needs a bridge release first.** The web platform re-checks the schema on
   every `/ready` probe, so applying 0131 under `cd8aa8f` turns production `/ready`
   red at once. See the runbook.
3. **Daily cap.** 10 segments per day across the whole MHP connection, codes
   included; codes reserved at 3 a day and 15 a month. At most three new people
   can confirm a mobile each day. Raising caps is a founder decision.
4. **Accepted risks** recorded by the independent review are listed in
   `docs/mhp-event-sms-programme.md`.
5. **WhatsApp** is a separate candidate on `claude/009c-mhp-whatsapp` (handoff 30).

## Next owner

Astra (reconcile with the ratified design, ratify or reject), then Root (CI, publish,
bridge, migrate, deploy per the runbook below). Founder decisions remain: consent
wording, linking the public page, switching on codes, and every batch send.

## Release runbook

Status of this document: **prepared, not executed.** Nothing below has run against
production. Every step is for the release owner (Root) on the Windows host, after
independent review and Astra's ratification.

## Exact artifacts

| Artifact | Branch | Commit | Tree |
|---|---|---|---|
| Live today | `codex/relaunch72-platform-foundation` | `cd8aa8f47b21ebe88b329de4bcc2814f1faf74e1` | `42429022f0f316c98c98bfd7489c6c893c882778` |
| Bridge (code-only, tolerates exact 0131) | `claude/009b-readiness-bridge` | `5bb62cb58aea92f80b962b4335f7f6ca79cce63c` | `4a9ae4ef9e13991530290de436c3d8f8cb704a13` |
| 009B release candidate | `claude/009b-public-phone-programme` | `602fb5a1d15da7c26c8bcda916ab48c21659c3ed` | `d2220762ca7ccb35baf40af46f0504da5eb7372c` |

Migration `0131_mhp_event_sms_programme.sql` checksum: `c3bf409ea54d4311d0c750ba58719db905988d21878c8760fe041f56d25ef278`.

## Why there is a bridge

Every release's readiness check rejects a database ledger row it does not bundle.
The live release `cd8aa8f` has no allowance for 0131. The web platform re-runs this
check on **every** `/ready` probe (`postgres-platform.ts` `assertReady`), so applying
0131 under `cd8aa8f` would turn the live `/ready` red immediately; workers and
webhooks would fail on their next start.
The bridge is `cd8aa8f` plus one narrow allowance for exactly `c3bf409ea54d4311d0c750ba58719db905988d21878c8760fe041f56d25ef278`,
the same pattern used for 0121 through 0130. It changes no behaviour.

## Order

1. **Gates.** Independent review of `602fb5a1d15da7c26c8bcda916ab48c21659c3ed` and `5bb62cb58aea92f80b962b4335f7f6ca79cce63c`; Astra ratifies
   both and the 0131 SQL; Linux CI green on both exact SHAs.
2. **Publish** both branches through the exact-SHA API publisher.
3. **Deploy the bridge to every service that connects to this database and checks
   the ledger.** First read each service's currently deployed SHA. Known MHP ones:
   web `srv-da7fv1gn74is73d58hb0`, SMS worker `srv-dbj47567bikc73ecfdtg`,
   SMS webhook `srv-dbj4ceajnfac73c47530`. The production blueprint also defines
   `property-predator-growth-hq`, `-meta-whatsapp-live-worker`, `-meta-whatsapp-live-webhook`,
   `-customer-email-live`, `-email-worker`, `-owned-public-social-live`,
   `-twilio-sms-live` and `-twilio-sms-live-webhook`; every one of them enforces the
   ledger at start-up and must be on `5bb62cb58aea92f80b962b4335f7f6ca79cce63c` (or later) if it uses this database.
   Confirm each reports `5bb62cb58aea92f80b962b4335f7f6ca79cce63c`, both public `/ready` endpoints return 200 and
   worker ready logs are unchanged. Do not continue while any service is unbridged.
4. **Read-only check** on Neon `br-calm-surf-b22211ng`: `npm run db:check` must show
   exactly 130 applied with matching checksums.
5. **Apply 0131 only**: `npm run db:migrate` must report `1 applied, 130 already
   current`. Read back `app_private.schema_migrations` for 0131 and compare to
   `c3bf409ea54d4311d0c750ba58719db905988d21878c8760fe041f56d25ef278`. Bridge services stay ready throughout.
6. **Deploy `602fb5a1d15da7c26c8bcda916ab48c21659c3ed`** to every bridged service with both new switches unset
   (or, if WhatsApp is shipping in the same window, use handoff 30's order instead).
   Confirm `/ready` 200, the web log line `mhp.event-sms.readiness` shows
   `publicOptInMounted:false`, and the worker ready line shows
   `mhpEventCodesEnabled:false`.
7. **Smoke, no provider effect:** `GET https://app.martinhowardproperty.co.uk/webinar/texts`
   is not served (switch off). Existing owner phone-test page still shows
   "Sending blocked by an opt-out" for the founder's test number.
8. **Founder decision 1, web only:** set `MHP_EVENT_SMS_ENABLED=true` on the web
   service (it also needs the existing MHP SMS pilot settings and
   `DATABASE_SMS_COMMAND_URL`). The public page renders; the owner page
   `/hq/marketing/event-texts` loads with zero recipients. Still no texts can be
   sent: codes are off.
9. **Founder decision 2, worker:** first confirm in the Twilio console that Advanced
   Opt-Out is on for the MHP Messaging Service, and that the worker poll is 15000 ms
   or less. Then set `MHP_EVENT_SMS_TWILIO_ADVANCED_OPT_OUT_CONFIRMED=true` and
   `MHP_EVENT_SMS_CODES_ENABLED=true` on the SMS worker. From then on each public
   opt-in triggers one code text to the number the person typed, within the SQL
   budget of 3 codes a day and 15 a month (inside the 10/50 caps).
10. **Every event text is a founder action** on `/hq/marketing/event-texts`. Nothing
    sends on a schedule.

## Recovery

- Turn either switch off and redeploy: public page and codes stop at once.
- Roll code back to **`5bb62cb58aea92f80b962b4335f7f6ca79cce63c`**, never to `cd8aa8f`, once 0131 is applied.
- No down-migration, no deletion of opt-in or batch evidence, no clearing of STOP.

## Not covered

- Linking `/webinar/texts` from martinhowardproperty.co.uk or an email is the
  founder's content decision. The active email programme is untouched.
- Scheduled (delayed) sending needs a rail change; see the design note.

