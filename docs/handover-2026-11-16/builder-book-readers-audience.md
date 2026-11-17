## Release B (book readers audience): complete, all tests pass, pushed

There was no PR, merge or deploy, no `mcp__*` tools were used, and no request went to production. The safety branch and `/home/user/r72-seq` were not touched.

- **Head:** `ca7c217feec8073123377ded2fd7df7331fee737` on `origin/claude/mhp-book-readers-audience`, built on a7746c84. The local head and the remote head match, and the tree is clean.
- **Worktree:** `/home/user/r72-bookseq`.
- **Migration:** `orchestrator/src/db/migrations/0160_mhp_book_readers_audience.sql`, sha256 `5ca18d80d089c27307f9d44aea2ccad91f99f549d6bf42a6249142a34697b405`. The hash is pinned in `src/db/mhp-book-readers-schema.ts` and in the SQL contract test.
- **Commits:** a089df5f (migration), 24a5b8a9 (app), 9f763508 (database tests), f68869cc (readiness admission), 946000c6 (fixture and book CRM fix), e532da11 (unit and router tests), ca7c217f (two fixes from the browser walk).

### Design decisions and why
1. **The audience is saved in each version's metadata** (`mhpSequence.audience`, kind `book_readers`, campaign null). Versions are append-only, so nothing is ever guessed. The database reads it through `mhp_sequence_version_audience`.
2. **A book reader's record of being in a sequence keeps the webinar campaign in `campaign` and adds `audience` = 'book_readers'.** This lets the existing claim, prepare and email checks work without rewriting them. Only the "allowed" and "audience" functions gained a book branch.
3. **The old 0128 functions are kept, renamed to `*_0128`.** Wrappers with the original names add the audience checks:
   - one-press "add everyone" is refused once 0160 is on;
   - resume is refused if the saved audience no longer matches;
   - the webinar automatic rule only works for a webinar audience.
4. **Every start goes through an explicit recipient list** (`mhp_sequence_start_v2`, 1–500 distinct people). The database rechecks every person and refuses the whole list if any one is not eligible. On 0160, webinar starts use this path too.
5. **Automatic entry uses a receipt per switch and sign-up** (unique), not a cursor. Each sign-up is looked at exactly once, and one that commits late is not lost. Only sign-ups created at or after the moment the switch went on are considered.
6. **People who buy are stopped in the worker's sweep**, which runs before each claim, with the reason 'purchased'. Claim and prepare also refuse them, as a second check.
7. **New code works on a database still at 0159.** The 0160 functions are missing there (error 42883), so the app returns null. Book sequences then show "This will be ready after one database step…", and webinar sequences keep the safety release's path.

### Requirements 1–6
1. **Audience choice:**
   - `src/followup-sequences/audience.ts:19,68-82`;
   - the editor radio at `src/followup-sequences/editor-view.ts:29`;
   - the database read at migration line 129.
   - Tests: `test/mhp-book-readers.test.ts` (the first two tests) and `test/mhp-sequence-safety.test.ts`.
2. **Automatic entry:**
   - switch on and off: `followup-sequence-service.ts:457`, router `:224`;
   - status card `followup-sequence-view.ts:236`, confirm page `:374`;
   - worker `followup-sequence-dispatch.ts:30,59`;
   - migration: `mhp_book_entry_command` (330), `mhp_book_sequence_sweep` (374), switch and receipt tables (49, 61).
   - Tests: the "switching on" and "worker" tests in `mhp-book-readers.test.ts`; in the database test, the switch only takes people after its moment, sends the first email straight away, is safe to run twice, and switches off.
3. **Named start for earlier sign-ups:**
   - `plan()` `:476`, `startExplicit` `:588`;
   - confirm page `followup-sequence-view.ts:314`;
   - migration `mhp_sequence_eligible` (220), `start_v2` (263).
   - Tests: the "named start" and "becomes ineligible" tests, plus the database test of the explicit start.
4. **Eligibility in the database:**
   - `mhp_book_reader_reason` (152): not a book sign-up / unsubscribed / no consent / blocked / purchased;
   - anyone who has ever been in the sequence is excluded inside `eligible` and `start_v2`;
   - webinar-only registrants come back as `not_book`.
   - Test: `test/db/mhp-book-readers.integration.test.ts`.
