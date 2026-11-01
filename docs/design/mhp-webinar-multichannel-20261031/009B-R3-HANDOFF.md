# 009B r3 handoff — agreed-design source candidate (not deployed)

| | |
|---|---|
| Base | live `ea1903f` + design docs `1e28980` |
| Candidate | branch `claude/009b-r3` (head: see the commit that adds this file) |
| Migration | `0131_mhp_event_phone_programme.sql`, sha256 `b117e3d267640f58ee41e4d32a7d9f936e9e4add5d91ea1e921cc88051312c14` (second round; the first-round candidate was `8ad7b48e…`) |
| Readiness bridge | branch `claude/009b-r3-readiness-bridge` = `ea1903f` plus an allowance for that exact 0131 only |
| External effects | none: no deploy, no migration outside the disposable local DB, no provider call, no text or email sent |
| Reviewer | independent review agent (read-only) of `6f789bf`/`0198080`; findings and their disposition below |
| Next owner | Astra (ratification, open decisions), then Root (bridge → migration → owned acceptance per `009B-R3-CUTOVER-AND-RECOVERY.md`) |

## What the candidate does (agreed design sections)

- **§1–2:** The programme is an owner-approved 0021 version (`mhp.event-phone/v1`).
  - Each registrant has an access intent (single-use email link, 15 minutes, then a capability valid 15 minutes) and an SMS intent (`JOIN <nonce>` within 10 minutes).
  - There is an append-only receipt per grant or withdrawal.
  - The consent text is event-only, purpose `mhp.webinar.<date>`, and never general marketing.
- **§3–4:**
  - The signed inbound wrapper verifies JOIN for the exact number and nonce.
  - It reuses or creates one contact without impersonation, holding on any ambiguity.
  - It appends event consent and proof, then runs the existing projection in the same transaction.
  - STOP appends the event withdrawal after the existing suppression.
- **§5–6:** Owner review and one activation.
  - Activation pre-materialises, per exact reviewed recipient, the approved message, version, request, decision, queued delivery, reserved operation, compliance chain and calendar row. It creates no authority and no job.
  - Activation is atomic and replayable; a stale recipient refuses the whole batch.
- **§7–8:**
  - At the absolute due time the worker creates a fresh `mhp_event` authority (no operator or permission-use receipt) and one worker-provenance job.
  - The event claim/load/begin functions re-prove every current gate. Settlement is the shared 0056 path.
  - The optional Twilio `ValidityPeriod` comes from the immutable deadline.
- **§9:** Nine legacy definitions are replaced by their exact prior bodies plus a single predicate each (compatibility test). Structurally fenced paths are unchanged.

## Tests (this candidate)

- **Focused DB, real login roles** (`test/db/mhp-event-phone.integration.test.ts`): pass.
  - Covers the email link (uniform, replay, conflict, GET does not consume) and signed JOIN (replay, wrong number).
  - Covers CRM reuse and the new contact, withdrawal, owner activation with replay and conflict, and a later entrant waiting for review.
  - Covers legacy email and SMS isolation, the absolute-due wait and the two-backend prepare race.
  - Covers worker provenance, STOP before claim (cancelled) and STOP after claim before begin (denied), begin exactly once, and shared settle.
- **Static compatibility:** 10/10 (`mhp-event-phone-legacy-compat.test.ts`).
- **Unit:** 7/7 (`test/mhp-event-phone.test.ts`).
- **Full unit suite:** 3705 tests, 3663 pass, 0 fail, 42 skipped (DB-gated).
- **Integrated full suite on the disposable DB (before the review fixes):** 3730 tests, 3723 pass, 6 fail, 1 skipped.
  - All 6 failures are pre-existing and reproduce on unchanged `ea1903f`: company-asset, growth-evidence, 0090, 0091, 0092, and the email pilot.
  - The email pilot's `conversations_check1` is date-dependent fixture data and also fails on the base with 130 migrations.
- **Integrated full suite after the review fixes and the harness fix (`67fe2d2`, fresh 131 database):** 3730 tests, 3723 pass, 6 fail, 0 cancelled, 1 skipped. These are the same six that fail on unchanged `ea1903f`: company-asset, growth-evidence, 0090, 0091, 0092 and the email pilot.
- **Test harness fix (test-only, added after review).** The disposable-DB advisory lease used to inherit the migrator's 120 s statement timeout. This test waits 2–3 minutes for a real due minute, so whichever DB test queued behind it could fail with 57014. The lease wait now has no statement timeout (node's per-test timeout still bounds it). Proof: the harness test, this integration test and the 0055 inbox test queued behind it, run together on a 131 database: 4/4 pass.
- **Bridge:** runtime-readiness 26/26; full unit suite 3688 tests, 3647 pass, 0 fail, 41 skipped.

