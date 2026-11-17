# Adversarial review: sequence safety release, head `e0c8dc5f9512e2d9b9bfadcbe855dcd41ecfdde6` (confirmed), base `fd1d9f5`

## Verdict

**Safe to deploy: yes, after one named fix (M1).** Every forged, replayed or shortcut route to an enrolment was refused on a real PostgreSQL 16 with all migrations applied. But the build classifies the production book sequence as "for webinar sign-ups" again and lets it be started and resumed.

**Can the owner still email people he has not seen listed?**
- **Sequences screen: yes, in three narrow ways.**
  - Someone who signs up during the fraction of a second of the Start press is enrolled unseen. The safety net pauses them when the confirmed batch is 100 or fewer; above 100 it never does (S1).
  - The automatic sign-up rule emails future sign-ups by design; they cannot be named in advance.
  - On a phone the names sit in an inner scrolling box showing about five at a time, so "on the page" is not the same as "seen".
- **Owner email screen: yes, plainly.** One press of "Schedule remaining audience" queues the whole webinar list with no names (area 8).

Unless marked "read", everything below was run. The marketing-workspace selection was stubbed in my harness, as in the builder's integration test; the content reader, email service, sequence service, router and SQL functions were real.

## MUST-FIX before deploy

**M1. The book sequence is classified as a webinar sequence and can be started and resumed.**
- **Cause:** `classifyLegacyFollowupAudience` (`src/followup-sequences/audience.ts:57-61`, called from `followup-sequence-service.ts:251-258`) returns `webinar_signups` for any pre-release version whose sequence has people in it. The book sequence has 14, because of the incident.
- **Builder's own test encodes it:** `test/db/mhp-sequence-safety.integration.test.ts:117-118` asserts this as intended ("B is now used with the webinar").
- **Scenario** (`s1-routes.mts`): a pre-release sequence enrolled by the old one-press command, everyone then paused, two new webinar sign-ups added.
- **What the owner sees:** "Who it is for: People who registered for the current webinar and agreed to emails. 0 active, 6 paused… **Start this sequence…** … **Resume everyone (6)**".
- **Start:** the confirmation lists the two newcomers; one tick enrolled them into the book sequence and the worker could claim their first email.
- **Resume everyone:** the confirmation names the paused people; one tick made all of them active and their remaining emails claimable. `resumePlan`/`resumeAll` (`service.ts:487-503`) never look at the audience.
- **Laundering:** opening that sequence in the editor preselects the "webinar sign-ups" radio (`followup-sequence-view.ts:220-226`), so the next save turns the guess into an explicit choice.
- **Is it acceptable?** No. Names are shown, so it is not silent, but nothing says "this was written for book readers", and one tick repeats the incident for the same 14 people.
- **Smallest fix:**
  1. A legacy version is `webinar_signups` only if its item id is on a short explicit list of known webinar sequences; otherwise `none_yet`.
  2. Refuse resume (one person and everyone) when `followupAudienceCanStart` is false; stop and remove stay allowed.
  3. In the editor, preselect "No one yet" unless the audience origin is `chosen`.
- **Operational alternative, post-deploy only:** save a new version of the book sequence as "No one yet". I ran this: Start is refused, the people go "on hold", the database blocks every resume, and the worker claims nothing. A version saved before deploy has no audience key and is still classified as webinar.
- I could not tell tool-saved versions apart from the data (same `authoredBy`, random request ids), so "saved by the draft tool ⇒ none_yet" is not implementable for existing rows.

## SHOULD-FIX

**S1. Everything depends on a snapshot of the 100 most recent people in the whole campaign** (`0127_mhp_followup_sequences.sql:270`).
- **Safety net blind above 100** (`s2b-net-blind.mts`): 156 confirmed plus one unseen sign-up left the unseen person active in 6 of 6 runs. The owner is told to "check them in the list below", which shows only 100.
- **False promise:** after a 500-person start the page said 26 more "can be started afterwards with a second confirmation"; the next plan refuses forever with "more people in sequences than this page can list".
- **Wrong counts:** the page showed "0 active, 100 paused" with 500 paused.
- **Cliff (read):** once the campaign holds more than 100 people across all sequences, Start and Resume everyone are refused for every sequence.
- **Smallest fix:** refuse a plan larger than 100 and drop the "more can be started afterwards" text; the real fix is the migration below.

**S2. Result notes are not bound to a sequence** (`followup-sequence-router.ts:51-59`).
- A genuine "Started for 7 people. Their first email is going now." note replayed on the book sequence's URL in the same session displays there.
- Back or reload after pausing everyone still shows "Started for…".
- Forged and other-session notes are correctly ignored.
- **Fix:** include item and version (ideally a timestamp) in the signature.

**S3. People on hold after a newer version are offered resumes that cannot work.**
- "Resume this person" and "Resume everyone (N)" appear; the plan says "Resume 8 people?" and resumes 0.
- The card then says "their permission, an email or an earlier send needs checking first" in green success styling, when the real reason is the newer version.
- **Fix:** do not offer or count resume for `newer_sequence`.

**S4. The builder's real-database test is flaky: 2 of 6 runs failed on fixture load.**
- `test/db/mhp-sequence-safety.fixture.sql` writes `clock_timestamp(),clock_timestamp()+interval '15 minutes'` twice, which randomly trips the 15-minute guard in migration 0049.
- **Fix:** use one timestamp. Not a production issue.

## NOTES

