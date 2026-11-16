REVIEW OF TWO SMALL BRANCHES (both based on 46dedb7; production at 7ac4392)

VERDICTS
- Branch 1, claude/allowance-followups at 8b381b3: SHIP AFTER FIXES, one line (S1 below). Nothing found that spends twice, spends past the allowance, or loops.
- Branch 2, claude/wordpress-focus-phrase at 36123b3: SHIP with the switch left off. Do two things before SEO_BLOG_WORDPRESS_FOCUS_PHRASE is turned on (S2, S3 below).

Both worktrees were clean before and after; nothing was edited. The PostgreSQL cluster is stopped and deleted. Scratch is under /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-small/.

====================================================================
BRANCH 1: /home/user/r72-article-page, 8b381b3
====================================================================

Tests (ran)
- `npx tsc --noEmit -p .`: exit 0.
- Allowance, article-page and shell test files: 89 of 89 pass.
- Full suite once, CONTENT_AREA_PREVIEW=enabled: 5161 tests, 5046 pass, 0 fail, 0 cancelled, 115 skipped (366 s).

SHOULD-FIX

S1. The waiting sentence promises a restart that does not happen when details are unconfirmed or the writing service is not connected.
- Where: orchestrator/src/portal/seo-blog-article-view.ts:218. `restarts` checks only the pause and the ceiling.
- Ran (b1/matrix.test.mts, 96 combinations of stop reason, pause, details, service, allowance): the article page, Articles list and new-look Home, Articles and article page all say "Paused: waiting for more writing allowance this month. It starts again by itself when next month's allowance begins, if not before."
- Result on 1 December after four worker passes: still blocked in 3 of the 4 combinations that show the promise (details unconfirmed; service not connected; both). Only the all-clear case was written.
- Nothing is spent. It is realistic: an owner edits their details while a write waits.
- Fix: add `&& holds.profile && holds.service` to `restarts` (`holds` is already in scope at line 197).

What held (ran)

(a) Money and loops
- Five callers at once (owner Retry, owner save, worker pass, month wake, daily pass): one requeue (row version 4 to 5), one article, one version, 2 model calls; 8 more passes and another save added none (b1/wake.test.mts).
- Same on real PostgreSQL: owner save plus two worker passes at once on three waiting writes gave each exactly one requeue (v1 to v2), 3 activity rows, and 0 on every later pass (b1/pg2.mts).
- The wake is still one per business per month: key `allowance-wake:YYYY-MM`. On PostgreSQL a second enqueue with the same key created no row.
- Paused for 12 months (120 worker passes, 24 daily passes): 13 wake tasks in all, 1 queued, 0 model calls, 0 usage change, job untouched. Unpaused: written within 3 passes.
- Details unconfirmed on the 1st: the wake for the following month was created. The builder's test covers only the pause case.
- "Write it now" (A1): shown in 4 of 96 combinations, all four with nothing else in the way, and all four were written after the press. No combination offered a button that failed.

(b) `listBlockedWrites` on real PostgreSQL 16.15
- Setup: 158 migrations applied by the real runner as a non-superuser owner (ci_migrator); queries run as r72_content_command (not superuser, no BYPASSRLS), as both a signed-in user and the worker (b1/pg.mts).
- Rows: exactly the tasks with kind write and state blocked, oldest first, with a usable row version (a stale second requeue was refused).
- None: a business with no tasks returns 0 rows for user and worker.
- Isolation: another owner asking for the business gets 0 rows through the store and 404 through the engine. Raw SQL as the application role returned 0 rows with the wrong workspace, a spoofed workspace setting, the worker in another workspace, and no context.
- Bound: with 1,300 blocked writes it returns the oldest 1,000.
- Plan (49,534 rows in the table, 9,600 in one business): bitmap scan on the primary key by business, filter, sort. There is no dedicated index; it reads every task of that business, the same shape as the existing `listJobs`. 5.8 ms as the worker. Acceptable.
- As a signed-in user the same query took 374 ms, because the row-security policy calls `can_manage_workspace` once per row (about 0.3 ms each). The existing `listJobs` took 2,881 ms on that business for the same reason. That cost predates this branch.

(c) Truthfulness: apart from S1, sentence and button agreed across the five views in 93 of 96 combinations. The other 3 are Home showing the Brand DNA card first, which is true.

(d) No write on GET: 28 GETs (14 paths, both looks; a few of my guessed new-look paths returned 404) in each of four waiting states made no mutating store call; tasks, usage and brand were byte-identical afterwards (b1/get.test.mts).

NOTES
- N1. A paused or unconfirmed business with a waiting write now always has a queued wake, so the worker visits it every pass for good (on PostgreSQL: not active before the wake, active after). Cost is three reads per pass. It also takes one of the first 50 places in an unordered list that the resume and the publishing dispatch both cut at 50 (engine.ts:2970, 2977). Fine today; it matters past about 50 active businesses.
- N2. The 1,000 limit covers every blocked task of kind write, including image-stage tasks and writes blocked for other reasons. Past 1,200 blocked, the middle ones are still unseen (ran: 1,000 of 1,300). Pages can now load up to 1,200 tasks (1.3 MB in my run).
- N3. When readiness cannot be read, a write stopped for a pause that is now off says "Paused: writing is paused for your business" (ran, b1/unknown.mts). Before this branch it offered the button.
- N4. No automated test runs the new SQL; the database tests are skipped without a database.
- N5. On deploy, waiting writes older than the newest 200 tasks will be picked up for the first time: at most 10 per pass, within the allowance.