## Review findings and disposition

1. **Uniform public response.** Fixed. Limits return the same non-sending result; a mail failure is logged and stays uniform. Tested.
2. **Number blocking by an expired pending choice.** Fixed.
   - Expired pending choices are expired before the availability check.
   - The message no longer says who holds the number.
3. **STOP from an unlinked number.** Implemented in the second round (Astra item 1, below).
4. **Lock-order inversions.** Fixed:
   - JOIN now takes the advisory keys before the row lock.
   - The STOP loop takes the prospect keys first.
   - control now follows the order job, then cap, then calendar.
5. **Lapsed authority left a job queued.** Fixed: claim cancels it (freeing the cap) and holds the step as `expired`.
6. **Event preparation failure blocked the existing 009A cycle.** Fixed in two places:
   - The runner isolates `prepareDue` from the existing cycle.
   - Each row runs in its own subtransaction: transient errors are retried and other errors are held as `prepare_failed`.
7. **Re-scheduling after a hold or change.** Copy corrected. Re-scheduling a held registrant is not built and is a known limit.
8. **STOP during activation.** Resolved by 4: STOP now takes the same prospect key as activation.
9. **JOIN hash binding.** Kept as a domain-separated hash of a 130-bit random nonce. The event is not known before the lookup; this is a deliberate deviation for Astra to note.
10. **JOIN creates an "urgent call" task.** Unchanged reuse of the existing projection, as the design says. Flagged for Astra.

## Second review round (Astra, 1 November 2026)

Astra reviewed `e072627` and asked for bounded fixes. The two that touch 009B:

**Item 1 — a signed STOP from a number that is not yet linked to a contact is recorded durably, and JOIN and scheduled sends honour it.**
- New append-only table `app_private.mhp_unlinked_opt_events`, keyed by `channel` ('sms' or 'whatsapp') and the phone digest the intents already use (sha256 of the E.164 number). It holds the provider event and message ids, the opt evidence ('stop' or 'start'), the four evidence digests, the recording role and the occurred time. No contact, no point, no body. UPDATE and DELETE are refused by trigger.
- `mhp_record_event_sms_inbound`: when the existing projection reports an unknown sender (`23503`) and the message is a signed STOP or START, the wrapper appends the row and answers `unlinked_stop` / `unlinked_start`. Any pending `awaiting_join` intent for that number is held as `suppressed`. Every other unknown-sender text keeps the existing refusal, and a known number whose projection fails still re-raises `23503` exactly as before. Replays answer `replayed`.
- JOIN: a valid JOIN from a number whose latest signed SMS event is `stop` is held as `suppressed`, consumes the message and creates nothing.
- Scheduled sends and review: `mhp_event_phone_grant_tuple`, the one gate that review, activation, prepare and begin already use for a linked suppression, now also requires the latest unlinked SMS event for the receipt's phone digest to be anything but `stop`. A held step shows `receipt_changed`, the same reason a linked suppression gives.
- A signed START appends `start` and releases only this unlinked key; it never touches a manual or legal suppression.
- RLS: `r72_sms_definer` can read and append `channel='sms'` rows only (append only in the webhook session). The WhatsApp definer's access is granted in 0132 for `channel='whatsapp'` only. Neither channel's opt-out is ever inferred from the other.
- Proved under real roles in `test/db/mhp-event-phone.integration.test.ts`: durable record and replay; the pending JOIN held and no point created; a later JOIN held; START then JOIN granted; an ordinary text from an unknown number still refused; a WhatsApp-only key ignored by SMS; the owner review dropping a registrant; and the worker prepare race holding an activated step with `receipt_changed` (no authority, no job).

**Item 4 — the shared database test lease wait has a finite timeout** (`test/db/database-helper.ts`): ten minutes, above every per-test timeout, instead of unlimited.

Not changed: caps (10 segments a day, 50 a month), the email pilot, 0056 bytes, the 009A owner-SMS path.

## Remaining limits

- The open decisions (WhatsApp STOP in principle accepted; Meta read in principle accepted; caps unchanged) still need Astra's ratification of the exact SHAs.
- There is no automatic enrolment: each batch needs a separate owner review.
- Caps are unchanged at 10 segments a day and 50 a month, so at most about 10 one-segment reminders fit on one day.
- A held or withdrawn registrant cannot be re-scheduled.
- The owner programme form takes raw IDs for the saved text (functional, not polished).
