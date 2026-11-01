# 009B + 009C r3 — handoff to Astra for ratification (1 November 2026)

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
