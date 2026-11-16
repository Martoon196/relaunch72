## Review of the keyword stack: fc0e3be → 7483efe → bce402f → 9dc53a5 on 46dedb7

**Verdict: all four steps can ship with their switches off. Neither switch should be turned on in production yet.**

With every new switch absent, behaviour matches 46dedb7 at each step, apart from the declared stamp and one credential case that needs a production check before step 2. The new database code, which the builder never ran on PostgreSQL, works on real PostgreSQL 16 as `r72_content_command`.

Paths below are under `/home/user/r72-keywords/orchestrator/` unless absolute. My scripts and outputs are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-chain/` (`scripts/` and `*.out`).

## Verdict per step, in merge order

| Step | Verdict | Condition |
|---|---|---|
| 2 engine-strict (fc0e3be) | SHIP AFTER one check, no code change | Read `SEO_BLOG_KEYWORD_METRICS` and the four credential names on the portal and the worker (finding 2-A). |
| 3a keyword-wiring (7483efe) | SHIP | None. |
| 3b keyword-planning (bce402f) | SHIP | None. |
| 4 keywords-page (9dc53a5) | SHIP | None. |

## 1. Switches off = production unchanged

**Same journey on every tree.** I ran one scripted journey on 46dedb7 and on each step, in three variants: numbers off, numbers measured, numbers failing. The journey was profile, plan, accept, two articles, approve.
- All 6 model requests, the searches, the number lookups and the usage rows are identical at every step.
- Both approvals bind to `contentSha`.
- Beyond run-to-run noise there are two differences: the stamp, and one field the builder did not declare, `payload.programme.research.numbers` on the planning job. It is not hashed and is not in any prompt.

**The stamp.**
- It is a top-level `engine` key on the plan record, the brief record and the version record.
- `contentSha` is `sha256(body)`, computed before the version object exists (`src/seo-blog/engine.ts:1687`). Approval binds that hash. I confirmed this on the memory store and on real PostgreSQL.
- Nothing renders or exports it. Its only reader is the strict write check at `src/seo-blog/engine.ts:1542`.
- No database rule restricts the keys of these records.

**Credentials.** I ran 13 environment combinations on both trees with the network stubbed.

| Case | 46dedb7 | Stack |
|---|---|---|
| `SEO_BLOG_KEYWORD_METRICS` unset, any combination | numbers off | identical |
| Set; only shared names, or both the same account | research and numbers on shared | identical |
| Set; neither | both off | identical |
| Set; only scoped names | research on, numbers off | numbers on, scoped account |
| Set; both, different accounts | numbers on shared | numbers on scoped |
| Set; mixed pairs (for example shared complete plus a scoped login) | numbers on the complete shared pair, or off | numbers follow research's field-by-field pair |
| Set; shared complete plus scoped names present but empty | numbers on shared | numbers off (research was already unconfigured, so planning was already refused) |

**2-A. SHOULD-FIX, step 2, release condition.** `src/portal/seo-blog-service.ts:85`, `src/seo-blog/engine-stamp.ts:32`.
- If production already has `SEO_BLOG_KEYWORD_METRICS=dataforseo` and only the scoped names, merging step 2 starts one paid number lookup per plan with no new switch.
- `render.yaml` holds no `SEO_BLOG_*` entries, so I could not tell.

**Tests.**
- `tsc` is clean at every step and at the top.
- The `seo-blog-*`, `keyword-*` and `content-area-*` tests pass at each intermediate step: 646, 655 and 660.
- The full suite ran once at the top with `CONTENT_AREA_PREVIEW=enabled`: 5,190 tests, 5,075 passed, 0 failed, 115 skipped. That includes the email, readiness and SQL-contract tests.
- No migration was added: 158 files at base and at head.
- Three opt-in database integration tests (programme 009A, website 009B, Brand DNA) fail on my cluster. They fail with the same errors on 46dedb7, so this is not from the stack. The cause is that the tests never grant the allowance that new businesses now start without.
- The older `seo-blog-pg` integration file also fails at head with that allowance error. I did not run that file on base.

## 2. The database write path on real PostgreSQL

My own cluster was migrated by the real runner as `r72_migrator` to 0158. It is now stopped and deleted.

**Equivalence.**
- `saveInventory` is byte-identical to the 46dedb7 implementation in 14 of 14 sequences, as worker and as owner. The sequences covered insert, update, Unicode, key order, dropped undefined values and a 1.5 MB record.
- An oversize record is refused the same way (23514).
- The full engine journey with switches off works on PostgreSQL: plan, write, stamps stored, approval.

**`keywordBoundary`.**
- It writes the job, one usage row and the list together.
- It leaves the rest of the inventory record byte-identical.
- It rolls everything back when there is no inventory record.
- Its month usage equals `usageSince`.
- A website refresh keeps the list byte-identical.

**Concurrency.**
- 30 list updates racing 30 refreshes: no lost update.
- Two refreshes at once: one whole record wins.
- 225 mixed operations (boundary, refresh, brief save, programme boundary, claim, usage, job update, as worker and owner): 0 deadlocks and 0 lock waits over 1 second.
- Every path takes the business row first. While it is held, writes for that business wait; reads and other businesses do not.
- A full fill took 132 ms.

**Tenant isolation.**
- Another owner's session gets 404 before `decide` runs.
- A lying workspace or user id is refused.
- A viewer is refused.
- The worker with another business's job id sees no job.
- A decision that swaps the business or job id is refused.

**Size.**
- At 300 rows per call the record is 778 KB against the 4,000,000 limit.
- Once a list exists it counts against the refresh. A 3.9 MB list plus a 150 kB refresh now fails where 46dedb7 succeeds. This is theoretical at current caps.

**Findings.**
- **2-B. NOTE, step 3a.** A 46dedb7 or step-2 process erases the list on its next website refresh, and treats a fill task as a plain website read. Every service must be on step 3a before the first fill.
- **2-C. SHOULD-FIX before the pool switch, steps 3b and 4.** A damaged or newer-shaped stored list throws a `TypeError`.
  - Where: `src/seo-blog/engine.ts:1145` (outside the task's error handling), `src/seo-blog/keyword-planning.ts:72`, `src/portal/content-area-keywords.ts:64`.
  - Ran: the worker's whole pass aborted four times in a row, a healthy business's planning task never ran, and that pass's publishing dispatch was skipped. The Keywords page throws too.
  - Fix: one shape check (`schema === 1`, `rows` is an array) used by planning, the fill and the page.

## 3. Money, with the pool switch on

**Today the spend is zero.** Nothing in `src` calls `requestKeywordFill`.

**What holds.**
- Every supplier call has a reservation first. Reserved attempts equalled supplier calls in every run.
- The allowance is never exceeded: with 3 attempts left, 3 calls were made and the task blocked.
- The same task never pays twice. Five owner retries, a lease that expired mid-call and a second worker taking the task all made no repeat call.
- No loop.
- Every call has a ledger entry and receipt, including failures (cost recorded), "no data" (cost recorded) and timeouts (no cost reported, counted as unpriced).
- The cache works. A repeat at once made 0 calls; after 15 days only the own-rankings call; after 31 days all 6. It is invalidated by age, a market change, or changed seeds (offers, audiences, page titles).
- The client is built only when the switch is exactly `true`, credentials exist, and the research provider is not `none`.
- Credentials are not in the task, the stored list or the activity log.

**Worst case.**
- One fill: 6 calls, about $0.19 at the foundation report's rates.
- One month: no separate cap, only the research allowance shared with planning.

**Findings.**
- **3-A. SHOULD-FIX before any fill trigger, step 3a.** `src/seo-blog/engine.ts:2215` and `:2303`.
  - Two fill commands for one business on two workers paid twice for every lookup: 12 calls for 6 lookups.
  - Reproduced on the memory store and on PostgreSQL with real row locks.
  - Attempts are tracked per task, and a second fill is not refused while one is queued or running.
- **3-B. SHOULD-FIX before the switch, step 3a.** `src/seo-blog/keyword-fill.ts:128` with the `pool_built` reducer at `src/seo-blog/keyword-store-shape.ts:158`.
  - A rebuild does not remove rows the builder now excludes. Rows excluded as cannibalising or off-topic stayed stored, for up to 90 days.
- **3-C. SHOULD-FIX before the switch, step 3a.** `src/seo-blog/keyword-fill.ts:104`.
  - A change of country wipes the cost ledger: 13 entries became 6 and November's totals were lost.
  - Receipts on the tasks and the usage rows remain.
- **3-D. NOTE, step 3a.** Timeouts are saved as ordinary failures. The same task never repeats them, but a new owner command repeated all 6 requests although the first charge is uncertain.
- **3-E. NOTE, step 3a.** The pre-check asks for 1 attempt though a fill needs up to 6. With 3 left, 3 calls are paid and the list is not built; the answers are cached, so not lost. The owner then sees the existing "supplier attempts" wording, and in one case "The keyword task lease ended."
- **3-F. NOTE, step 3a.** Any locale outside the five-country table is measured as the UK (`src/keyword/dataforseo-labs.ts:57`).
- **3-G. NOTE, step 3a.** One keyword call counts as one research attempt, like a search that costs about a twentieth as much.

## 4. Planning correctness (3b)

- With no list or an empty list, planning is identical to the old path.
- The validators and method rules are unchanged code, and the target stays a question.
- Rows 30 to 90 days old are used with their old number; rows over 90 days are excluded.

**Findings.**
- **4-A. BLOCKER for the pool switch, not for the merge, step 3b.** `src/seo-blog/keyword-planning.ts:64` and `:107`.
  - Binding by similarity attaches wrong numbers. Nothing checks that the plan uses the shortlist: the planner gets guidance only, where the plan asked for candidate ids and a membership check.
  - Cooperative planner: 7 of 7 right.
  - My adversarial set of 33 briefs: 29 bound, 16 wrong (55% of bindings). Nine were plainly a different subject, for example "serve a section 8 notice" bound to "section 21 notice" at 8,100 a month. Seven were a narrow article given a head term's number, for example an HMO licence article given "hmo" at 49,500. This set was built to break it, so it is an upper bound.
  - The repository's own scripted planner on PostgreSQL: 7 phrases shortlisted, 2 briefs bound, 1 wrong. "deposits basics for landlords" got "landlord deposit return rules" (210), while the brief about returning a deposit got nothing.
  - The wrong binding also sets `demand.kind` to measured and the stamp to measured (`src/seo-blog/engine.ts:1357`).
- **4-B. SHOULD-FIX before the switch, step 3b.** `src/seo-blog/engine.ts:2235`. There is no country check: after a locale change, a UK number was stored as measured on an en-US business's brief.
- **4-C. SHOULD-FIX before the switch, step 3b.** Only the exact phrase is excluded from the next shortlist. After "letting agent fees", the next shortlist offers "letting agent fees uk".
- **4-D. NOTE, step 3b.** Research runs only on the shortlisted phrases, so a one-phrase list means one search.
- **4-E. NOTE, step 3b.** A brief bound to nothing still gets secondary phrases with numbers at 0.25 similarity. A licence article got "landlord insurance cost: 1900".

## 5. Strict mode (2)

**What holds.**
- The five messages are neutral.
- "No data" does not hold, for an empty answer and for null volumes.
- Planning refuses before any spend when numbers are not switched on.
- A method-assigned business holds at planning with nothing spent.
- A method hold at writing wrote nothing and resumed after Retry.
- Fewer than 3 sources holds; the same case with strict off proceeds.

**Findings.**
- **5-A. SHOULD-FIX before the strict switch, step 2.** `src/seo-blog/engine.ts:1309`. Yes, strict mode can stop a correctly configured business.
  - One failed number lookup latches the research hold.
  - Retry cannot resume it, because the lookup is never repeated.
  - A new planning request is refused with the existing "Research is held…" message.
  - Autopilot planned nothing the next day.
  - Only the explicit resume works, and it repeats the searches (3 attempts became 6 in the fixture).
  - The message says "It will need to be started again" without saying where.
- **5-B. SHOULD-FIX before the strict switch, step 2.** `src/seo-blog/engine.ts:1542`. This check is not in the plan.
  - Every brief planned after step 2 ships while numbers were off is refused at writing.
  - The message says "Planning it again will fix this", but there is no way to re-plan an accepted brief.
  - Briefs from before the stamp existed pass.
- **5-C. NOTE, step 2, read only.**
  - `methodState` checks only the `blog` stage, while the writer resolves `blog` plus `visual-brief` (`src/seo-blog/engine.ts:2338`).
  - The numbers message is also used when the lookup was skipped for allowance, where "just now" misleads.
  - The thin-research message does not say what happens next.

## 6. The Keywords page (4)

**What holds.**
- The address returns the same 404 as an unknown address, and as 46dedb7, in all seven off combinations. The body hash is identical.
- The sidebar has 8 places only with both switches on, and 7 otherwise.
- A stranger gets 404.
- Page views record no spend.
- There is no form or button.
- Hostile phrases are escaped everywhere they can enter.
- No supplier, endpoint, cost or ledger word appears in the markup.
- Estimates follow the addendum: 400 gives 40 to 120, 1,300 gives 140 to 380, and small numbers give "fewer than 10". "Estimate" and the top-three condition are always present.
- No estimate is shown without a measured number. I tried wider phrase, observed, none, null, negative, NaN and fractional.
- The roll-up wording is exact.
- There is no sideways scroll at 390 or 320 in Chrome, and "More" is highlighted on a phone.

**Findings.**
- **6-A. SHOULD-FIX before the switch, step 4.** `src/portal/content-area-keywords.ts:74` and `:95`. "We will write these N next", the "Next up" mark and the autopilot roll-up promise phrases the planner is not bound to (see 4-A).
- **6-B. SHOULD-FIX before the switch, step 4.** `src/portal/content-area-keywords.ts:102`. A row seven months old is still shown with its number and an estimate. The month is shown, so it is not false, but it breaks the 90-day rule. A list measured for another country is shown as the business's own.
- **6-C. NOTE, step 4.**
  - The wider phrase is not named.
  - A measured 0 shows "fewer than 10 visits".
  - With auto-accept off the roll-up says "autopilot will write next" beside "Say yes to start".
  - Two briefs on one phrase: the first decides the state.

**Screenshots.** Yes, it reads as the same product: same sidebar, type, cards and pills, and nothing shouts. My reservation is that every row repeats the same full sentence, so nine rows run to about 5,800 px on a phone. There are no other committed screenshots to set beside it.

## Before each switch is turned on

**`SEO_BLOG_REQUIRE_FULL_ENGINE`**
- Fix 5-A and 5-B.
- Numbers must be switched on and proven working on both the portal and the worker.
- Pilot on one business.

**`SEO_BLOG_KEYWORD_POOL`** (it gates 3a, 3b and 4 together)
- Every service on step 3a or later.
- Fix 4-A, then 2-C, 3-A, 3-B, 3-C, 4-B, 4-C, 6-A and 6-B.
- One authorised live call on one business. Field shapes and prices are unverified by the builder and by me, because I had no network.

## Housekeeping

- The worktree is clean at 9dc53a5. I once copied a scratch script into `orchestrator/` and removed it in the same command.
- The full suite left 116 new folders in `/tmp` (`r72-runs-*` and similar). I did not remove them.
- At the start I ran `chmod 711` on the scratch parent folders so PostgreSQL could reach its data directory.
- No network, paid call or production system was touched.