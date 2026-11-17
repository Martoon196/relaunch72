## Result
The branch is merged with the foundation, verified on the merged head and pushed. Head is **a7746c84** on `claude/mhp-sequence-safety`, level with origin, tree clean. It contains the merge commit **b7bb1908** (foundation `cda1d9dc` merged with `--no-ff`) and, separately, **a7746c84**, which types the new methods on `mount.ts`. No pull request, no merge into the foundation, no deploy. No migration file and no `runtime-readiness.ts` admission touched. Every browser test talked only to a 127.0.0.1 server, and each context aborted every other host before its first page loaded; a test navigation to example.com was aborted in each context.

One thing to know from the previous round: in my first browser attempt, one request reached production. That was a GET to `app.martinhowardproperty.co.uk` carrying the synthetic test cookie; it was answered with the login page, and nothing was sent or changed. The browser tests have been local-only since.

## The merge
There were two conflicts, both in the "Open the MHP marketing workspace first" error handling:
- **`src/mhp/followup-sequence-router.ts`:** kept my framed page: header navigation, an "Open marketing workspace" button that opens the workspace and returns to the same sequence, and a way back. If the button cannot be shown it falls back to a link to `/hq/marketing`. I dropped the foundation's import and its plain page (text plus a link to `/hq/marketing`); mine covers it.
- **`src/mhp/owner-email-router.ts`:** same choice. My framed page has an "Open marketing workspace" link to `/hq/marketing` plus a way back. I removed the foundation's now-unused import.

The foundation's `marketingWorkspaceFirstPage` stays unchanged in `marketing-workspace-view.ts`, and its own test (`mhp-book-leads.test.ts`) passes. Everything else from the foundation merged cleanly as it was, including migration `0159_mhp_book_crm.sql`, which my test database applied (159 migrations).

**`mount.ts`** (separate commit): its `sequences` type now lists the optional methods the sequence router uses, and `ownerEmail` lists the four new owner-email ones. A few lines.

## What changed, per review item
**M1: a sequence saved before this release can no longer be started or resumed.**
- A version without an explicit, valid audience saved with it is "none yet", whatever people it has. "Can start" also requires the audience was explicitly chosen (`src/followup-sequences/audience.ts:56`, `:61`).
- Resume, for one person or everyone, is refused in the service when the audience cannot start (`src/mhp/followup-sequence-service.ts:347`, `resumePlan`/`resumeAll` around `:509-515`, and the per-person code `no_audience`). Pause, stop and remove still work.
- New "Stop everyone" with a confirmation that says it is final (`stopAll`, `service.ts:496`).
- The editor preselects "No one yet" unless the audience was explicitly chosen, so opening and saving can never turn a guess into a choice.
- Switching on automatic sign-ups needs an explicitly chosen webinar audience.
- **Tests:** four tests starting `M1:` in `test/mhp-sequence-safety.test.ts`, plus `test/db/mhp-sequence-safety.integration.test.ts`. The database test now reproduces the production incident: an old sequence started by the old one-press button, everyone paused, two new sign-ups. It checks:
  - no start, enrol or resume by any route;
  - nobody new added;
  - the real worker claim (`claim_v2`) leases nothing for it;
  - "Stop everyone" stops all 5.
  
  It replaces the earlier assertion that such a sequence counts as a webinar sequence.

**S1: never act beyond what the page can see.**
- A start is at most 100 people; above that the owner sees "This list is longer than this page can safely check (N people). Nothing was started." (`service.ts:416`). The "more can be started afterwards" text is gone.
- If a start adds people the page cannot see, everyone active in that sequence is paused and the owner is told why (`service.ts:456-466`).
- When the page cannot see everyone, counts read "At least …" with "(N in total), so these numbers are minimums", and "Resume everyone" is hidden.
- **Tests:** three tests starting `S1:`.

**S2: result notes are bound to their sequence and moment.**
- Each note is signed with the item, version, time and a random action id (`src/mhp/owner-notes.ts:17`, `:24`).
- It shows only on that sequence, for at most 5 minutes, and only while it is the latest action. An HttpOnly, Secure, SameSite=Strict cookie (`mhp_owner_note`) remembers the latest action.
- Both routers use it.
- **Tests:** an `S2:` test; in Playwright, going back or reloading after "Pause everyone" shows no "Started for…".

**S3: no resume that cannot work.**
- People on hold because a newer version exists (or an email changed) get no "Resume" button and are not counted in "Resume everyone". Their card says "They cannot be resumed in this version."
- An old resume form shows a neutral amber note, not a green success one.
- **Test:** one `S3:` test.

