## Delta review of `claude/keyword-fixes` (26e9dc8 on 7ac4392)

**Verdict for merging with the switches off: SHIP.**

HEAD is 26e9dc8 and the tree is clean. With no switch set the branch behaves exactly as 7ac4392. Nearly every finding is fixed. Two are not closed: 5-A is only partly fixed, and the new planning contract still lets a wrong number through if the planner picks the wrong id.

Paths are under `/home/user/r72-keywords/orchestrator/`. Scripts and outputs are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-chain/r2/`.

## Switch pilots (one business, after one authorised live call)

- **`SEO_BLOG_KEYWORD_POOL`: yes**, on these conditions:
  - Every service is on this build first.
  - A person reads each pilot plan's keyword-to-article matches until the check in N1 lands.
  - Nothing in the product starts a refresh yet (no route calls `requestKeywordFill`), so an operator has to start the pilot's first one.
- **`SEO_BLOG_REQUIRE_FULL_ENGINE`: yes**, because it can only pause, never spend or mislabel. Conditions:
  - Search numbers are switched on and proven on both the portal and the worker.
  - The pilot's plans are owner-requested, or someone watches Topics. On an autopilot business one failed number lookup still stops planning (N3).

## Conflict with production 475ab11

No textual conflict: `git merge-tree` writes a clean tree. On that merged tree:
- `tsc` is clean.
- 140 tests pass: the new and touched files, production's neutral-words test, and the shell, portal, programme-view and budget tests.
- The branch's 24 new owner messages pass production's own `revealsInternals` rule.
- I did not run the whole suite on the merged tree.

## Per finding

| Id | Status | What I ran |
|---|---|---|
| 2-C | Fixed | Damaged list: the worker's pass completes, the healthy business plans, and the page shows an honest state. Newer shape: request refused, a forced task blocks with 0 calls, list byte-unchanged after a website refresh. Damaged list: rebuilt, readable ledger kept. |
| 3-A | Fixed | Memory and PostgreSQL: six commands make one task; three forced tasks on three workers make 6 calls, 6 attempts, 6 ledger entries. |
| 3-B | Fixed | A rebuild after an article is planned and an exclusion is added stores only the row that is still allowed. A thin rebuild still keeps good rows. |
| 3-C | Fixed | Move to en-US: ledger goes 6 to 12 entries and month totals are kept. Move back the same day: 0 calls. |
| 3-D | Fixed | After timeouts a plain new command is refused with 0 calls; `acceptUncertain` repeats once. Nothing in the product sends `acceptUncertain` yet. |
| 3-E | Fixed | With 3, 5 or 0 attempts left: refused before any spend. Exactly 6 left: runs. All cached and none left: accepted, 0 calls. Allowance used between request and run: 0 calls. |
| 3-F | Fixed | fr-FR, en-NZ, de and en are refused with 0 calls. |
| 4-A | Fixed as claimed | Similarity binding is gone. See N1 and N2 for what remains. |
| 4-B | Fixed | A UK list on an en-US business binds nothing. |
| 4-C | Fixed | After "letting agent fees", "letting agent fees uk" is not offered. |
| 4-E | Fixed | Unbound briefs get no secondaries; questions carry no number. |
| 5-A | **Partly** | Owner-requested plan: Retry repeats only the failed lookup (3 to 4 attempts) and the plan completes. Autopilot plan: see N3. |
| 5-B | Fixed | Briefs planned before strict are written. The exemption cannot cover new briefs: strict planning refuses "numbers off" before any brief exists. |
| 5-C | Fixed | Stages now match the writer. Messages are corrected, except the autopilot case in N3. |
| 6-A | Fixed | No "Next up", no "we will write these", no autopilot roll-up. |
| 6-B | Fixed | A seven-month-old row and a foreign-country brief show no number and are not counted. |
| 6-C | Fixed | Wider phrase is named; a measured 0 reads "Too few searches to measure"; the furthest-along brief decides the state. 13 rows now take 3,200 px on a phone. |

2-A and 2-B were release conditions, not code. 3-G and 4-D were not claimed and are unchanged.

## New findings

**N1. SHOULD-FIX before wider rollout: nothing server-side checks that the chosen id fits the article.** `src/seo-blog/keyword-planning.ts:159`, used at `src/seo-blog/engine.ts:1353`.
- Ran: a planner that rotates the ids, all of them valid. All 7 briefs were stored as measured with another article's phrase and number.
- A cheap rule works on this data: at least half the phrase's meaning words must appear in the question or title, else unbound. It unbinds 5 of those 7 and none of the 6 correct bindings in the cooperative run.
- It cannot catch near-miss subjects such as section 8 against section 21.
- Secondary phrases chosen by id carry numbers with no check either. The fixture planner gave a deposits pillar "section 21 notice: 8,100". They are not shown anywhere yet.

**N2. SHOULD-FIX: with the switch on, one id slip loses the whole plan.** `src/seo-blog/generation.ts:418` and `:520`.
- Ran: an unknown id, a secondary-only id used as a target, one target used twice, or the id fields left out.
- Each case rejects the plan after two paid planning calls and blocks the task with the existing "did not pass its format or evidence checks" message.
- The stripping in `bindByIds` never gets a chance. Strip-and-accept would cost nothing and leave that brief unbound.

**N3. SHOULD-FIX before strict mode on autopilot businesses: the rest of 5-A.** `src/seo-blog/engine.ts:1169` and `:3427`, message at `src/seo-blog/engine-stamp.ts:64`.
- Ran: an autopilot-requested plan under strict, with one failed number lookup.
- The message says to press Retry in Activity. Retry requeues it and it blocks again with "Research is held. A managing owner can review and explicitly resume with a new intent."
- No plan was made over three more healthy days.
- Only the explicit resume works, and it repeats the searches (3 became 6 attempts).

**N4. NOTE: sideways scroll at 390 px, new in this delta.** `src/portal/content-area-keywords.ts:221`.
- A wider phrase containing an unbroken word of 45 or more letters makes the page 433 px wide.
- `.kw-searches` has no `overflow-wrap`. An 80-letter phrase in the heading itself is fine.

## The new planning contract, switch on

- **Wrong number still possible:** yes, only if the planner picks the wrong id (N1). The cooperative fixture bound 6 of 7 correctly and left the seventh unmeasured.
- **Candidates block:** nine plain fields: id, phrase, can-be-target, searches, wider phrase and its searches, a difficulty band label, what the searcher wants, and month. No supplier, cost, endpoint, source, cluster or score.
- **Bounded:** at most 20 candidates (7 targets, 13 secondary-only). A 300-row list sends 20; the block is 5.2 KB and the whole request 19 KB.
- **Hostile phrases:** the block cannot close its own fence (tags inside are replaced), it still parses, and the prompt calls it data. The worst a phrase can do is sway which id is chosen; numbers always come from the server.
- **Id enum:** with 0 candidates the old prompt and schema are used. With 1 it is the new contract. A schema with 300 ids is 7.4 KB and compiles in 12 ms. The schema is never sent as a provider grammar, so provider schema limits do not apply: it is checked server-side in both paths.
- **Method-pack path:** the builder's test runs the real controller with both planning packs and the plan is accepted with a receipt and no correction. I ran that test; I did not write my own.
- **Prompt version:** recorded on the plan as `seo-blog-plan-v2.md@2.0.0#06a89c57fa46`, plus `keywordPlanning` with contract, candidate count and stripped count.