5. **Stop on purchase:** the existing `mhp_has_purchase_email` (0114) reads `app.purchases` by buyer email, and the sweep stops with 'purchased'. The owner sees "Stopped because they bought from you…" (`followup-sequence-view.ts:60`). The signal has two gaps:
   - a buyer who paid with a different email is missed;
   - there is no book product, so "bought" means any MHP product: kit, course, room or private.
6. **Email only, nothing switched on:** the migration starts, switches on, schedules and sends nothing. The post-check confirms there are no switches and no new records.

### Exact owner wording
- **Audience choice:** "Book readers: people who asked for the Before You Buy first chapter and ticked the email box". The "No one yet" choice now reads "No one yet. Save it now and choose who it is for later."
- **Named start:**
  - heading "You are about to email N person/people";
  - "Who: people who asked for the Before You Buy first chapter and agreed to emails.";
  - held-back lines including "1 person's email address bounced or is blocked" and "1 person has already bought from you";
  - the list "Who is already in this sequence (N)", where each line ends "already in this sequence (stopped)";
  - tick "Yes, send to these N people", button "Start for N people".
- **Switch-on page:**
  - heading "Send this to each new book sign-up automatically?";
  - "From the moment you confirm, everyone who asks for the Before You Buy first chapter and ticks the email box will be added to this sequence and sent "…" within a few minutes of signing up, then N more emails on schedule.";
  - "People who signed up before now are not added by this. You can start them yourself with "Start this sequence…".";
  - "Nobody who has ever been in this sequence is added again, and nobody who unsubscribed, whose email bounced, or who has bought from you.";
  - "You can switch this off at any time.";
  - tick "Yes, send this to each new book sign-up automatically", button "Switch on".
- **After switching:** "Switched on. From now on, each new book sign-up who agrees to emails gets this sequence…" and the card "On since … (UK time). N people added automatically · N not added", with the button "Stop sending to new book sign-ups".
- **Guidance on the old sequence that has no audience:** "To send this to book readers: in "Edit your sequence" below, choose "Book readers" under "Who is this for?", press Save draft, then Publish this version, then switch on "Send this to each new book sign-up automatically". Your emails stay exactly as they are."
- **On 0159:** "This will be ready after one database step. The sequence is saved; nothing has been sent."

