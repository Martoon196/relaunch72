# Independent review: `claude/mhp-book-crm` at `b7a05bae2f67974dc49e4f50875e73fb052d9743`

Head confirmed with `git rev-parse HEAD`; it did not move during the review and the tree stayed clean. I modified no tracked file and made no commit. All "ran it" evidence is on my own PostgreSQL 16.15 clusters (non-superuser `CREATEROLE` migrator, real role logins), migrated with the repo's runner, with the two `docs/ops` files applied exactly as recorded.

## Verdict

1. **Safe to deploy the code with the trigger still present?** Yes after one named fix (M1). Otherwise the new code is safe beside the trigger: one contact, one enquiry, one open task under heavy races, and the public form is not slowed by the new code.
2. **Safe to then apply 0159 to production?** Yes, the migration itself is sound. Apply it only after three read-only gates pass (G1–G3 below).
3. **Anything to fix before either?** Yes: M1 before deploy. Before the website's mobile field is shown again: S1 and a decision on S2.

## MUST-FIX before deploy

**M1. "About the book only" is stored as `opted_out` on the phone point, and the existing WhatsApp tool reads that as a real opt-out.**
- **Ran it** (`s1-basics.mts`, `s6-people.mts` §1, `s7-consent.mts`). After a book sign-up with a mobile and no texts tick, `app_private.mhp_wa_owner_number_blocked('447700900123')` returns `opted_out`. That is the gate the owner one-to-one WhatsApp send uses (`0151_mhp_whatsapp_owner_one_to_one.sql:429-441`, called at `:485` and `:937`). The owner is told "This person has opted out of WhatsApp. Nothing can be sent." (`src/integrations/group-hq-crm/whatsapp-owner.ts:45`).
- **It is number-level across the workspace.** I created an existing WhatsApp contact holding `+447700900555` (block = null). A different person then posted the public book form with `07700 900555`; the block for that number became `opted_out`. Anyone can therefore stop the owner's WhatsApp to any number through the public endpoint, whether or not the site shows the field.
- **It happens with the trigger live too**, from the first sign-up that carries `PHONE`.
- No other code writes `opted_out` automatically, so until now it has only ever meant a real opt-out. `opted_in` on a point is read by no sender (grep of `src` and all migrations).
- **Where:** `src/mhp/book-leads-service.ts:315` (new point) and `:232` (`phonePermission`).
- **Smallest fix:** never write `opted_out` from the projection. Use `unknown` for a mobile without the tick and keep "about the book only" in `mhpBookPhone`, the task text and the timeline. Let `phonePermission` upgrade `unknown` to `opted_in` on a later tick when there is no suppression, and leave an existing `opted_out` alone. Update the tests and doc that assert `opted_out` (`test/db/mhp-book-crm.integration.test.ts` ≈ lines 351, 390, 573–590; `docs/mhp-book-leads.md`).

## MUST-CHECK before 0159 is applied (read-only gates, no code change)

**G1. Confirm the lead owner is configured on the service that serves `/api/mhp/subscribe`.** The start-up log line must read `{"event":"mhp.book-leads.readiness","automatic":true}`. It needs a valid `R72_GROUP_HQ_INBOX_SECRET` and an `mhp` scope in `R72_GROUP_HQ_INBOX_SCOPES` whose `workspaceId` is `2789228d-…` (`runtime.ts` `mhpBookLeadOwner`, `inbox.ts:60-66`).
- **Ran it** (`s8-owner.mts` B/C) without that setting:
  - a sign-up before the first owner visit after a process start is skipped, not queued (one log line), and its mobile is gone for good;
  - an owner visit when nothing is due does not arm automatic copying (`automatic` stays false);
  - every restart resets it.
- While the trigger is live this is masked, because the trigger makes the lead. After 0159 it would mean no lead until the owner opens the pages.
- With two active owners: the visit fails, and the button answers 503 "needs exactly one active owner". With a configured owner who cannot manage the workspace: every copy fails `forbidden_scope` and there is no fallback.

