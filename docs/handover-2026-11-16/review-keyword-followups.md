# Review of `claude/keyword-followups` (3739756 on d4e5527)

Full report: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-keyword-followups/REPORT.md`. Scripts are in `scripts/` and outputs in `out/` in the same folder. The worktree is clean; nothing tracked was changed, nothing committed, and no paid or live call was made.

## Verdict

- **Merge and deploy with both switches off: yes.** No must-fix before merge. The planner request and schema hashes are identical to the foundation, nothing in the N3 path can run with strict off, and the CSS change moves nothing on ordinary content.
- **Before a one-business pilot with `SEO_BLOG_KEYWORD_POOL` on:** fix F1 or keep a person reading every match, and fix F2 so that person can see the match on screen. The half rule does not close N1.
- **Before strict mode is ever on:** fix F3. F4 and F5 belong in the same change.

The repeat lookup itself is sound. I could not make it loop, pay twice or plan twice by itself, in memory or on real PostgreSQL.

## Findings

**Must fix before merge:** none.

**Before the pilot**

- **F1. The half rule still binds a sibling's phrase and number to the wrong article** (`src/seo-blog/keyword-planning.ts:220-226`).
  - Ran through the real engine: a landlord shortlist with each article given the next article's valid id stores 5 of 7 briefs with another article's phrase and number.
  - Topics then shows "Measured: 49500 searches/month" against "Do landlords need an electrical safety certificate?". That number belongs to "landlord insurance".
  - Across eight realistic shortlists, 116 of 336 sibling slips (35%) still bind.
  - Classes that pass, all run:
    - generic shared word;
    - section 21 against section 8;
    - band D against band A (single letters are dropped);
    - Leeds against Bradford;
    - "letting agents reading" against "read a letting agent's contract";
    - "no deposit mortgage" (the "no" is dropped);
    - over-stemming: new/news, rat/rate, site/sitting, plan/planning.
  - A wrong binding also becomes the focus phrase sent to the website's SEO plugin (read, `engine.ts:2980-2987`).
  - Smallest fix: keep the half rule and add "no other target candidate covers this brief better; on a tie the longer phrase wins". On my data that takes slips from 35% to 4% with no extra correct refusals. Also require every phrase word containing a digit to be present.
  - Places and single letters stay open after both additions.
- **F2. No screen names the phrase a number belongs to** (`src/portal/seo-blog-view.ts:315`, `src/portal/seo-blog-seo-panel.ts:83-103`; predates this branch).
  - Topics and the SEO report show the article's question beside the candidate phrase's number, so the pilot's human check cannot be done on screen.
  - Fix: show `6,600 searches a month for "landlord tax"`.

**Before strict mode**

- **F3. A plan asked for by hand during the 30-minute wait goes through, then the queued task makes a second plan** (`engine.ts:1263-1267` with `:1282`; new in this branch).
  - Ran: 2 plans and 2 planning calls. On the foundation the same request is refused, with 0 plans.
  - Fix: when the re-check is claimed, hold if a plan was created after `numbersRecheckAt`; or refuse `requestPlan` while that task is queued.
- **F4. When a lookup's outcome is unknown, the hold tells the owner to press Retry, and Retry can never work** (`engine.ts:1083-1086`, `engine-stamp.ts:64`).
  - Ran in memory and on PostgreSQL. The lookup is correctly never bought again, but each press says "Checking… again", checks nothing and re-holds.
  - This existed for owner plans and now reaches autopilot plans.

**Should fix**

- **F5. `numbersRetry` is never cleared** (`engine.ts:3472-3473`, read at `:1175`).
  - After one numbers Retry, a later strict hold of another kind on the same autopilot task is also resumed by Retry.
  - I planted that second hold. In a real run every strict check repeats, so only the "resume explicitly" gate is skipped.
- **F6. The operator log line is unbounded** (`engine.ts:1376`).
  - 20,000 junk ids made one 1.9 MB line; roughly 0.5 to 1.2 MB at the production token ceiling.
  - Nothing from the planner is echoed. Fix: log counts and the first 40 entries.

**Notes**

- Retry on an autopilot hold leaves no acknowledgement entry. Nothing downstream uses that entry for spend or consent (read: its only consumer is the legacy-hold check). The loss is audit only.
- The promised re-check is skipped if the allowance runs out during the wait; it holds with the plain allowance message.
- Topics copy beside the new message contradicts it: the "Retry limits" text says only two automatic retries exist. "By ourselves" reads oddly.
- `stripped` now also counts the good secondaries of a brief left unbound.
- `test/db/seo-blog-pg.integration.test.ts` fails 4 of 4 when given a database, identically on the foundation. Not caused by this branch.

## Fit rule pair table

86 hand-written UK property and local-service pairs. The wrong pairs are deliberate near-misses, so this is a worst case.

| Rule | Right pairs refused | Wrong pairs accepted |
|---|---|---|
| Half (shipped) | 4/36 (11%) | 42/50 (84%) |
| More than half | 8/36 (22%) | 20/50 (40%) |
| All but one, when three or more words | 8/36 (22%) | 20/50 (40%) |
| All words | 9/36 (25%) | 7/50 (14%) |

Sibling slips inside one shortlist (8 shortlists, 56 correct choices, 336 possible slips):

| Rule | Correct refused | Slips still bound |
|---|---|---|
| Half (shipped) | 3/56 (5%) | 116/336 (35%) |
| Half, and no other candidate fits better | 3/56 (5%) | 14/336 (4%) |
| Half, and every word no other candidate has | 9/56 (16%) | 7/336 (2%) |
| All words | 13/56 (23%) | 1/336 (0%) |

Right pairs refused are paraphrases or UK spelling: evict/eviction, licence/licensing, valuation/worth, broker/adviser. An unbound or stripped brief shows no number anywhere (ran on Topics and Keywords; read for the SEO report and website focus phrase).

## N3 on real PostgreSQL: yes

PostgreSQL 16.15, fresh cluster, 158 migrations applied through `npm run db:migrate` as a non-superuser owner. The store ran as `r72_content_command` under RLS. The cluster is now deleted.

- First failure: one row write sets `queued`, `run_after` +30 min and the marker, with no hold.
- Four workers racing at its time: exactly 1 more lookup.
- Three more days of daily runs: no further lookup, no new plan.
- Retry pressed three times at once: 1 accepted, 2 refused. Then 1 lookup, 1 plan, 7 briefs, no usage reference charged twice.
- No allowance: holds at once.
- Worker dies inside the lookup: never bought again.
- Owner-requested plans and strict off: unchanged.
- 0 deadlocks.

## N2 and N4

- **N2:** no malformed output threw, polluted a prototype or bound wrongly. That includes `__proto__` keys, 200,000-entry lists, 5,000-deep nesting, a 5 MB string and near-equal ids. Two briefs never share a phrase across six orderings. The method-pack path accepts bad ids in one request.
- **N4:** the foundation scrolls sideways (684 px) at 320 and 390 px; head does not, at 320, 390 or 1280, light or dark, folds open or closed, "More" sheet open. With ordinary content, 0 of about 90 boxes outside the rows differ from the foundation.

## Tests

| Run | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Full suite, plain | 5,289 | 5,173 | 0 | 116 |
| Full suite, `CONTENT_AREA_PREVIEW=enabled` | 5,289 | 5,173 | 0 | 116 |
| The four new or changed files alone | 26 | 26 | 0 | 0 |

`npm run typecheck` is clean. The builder's database proof passes on my cluster.

- The changed existing test is a legitimate consequence of N2: the "one target twice" guard was already in `bindByIds`, and it holds.
- The N4 test is a regular expression over the CSS string, with no browser.
- The N1 rotation test, for the single-niche case, asserts only that whatever was bound passes `phraseFits`, so it cannot fail.
- The N3 and engine tests assert real behaviour.

## Not verified

- How often a real planner picks a wrong id; that needs a live call. Every slip rate above is "if it slips".
- The full suite on a tree merged with current production.
- Anything on the production database or Render.
- What a live site's SEO plugin shows for a wrong focus phrase; I read the sending code and did not run a publish.