Merge with 7ac4392: no conflict (`git merge-tree` wrote a clean tree). I extracted the merged tree to scratch: tsc exit 0, and 138 allowance, article-page, shell and keyword tests pass.

====================================================================
BRANCH 2: /home/user/r72-shell, 36123b3
====================================================================

Tests (ran)
- `npx tsc --noEmit -p .`: exit 0.
- WordPress and website test files: 43 of 43 pass.
- Full suite once, CONTENT_AREA_PREVIEW=enabled: 5161 tests, 5046 pass, 0 fail, 0 cancelled, 115 skipped (413 s). The totals match branch 1 by coincidence (each adds four tests); each log contains its own branch's new tests.
- PHP 8.3.6 is available. `php -l` is clean on the three changed PHP files. The standalone test passes in yoast, rank_math and standalone modes.

SHOULD-FIX (before the switch is turned on; neither blocks merging with it off)

S2. Today the phrase sent is the whole question.
- Where: orchestrator/src/seo-blog/engine.ts:2647 falls back to `brief.targetQuery`.
- Ran: the fixture sent "how does tenancy deposit protection work". It appears nowhere exactly in the SEO title, description, slug, first tenth, sub-headings or body (0 occurrences in 265 words). That is a scripted fixture, not a real article.
- Rank Math matches the phrase literally, so a question would fail most of its checks and the post list would show a poor score where it shows none today. My test also showed the "?" is kept in the stored phrase. This is from my knowledge of Rank Math, not a run.
- It does not affect search ranking; the field is not public. It affects what the owner sees.
- Fix: in `focusFor`, return null when there is no measured phrase, so nothing is sent.
- Once briefs carry it: send `brief.seo.primary.phrase` when its basis is not "none", with up to four of `brief.seo.secondary` for Rank Math and the primary only for Yoast. `focusFor` already does this and its field names match production's `BriefSeo`. It only helps the score if the writer was given that same phrase.

S3. Run the WordPress Playground test for yoast and rank_math before 1.2.0 goes on a customer site. I did not run it either. Unverified on real plugins: whether Rank Math rewrites the stored value on save (that would read as a person's edit, the safe direction), and whether Yoast picks up the value written after the post is saved.

What held (ran)

(a) Compatibility
- Switch off: I captured the publish inputs the engine produced in the existing tests and built the payload with the 46dedb7 publisher and the head publisher. 3 of 3 were byte-identical, and there is no `focus` key at all. `focus: null`, `undefined` and an empty phrase are also identical (b2/off.test.mts).
- Switch on: the payload differs from base only by `wordpress.seo`.
- Old plugin 1.1.1 (from its ZIP) receiving the new field: stored values identical with and without it, in all three modes.
- New plugin receiving an old payload: stored values and result byte-identical to 1.1.1; a focus phrase already there is left alone (b2/oldnew.php).

(b) PHP (b2/extra.php, against the class extracted from the 1.2.0 ZIP)
- Only class-r72pub-seo.php, the version header and the readme changed. No new endpoint; signature, capability, REST and publisher files are byte-identical to 1.1.1.
- Sanitising: tags stripped, commas removed, whitespace collapsed, 100 characters, four secondaries. Arrays, numbers, null, a string or list in place of `seo`, a PHP tag and comma-only values all store nothing. Quotes and backslashes are stored intact. The plugin itself echoes only field keys, through `esc_html`.
- Keep rule: first publish writes; our own change overwrites; a person's edit is kept and stays kept on later republishes; a payload without the field leaves ours in place.
- Neither SEO plugin active: nothing is written to either field. Both active: mode "hold", publishing is refused before any SEO write (existing behaviour).

(c) ZIP: sha256 d2ee6d6b064a542d125091d93d192a9245106ea54182d228e352a37428c8dbbd matches the recorded file. 16 entries, all .php or .txt, mode 644, no links, no unsafe paths. `diff -r` against the plugin directory at 36123b3: identical. Rebuilding from the committed source in scratch reproduced the same sha.

(d) Line endings: the net diff has no whole-file churn (`--numstat` equals `-w --numstat`). The four CRLF files are still CRLF and the LF files still LF.

NOTES
- The branch history does carry the churn: 79fe464 rewrote four files whole and 36123b3 reversed it. Squash when integrating.
- The phrase is read from the brief at send time, inside the try after the publication is marked "submitted" (engine.ts:2676). A failed read fails the publish before anything is sent. Read only.
- A version already on the site returns "already present" without touching SEO fields, so the phrase reaches only first deliveries and new versions (read, class-r72pub-publisher.php).
- If a person clears the phrase, it stays empty for one republish and is written again on the next (ran). Same rule as the other fields.
- The PHP test inside the suite passes silently when PHP is missing (orchestrator/test/seo-blog-wordpress.test.ts:268).

Merge with 7ac4392: conflicts in 2 files, 3 hunks, all "both sides added a line at the same place".
- orchestrator/src/portal/seo-blog-service.ts: 2 hunks.
- orchestrator/src/seo-blog/engine.ts: 1 hunk, in `EngineDeps`.
- Resolution: keep both sides. I did that in scratch: tsc exit 0, and 92 WordPress, website and keyword tests pass.

Scripts and logs: /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-small/b1/ (pg.mts, pg2.mts, matrix.test.mts, matrix.out, wake.test.mts, get.test.mts, unknown.mts), /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-small/b2/ (extra.php, oldnew.php, off.test.mts), /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-small/full-b1.log and /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-small/full-b2.log.