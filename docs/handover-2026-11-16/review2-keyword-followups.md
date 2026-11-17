# Second review of `claude/keyword-followups` at e1a431f (fix round 127461d..e1a431f)

Nothing tracked was changed, nothing committed, no paid or live call made. Scripts and outputs are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review2-keyword-followups/` (`scripts/`, `out/`). My PostgreSQL cluster is stopped and its data removed. Another postgres on port 55437 (`scratchpad/seq-safety`) is not mine and was left alone.

## Verdict

- **Merge and deploy with both switches off: yes.** No must-fix.
  - The planner request hash is identical on 7b5ccf2, 127461d and e1a431f, at generation level and through the engine (table below).
  - With both switches off the only live change is the F2 wording on Topics and the SEO report. The fit rule is reached only from `bindByIds`, and the re-check paths need a `numbersRecheckAt` that only strict mode writes.
- **Supervised one-business pilot with `SEO_BLOG_KEYWORD_POOL` on: yes, with a person reading every match.** That check can now be done on screen.
  - Expect about 1 in 10 correct matches to show no number, and more in local-service niches (finding P1).
  - If the planner attaches an id to an article none of the candidates is for, 5 to 8% of the possible wrong ids still bind (P4).
- **Before strict mode is ever on:** fix S1, and decide S2 to S4.

## F1 to F6

| | Status | Evidence |
|---|---|---|
| F1 | Partly fixed | Sibling slips 0/672 (target 5% met). Correct refusals 11/112 = 9.8% (target 8% missed; the builder's own test comment admits the miss on the old table). |
| F2 | Fixed | Topics, SEO report and Keywords each name the phrase; hostile markup escaped; no number for an unbound brief. One phone readability flaw (SF1). |
| F3 | Fixed for the wait | PostgreSQL: 2 plans and 2 planning calls on 127461d, 1 and 1 on e1a431f. Residuals S1, S3, S4. |
| F4 | Fixed | The lookup is never bought again; Retry refused with true words; the way forward works. |
| F5 | Fixed | Marker absent after each resume; one gap on the superseded path (S1). |
| F6 | Fixed | 20,000 junk ids give a 5,997-byte line. |

**F1 rules as asked** (`src/seo-blog/keyword-planning.ts`):
- Done: best fit among the shortlist, longer phrase wins a tie of share, exact tie unbound (`:325-347`); digits required; no/not/without/non kept (`:184`); the six stem pairs kept apart, with the licence and evict table (`:193-222`).
- Partly: single letters count only after a fixed list of twelve qualifier words (`:186`).
- Places: a deterministic heuristic on the question only (`:267-283`); it both misses and over-refuses (P3, P4).

**F2 render paths** (ran, `f2-render.mts`, `f2-newlook.mts`):
- Topics, both looks: `Measured: 6,600 searches a month for "landlord tax" (measured, Nov 2026)` (`src/portal/seo-blog-view.ts:39-44`).
- SEO report: `6,600 searches a month in Google for [landlord tax]`.
- Keywords: each number sits in its phrase's own row; the roll-up sentence is an aggregate and names none.
- Results, Home, publishers and email show no search numbers (read, by search of `src`).
- `<script>`, `<img onerror>`, quotes and `</td>` are escaped on Topics and the panel. A right-to-left override passes through raw; the keyword list strips it at build, so only an old-planner question could carry one, and that question is already shown on the page.
- Unbound and wider-phrase-only briefs show "Qualitative" on Topics and "We do not have search numbers for this phrase yet" on the report. The engine script throws if any unbound brief carries a number; none did across 24 plans.
- No sideways scroll at 390 or 1280 px, 300-letter phrase included.
- **`src/portal/seo-blog-seo-panel.ts`: this branch touched line 101 only** (commit fbbdccd, 1 insertion, 1 deletion). It repeats the phrase choice inline and does not import `brief-demand.ts`.

**F3 to F5 on PostgreSQL** (ran, `f3-pg.mts`; every scenario ended with 0 usage references charged twice and 0 deadlocks):

| Scenario | Result on e1a431f |
|---|---|
| A. By-hand request at +5 min of the wait | 1 plan, 1 planning call, 2 lookups (127461d: 2 plans, 2 calls, 3 lookups, 8 research attempts) |
| B. Two by-hand requests and three workers at the due moment | 1 plan |
| J. Forced stale write against a claimed task | Refused by row version; 1 plan |
| C. By-hand request while the re-check is running | 2 plans (S3) |
| D. By-hand request during the first attempt | 1 plan; the waiting task stops without a lookup |
| E. Retry pressed three times during the wait | No change. Later each Retry buys exactly one lookup; marker `true` when queued, absent after it runs (127461d: stays `true`) |
| F, G. Worker dies inside the lookup (autopilot and owner plan) | Lookups stay at 1 through 90 minutes and two Retries. Retry gives 409 `numbers_unknown`. Activity shows "Start a fresh plan in Topics" and no Retry. The Topics resume makes 1 plan and spends 3 more research attempts, as the message says (127461d: "press Retry", accepted, does nothing) |
| K. Worker dies between the saved failure and the requeue, then inside the re-check | One re-check queued after the lease ends, then held as unknown. 2 lookups in total; none in two more days or by Retry |
| I. Strict off | 0 tasks carry a re-check time or marker |

The marker and the requeue are one row write, so there is no gap between them.

**F6 and notes** (ran, `f6-words.mts`, `topics-copy.mts`):
- Worst case for the log line is about 23 KB.
- The seven new or changed messages pass `ownerWords` unchanged and name no supplier, model or method.
- "by ourselves" is gone from this feature.

## New findings

**Must fix before merge:** none.

**Before or during the pilot** (all fail in the safe direction, no number shown)

- **P1. Twin phrases can never bind** (`keyword-planning.ts:328, 340`).
  - "boiler repair", "boiler repair near me", "boiler repair uk" and "best boiler repair" have the same meaning words, so each ties with the others and is refused.
  - Ran through the real `buildKeywordPool` and `planningCandidates` (`twins.mts`): 4 of 7 targets are such twins. The correct choices "boiler repair" (40,500) and "boiler repair near me" (33,100) both come back `tied`.
  - The pool merges plural twins, but not "near me", "uk" or "best".
  - Fix: in `bestFit`, skip a candidate whose meaning-word set equals the chosen one's; or keep one twin when building the shortlist.
- **P2. A pillar is refused when its title names a sub-topic.**
  - "Landlord Insurance: Cover, Costs and How to Compare Quotes" loses "landlord insurance" to "landlord insurance cost" (`fits_another_better`).
  - 2 of 8 new shortlists lose their pillar this way. One supporting article lost its phrase to a tie because its title said "Cost".
  - The same rule is what stops slips, so there is no free fix. Accept it for the pilot and count it.
- **P3. The place rule refuses correct choices** (`:311-315`).
  - Refused: "in North London" against `estate agents london`; "in Greater Manchester"; "in North Yorkshire".
  - Refused whenever one phrase word is also missing: "in England", "in Scotland", "from April", "from Airbnb".
  - Refused for a question in Title Case: "Who Pays For Repairs In Rented Houses?" against `house repairs`, with every phrase word present.
  - 7 of 9 right pairs with a place were refused.
  - Fix: ignore nations, months and compass or size words (North, Greater, Central) in `placesIn`, and skip the rule when most words of the question are capitalised.
- **P4. Wrong pairs that still bind when no better sibling is offered** (`data-new.mts`, 31 of 52):
  - letters: `vitamin c serum` on a vitamin D article, `form e divorce` on Form A, `hepatitis b` on hepatitis C, `epc c rating` on rating E, `e bike insurance` on bike insurance;
  - `grade ii listed` on a Grade I article;
  - `unfurnished` against furnished, `cordless` against corded, `sugar free`;
  - `plumber leeds` on "Who is the best Bradford plumber?" (no preposition), and `bath fitters` on "kitchens in Bath";
  - `landlord gas safety certificate` on an electrical certificate article when the electrical phrase is not offered;
  - one-word `mortgage` or `insurance` on any article in the niche;
  - the Russian and Arabic sibling pairs, by the half rule.
  - No code fix proposed; the person's check covers it.

**Before strict mode**

- **S1. Any plan record saved after the wait began stops the waiting autopilot plan, and the stop is not clean** (`engine.ts:1193-1196`).
  - `s.plans` holds every plan, including the one `requestProductArticle` saves (`engine.ts:2695`).
  - Ran on PostgreSQL with that record shape. Scenario H: the task ends "A newer plan was made…" although no topic plan exists; the next daily run plans a day later.
  - Scenario L (the task already held, then Retry): the task ends done, the business's research hold stays latched to it, the marker stays `true`, and three days of daily runs make no plan. Topics says "Research needs your attention" with nothing to press in Activity.
  - Fix: count only plans made by a planning task; when stopping, clear the hold if it is this task's and drop the marker.
  - The builder's F3 test plants an unrelated plan and asserts the stop, so it encodes this.
- **S2. Topics copy while held contradicts itself** (existing lines, reached by this path).
  - After a failed re-check it says "press Retry in Activity", "use the explicit resume option below", "demand estimates are labelled qualitative" and "demand is described in words instead", next to "planning is paused rather than guessing".
  - A waiting run that used one search retry earlier shows "Temporary search error. Retry 1 of 2 is planned for…" in place of the re-check message (`seo-blog-view.ts:308`; ran with a planted `retries: 1`).
  - "Retry limits" still opens with "Only… Anything else waits for you" before the new sentence about the one re-check.
- **S3. A by-hand request while the re-check is running still gives 2 plans.**
  - The foundation does the same for any running plan (ran on 7b5ccf2: 2 plans).
  - The Topics form is hidden while a plan is queued or running, so it needs a stale tab.
- **S4. The pulled-forward task ignores the owner's focus, exclusions and source article.** The notice still says "Planning started" (`engine.ts:1323-1329`, scenario A).

**Should fix**

- **SF1. On a phone the Topics demand cell breaks ordinary words** (`seo-blog-view.ts:43`).
  - `overflow-wrap:anywhere` in a table cell lets the column shrink to about 80 px: "Measur/ed:", "searche/s a", "landlor/d gas".
  - Screenshot: `out/topics-newlook-390-compare.png`.
  - Fix: `overflow-wrap:break-word` with a minimum width.
- **SF2. The browser test does not load Topics, which is why SF1 was missed.** It also skips itself where `playwright` cannot be resolved; the repo depends on `playwright-core` only. It ran here.
- **SF3. `test/seo-blog-keyword-fit-rule.test.ts:109` pins `accepted.length === 27`.** It fails if the rule improves. Use an upper bound.

**Notes**

- `bindByIds` now reads every target row for every brief, so one stored shortlist row with a non-text phrase throws (ran, `throws.mts`; on 127461d only the chosen row was read). I did not check that the list's shape check makes this unreachable.
- `keyword-planning.ts:225` now holds raw combining characters in a regex where escapes were; it works (café, crème brûlée).
- The SEO report shows an empty pill if a measured brief has no phrase at all (`seo-blog-seo-panel.ts:101`).
- Topics says "measured, Nov 2026" for a number whose month on Keywords is October.
- Everyday forms now stay apart: manage/managed, service/servicing, price/pricing, buy/buying, fit/fitting. They cost refusals only.
- In a nested cluster 5 of 9 fitting secondary phrases were kept.
- No conflict of facts found with the previous review: its numbers reproduce exactly on 127461d.

## Tables

**Previous reviewer's tables** (`fit-tables.mts`):

| | 127461d | e1a431f |
|---|---|---|
| 86 pairs: right refused | 4/36 (11%) | 2/36 (6%) |
| 86 pairs: wrong accepted | 42/50 (84%) | 27/50 (54%) |
| 8 shortlists: correct refused | 3/56 (5.4%) | 6/56 (10.7%) |
| 8 shortlists: slips bound | 116/336 (34.5%) | 0/336 |

The six refusals at head are three ties and three paraphrases, all in the two paraphrased shortlists.

**My tables** (`data-new.mts`: 108 pairs and 8 shortlists across trades, legal, health and beauty, hospitality, e-commerce, lettings, insurance and accountancy; the pairs are deliberate stress cases):

| | 127461d | e1a431f |
|---|---|---|
| Pairs: right refused | 8/56 (14%) | 26/56 (46%) |
| Pairs: wrong accepted | 46/52 (88%) | 31/52 (60%) |
| Shortlists: correct refused | 0/56 | 5/56 (8.9%) |
| Shortlists: slips bound | 113/336 (33.6%) | 0/336 |
| Own phrase not offered, old shortlists: slips bound | 116/336 | 18/336 (5.4%) |
| Own phrase not offered, new shortlists: slips bound | 113/336 | 27/336 (8.0%) |
| 4,800 random whole plans: wrong ids that bind | 34% | 0% |
| Engine, right ids: bound | 56/56 | 51/56 |
| Engine, rotated ids: wrong bindings | 24 | 0 |

The 19 extra right-pair refusals at head:
- 6 from the tie and better-fit rule;
- 7 from places;
- 3 from digits (year only in the phrase, "5 star" against "five-star", "grade 2" against "Grade II");
- 1 each from "EPC C", "without" against "no", and "remortgage" against "remortgaging".

**Planner request and schema hashes**, identical on 7b5ccf2, 127461d and e1a431f (`out/reqhash.out`):

| | sha256 (first 16) |
|---|---|
| Request, no candidates | 6d30a6e4875ebed3 |
| Request, with candidates | 68587466e09671ab |
| `PLAN_SCHEMA` | d2e13b5aa372d09f |
| Schema with candidates | 52767d45c9f3e8ed |
| Engine-level request, both switches off | da2dd55c22d5ffac |

## Merge commit 127461d

- Its tree is identical to git's own three-way merge of 3739756 and 7b5ccf2 (`git merge-tree --write-tree`, empty diff).
- No conflicts existed. `engine.ts`, `generation.ts` and `types.ts` changed on both sides and merged cleanly.
- Patch ids match both ways, per file and for the whole tree. Nothing was dropped or reordered.
- `npm run typecheck` is clean on e1a431f.

## Tests

- Five targeted files: 44 pass, 0 fail. The wrap file: 2 pass, with the browser running. The full suite was not re-run, as instructed.
- The new F3, F4, F5 and F6 tests assert behaviour: plans, planning calls, lookups, the refusal and the page.
- Existing assertions changed this round, all in `seo-blog-keyword-followups.test.ts` unless noted:
  - Stem pairs letting/let, manage/managed, housing/houses and planning/plans were removed and others added. Legitimate; it follows the request and costs recall.
  - `meaningWords` now expects `lett`. It mirrors the code and is harmless.
  - `stripped` went from 1 to 0 with a new `withdrawn` of 1. Legitimate; it answers the earlier note.
  - The rotation test now asserts exact phrases and reasons. Strengthened; the earlier could-not-fail loop is gone.
  - `seo-blog-neutral-words.test.ts:465` accepts any phrase after the number. Slightly looser, and fine for that test's purpose.

## Not verified

- How often a live planner picks a wrong id, or writes an article no candidate is for. Every slip rate here is "if it slips".
- Production data, Render, and what a site's SEO plugin shows.
- Whether CI resolves `playwright`.
- Whether every measured brief already in production got its number by exact match. The matching line has been exact since the file's first commit (`git log -S`).