**S4: the database fixture is deterministic.**
- One timestamp for every attestation window (`test/db/mhp-sequence-safety.fixture.sql:15`).
- Before the merge: 10 of 10 passes, twice. On the merged head: 3 of 3.

**Owner-email confirmation.**
- "Schedule" now opens a confirmation page (`src/mhp/owner-email-service.ts:275`, `:300`, `:310`, `:321`; new `src/mhp/owner-email-confirm-view.ts` and `src/mhp/webinar-audience.ts`).
- What binds it:
  - a tick;
  - a server signature over the count, a fingerprint of the exact people, the session, item, version, both times and the moment it was shown;
  - a 30-minute expiry;
  - a recount just before the queue command (any difference schedules nobody and explains it);
  - the 100-person limit;
  - a refusal once anyone already has a copy, because the page cannot tell who is left.
- "Replace" confirms how many already-scheduled people it changes ("Nobody new is added") and needs a tick. "Cancel" has a short signed confirmation.
- The service's public `queue` refuses schedule and replace (`:258`).
- Every action redirects back to the page, each form has its own command id, and notes are bound as in S2.
- **Tests:** `test/mhp-owner-email-confirm.test.ts` (7 tests); `test/mhp-owner-email-router.test.ts` updated.

**The notes.**
- The list of names has no inner scroll box; above 30 it says "Showing all N".
- The not-found page's back button goes to the list (`followup-sequence-router.ts:263`, `owner-email-router.ts:191`).
- "native flow form" and "exact versions from your local library" are replaced with plain English.
- The double full stop is fixed.
- After a start, the button is the secondary "Check for anyone new…".
- On the phone layout every link and button is at least 44 px tall and all text at least 15 px; Playwright checks this.
- Two tabs pressing Start together: the second shows "These people had already been started from another tab. Nothing new was sent."
- Someone added in the same instant is described as "not on your list … (a new sign-up, or the automatic sign-up rule)".
- **Tests:** two tests starting `notes:`.

All 13 new behaviour tests in the sequence file and all 7 owner-email tests failed on the old code (e0c8dc5) and pass now. To run the sequence file on the old code I added only its two missing constant exports.

## What the owner sees, word for word
**(a) A sequence with no audience and paused people in it (the book sequence, 14 paused):**
"Who it is for: No one yet. This sequence has no audience that can be started."
"0 active, 14 paused, 0 finished, 0 stopped"
"This sequence has no audience yet. The 14 people in it are paused and will not be sent anything. You can stop them, but not restart them here."
Button: "Stop everyone (14)". Each person's card has a "Stop this person" button and says "This sequence has no audience yet, so they cannot be restarted here. You can stop them."
The confirmation: "Stop all 14 people in this sequence?" then "Stopping is final: nothing more from this sequence will ever be sent to them, and they cannot be restarted. An email already on its way cannot be called back." with "Stop everyone" and "Cancel".
Afterwards: "Stopped 14 people. Nothing more from this sequence will ever be sent to them."

If some people in such a sequence are still active, it instead says: "This sequence has no audience yet, so it cannot be started or restarted here. N people in it are still active and will be sent its next emails unless you pause or stop them." It then offers "Pause everyone (N)" and "Stop everyone (M)".

**(b) The start confirmation:**
"You are about to email N people"
"Who: people who registered for “<label>” (the webinar on <weekday, date>) and agreed to emails."
"First email: “<subject>”, sent straight away."
"Then" followed by each later email, e.g. "“<subject>”: 2 days after the previous email (about day 2)", and the line "Each wait starts once the previous email has gone. Anyone who unsubscribes gets nothing more."
"The N people" with each first name and email (and "Showing all N, in the order they will be started." above 30).
"Held back", e.g. "1 person did not agree to emails", "1 person unsubscribed", "N people are already in this sequence"; then "These people are not emailed."
Tick: "Yes, send to these N people". Button: "Start for N people". Plus "Cancel".
Afterwards: "Started for N people. Their first email is going now."

**(c) The owner-email "schedule" confirmation:**
"You are about to email N people"
"Who: people who registered for “<label>” and agreed to emails."
"Email: “<subject>”, sent <day date, time> (UK time)." (or "straight away"), then "If it cannot go by <time> (UK time), it is not sent."
"The N people" with names and emails; "Held back" (e.g. "1 person did not agree to emails", "1 person unsubscribed"), then "These people are not emailed."
Tick: "Yes, send to these N people". Button: "Schedule for N people". Plus "Cancel".
Afterwards: "Scheduled for N people. It goes <date, time> (UK time)."