## Switch off

- The golden hash recomputed on 7ac4392 equals the one on this branch (`cddf777b…`).
- In a scratch copy, one extra space in the old prompt fails the golden test, and so does one changed digit in the old schema.
- My scripted journey in three variants shows 0 differences from 7ac4392 beyond run-to-run noise. Model requests, searches, number lookups, usage and approvals are identical.
- `pg-store.ts` is untouched and no migration was added.

## Money on real PostgreSQL

- Fresh cluster, migrated to 0158 by the real runner; now deleted.
- The builder's database proof passes. It needs `SEO_BLOG_PG_ADMIN_URL` and `SEO_BLOG_PG_CONTENT_URL`, and skips under the usual `TEST_DATABASE_URL` variables.
- My runs as `r72_content_command`: the 3-A and 3-D results in the table, with 0 deadlocks and 0 lock waits over one second.
- I found no new route to pay twice. Tried: join, the active marker with a second task during a live lease, `acceptUncertain` twice, and `acceptUncertain` during an in-flight lookup (it joins the same task).

## Strict mode and the Keywords page

- **Strict:** the earlier cases still hold. "No data" goes on, 2 sources hold, and a method hold writes nothing and resumes.
- **Page:** all 16 states render without error, including damaged, newer, another country, unsupported country and a damaged choices record.
- Route gating is unchanged: the same 404 hashes as 7ac4392, and 8 sidebar places only with both switches on.
- Hostile text is escaped, and there are no internal words, forms or buttons.

## Tests

- `tsc` is clean.
- Full suite, once, at 26e9dc8 with `CONTENT_AREA_PREVIEW=enabled`: 5,218 tests, 5,101 passed, 1 failed, 116 skipped.
- The one failure is the Brand DNA pricing speed test (2,370 ms against a 2-second limit) while two other suites were running. Alone it passes 31 of 31, and this branch does not touch that file.
- My first full-suite attempt was lost to the container restart and is void.
- The run left new folders in `/tmp` that I did not remove, because other suites were writing there at the same time.