# Second-pass review: `claude/mhp-book-crm` at `91f8d7c343f584038bd4238166bef48037562d50`

Head confirmed with `git rev-parse HEAD`; the tree stayed clean and I changed no tracked file. Delta reviewed: `git diff b7a05ba..91f8d7c`. Everything marked "ran" was run on my own PostgreSQL 16 clusters (non-superuser `CREATEROLE` migrator, real role logins, the repo's migration runner, the two `docs/ops` files applied as recorded). Both clusters are stopped and removed.

## Verdict

1. **Deploy the code with the trigger still present?** Yes. M1 and S1 are fixed and verified; I found no must-fix in the code. One release-plan check first: this branch is based on `fd1d9f5` and does not contain `a278b92` (see R1).
2. **Then apply 0159?** Yes. The migration is sound in both starting states, including the new schema part. Apply only after the read-only gates below pass.
3. **Anything to fix first?** Nothing blocking. Four should-fixes, of which SF1 is a new regression from the S1 fix and SF2 matters for when the mobile field is shown again.

## Release-plan check before deploy

**R1. The reviewed head does not contain `a278b92`.** `a278b92` (#132, keyword-first planning) is a descendant of `fd1d9f5`; this branch is not based on it. If `a278b92` is what is live, deploying this head as it stands would drop #132. The two do not overlap: no common changed file, an in-memory merge had no conflicts, and `a278b92` adds no migration, so 0159 and its checksum are unaffected. The release artefact must be the merge. (That trial merge wrote one unreachable tree object into the repo's object store; nothing else was touched.)

## Read-only gates before 0159

- **G1. Owner mode.** The start-up log line now reads `{"event":"mhp.book-leads.readiness","mode":"automatic","automatic":true}`. If it says `no_owner` or `owner_cannot_manage`, sign-ups and mobiles are still saved after 0159 but reach Leads only when the owner presses the button (see area 6).
- **G2. Pre-flight the catalog** (queries at the end). Unrecorded extras still survive silently; a pre-existing `phone` column or same-named function makes 0159 fail cleanly.
- **G3. Ledger at exactly `0158_affiliate_studio.sql`, and every service and worker on a build that bundles 0159.**

**What "no rollback" means, precisely (ran).**
- This build is READY at 158 with the trigger and at 159.
- The `fd1d9f5` build on a database with 0159 fails readiness: "Database contains migration not present in this release: 0159_mhp_book_crm.sql". It cannot start, restart, scale up or be redeployed.
- An old-build process already running keeps serving: book, webinar and cheat-sheet captures and the registrant list all worked against a 0159 database. But it makes no lead (trigger gone, no app path) and keeps no mobile.
- So every web instance must be on the new build before 0159, and any later "revert" must be a forward build that still bundles 0159.

## Findings

### SHOULD-FIX

**SF1. New: the replay loop can fail for ever on one person and block the owner's button for everyone after them.**
- **Ran** (`pass2/p9-poison.mts`). I made a lead, then moved its email onto another record with no book enquiry (the same state arises if the owner removes the email and a webinar import later creates a new record with it).
- The copy then throws "Book lead kept changing while it was being copied" on every try: 4 attempts, 98 ms, no rows written.
- Three button presses each returned `failed:true` at that person; the person after them in order was never brought in by the button.
- In `automatic` mode the visit catch-up steps past them (one failure logged per visit). In `no_owner` and `owner_cannot_manage` the button is the only way in, so later sign-ups are stuck.
- At `b7a05ba` this case returned `present` and the batch carried on.
- Where: `book-leads-service.ts:476-515` (`classify` says `create` while a receipt for the key names another contact).
- Smallest fix: when the attempts end on a replay, return `skipped` with a "needs you" reason instead of throwing; or have `importBatch` count the person and move the cursor past them.

**SF2. For up to 5 minutes after 0159, a running process still skips keep-phone.**
- **Ran** (`pass2/p8-path.mts` §3). A process that probed before 0159 caches "function missing" for 5 minutes (`growth-service.ts` `bookFunctionsMissingUntil`); an owner page view sets the same cache.
- The first sign-up right after 0159 in that process: `kept=missing`, sign-up row phone `null`, owner read `null`. Five minutes later: `kept`, read works.
- In `automatic` mode the mobile still reached Leads through the in-process copy. In `no_owner`/`owner_cannot_manage` nothing copies it, so a mobile typed in that window is lost.
- Fix: restart the web service straight after 0159, or wait 5 minutes before showing the field; in code, shorten the cache or re-probe when a mobile is present.

**SF3. The awaited keep-phone has no timeout of its own.**
- **Ran**: normal cost is 1 ms median, 6 ms max over 40 sign-ups (capture 2 ms median).
- With the new row locked by another session it waited the full pool statement timeout (4.0 s on my 4 s setting; the production default is 15 s, plus up to 5 s to get a connection), then the route answers normally and logs "mobile not kept".
- Nothing realistic locks a brand-new row; this is a database-stall case. Smallest fix: a 2 s cap around the call.

**SF4. Wording is wrong during the window before 0159 in `no_owner` mode.**
- **Ran** (`pass2/p7-modes.mts` B). The page and the log say "They and their mobiles are saved" while `kept=missing`. The page also says sign-ups are "not going into Leads automatically" while the trigger is in fact making the lead (1 of 1 in Leads).
- Fix: say "mobiles are saved" only when the stored read is available.

### Notes
- **Keep-phone checks kind and module, not label.** A waitlist row with the book module and another label was accepted (ran). The app only calls it for the exact book form, and the owner read filters by label, so the number is never shown.
- **Format gaps.** A tick typed in the other UK format does not upgrade the person's own book-only number (stays `unknown`, ran). "+44 (0)7700…" becomes `+4407700…` and is not matched to `07700…`.
- **`owner_cannot_manage` never clears without a restart** (read). Before the start-up probe answers, the mode reads `automatic`; the first failed copy flips it (ran).
- **Not atomic.** A process crash in the 1–2 ms between capture and keep-phone leaves no stored mobile (read).
- **Waiting count** covers the people on the page (latest 2,000 registrants), not all time (ran on 50,000 rows).
- **Readers of the new column.** `r72_sms_definer`, `r72_whatsapp_live_definer` and `r72_email_block_definer` hold table-wide SELECT on sign-ups, but no function, view or policy of theirs references the column (catalog search, ran). Only the two new functions read or write it, so it is not an authority for any text, WhatsApp or reminder.
- **Still true from pass 1:** a policy renamed without the prefix and extra grants survive 0159 silently; the theoretical lock-order deadlock with an in-flight copy (not reproduced).
- A stranger using someone's email puts their own number on their own sign-up row and, in Leads, as a second unverified number on that person's record. The victim's row keeps its number (ran). Unchanged in kind from before.
- `followup-sequence-router.ts`: the two CRLF lines are restored, so they no longer differ from `fd1d9f5`.

## The seven attack areas

### 1. Migration 0159 (held, ran)

- **Fresh 0158 → 0159** (17,639 catalog lines): gains exactly the `phone` column (text, nullable), `mhp_prospect_signups_phone_check`, the two functions with their four grant lines, and the ledger row. Nothing else.
- **Production-shaped 0158 → 0159**: removes the old trigger, old function, ten `mhp_book_*` policies and the nine recorded grants; adds the same new objects. `SELECT` on `contact_points` and the two `mhp_event_phone_*` policies are kept.
- **Fresh-0159 vs production-0159:** identical.
- **Rows:** CRM and prospect digests identical; sign-up rows identical apart from the new null column.
- **Second run** of the file: no change. **Rolled-back run:** catalog identical to before.
- **16 production variants:**

| Variant | Result |
|---|---|
| policy missing; renamed with prefix; function replaced; trigger dropped or disabled; `CREATE` left granted | converge exactly |
| policy renamed without prefix; extra grants; extra UPDATE policy plus grant | applied, extras remain (as before) |
| old function owned by another role; `mhp_book_*` policy for another role; second trigger on the function | clean failure, trigger still present, no column, no new functions, ledger 158 |
| `phone` already there as integer, or as text without the check | clean failure `55000`, nothing applied |
| `mhp_book_signups` already owned by another role | clean failure `42501`, nothing applied |

No half-applied state in any case.

- **Locks.** `ACCESS EXCLUSIVE` on sign-ups and the seven CRM tables for the whole file: 58–144 ms on small tables, 116 ms on 50,000 sign-ups.
  - 624 sign-ups hammered across the migration: 0 failed, worst 58 ms.
  - With a long reader holding sign-ups (and separately `app.tasks`): the migration failed at 5 s with `55P03`, fully rolled back; three sign-ups that arrived meanwhile succeeded after about 3.7 s; the retry applied in 87 ms.
- **Dependents of the sign-ups table.** I listed all 21 functions that name it; there are no views.
  - Two use `%ROWTYPE` with `SELECT *` (`mhp_event_phone_from_signup`, `mhp_sequence_enrol_captures`).
  - On connections opened before the migration and reused after: webinar, book and cheat-sheet capture, the phone hand-off (real function), the enrol sweep (real function, plus the same rowtype loop in a session function that went from 14 to 15 columns), the registrant list and growth summary all worked.
  - The 0128 immutability trigger still refuses any change to an accepted webinar row, including `phone`; keep-phone only touches rows with no entry sequence.
  - Only a named prepared `SELECT *` held by a session breaks ("cached plan must not change result type"); the app has none, and no app code names the table.
  - All test fixtures use explicit column lists.
- **Verify block (read).** It cannot fail on the recorded production state. It can pass with leftover unrecorded grants (variants above) and does not compare function bodies or the check's text.
- **Checksum.** sha256 of `0159_mhp_book_crm.sql` as I computed it: `76fd4a6c894c6868ac65e14bdc466d8cbab20479177586b86bb9c994760a8607` (raw and LF-normalised), equal to `MHP_BOOK_CRM_CHECKSUM` and to the ledger row written. `db:check`: "behind by 1" before, "current" after.

### 2. `mhp_book_signup_keep_phone` (held, ran `pass2/p2-keepphone.mts`)

- **Who can call it.** `r72_web`, `r72_crm_command`, `r72_worker`: permission denied. Superuser, and superuser with `SET ROLE r72_identity_command`: "Invalid capture boundary". Nothing granted to PUBLIC. SECURITY DEFINER with `search_path=pg_catalog`.
- **As the capture login**, it returned false for: wrong prospect for the sign-up; random ids; webinar, cheat-sheet and course rows; a row older than 10 minutes; null, short, long, lettered, trailing-newline and full-width-digit numbers; and a replay with a different number.
- The capture login cannot read or update the table directly. The CHECK holds even for the owner role.
- The visitor never supplies the ids; they come from the capture's own result.
- It writes nothing to `mhp_prospects.phone` (still only the webinar number).
- No timing oracle beyond what capture already has: it is one update by primary key.

### 3. `mhp_book_signups` (held, ran)

- Authorisation text is identical to `mhp_list_registrants`.
- Refused (`42501`): no such session; owner with a session for the other product audience; a workspace admin who is not a programme admin; a revoked session; the capture login; superuser with `SET ROLE r72_web`.
- Returns only rows with the book kind, module and label: latest per person, at most 2,000.
- On 50,000 sign-ups: 76–86 ms and about 870 KB of JSON (registrant list: 65 ms).

### 4. Request path
Held, with SF2 and SF3. Before 0159 the missing function is silent: 1 ms once, then skipped, no log noise.

### 5. M1 and S1 (fixed, ran)

- **WhatsApp gate** (`pass2/p6-gate.mts`). `mhp_wa_owner_number_blocked` gave the same answer before and after in every case:
  - mobile with no tick (old form and `book-2026-11`), and with the tick;
  - a stranger typing an existing WhatsApp contact's number, in `07…` and `+44…`;
  - a number another contact holds in either UK format, including one that is really opted out (stayed `opted_out`; that contact's point and `row_version` untouched);
  - catch-up from stored sign-ups.
- **No `opted_out` phone point** was written by any path. Zero consent-ledger rows.
- **Upgrade rules.**
  - Own book-only number plus a later tick becomes `opted_in`.
  - A later sign-up without the tick keeps `opted_in`.
  - A recorded STOP blocks the upgrade.
  - An owner's opt-out is left alone.
  - A number the owner added by hand is not upgraded.
- **S1.** My race with differing mobiles: 8 runs × 12 people, 0 mobiles lost (was about 4 of 12 per run).
- **Counts.** 36 simultaneous sign-ups, two instances, catch-up and button together, trigger live and after 0159: 12 contacts, 12 enquiries, 12 open tasks, 12 phone points, at most 2 timeline entries per person.
- **Loop bound.** 4 attempts; in the stuck case no rows are written. See SF1 for what it does when it gives up.

### 6. Owner modes (ran `pass2/p7-modes.mts`)

- **`no_owner` after 0159.** Three sign-ups wrote only prospect and sign-up rows, mobiles kept. A visit copies nothing. The page says "0 of 3… 3 are waiting", and the count was right. One press made all three leads with their mobiles and the right texts state. A later sign-up waits again: pressing no longer arms automatic copying.
- **Plainly:** safer than before (no sign-up is skipped and no mobile is lost while an owner is absent, and the page says so), but worse for immediacy (nothing arrives in Leads without a press, and a visit to Book interest no longer brings anyone in).
- **`owner_cannot_manage`.** Same waiting behaviour; the button assigns to the workspace's single owner.
- **`automatic`.** Copied at sign-up; visit catch-up correct; a crash before the copy is completed at the next visit with the stored mobile and the correct tick state; an unsubscribe is reflected at the next visit and lifted when the person ticks again.

### 7. Regression (held, ran)

- Non-book forms: parse results, SQL text and parameters identical to `fd1d9f5` for 10 forms (same digest as pass 1); stored webinar and cheat-sheet rows have `phone` null; keep-phone is not called for them.
- Book consent fields on a webinar or cheat-sheet post are now ignored (`site-2026-10` stored).
- Owner edits (rename, stage move, contact rename) untouched by repeat sign-ups.
- Archived, deleted, email-removed and `.invalid` cases skipped as before.
- UK `07…`/`+44…` now treated as one number.
- Nothing outside the workspace written.
- Every-table row diff for one sign-up: trigger live, only the trigger's rows plus one timeline entry and the phone point; after 0159, prospect, sign-up, contact, 2 points, enquiry, task, 2 timeline entries, 1 receipt, 2 pending outbox rows. Nothing in any send, message, provider or consent table.
- CRM locked after 0159: sign-up committed in 1–2 ms, lead made once after unlock. With the trigger live the sign-up still fails at the statement timeout (unchanged old-trigger risk until 0159).
- Screens at 390 px with hostile values in every new cell: no script ran, no page overflow, the three mode sentences read correctly.
- **Tests.** The five changed unit and contract files: 147 of 147 pass. The two changed DB files: 6 of 6 on my cluster with real role logins and both starting states (50.5 s), matching the builder. Removed assertions were replaced by stricter ones (exact list of what 0159 adds; sign-up row digest excluding only `phone`; "never `opted_out` on a phone"); none was loosened. Full suite not run, as instructed.

## Can the website's mobile field be shown again?

**Yes, after 0159**, on these conditions:
- 0159 is applied and each web process has been restarted, or 5 minutes have passed (SF2).
- The readiness line says `automatic`. In the other modes mobiles are still kept, but leads wait for the button.

**Not before 0159:** the function is missing and the mobile is not stored.

**Residual risk afterwards:** a crash in the 1–2 ms before keep-phone, or a keep-phone timeout. In `automatic` mode the lead normally still gets the number.

## Read-only checks

**Before 0159, on production:**
```sql
SELECT max(filename), count(*) FROM app_private.schema_migrations;   -- 0158_affiliate_studio.sql, 158
SELECT c.relname, string_agg(a.privilege_type,',' ORDER BY 1) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE c.relnamespace='app'::regnamespace AND a.grantee='r72_mhp_prospect_definer'::regrole
 AND c.relname IN ('contacts','contact_points','pipelines','pipeline_stages','opportunities','opportunity_stage_history','tasks') GROUP BY 1 ORDER BY 1;
SELECT tablename, policyname, cmd, roles FROM pg_policies WHERE schemaname='app'
 AND ('r72_mhp_prospect_definer'=ANY(roles) OR policyname LIKE 'mhp\_book\_%') ORDER BY 1,2;
SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.proname LIKE 'mhp\_book%';
SELECT tgrelid::regclass, tgname, tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgfoid::regprocedure::text LIKE '%mhp_book%';
SELECT attname, atttypid::regtype FROM pg_attribute WHERE attrelid='app_private.mhp_prospect_signups'::regclass AND attname='phone' AND NOT attisdropped;
```
Expected:
- grants `contact_points:INSERT,SELECT`, `contacts:INSERT,SELECT`, `opportunities:INSERT,SELECT`, `opportunity_stage_history:INSERT`, `pipeline_stages:SELECT`, `pipelines:SELECT`, `tasks:INSERT`;
- the ten `mhp_book_*` policies plus `mhp_event_phone_points_public_read` and `mhp_event_phone_signup_email_read`;
- exactly one function, `mhp_book_contact_after_signup()`, owned by `r72_mhp_prospect_definer`;
- one trigger on `app_private.mhp_prospect_signups`;
- no `phone` column.

Anything else: stop and review.

**After 0159:**
```sql
SELECT filename, checksum FROM app_private.schema_migrations ORDER BY filename DESC LIMIT 1;  -- 0159_mhp_book_crm.sql, 76fd4a6c…a8607
SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.proacl FROM pg_proc p WHERE p.proname LIKE 'mhp\_book%';
SELECT count(*) FILTER (WHERE phone IS NOT NULL) AS with_mobile, count(*) FROM app_private.mhp_prospect_signups WHERE module='book-before-you-buy';
-- must stay 0: a phone point the book path marked that is opted out
SELECT count(*) FROM app.contact_points p JOIN app.contacts c ON c.workspace_id=p.workspace_id AND c.id=p.contact_id
 WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND p.kind='phone' AND p.consent_status='opted_out'
 AND c.custom_fields->'mhpBookPhones' ? p.normalized_value;
```
Expected:
- grants show only `contact_points:SELECT`; only the two `mhp_event_phone_*` policies remain; no trigger;
- exactly two functions, `mhp_book_signup_keep_phone(uuid,uuid,text)` and `mhp_book_signups(bytea)`, both owned by `r72_mhp_prospect_definer`, security definer, `search_path=pg_catalog`, executable by `r72_identity_command` and `r72_web` respectively and not by PUBLIC.

The last query can be non-zero only if the owner or a real STOP later opted out a number the book path added; check any hit by hand.

Also confirm: the readiness log line; Book interest reads "N of N are in your Leads" with the mobile and texts columns filled for a test sign-up; no `mhp book leads:` warnings.

## What I could not verify

- Production itself: environment and owner mode, the actual catalog and ledger, which commit is live.
- What the website form posts.
- The full HTTP stack end to end; I drove the same call order (capture, keep-phone, copy) directly and ran the router's unit tests.
- How the host shuts a process down mid-request.
- The real sequence sweep with an active entry rule; I ran the real function with none and the identical rowtype loop separately.
- The full suite.

Scripts and outputs are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-book-crm/` (pass 2 in `pass2/`: `p1-rowtype` to `p9-poison`, catalog listings `*.sorted`, variant results `v*_test.after.sorted`). The DB test run left its own `r72-book-crm-*` temp directories in `/tmp`; I left them alone.