## What the server enforces
- **Starting:** only the confirmed path can start a sequence. It checks the audience was explicitly chosen as webinar, the version is published and ready, the signature and expiry, and a recount matching exactly. Forged and old POSTs (`/enrol`, `/start`) are refused.
- **Resuming:** resume (one person and everyone) is refused for a sequence without a startable audience, and resume-everyone is bound to the list it showed.
- **Automatic sign-ups:** need an explicitly chosen webinar audience and the tick.
- **Owner email:** scheduling and replacing only through the signed, recounted confirmation; cancel needs its signed confirmation.
- **Unchanged:** CSRF, origin and session checks, approvals, and who is eligible.

## Remaining limits
- **What the page can see:** only the 100 most recent people across all sequences of the webinar. Starts and owner-email schedules are capped at 100, and once more than 100 people are in sequences, Start and Resume everyone are refused for every sequence.
- **Race window:** someone who signs up in the instant between the recount and the database command is still enrolled, then paused straight away. Their first email can already have been picked up for sending in that gap.
- **Resume everyone:** the database resumes everyone paused in that sequence at that moment, so someone paused between the check and the call is resumed too.
- **Owner email:**
  - It schedules only when nobody has a copy of that email yet.
  - Someone who signs up in the same instant is scheduled and reported (not named or paused; there is no per-person cancel).
  - Replace and cancel confirm counts, not names.

## Migration I recommend next
1. **Explicit recipients for starting.** `mhp_sequence_command_v2(…, p_recipients uuid[])` enrols only people in both the audience and the list, in one statement, and raises if any listed person is missing. Add a read function `mhp_sequence_recipients(session, campaign, version)` that returns exactly who is eligible and not already in. This removes the race window, the safety net and the 100 limit.
2. **Run ids for resume everyone.** Resume only the people passed (`p_runs uuid[]`), refusing anyone held for a newer version or a changed email.
3. **The database refuses non-webinar audiences.** Allow a v3 definition carrying the audience in `mhp_sequence_exact`, and make start, resume and automatic sign-ups raise unless the audience is webinar sign-ups for that campaign. Move the audience from the version's metadata into the definition.
4. **A book-readers audience.**
   - **Who is eligible:** book sign-ups with consent, not unsubscribed, not bounce-blocked, and not having bought the book or course.
   - **Starting:** through the same explicit-recipient path.
   - **Automatic entry:** a capture rule on book sign-up, from sign-up time onwards, with an end date.
   - **Stop on purchase:** a purchase event from the payment webhook stops their sequence before the send check.
5. **Owner email.** `mhp_owner_email_queue_command_v2` with an explicit recipient list, plus a per-person read of who already has a copy, so "remaining" can be named and limited safely.

## Test totals on the merged head (a7746c84)
- **Typecheck:** passes (exit 0).
- **Targeted tests:** 148 pass, 0 fail. These cover sequence safety, the four owner-email files, the sequence router, service and dispatch, entry, operator follow-ups, the PP follow-up flow and the foundation's book-leads file.
- **Real-database test:** 3 of 3.
- **Full suite, plain:** 5,418 tests, 5,296 pass, 0 fail, 122 skipped.
- **Full suite with `CONTENT_AREA_PREVIEW=enabled`:** 5,418 tests, 5,296 pass, 0 fail, 122 skipped.
- **Playwright** at 390 px and 1280 px: all checks pass on the merged head.

## Screenshots
In `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/seq-safety/shots/`: `none-yet-paused-390.png`, `email-confirm-390.png`, `confirm-names-390.png`, and `email-confirm-1280.png`.

## Verified vs assumed
**Verified:** everything in the tests above. The database test ran the real functions and the real worker claim under the real login roles.

**Not run against a real database (in-memory only):** the owner-email confirmation, the safety net that pauses everyone when the page cannot see the extra people, and the two-tabs case.

**Assumed:**
- Production's book sequence versions were all saved before this release; the review could not confirm this.
- Who an owner-email schedule reaches matches `mhp_owner_email_queue_command`; checked by reading it.

**Browser test caveats:** the local server supplies the session cookie, and drops `Secure` from the note cookie because the test runs over plain http.

## What a reviewer should attack first
1. The safety net that pauses everyone (`service.ts:456-466`), including a start of exactly 100.
2. The owner-email refusal once anyone has a copy: does the per-email total cover every case the database uses? And is the replace/cancel fingerprint, which uses only counts, enough?
3. The note cookie as the record of the latest action when two tabs are open.
4. That no route still reaches `queue('schedule')` or `command('resume')` for a sequence without an audience.
5. The merge choice: my framed workspace page replaces the foundation's simpler page on both routers.
6. `stopAll` on a sequence with more than 500 open people; it repeats until done, but this was never run.