**G2. Pre-flight the production catalog against the recorded state** (queries at the end). 0159 never fails half-way, but it only removes what was recorded. **Ran** 12 production-shaped variants:

| Production differs by | Result |
|---|---|
| a policy missing; a policy renamed but still `mhp_book_*`; function replaced again; trigger already dropped or disabled; `CREATE` on schema left granted | Converges exactly |
| a policy renamed without the prefix | Succeeds, orphan policy stays (inert, its grant is revoked) |
| extra grants (`UPDATE` on contacts, `SELECT` on tasks), or an extra `mhp_book_*` UPDATE policy plus `UPDATE` grant | Succeeds, the extra grants stay silently (the verify block checks only the nine recorded ones) |
| function owned by another role | Clean failure `42501`, nothing applied |
| an `mhp_book_*` policy for another role | Clean failure `55000`, nothing applied |
| a second trigger using the function | Clean failure `2BP01`, nothing applied |

**G3. Ledger at exactly `0158_affiliate_studio.sql`, and every service and worker on this build first.** **Ran** (`s10-gate.mts`): this build is READY at 158 with the trigger and at 159. The fd1d9f5 build is NOT READY on a database containing 0159, so there is no rollback after 0159.

## SHOULD-FIX

**S1. A mobile is silently dropped when two copies for the same person race and the one without the mobile creates the lead.**
- **Ran it** (`s4c-race-debug.mts`, after 0159): three simultaneous sign-ups per person (mobile, none, mobile). In every run about 4 of 12 people ended with no phone point. Trace: `[B] sign-up phone=n -> created`, then `[A] sign-up phone=y -> present phone:none`. Nothing is logged and nothing retried.
- **Cause:** the loser's guarded transaction throws `ProjectionChanged`; `createOrReplaySignupLead` (`signup-leads.ts:80-88`) finds the winner's receipt for the same key and returns a replay. The retry at `book-leads-service.ts:427-429` never runs, so `enrich` is skipped.
- The same path drops the loser's `+messages` tick and `mhpBookLatest`.
- It can also happen when the owner's catch-up, which carries no mobile, wins against the at-sign-up copy. That is rare: 0 of 60 in `s4b`.
- It does not happen with the trigger live (12 of 12 phones).
- **Smallest fix:** when the result is `replayed`, continue the loop so the first-transaction enrich path runs, or let `ProjectionChanged` skip the receipt lookup. Add a race test with different mobiles; the existing race tests use identical mobiles and cannot see this.

