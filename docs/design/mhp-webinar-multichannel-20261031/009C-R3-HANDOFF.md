# 009C r3 handoff — WhatsApp webinar follow-up on the corrected 009B (not deployed)

| | |
|---|---|
| Base | `claude/009b-r3` (009B, reviewed) |
| Candidate | branch `claude/009c-r3` (head: the commit that adds this file) |
| Migration | `0132_mhp_event_whatsapp_programme.sql`, sha256 `699509011c03267e2df8aa4e8ef7ef2c219fcb4a8fea641c82fa97d7d279f366` (second round plus Astra's replay correction; earlier `ad09a7f2…`, `25f63660…`), on 0131 `8abaea82…`; both pinned in the ledger tests and the bridge |
| Readiness bridge | `claude/009c-r3-readiness-bridge` = 009B head plus two allowances: exactly this 0132 after 131, and the 0132 WhatsApp functions tolerated (never required) by the three exact WhatsApp boundaries |
| External effects | None. No deploy, no migration outside the disposable local DB, no Meta or Twilio call, no message sent. |
| Not ratified | There is no ratified 009C SQL design. Proposals 2 and 3 in `009B-009C-DECISION-PROPOSALS-R3.md` are implemented here as candidates and need Astra's decision. |

## What it does

- **Journey.** The same email-proved capability as 009B opens an optional WhatsApp follow-up page.
  - The registrant chooses their own mobile and ticks the event-only consent.
  - They then message `JOIN <code>` from WhatsApp via a `wa.me` link.
  - The signed inbound arrives through the existing app-secret-HMAC verifier and the unchanged 0055 projection. A wrapper links or creates one WhatsApp point and appends event consent plus proof.
  - An SMS verification never counts; the code digest is domain-separated from SMS.
- **STOP (proposal 2).** A signed WhatsApp STOP appends WhatsApp-only NULL-purpose suppression and withdraws the event grant. SMS is never touched, and vice versa.
- **Template evidence (proposal 3).**
  - The WhatsApp worker reads `GET /{waba-id}/message_templates?name=<name>` from Meta with the decrypted binding credential and accepts only the single entry whose id is the configured template id, so the template must belong to this sender's own WhatsApp Business Account. The token is never stored, logged or returned.
  - It records an immutable observation: status, body hash, components hash and response hash, valid 15 minutes. A template with any header, footer or button gets a body hash that can never equal the draft, because the owner never reviewed that content.
  - Owner review (eligibility), activation, prepare and begin each require a current `APPROVED` read whose body equals the approved local draft, and the draft itself must still be owner-approved. There is no typed approval anywhere.
  - The 0053 template row is created at activation with the observation as its evidence.
- **Owner batch.** One review of exact recipients per batch, within the unchanged caps: 1 a day and 3 a month per binding. Activation pre-materialises the compliance chain and a calendar row (`app_private.mhp_event_whatsapp_sends`, a separate relation). It creates no authority and no job.
- **Due worker.**
  - At the absolute due time it creates a fresh `mhp_event` authority (no permission-use receipt) and one worker-provenance job.
  - The event claim, load and begin functions re-prove everything, and the template is re-read immediately before begin.
  - The send is the unchanged 0053 template transport; settlement is the unchanged 0053 path.
- **Legacy.**
  - Two latent 0053 defects are repaired: the template-name regex (every template insert failed) and the claim OUT-column ambiguity.
  - The legacy claim recovery also gets an explicit owner-only filter.
  - Legacy load and begin are structurally blind to event authorities (proved in the test).
  - The 0131 `mhp_event_phone_request_link` is widened so a WhatsApp-only programme, or a registrant of only the WhatsApp programme, opens the email proof (exact-body compatibility test).
  - The 0053 `authorize_and_enqueue_whatsapp_live_job` refuses any `mhp.webinar.*` purpose, so a legacy owner-action send can never reuse webinar-only consent (exact-body compatibility test).

## Tests

- **Real-role WhatsApp integration** (`test/db/mhp-event-whatsapp.integration.test.ts`): passes. It covers:
  - the email proof and WhatsApp JOIN, including replay, wrong number and no SMS point;
  - the observation targets and a WhatsApp STOP that suppresses WhatsApp only;
  - no scheduling before an `APPROVED` read, with PENDING and a body mismatch both refused;
  - the 1-a-day cap, activation and its replay, the absolute-due wait and the two-backend prepare race;
  - worker provenance, legacy claim/load/begin blindness, one begin and the shared settle.
- **009B SQL path on a 132 database:** passes.
- **0132 compatibility:** 6/6 (five exact prior bodies plus the untouched-functions check). **Unit:** 4/4. **Ledger tests:** pinned to the final checksum.
- **Focused run on a 132 database:** 106/106 (SMS and WhatsApp integration, ledger, both compatibility suites, units).
- **Full integrated suite on a 132 database:** 3741 tests: 3734 pass, 6 fail, 1 skipped. All six failures also fail on ea1903f without 0131/0132: company-asset, growth-evidence, 0090, 0091, 0092 and the email pilot.
- **Test harness fix (test-only).** The disposable-DB advisory lease used to inherit the migrator's 120 s statement timeout. The 009B/009C absolute-due tests wait for a real due minute, so the test queued behind them failed with 57014. This happened once in the first full run, hitting the 0055 inbox test. The lease wait now has no statement timeout (node's per-test timeout still bounds it), and the 009C fixture's due time is the whole minute 30–90 s ahead.
- **Readiness matrix (ledger plus the three real-role WhatsApp boundaries):**

  | Build | 131 database | 132 database |
  |---|---|---|
  | 009B `f3ed2e6` | ready | refused (unknown 0132; boundaries not exact) |
  | bridge `16d412f` | ready | ready |
  | 009C (this branch) | refused (0132 pending) | ready |

  This is why the bridge must be deployed before 0132 is applied.

