# 009B + 009C r3 — handoff to Astra for ratification (1 November 2026)

> **Second round (resubmission, 1 November 2026).** Astra reviewed 009B `e072627` and 009C `6b6515a`, found the earlier design gaps corrected, and asked for four bounded fixes. All four are implemented, tested and pushed. **Still not deployed.** The first-round record below is kept unchanged under it for history; the new exact SHAs are in the table immediately below.

## 0. Resubmission: what Astra asked for, what changed, and the exact new SHAs

| | Branch | Full SHA |
|---|---|---|
| **009B SMS candidate** | `claude/009b-r3` | `76fe4d8f5f0d691c52e58ec8f77f5970c272af61` |
| 009B readiness bridge (`ea1903f` + exact new 0131) | `claude/009b-r3-readiness-bridge` | `5fc870192be36feae5b3ca24366b5fffe512e770` |
| **009C WhatsApp candidate** (descends from the 009B head) | `claude/009c-r3` | `a0c9c9e46c18c68515abaa9e74f16c62e9448dce`, plus the docs-only commit that adds this section |
| 009C readiness bridge (009B head + exact new 0132) | `claude/009c-r3-readiness-bridge` | `cfd7491781fff8fca5ccc754394daca00f0ea6aa` |

| Migration | Second-round sha256 | First round |
|---|---|---|
| `0131_mhp_event_phone_programme.sql` | `b117e3d267640f58ee41e4d32a7d9f936e9e4add5d91ea1e921cc88051312c14` | `8ad7b48e…` |
| `0132_mhp_event_whatsapp_programme.sql` | `25f63660ee2148c6ff949cb97b2c791c6e560df5ccdc7d718c286566dd10cbc0` | `ad09a7f2…` |

Both migrations were amended in place: neither had been applied anywhere but the disposable test database. Every pin (ledger tests, both bridges) is updated, and the merge of 009B into both 009C branches carries byte-identical 009B files.

**1. A signed STOP is recorded durably even when the number is not yet linked to a contact; JOIN and scheduled sends honour it.**
- New append-only `app_private.mhp_unlinked_opt_events` (0131), keyed by `channel` and the phone digest the intents already use. It stores provider ids, the evidence (`stop`, or `start` for SMS), the four digests, the recording role and the time. No contact, no point, no body. UPDATE and DELETE are refused.
- SMS (0131): when the projection reports an unknown sender and the message is a signed STOP or START, the wrapper appends the row and answers `unlinked_stop` / `unlinked_start`; pending JOIN intents for that number are held; a later JOIN is held; a signed START releases only this key. Other unknown-sender texts keep the existing refusal.
- WhatsApp (0132): the same for a signed WhatsApp STOP (channel `whatsapp`; no START release, consistent with the linked WhatsApp STOP).
- Enforcement is in the **grant tuple**, the one gate review, activation, prepare and begin already use for a linked suppression; a held step reads `receipt_changed`. Per-channel RLS: the SMS definer sees only `sms` rows, the WhatsApp definer only `whatsapp` rows. Neither opt-out is inferred from the other.
- Proved under real roles in both integration tests (record, replay, pending JOIN held with no point, later JOIN held, START then JOIN granted (SMS), ordinary unknown text still refused, cross-channel key ignored, owner review dropping the registrant, the worker prepare race holding an activated step).

