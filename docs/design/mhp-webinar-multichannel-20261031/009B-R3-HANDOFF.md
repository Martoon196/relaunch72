# 009B r3 handoff — agreed-design source candidate (not deployed)

| | |
|---|---|
| Base | live `ea1903f` + design docs `1e28980` |
| Candidate | branch `claude/009b-r3` (head: see the commit that adds this file) |
| Migration | `0131_mhp_event_phone_programme.sql`, sha256 `8ad7b48ede3c99d2232dac73b0b61a074a153402208564c4dabe824a5aba4fde` |
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
- **Bridge:** runtime-readiness 26/26; full unit suite 3688 tests, 3647 pass, 0 fail, 41 skipped.

## Review findings and disposition

1. **Uniform public response.** Fixed. Limits return the same non-sending result; a mail failure is logged and stays uniform. Tested.
2. **Number blocking by an expired pending choice.** Fixed.
   - Expired pending choices are expired before the availability check.
   - The message no longer says who holds the number.
3. **STOP from an unlinked number.** Not implemented. It is still a release blocker; proposal 1 in `009B-009C-DECISION-PROPOSALS-R3.md` covers it.
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

## Remaining limits

- Unlinked STOP (finding 3) and the open decisions block live use.
- There is no automatic enrolment: each batch needs a separate owner review.
- Caps are unchanged at 10 segments a day and 50 a month, so at most about 10 one-segment reminders fit on one day.
- A held or withdrawn registrant cannot be re-scheduled.
- The owner programme form takes raw IDs for the saved text (functional, not polished).