**S2. Book mobiles are not durable (confirmed).**
- **Ran it:** `mhp_capture_signup_v3` (0136) returns before the phone update for non-webinar kinds, so `mhp_prospects.phone` is `null` after a book sign-up with a mobile.
- The mobile exists only in process memory until the copy succeeds. It is lost on:
  - a restart or deploy between commit and copy (normally 50–300 ms, plus anyone inside the 1- and 5-minute retry window; the timers are `unref`'d);
  - a CRM fault outlasting the three attempts (about 6 minutes);
  - no configured owner (G1);
  - the race in S1.
- After a crash the catch-up makes the lead exactly once, with no mobile (`s5-latency.mts`).
- The trigger and the app racing do not lose it.
- **Nothing clean makes it durable without a migration.** The app has no place to write it except the CRM itself, and every caught-up or trigger-made lead has no phone to work from.
- **Smallest 0160:**
  - `CREATE OR REPLACE` `mhp_capture_signup_v3` so the existing "informational phone" update also runs for `waitlist` (same signature, so this build keeps working);
  - preferably a nullable `phone` on `mhp_prospect_signups`, so a `+messages` version is tied to the number it was given for;
  - expose the latest book sign-up's `consent_given` and `consent_version` to the owner list, so catch-up can be exact.
- **Showing the mobile field again:** not until M1 and S1 are fixed and G1 is confirmed. Even then every deploy and every CRM outage is a loss window until 0160. I would keep it hidden until 0160, or accept and write down that risk.

**S3. Owner-list catch-up misdescribes what it knows** (read it; not run for a webinar+book person). `bookCandidateFromRegistrant` (`book-leads-service.ts:154-158`) passes `mhp_prospects.phone`, which can only be a webinar-given number. `bookTaskDescription` (`:114-125`) then says "Added a mobile for a quick call about the book… they asked for a call", and the number is added as the book lead's mobile. Evidence is stored with `consentGiven`/`consentVersion` null although the sign-up rows hold them.

**S4. The "Texts/WhatsApp offers" column can disagree with Leads** (ran `s7-consent.mts`).
- Tick, then a later sign-up without the tick: the point stays `opted_in` but the page says "No". Conservative, but the page tells the owner to follow it.
- Tick with a number held by another contact: the page says "Yes" with no mobile on the lead or the page.
- The column is per person; the consent is per number. Better to derive it from the point state.

**S5. `CONSENT_FORM` is not tied to the book form** (ran). A webinar or cheat-sheet post with `CONSENT_FORM=book-2026-11`, the texts tick and a mobile is stored with `consent_version='book-2026-11+messages'`. With no email tick on a webinar it is stored as `book-2026-11` with `consent_given=false`. Nothing reads it today; restrict the new fields to the book label/module in `signupConsentVersion` (`growth-service.ts:144-151`).

**S6. Unsubscribe reaches Leads only on the button, not on a visit** (ran `s6` §8). After an unsubscribe the email point stayed `opted_in` through a visit catch-up and became `opted_out` only on the button. A later re-subscribe with the tick leaves Leads at `opted_out` while Book interest says "Tips emails: Yes". Display only: sending authority is the prospects table and the ledger.

## Notes

- **Periodic catch-up:** none exists (documented). Catch-up is: at sign-up; two in-process retries; the owner's visit to Book interest (awaited, 25 people, 3 s budget checked between people); `/hq/marketing` (background); the button.
- **Owner page worst case:** with the CRM tables locked, about 15–30 s (15 s pool statement timeout) (read).
- **0159 locks:** `ACCESS EXCLUSIVE` on `mhp_prospect_signups` and the seven CRM tables (all workspaces) for 60–90 ms. A theoretical lock-order deadlock with an in-flight copy exists (`classify` locks `contact_points` then `contacts`; 0159 the reverse). The deadlock detector would end one in about 1 s and both are retryable; not reproduced.
- **Phone de-duplication is format-sensitive:** `07700900556` and `+447700900556` are treated as different numbers (ran).
- **The lead page does not show the point states.** It shows consent from the ledger, so a book lead will say "No channel evidence" (read). The owner sees the permission in the task text and timeline entry.
- **Book import is not session-fenced** like the webinar import, and writes as the configured lead owner rather than the viewer (read).
- **Catch-up filters by label only**, not module/kind, and only within the latest 2,000 registrants (read).
- **Docs:** the claim that trigger-made leads get their mobile filled in is wrong; none was stored.
- **Outbox:** `crm.createLead` writes two `pending` `outbox_events` rows per new lead; I found no reader in `src` (same as the webinar import).
- `enrich` bumps the contact's `row_version`, so an owner mid-edit could get a conflict (read).
- `followup-sequence-router.ts`: two lines are CRLF→LF only.
- New columns are the 10th and 11th of 11, so on a phone they need a sideways scroll inside the table.

## The ten areas

| # | Area | Result |
|---|---|---|
| 1 | Form never fails or slows because of the CRM | **Held after 0159** (ran): CRM locked, sign-up committed in 1–2 ms, `afterCapture` returned in 0–1 ms, lead made once after unlock. **Still broken while the trigger is live** (ran): same lock, sign-up failed after the statement timeout, no row saved; that is the old trigger, and the new code adds nothing to it. The copy has no timeout of its own beyond the pool's 15 s statement and 5 s connect limits. |
| 2 | Non-book sign-ups untouched | **Held** (ran `s9-nonbook.mts`): parse results, SQL text, parameters and results identical on fd1d9f5 and head for 10 forms; capture function unchanged by 0159. |
| 3 | Migration 0159 | **Held** (ran), with G2. |
| 4 | Both orders and the window | **Held** for one contact / one enquiry / one open task (ran: 36 simultaneous sign-ups, two instances, catch-up and button together, trigger live and after 0159). Owner edits left alone (ran: rename, stage move, contact rename; repeat sign-ups changed nothing). Mobile enrichment of earlier leads is impossible (S2); S1 after 0159. |
| 5 | Wrong person / merge / tenant | **Held** (ran): no merge on phone; ambiguous, archived, deleted and email-removed contacts skipped and reported; case and whitespace normalised; `.invalid` skipped; nothing written outside the workspace; `r72_mhp_prospect_definer` back to baseline after 0159; app path uses existing `r72_crm_command` rights with `can_manage_workspace` re-checked per transaction. **Broken by M1** for a number belonging to someone else. |
| 6 | Consent truthfulness | **Partly broken.** Allow-list, hostile values, `+messages` rules and stored `consent_version` all correct (26-case matrix ran). A later sign-up without the tick keeps the earlier opt-in ("not ticking again is not a withdrawal"), which is defensible, but see S4. M1 is the false state. |
| 7 | Nothing is sent | **Held** (ran: every-table row diff). One sign-up after 0159 adds only prospect, sign-up, contact, 2 points, enquiry, task, 2 activities, 1 receipt, 2 outbox rows. Nothing in marketing sends, messages, provider operations, consent or suppression ledgers. |
| 8 | Owner screens | **Held.** Rendered in Playwright at 390 px with hostile values: no script ran, no page overflow, links and forms correct, text ≥15 px. POST shares the webinar import's method, origin, `sec-fetch-site`, CSRF and session checks (read). "N of M" correct (ran, 5 of 5). Button idempotent and batched (ran). I did not drive the full HTTP stack myself. |
| 9 | Periodic catch-up | **Not present.** See Notes. |
| 10 | Tests | **Held:** real logins (`r72_web`, `r72_identity_command`, `r72_crm_command`), both starting states, real runner. Gaps: the `signUp` helper awaits `project` directly, so the HTTP path is unit-tested only; no race with differing mobiles; no WhatsApp-gate check; `opted_out` is asserted as correct. |

**My totals:** the five new/changed unit and contract files, 144 tests, 144 pass. The two changed DB integration files, 5 of 5 on my cluster (43.8 s), matching the builder. Full suite not run, as instructed.

## Catalog diffs and checksum

- **Fresh 0158 → 0159:** 12,477 catalog lines (every grant, column grant, schema grant, policy, function, trigger, membership, role, default ACL, index, constraint); the only difference is the ledger row.
- **Production-shaped 0158 → 0159:** removed exactly the trigger, the function, the ten `mhp_book_*` policies, and `INSERT` on `contact_points`, `SELECT,INSERT` on `contacts` and `opportunities`, `INSERT` on `opportunity_stage_history` and `tasks`, `SELECT` on `pipelines` and `pipeline_stages`. Kept 0134's `SELECT` on `contact_points` and its two policies. Row digests of 12 tables identical before and after.
- **Fresh-0159 vs production-0159:** identical.
- **Blocked run** (`s3-locks.mts`): failed at 5 s with `55P03`, fully rolled back; a public sign-up arriving meanwhile waited 3.1 s and succeeded; retry applied in 85 ms; a third run was a no-op.
- **sha256 of 0159:** `653f5ab7bd206d39af6ce0286e4882a2120b6a4b3b27965e6502a22720363fd5` (raw bytes and LF-normalised), equal to `MHP_BOOK_CRM_CHECKSUM` and to the ledger row written.
- `db:check` says "behind by 1" before and "current" after.

## What happens to the leads already in production

1. **Code goes live, trigger still present.** Nothing changes until an owner opens Book interest or `/hq/marketing` inside the MHP workspace, presses the button, or the same person signs up again.
2. **On that visit** each trigger-made lead (found by enquiry name or the "Book signup received" history note) is completed once:
   - `mhpSignup` evidence added, marked `owner-list` with consent fields null;
   - email point `unknown` → `opted_in` (or `opted_out` if unsubscribed) and made primary;
   - one `mhp.book.signup` timeline entry;
   - contact `row_version` +1.
   Stage, enquiry name, owner, task and contact name are untouched (ran). No mobile is added: none was stored. A second visit does nothing.
3. **New sign-ups in the window:** the trigger makes the lead inside the sign-up; the app then adds mobile and evidence. Until M1 is fixed that mobile is written `opted_out`.
4. **0159 applied:** no row changes. From then the app alone makes leads, if G1 holds.

## Read-only checks for the coordinator

Before 0159, on production:
```sql
SELECT max(filename), count(*) FROM app_private.schema_migrations;  -- 0158_affiliate_studio.sql, 158
SELECT c.relname, string_agg(a.privilege_type,',' ORDER BY 1) FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
 WHERE c.relnamespace='app'::regnamespace AND a.grantee='r72_mhp_prospect_definer'::regrole
 AND c.relname IN ('contacts','contact_points','pipelines','pipeline_stages','opportunities','opportunity_stage_history','tasks') GROUP BY 1 ORDER BY 1;
SELECT tablename, policyname, cmd, roles FROM pg_policies WHERE schemaname='app'
 AND ('r72_mhp_prospect_definer'=ANY(roles) OR policyname LIKE 'mhp\_book\_%') ORDER BY 1,2;
SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.proname LIKE 'mhp\_book%';
SELECT tgrelid::regclass, tgname, tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgfoid::regprocedure::text LIKE '%mhp_book%';
```
Expected before:
- grants: `contact_points:INSERT,SELECT`, `contacts:INSERT,SELECT`, `opportunities:INSERT,SELECT`, `opportunity_stage_history:INSERT`, `pipeline_stages:SELECT`, `pipelines:SELECT`, `tasks:INSERT`;
- the ten `mhp_book_*` policies plus `mhp_event_phone_points_public_read` and `mhp_event_phone_signup_email_read`;
- one function owned by `r72_mhp_prospect_definer`;
- one trigger on `app_private.mhp_prospect_signups`.

Anything else: stop and review.

After 0159: grants show only `contact_points:SELECT`; only the two `mhp_event_phone_*` policies remain; the function and trigger queries return no rows; ledger is 159 with checksum `653f5ab7…3fd5`.

After the release:
```sql
-- every book sign-up has exactly one book enquiry
SELECT count(*) FROM app.opportunities WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND name LIKE 'Before You Buy book enquiry%';
-- must be 0 once M1 is fixed
SELECT count(*) FROM app.contact_points p JOIN app.contacts c ON c.id=p.contact_id
 WHERE p.workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND p.kind='phone' AND p.consent_status='opted_out' AND c.custom_fields ? 'mhpBookPhone';
```
Also: Book interest reads "N of N are in your Leads"; the service log has `automatic:true` and no `mhp book leads:` warnings; MHP has exactly one active owner.

## What I could not verify

- Production itself: environment (`R72_GROUP_HQ_INBOX_SCOPES`, whether owner WhatsApp sends are enabled), actual catalog, ledger position, number of active owners.
- What the live website form posts, and whether the mobile field is hidden.
- The end-to-end HTTP path with the real portal stack and abuse limiter (read the router and ran the unit tests only).
- How the host shuts a process down during a deploy (in-flight copies).
- The lead page rendering, and the lock-order deadlock (both read only).
- The full suite.

My clusters are stopped and removed. The DB test run left its own `r72-book-crm-*` temp directories in `/tmp`; I left them, and the unrelated cluster on port 55437, alone. Scripts, outputs, catalog listings and screenshots are kept in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-book-crm/` (`world.mts`, `s1`–`s12`, `catalog.sql`, `fresh-*`/`prod-*.sorted`, `v*_test.after.sorted`, `shot-*.png`).