## Independent review disposition

All ten findings from the independent 009C review are fixed in this head:

1. **Legacy enqueue could reuse event consent.** The 0053 enqueue now refuses `mhp.webinar.*` purposes. The event grant's `occurred_at` is `least(signed time, now)`.
2. **The public journey dead-ended for a WhatsApp-only programme.** The email proof falls back to the WhatsApp programme. The page shows the WhatsApp link even when SMS is closed, and the opened page is neutral.
3. **The wrapper narrowed 0055.** It now uses the 0055 sender rule (`^[1-9][0-9]{6,14}$`). TypeScript routes only JOIN- or STOP-shaped bodies to the wrapper; everything else goes to the unchanged projection.
4. **STOP was fragile.** STOP is matched as the first word (`Stop please` counts; proved under real roles). It is honoured even when the inbox projection is unprojected, provided a verified WhatsApp point exists.
5. **The Meta read was not tied to this WABA, and non-BODY components were ignored.** Fixed as described under *Template evidence*.
6. **Draft approval was checked only at activation.** Eligibility now calls `mhp_owned_whatsapp_content`.
7. **The control's in-flight count was incomplete.** It now covers `calling`, `awaiting_status` and `succeeded`.
8. **The review digest carried the observation id.** It now records `templateApprovedAtReview`, so a routine 5-minute re-read does not invalidate the owner's review.
9. **The prospect hold policy was too broad.** It is limited to `r72_identity_command` and `r72_content_adapter`.
10. **The view used module-global state.** That is removed, and the runtime requires `MHP_EVENT_WHATSAPP_META_TEMPLATE_ID`.

## Second review round (Astra, 1 November 2026)

Astra reviewed `6b6515a` and asked for bounded fixes; all four are in this head.