**2. Fail closed on the Meta template check.** The worker now records *every* read. A failed or refused read is an immutable `READ_FAILED` observation and `begin` is never called without a fresh successful read. Because the SQL gate requires the *latest* observation to be `APPROVED`, the recorded failure also closes review, prepare and begin until a later read succeeds; the lease lapses, the job is re-queued, and the authority expires after four minutes if Meta stays unreachable. Regressions: unit (failed fetch and HTTP 429: `READ_FAILED` recorded, no begin, no provider call, no settlement; a successful read: begin, send, settle) and real-role integration (`READ_FAILED` makes the owner review's template evidence non-current; `APPROVED` restores it before the one begin).

**3. Empty monthly WhatsApp count.** `mhp_event_whatsapp_budget` counts `j.id` / `s.id`; an empty month reads 3 available, asserted at the first APPROVED review.

**4. Finite test lease wait.** Ten minutes instead of unlimited, on both branches.

**Unchanged by instruction:** caps (SMS 10 segments a day / 50 a month; WhatsApp 1 a day / 3 a month). The linked WhatsApp STOP and the WABA-specific, worker-held Meta read are as Astra accepted in principle.

**Second-round evidence**

| Run | Result |
|---|---|
| 009B focused, fresh 131 database (`test/db/mhp-event-phone.integration.test.ts` under real roles, unit, compatibility, ledger, harness) | 98/98 |
| 009C focused, 132 database: both real-role integration tests | 2/2 |
| 009C ledger, both compatibility suites, both unit files (incl. the new worker regression) | 106/106 |
| Bridges: runtime-readiness | 26/26 each |
| Full integrated suite, 009C on 132 (head `a0c9c9e`) | 3742 tests: 3735 pass, 6 fail, 1 skipped |
| Full integrated suite, 009B on a fresh 131 (head `76fe4d8`) | 3730 tests: 3723 pass, 6 fail, 1 skipped |

The six failures are the same six in both runs and the same six as the first round; all also fail on unchanged `ea1903f` (company-asset, growth-evidence, 0090, 0091, 0092, the date-dependent email pilot). No timeouts.

Readiness matrix (migration ledger plus the three real-role WhatsApp boundaries), re-run after the fixes:

| Build | 131 database | 132 database |
|---|---|---|
| 009B bridge | ready | refused |
| 009B | ready | refused |
| 009C bridge | ready | ready |
| 009C | refused (0132 pending) | ready |

**Still blocking release:** Astra's ratification of these exact SHAs; the Meta template approval (`mhp_webinar_20261104_reminder_v1`, with the ChatGPT lane). The proposals doc now records items 1–3 as implemented/accepted in principle. No deploy, no production migration, no provider call and no message were made in this round.

---

**Status:** source candidates, independently reviewed, with review fixes applied and tested. **Not deployed.**
No production migration was applied and no provider call was made. No SMS, WhatsApp or email was sent.
All database work used the disposable local test database.

**What Astra is asked to do:**
1. Decide the four open items in section 5.
2. Ratify or reject each candidate at the exact SHAs below.

Root then owns integration, migration and the owned acceptance test, following the cutover order in section 6.

## 1. Exact base and candidates

| | Ref | Full SHA |
|---|---|---|
| Live Relaunch72 base | `ea1903f` | `ea1903fa28b4cab57a3ced4dfcade790a1de28c6` |
| Agreed design (base + docs) | `1e28980` | `1e28980fb66feac321723e4f5fb795b2c9b90ea3` |
| Design file | `009B-SQL-DESIGN.md` | sha256 `30486ff74217acadc59b4b06dd2a5bab9d96e0f248941356180a5ba0dfdcbc7c` |
| **009B SMS candidate** | `claude/009b-r3` | `e07262702a61e1ee902a9ddaecc06280c84e0fe2` |
| 009B readiness bridge (`ea1903f` + exact 0131 allowance) | `claude/009b-r3-readiness-bridge` | `2e1ef7fa2df37a23304aa54fbbe6d61b1499c0fb` |
| **009C WhatsApp candidate** (descends from the 009B head) | `claude/009c-r3` | `6b6515acfff2324ca5ebcc47d796d9c89711869b`, plus the commit that adds this file (docs only) |
| 009C readiness bridge (009B head + exact 0132 allowance) | `claude/009c-r3-readiness-bridge` | `ace89d786ea05211537bc366542168b38caaf20f` |

| Migration | sha256 |
|---|---|
| `0131_mhp_event_phone_programme.sql` | `8ad7b48ede3c99d2232dac73b0b61a074a153402208564c4dabe824a5aba4fde` |
| `0132_mhp_event_whatsapp_programme.sql` | `ad09a7f2a75bc536ad6e318e7069a3f081c1f31137b80747bde24180e9a65da3` |

Both checksums are pinned in the ledger tests and in the corresponding bridge.

## 2. What each candidate delivers against the brief

**009B — SMS**
- **Email ownership before phone.** A single-use 15-minute link is sent to the signup email. Opening it gives a 15-minute capability, and only then can a number be chosen.
- **Phone possession.** The registrant texts `JOIN <code>` from that number. It arrives through the signed Twilio webhook within 10 minutes and must come from the chosen number.
- **Consent scope.** Consent is recorded for this webinar only (purpose `mhp.webinar.<date>`), never general marketing.
- **Owner approval schedules rather than sends.** The owner reviews the exact recipients. Activation prepares the exact batch (message, approval, delivery, operation and compliance chain) for the scheduled time and creates no job.
- **Due worker.** At the absolute due time the worker creates the authority and one job.
- **Deadlines and once-only.** The event deadline is enforced at prepare and at begin, and a provider `ValidityPeriod` is set. Each recipient/step is sent once, and begin succeeds exactly once.
- **Signed STOP** suppresses SMS and withdraws the event grant, before or after claim.
- **Existing paths preserved.** The legacy owner SMS, email and CRM paths are proved blind to event work by exact-body compatibility tests and real-role integration tests.

**009C — WhatsApp (built on corrected 009B)**
- **WhatsApp's own verification.** The registrant sends `JOIN <code>` from WhatsApp through a `wa.me` link, verified by the signed Meta webhook. An SMS verification never counts; the code digests are domain-separated.
- **WhatsApp STOP** (first word) suppresses WhatsApp only and withdraws the event grant. It never touches SMS, and vice versa.
- **Template checked against Meta.** There is no typed approval anywhere. The worker reads the template from Meta and records an immutable observation that is valid for 15 minutes. A current `APPROVED` read whose body equals the owner-approved local draft is required at review, activation, prepare and begin. Meta is re-read immediately before begin.
- **Follow-up journey delivered.** Registrant pages, owner review/activate/control at `/hq/marketing/webinar-whatsapp`, a due worker and the unchanged 0053 transport and settle. This is the full journey, not just an owner test.
- **Legacy repairs (exact-body tested):**
  - 0053 template-name regex: every template insert previously failed.
  - 0053 claim OUT-column ambiguity.
  - The 0053 enqueue now refuses `mhp.webinar.*` consent.

## 3. Review

The reviewer for both candidates was an independent read-only review agent, not a human.

**009B.** Reviewed at `6f789bf`/`0198080`. All findings were fixed in `f3ed2e6`:
- uniform link responses;
- expired choices no longer block a number;
- lock order;
- a queued job whose authority lapsed is cancelled;
- per-row prepare isolation;
- copy fixes.

**009C.** Reviewed at `b8e9a5b`. All ten findings were fixed in `27c2704`:
- legacy enqueue reuse of event consent;
- the journey dead-ending for a WhatsApp-only programme;
- the wrapper narrowing the 0055 sender rule;
- fragile STOP matching;
- the Meta read not being tied to the WABA and ignoring non-BODY components;
- draft approval checked only at activation;
- an incomplete in-flight count;
- the observation id in the review digest;
- a broad hold policy;
- module state in the view.

The detailed disposition is in each handoff.

**Not yet done:** an exact-SHA re-review of the final heads. Astra may want one before ratifying.

## 4. Test evidence

| Run | Result |
|---|---|
| 009B real-role integration (full path) | pass |
| 009B compatibility / unit | 10/10, 7/7 |
| 009B full integrated suite, fresh 131 database, at `67fe2d2` | 3730 tests: 3723 pass, 6 fail, 1 skipped |
| 009C real-role integration | pass (includes the `Stop please` case and the two-backend prepare race) |
| 009C focused, on a 132 database | 106/106 (SMS and WhatsApp integration, ledger, both compatibility suites, units) |
| 009C full integrated suite, 132 database, at `452e3b8` content | 3741 tests: 3734 pass, 6 fail, 1 skipped |
| Bridges | runtime-readiness 26/26 each |

The same six failures appear in both full runs, and all six also fail on unchanged `ea1903f`: company-asset, growth-evidence, 0090, 0091, 0092 and the email pilot (date-dependent fixture). Commits after `452e3b8` on 009C are docs-only merges.

**Readiness matrix.** Each build was checked against the migration ledger and the three real-role WhatsApp boundaries:

| Build | 131 database | 132 database |
|---|---|---|
| 009B | ready | refused |
| 009C bridge | ready | ready |
| 009C | refused (0132 pending) | ready |

This is why each bridge must be deployed before its migration is applied.

**Test-harness change (both branches, test-only).** The shared disposable-DB lease used to inherit the migrator's 120 s statement timeout. As a result, the absolute-due tests made the test queued behind them fail with 57014. The lease wait is now bounded only by node's per-test timeout. This touches the shared `test/db/database-helper.ts`, so Astra should confirm it is in scope.

## 5. Decisions needed from Astra (release blockers)

The proposals are in `009B-009C-DECISION-PROPOSALS-R3.md`.

1. **Signed SMS STOP from a number with no contact point.** This is not implemented: 009B keeps today's refusal (webhook 503, nothing durable), and Twilio's own opt-out is the only safety net. The proposal is an append-only unlinked-opt table with no contact created. **Blocks live SMS use.**
2. **WhatsApp STOP.** Implemented in 009C as the candidate for a linked or verified sender: WhatsApp-only, NULL-purpose suppression plus grant withdrawal. An unlinked WhatsApp STOP depends on decision 1 and is not implemented. Needs ratification.
3. **Meta read and token custody.** Implemented as a worker-only read with the sealed binding credential. The token is never stored, logged or shown.
   - **The proposals doc is out of date here.** It says `GET /{template-id}` on v21.0. The review changed this to `GET /{waba-id}/message_templates?name=…` on v24.0, matched by id, so the template must belong to this sender's own WABA. Ratify the implemented form, or say otherwise.
4. **Caps.** Unchanged and no increase proposed:
   - SMS: 10 segments a day and 50 a month.
   - WhatsApp: 1 send a day and 3 a month, so at most 3 WhatsApp follow-ups a month.

   A larger audience needs a founder and Astra decision.

**Other blockers and limits:**
- **Meta template.** `mhp_webinar_20261104_reminder_v1` (`1441099094827445`) was last reported "In review", and the ChatGPT lane owns it. Nothing can be scheduled until Meta returns `APPROVED`, by design.
- **Existing defect (flagged, not fixed, outside this packet).** The legacy `PgMetaWhatsAppLiveRepository` calls its functions without the worker context, so the legacy WhatsApp worker would be refused. The new event path is unaffected.
- **No automatic enrolment.** Each batch needs owner review, and a held or withdrawn registrant cannot be re-scheduled.

## 6. Cutover and recovery (summary)

The full procedures are in `009B-R3-CUTOVER-AND-RECOVERY.md` and `009C-R3-HANDOFF.md`.

**Cutover**
1. Deploy the 009B bridge.
2. Apply 0131 with the guarded migrator and read back the ledger and role boundaries.
3. Deploy 009B with all switches off.
4. Run owned acceptance with the owner's own number: JOIN, schedule, send, STOP.
5. For 009C, after 009B is live: deploy the 009C bridge, apply 0132, deploy 009C with switches off, connect the sender and enable the worker observation.
6. Run WhatsApp owned acceptance, then approve the real programme.

**Recovery**
- Unset the public, owner and inbound switches.
- Run the hold function as the worker role, then unset the worker mode.
- Reconcile in-flight work against the lease and the provider status; never retry it.
- Redeploy the bridge, which stays ready on the new migration.
- Never down-migrate, delete evidence or create a typed approval.

## 7. Next owners

- **Astra:** sections 5 and 3 (decisions, optional re-review), then ratify or reject the exact SHAs.
- **Root:** integration, migrations and deploys, only after ratification and in the section 6 order.
- **ChatGPT lane:** Meta template approval.
- **Founder:** any cap change. No future SMS or WhatsApp send happens without specific approval.