### What the database enforces and what the app does
**The database enforces:**
- who is eligible, and the refusal of a whole list if any person is not eligible;
- that nobody is ever added to a sequence twice;
- that the audience matches on start, resume and automatic entry;
- that one-press "add everyone" is refused;
- that a switch only takes sign-ups after its moment, each looked at once;
- the purchase stop;
- that the audience field and the switch and receipt rows cannot be changed afterwards;
- grants, forced row security and no PUBLIC execute (the migration's own check block).

**The app does:**
- the tick requirements;
- re-planning when the list changed, so the owner sees "The list changed, so nothing was sent";
- the 500 cap on what is shown;
- the 0159 fallback;
- all wording.

### Release order and checks (read-only)
**Order:** new code on all nine services first, then apply 0160 by hand. Readiness accepts exactly one pending migration, 0160, on top of the exact 159 and 158 (`runtime-readiness.ts:453-458`). A 159-file build containing this code stays ready after 0160 is applied (`:342-346`). The released 159 build (cda1d9d) does not have that bridge, so every service must be on the new code before the migration runs.

**Before:**
- the latest applied row in `schema_migrations` is 0159 with its exact checksum;
- `SELECT to_regprocedure('app_private.mhp_sequence_command_0128(bytea,text,uuid,uuid,text,uuid,uuid,text)')` is NULL;
- `to_regclass('app_private.mhp_book_entry_switches')` is NULL;
- count the existing records in `mhp_followup_runs` (to compare after).

**After:**
- 0160 is applied with the checksum above;
- the 14 functions plus the four `*_0128` are owned by `r72_mhp_prospect_definer`, are SECURITY DEFINER with `search_path=pg_catalog`, and have no PUBLIC execute;
- `r72_identity_command` can execute command, start_v2, resume_v2, book_entry_command and sweep, but not `*_0128`;
- `r72_web` can execute only `eligible` and `book_entry_read`;
- the definer has no CREATE on `app_private`;
- forced row security is on for both new tables;
- `SELECT audience, count(*) FROM app_private.mhp_followup_runs GROUP BY 1` shows only 'webinar_signups', with the same count as before;
- `mhp_book_entry_switches` and `mhp_book_entry_receipts` are empty;
- no record created after the migration time.

### Remaining limits
- 500 people per start; anyone over that is shown "N more after this".
- Automatic entry runs on the worker tick (100 per sweep), so the first email goes within a few minutes, not instantly.
- The purchase match is by email only, and "bought" means any MHP product (there is no book product).
- The page counts still come from the existing 100-row snapshot.
- After 0160, the old one-press "add everyone" is refused. This is by design.
- There is no separate hold on webinar automatic rules created by older versions. None are active in production; this is assumed, not checked.
- One wording issue from the safety release that I left alone: "Yes, send to these 1 person".

### Test totals
- **Full suite, plain:** 5,432 tests, 5,308 pass, 0 fail, 124 skipped.
- **Full suite with `CONTENT_AREA_PREVIEW=enabled`:** the same, 5,432 / 5,308 / 0 / 124.
  - Both runs skip the database tests because the database settings are not set; that is the 2 extra skips compared with the safety branch's 122.
- **Database tests, run separately on local PostgreSQL 16 migrated to 0160:**
  - book readers integration, sequence safety integration, runtime readiness and SQL contract: 124 / 124 pass;
  - book CRM integration: 5 / 5 pass (the earlier order-A failure is fixed).
- **Targeted unit and router files:** 97 / 97 pass, including the 10 new tests in `test/mhp-book-readers.test.ts`.
- **`npm run typecheck`:** clean.

### Browser walk
- Done at 390 and 1280 pixels, local server only. The route that blocks other hosts is installed before the first navigation, and a deliberate probe was aborted twice (once per width).
- **Screens checked:**
  - the audience choice;
  - the named start, including the "(stopped)" list;
  - the switch-on page;
  - the switch status card, then switching off;
  - the 0159 database-step notice;
  - the guidance on the old sequence that has no audience.
- **Checks at 390:** no horizontal scroll, every tap target at least 44 px, no banned words in owner text. The radio labels measure 84–112 px.
- **Two fixes came out of the walk:**
  - the shared confirm tick was 31 px tall; the `.check` style now has a 44 px minimum height, added to the end of the rule rather than rewriting it;
  - the "No one yet" choice still said "for example, book readers", which is now its own choice; it was reworded.
- **Screenshots (12 files)** are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/book-readers/shots/`. The walk script is `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/book-readers/walk.mts`.

### Verified versus assumed
**Verified on a real 0160 database:**
- all the eligibility exclusions;
- an explicit start that names an ineligible person is refused;
- a stopped person is never added again;
- wrong-audience refusals;
- the switch-moment cut-off and the sweep being safe to run twice;
- the purchase stop;
- the claim leases exactly the active people;
- prepare carries the book label and link;
- resume through the explicit list;
- the audience field cannot be changed;
- the old functions are still present.

**Behaviour as at 0159:** verified by renaming the 0160 functions so they are absent. It was not tested against a real database that never had 0160.

**Assumed:**
- production is at exactly 0159 with the checksum the tests expect;
- no webinar automatic rule is active in production;
- `app.purchases.buyer_email` is filled for real Stripe purchases.

### What a reviewer should attack first
1. **`mhp_book_sequence_sweep`** (migration line 374): the receipt uniqueness, the `created_at >= activated_at` boundary, and what happens if the switch is turned off mid-sweep.
2. **The `*_0128` renames and wrappers:**
   - can `r72_identity_command` reach any old body;
   - does the "add everyone" refusal close the old one-press path completely.
3. **`mhp_book_reader_reason`:**
   - "latest sign-up" semantics when a person has both a webinar and a book sign-up;
   - the hard-coded MHP workspace id used for blocked addresses;
   - the new row-security policy that lets the definer read `email_address_blocks`.
4. **The readiness bridge** (`runtime-readiness.ts:342-346, 453-458`) and the order in which the nine services and the migration are released.
5. **On 0160, webinar starts move to the explicit list.** Reviewers should check that the plan, the digest and a refused list hold together on that path.