1. **Unlinked WhatsApp STOP recorded durably; JOIN and scheduled sends honour it.** `mhp_record_event_whatsapp_inbound` now appends a `channel='whatsapp'` row to the 0131 table `app_private.mhp_unlinked_opt_events` (phone digest only, no contact or point) when a signed STOP arrives from a number with no verified WhatsApp point, holds any pending WhatsApp JOIN for that number and answers `unlinked_stop`. A later WhatsApp JOIN from that number is held. `mhp_event_whatsapp_grant_tuple`, the gate review, activation, prepare and begin share, refuses the receipt while the latest unlinked WhatsApp event is `stop`. The WhatsApp definer can see and append `whatsapp` rows only; an SMS key never counts for WhatsApp and vice versa. There is no WhatsApp START release in this packet (nor for a linked WhatsApp STOP). Replay (Astra's correction): a replay under the same provider id is effect-free and answers `replayed` only when the binding, message id, phone digest and all evidence digests are identical; any change answers `conflict`, and the projection is never re-run for it (proved under real roles: identical replay; changed body, signature and sender). Proved under real roles: durable record and replay; the pending JOIN held with no point; a later JOIN held; an ordinary message from an unknown number still refused; an SMS-only key ignored; the owner review dropping the remaining granted registrant only after a WhatsApp key is recorded.
2. **Fail closed on the Meta re-read.** `runMhpEventWhatsAppOnce` records every read: a failed or refused read is stored as an immutable `READ_FAILED` observation (category `UNKNOWN`, a body digest that can never equal a draft), and `begin` is not called without a fresh successful read. Because `mhp_whatsapp_template_current` requires the *latest* observation to be `APPROVED`, the recorded failure also closes the SQL gate that review, prepare and begin evaluate, until a later read succeeds. The lease then lapses, claim recovery re-queues the job, and the authority expires after four minutes if Meta stays unreachable; nothing is sent on a stale approval. Regressions: `test/mhp-event-whatsapp.test.ts` (failed fetch and HTTP 429: `READ_FAILED` recorded, no begin, no provider call, no settlement; a successful read: begin, send, settle) and the real-role integration test (`READ_FAILED` makes the owner review's template evidence non-current; `APPROVED` restores it before the one begin).
3. **Empty monthly budget.** `mhp_event_whatsapp_budget` counts `j.id` / `s.id`, so an empty month reads 3 available, not 2. Asserted in the integration test at the first APPROVED review.
4. **Finite test lease wait.** `test/db/database-helper.ts`: ten minutes instead of unlimited.

Caps are unchanged: 1 a day and 3 a month.

## Remaining limits and blockers

- **Meta template.** `mhp_webinar_20261104_reminder_v1` (1441099094827445) was last reported "In review". Until Meta returns `APPROVED`, nothing can be scheduled; this is by design.
- **Astra's ratification** of the exact second-round SHAs. The linked WhatsApp STOP and the WABA-specific worker-held Meta read are accepted in principle; unlinked STOP is now implemented; caps are unchanged by instruction.
- **Caps** of 1 a day and 3 a month mean at most 3 follow-ups a month in total.
- **Existing defect (not caused by 009C).** `PgMetaWhatsAppLiveRepository` (legacy 0053 worker) calls its functions without the worker GUC context, so the legacy WhatsApp worker would be refused. The event repository uses the proper worker transaction. The legacy defect is left unchanged and flagged.
- **Deploy order.** The exact WhatsApp boundaries list the 0132 functions. Any running WhatsApp runtime must be on the bridge or this build before 0132 is applied.

## Cutover (after 009B is live and Astra ratifies)

1. Deploy the `claude/009c-r3-readiness-bridge` build: 009B behaviour, ready on 131 and on 131 + exact 0132.
2. Apply 0132 with the guarded migrator. Read back the ledger and the role boundaries; there should be no `mhp_event_whatsapp_*` rows yet.
3. Deploy `claude/009c-r3` with all switches off.
4. Connect the MHP WhatsApp sender with `mhp_whatsapp_connect` (sealed credential from the off-web CLI).
5. Enable `PROPERTY_PREDATOR_WHATSAPP_MHP_EVENT_MODE` (and `..._MHP_BINDING_ID`) on the worker. Confirm a template observation row appears.
6. Owned acceptance on a near-term TEST programme with the owner's own WhatsApp:
   1. set `MHP_EVENT_WHATSAPP_INBOUND=enabled` on the webhook;
   2. set `MHP_EVENT_WHATSAPP_PUBLIC=enabled` with `MHP_EVENT_WHATSAPP_NUMBER`, and `MHP_EVENT_WHATSAPP_OWNER=enabled` with `MHP_EVENT_WHATSAPP_BINDING_ID`, on web;
   3. take one owned recipient through JOIN, schedule, send and STOP.
7. Only then approve the real follow-up programme.

## Recovery

- Unset `MHP_EVENT_WHATSAPP_PUBLIC`, `MHP_EVENT_WHATSAPP_OWNER` and `MHP_EVENT_WHATSAPP_INBOUND`.
- Run `mhp_hold_event_whatsapp()` as the worker role: it holds unprepared steps, cancels queued event jobs and reports in-flight work. Then unset the worker event mode.
- In-flight or unknown jobs are reconciled only against their lease and Meta status, never retried.
- Redeploy the bridge build; it stays ready on 132.
- Never down-migrate, delete evidence or create a typed template approval.