- **Safety net pauses a legitimately auto-added person** when a manual Start coincides with the automatic rule, and reports them as "signed up in the moment you pressed Start". Safe direction.
- **Resume everyone is fingerprint-checked in the service only (read):** the database resumes every paused or held person in the item (`0128:512-513`), so someone paused between check and call is resumed too.
- **Short-id collision:** two ids sharing their last 8 hex characters never caused an enrolment; the "list changed" page just failed to name the removed person.
- **Two tabs pressed together:** nobody was enrolled twice, but the second tab says the six "are no longer able to receive it (for example they unsubscribed)", which is false.
- **A draft-tool or cached-old-page save of a real webinar sequence** makes the new version `none_yet` and puts its people on hold. Safe, but surprising.
- **Usability:**
  - "Back to the sequence" on the not-found page loops to the same error.
  - Shared form errors read "Refresh the native flow form before continuing." and "Use the native flow form." (`src/followup-sequences/http.ts`).
  - The editor says "choose exact versions from your local library".
  - The summary line ends "started.." (double full stop).
  - A primary "Start this sequence…" button sits directly under "Started for 8 people".
  - Tap targets under 44 px: header links 28, saved-sequence links 20, "More for…" 40. Text at 13 px (eyebrows) and 15 px (badges).

## The eight areas

1. **Enrol without a seen name: broken for the book case (M1), otherwise held.** All refused:
   - POST `/enrol`; `service.command` with every action value and junk.
   - Missing tick; tampered count, digest, people, issued.
   - Other version, other command id, other session's signature, resume-all signature.
   - A 31-minute-old confirmation; `none_yet`, legacy-unused and unknown audience values.
   - The old one-press resume, stop and cancel everyone.
   
   The operator tools expose only snapshot, review, simulate and save (read).
2. **List equals who is enrolled: held up to 100, broken above (S1).** Matched exactly for no consent, unsubscribed, sign-up without consent, two sign-ups, sign-up after the anchor, a markup name, every earlier-version state, and 500 of 526.
3. **Pause, resume, stop: held.**
   - The worker never claimed or prepared a paused, stopped, removed or held person, including after lease expiry.
   - Claimed-then-paused: prepare returns nothing.
   - Three concurrent pause-everyone presses paused A only.
   - Resume everyone was refused on a changed set and without the tick.
   - Cross-sequence and guessed ids changed nothing.
4. **Audience in metadata: held.** Version rows are append-only even for the owner role ("company content versions and approval records are append-only"); `save` is the only writer (read). The weak point is the legacy inference, not the storage.
5. **Web safety: held, except S2.**
   - All 15 POSTs refuse wrong CSRF, foreign or missing origin and query strings; no session goes to login.
   - Open-workspace rejected nine hostile return targets.
   - Hostile names are escaped; no name or address in redirects or notes; no logging in the changed files (read).
6. **Phone usability: held, with notes.** At 390 and 1280 px:
   - No sideways scroll.
   - Start blocked without the tick.
   - Pausing one person stays on their card with "Paused" and "Resume this person".
   - Back never re-enrols.
   - No "runs", "explicit batch", "content version", "provider" or "enrol" in visible text.
7. **Regressions: held.**
   - Save → publish → confirm → start → worker claims exactly the seven listed.
   - The automatic rule enrolled only a new consenting sign-up and none of the six existing registrants.
   - The 64 targeted tests pass. All five changed test files are legitimate consequences; none loosens a guard.
   - Full suite and typecheck not re-run.
8. **Owner email: confirmed.** One press queued all six registrants with no names; the page says only "Each click schedules up to 500 remaining registrations". Smallest safeguard: the same pattern, a confirmation page naming the people, a signed count and fingerprint, a tick, and a recount before the queue command.

## The race window (local PostgreSQL, no network)

| Window | Measured |
|---|---|
| Last audience read → enrol done, 6 people | 34–69 ms |
| Same, 500 people | 114–175 ms from the last page, 189–255 ms from the first |
| Enrol done → unseen person paused | 6–20 ms; up to about 150 ms when a worker claim contends |

- **60 unforced trials** (sign-up landing 0–60 ms into the press): 25 refused as "list changed", 31 enrolled unseen, all 31 paused.
- **40 forced trials** with a worker claim-and-prepare fired the instant the enrol returned: 0 unseen people had an email prepared.
- The worker sweeps every 60 s, so for today's list the residual chance is negligible. Production round-trip latency will widen both windows.
- **Is the migration the right fix? Yes.** Pass the confirmed prospect ids to the database function and enrol only audience ∩ list in one statement. That removes the gap, the safety net and the 100-person dependence. Pass run ids for resume everyone, and let the database refuse non-webinar audiences.

## Could not verify

- The real `select_mhp_marketing_workspace` behind the open-workspace step (the fixture owner has no personal Desk); checked by reading and with a stub.
- The production book sequence's actual stored definition and whether its latest version predates the release.
- Production latency, the real send path, and the bounce/block list (applied at send time, so blocked people would be listed and enrolled, then refused).
- Pause or resume of more than 500 (500 exactly ran in one batch).
- Rate limiting (stubbed) and the owner-email error frame in a browser (read only).

## Housekeeping

- Nothing reached a production host. Chromium ran with no proxy and a resolver that cannot resolve names, a route aborted every non-127.0.0.1 request, and a deliberate `https://example.com/` probe was aborted in both contexts.
- No connector tools used. No tracked file changed. My cluster under `/tmp/review-seq-safety-pg` is stopped and removed.

Files are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-seq-safety`:
- `scripts/` (harness `lib.mts`, `run.sh`, and `s0`–`s8` scenario scripts)
- `s1.log` … `s8.log`
- `shots/` (36 screenshots at 390 and 1280 px)