## Keyword pilot fixes: all seven items done and pushed

The branch is `claude/keyword-pilot-fixes`, cut from cda1d9dc. Head is **b3d291b308469ee36226c3bacf04b6dc4f86f986**, and the remote matches it. There are 7 commits (SF3, P1, a P1 follow-up, P2, P3, SF1, SF2). Each has a test that failed on its parent and passes after. No migration was added, and no PR, merge or deploy was done. I made no request to any non-local host and no supplier, model or paid call. I did not touch `seo-blog-seo-panel.ts`, `generation.ts`, `search-requirements.ts` or the writer prompts.

Files changed:
- `orchestrator/src/seo-blog/keyword-planning.ts`
- `orchestrator/src/portal/seo-blog-view.ts`
- new tests in `orchestrator/test/seo-blog-keyword-pilot-fixes.test.ts`
- the second reviewer's data, copied verbatim, in `orchestrator/test/keyword-fit-cases-review2.ts`
- `orchestrator/test/content-area-keywords-wrap.test.ts`
- `orchestrator/test/seo-blog-keyword-fit-rule.test.ts`

### What changed, item by item (file:line in `keyword-planning.ts` unless stated)

- **SF3** (68bfaa64), `seo-blog-keyword-fit-rule.test.ts:108`: the test now allows at most 27 wrong pairs, and allows only the two pure paraphrases among refused right pairs. To prove it, I made a temporary change that refused one more wrong pair: the old pin failed (26 !== 27) and the new bounds passed.
- **P1, twin phrases** (9f33d0f0 and c604962b), `sameWords` :408, `wording` :418, `closerTwin` :431, used in `bestFit` :469.
  - Twins are phrases with the same meaning words ("boiler repair", "… near me", "… uk", "best …").
  - When the chosen phrase is wholly in the brief, a twin whose own wording (stop words included) is closer to the brief wins. So "near me" in the brief picks "boiler repair near me"; otherwise "boiler repair" wins.
  - Twins worded equally close keep the planner's choice. I did this instead of using searches as the tie-break, because searches would refuse the planner's correct pick and leave the article with no number.
  - Twins only half in the brief still tie. The first version let "boiler repair" bind on a boiler-servicing article, and the follow-up commit fixed that.
  - Ties with phrases that are not twins still refuse.
  - Tests: `pilot-fixes.test.ts:23`, `:47` (the reviewer's twins case through the real `buildKeywordPool` and `planningCandidates`) and `:98`.
- **P2, pillar refused when its title names sub-topics** (0d9f17ba), in `bestFit` :481, plus `extraWords` :489.
  - A better-fitting phrase that is the same phrase plus more words is now collected instead of winning straight away.
  - If one of those narrower phrases covers every extra word the brief names, the article is about that sub-topic and the broad phrase is refused, as before.
  - If none does, the brief is broader than each of them, so the broad phrase binds.
  - I tried a question-first tie-break and dropped it: it bound one sibling slip and one more wrong pair.
  - Tests: `:106` and `:130`.
- **P3, place rule** (be5cf2d2), `AREA_WORDS` :273, `titleCased` :299, `placesIn` :321, `placeRefuses` :345, `LOOSE_PLACE_PREPOSITIONS` :193.
  - Words like North or Greater before a place no longer make it a different place. A phrase naming another part of it is still refused ("south london" against North London).
  - A nation (England, Scotland and so on) refuses only a phrase that names another nation, or one only half in the brief.
  - Months, days and holidays are not places.
  - After "from" or "at", a name refuses only a phrase that holds part of it, or one only half in the brief.
  - Questions in title case are skipped.
  - Still refused: Bradford against "plumber leeds" (with "in" and with "from"), Sheffield, New York against "york", North Yorkshire against "estate agents york", and England against "landlord registration scotland".
  - Tests: `:139` and `:173`.
- **P4**: nothing changed in the matcher. Wrong pairs accepted were 31/52 before and 31/52 after, and they are the same 31 pairs.
- **SF1** (1163d955), `seo-blog-view.ts:44-47`: the measured text now sits in a block at least 10em wide that can still wrap anywhere. Ordinary words wrap at spaces, and a 300-letter word still breaks rather than widening the page.
- **SF2** (b3d291b3), `browserSession` in `content-area-keywords-wrap.test.ts:91`.
  - The test now uses `playwright-core` (the repo's own dependency) with the repo's `findCreativeChromium()`, or Playwright's own install if that finds nothing.
  - Pages are served from 127.0.0.1, including the new look's script. A route set before the first navigation aborts every other origin, and the tests assert nothing was aborted.
  - Topics is loaded at 390 px in both looks, with an ordinary phrase and a 300-letter phrase. The test asserts no sideways page scroll and no ordinary word split across two lines.
  - A guard test at `:135` proves an external image and script are aborted.
  - Before and after:

| Run | Result |
|---|---|
| Old test, only the repo's own modules (`NODE_PATH` unset) | Both browser tests skip ("Playwright is not installed here") |
| New test, same conditions | 5/5 pass |
| New test, no usable browser (`CREATIVE_STUDIO_CHROMIUM=/bin/false`) | 3 browser tests skip cleanly, 2 checks without a browser pass |
| SF1 test on the old CSS | Fails with "Measured: \| searches \| "landlord \| certificate" \| (measured," broken mid-word |

### Before and after on the reviewer's data (their own scripts, before = cda1d9dc)

| Measure | Before | After |
|---|---|---|
| Pairs: right refused | 26/56 | **15/56** (all 9 right pairs that name a place now bind) |
| Pairs: wrong accepted | 31/52 | **31/52** (same pairs) |
| Shortlists: correct refused | 5/56 | **1/56** (left: "boiler service" against "servicing", a word-form miss) |
| Shortlists: wrong-article choices that bind | 0/336 | 0/336 |
| Whole plan with every id shifted one place: wrong bindings | 0 | 0 |
| 4,800 random whole plans: wrong bindings | 0 | 0 |
| Article's own phrase not offered (new shortlists): wrong phrase binds | 27/336 | **29/336** |
| Article's own phrase not offered (old shortlists): wrong phrase binds | 18/336 | 18/336 |
| Engine, right ids: bound | 51/56 | **55/56** |
| Engine, shifted ids: wrong bindings | 0 | 0 |
| First review's tables | 2/36 refused, 27/50 accepted, 6/56 refused, 0 slips | unchanged |

- The reviewer's twins case now binds both "boiler repair" and "boiler repair near me" for their own articles.
- All seven of the reviewer's title-case questions now fit.

### Switch-off comparison against cda1d9dc

I ran the engine with `SEO_BLOG_KEYWORD_POOL`, strict mode and the preview all off, over 5 brief shapes:
- no numbers provider;
- every target query measured;
- numbers provider failing;
- hostile, 120-letter and title-case target queries, measured;
- planner returning phrase ids anyway.

For each, I compared every model request (plan, article and social), the stored plans, briefs and articles, and Topics in both looks. A base-against-base run is identical, so the comparison is deterministic.

- Model requests, plans, briefs and articles are **identical** for all 5 shapes. The reviewer's engine request hash is still `da2dd55c22d5ffac`.
- **Topics is the one difference**: for briefs with a measured number, the demand span carries the SF1 class and style. With those attributes set aside the HTML is identical, so the words do not change. This layout change is visible to owners even with the pool off, on measured briefs.

### Screenshots of Topics at 390 px
- Before: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots/before-new-topics-390.png` and `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots/before-old-topics-390.png`
- After: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots/after-new-topics-390.png` and `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots/after-old-topics-390.png`
- From the test run: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots-final/topics-new-ordinary-390.png`, `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots-final/topics-new-300-letter-390.png`, `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots-final/topics-old-ordinary-390.png` and `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/shots-final/topics-old-300-letter-390.png`

### Test totals
- `npm run typecheck`: clean.
- Targeted keyword files (`seo-blog-keyword-*`, `keyword*`, `seo-blog-neutral-words`): 105/105 pass.
- `seo-blog-keyword-pilot-fixes.test.ts`: 7/7 pass; the wrap test: 5/5 pass.
- Full suite, plain: 5,389 tests, 5,268 pass, 0 fail, 121 skipped (real-PostgreSQL integration runs that only start through their own commands), 5m50s.
- Full suite with `CONTENT_AREA_PREVIEW=enabled`: the same totals, 5m37s.
- The browser tests ran rather than skipped in both full runs.

### Still open
- **S1**: any plan saved after the wait began stops the waiting autopilot plan, and the stop is not clean (`engine.ts:1193`).
- **S2**: the Topics copy contradicts itself while research is held.
- **S3**: a by-hand request while the re-check is running still makes 2 plans.
- **S4**: the pulled-forward task ignores the owner's focus, exclusions and source article.
- **P4**: 31/52 wrong pairs still bind when no better sibling is offered (letters, Grade I/II, unfurnished, Bath, one-word head terms).
- **Also left**: "boiler service" against "servicing"; "conveyancing solicitors" ties "conveyancing fees" when the title says "Fees".
- **On phones the Topics table is still wider than the screen** (673 px at 390). The card scrolls sideways inside itself, as it already did at 578 px before; the page itself does not scroll.

### Verified vs assumed
- **Verified:** everything above was run here with doubles and Chromium 153, using `/opt/pw-browsers` as the browser found.
- **Assumed:**
  - that CI skips the browser tests cleanly; I simulated it, I did not run it in CI;
  - how often a live planner slips;
  - that the CSS looks right on real phones other than headless Chromium at 390 px.

### What a reviewer should attack first
1. **The P2 rule**: try a single sub-topic article whose title also names a second sub-topic, so the broad phrase would bind on it.
2. **Equally worded twins keep the planner's choice**: check whether that is acceptable for plural or "uk" twins that the pool does not merge.
3. **P3 loosening**: the nation exemption, the "from"/"at" handling (a "plumber leeds" brief "from Bradford" is refused only because the phrase is half in), and title-case detection skipping all place checks (Title Case "In Bradford" questions now bind "plumber leeds" if half in). Also the 2 extra wrong bindings when the article's own phrase is not offered: "boiler repair" on the boiler repair cost and emergency boiler repair articles, now that its "near me" twin no longer ties it.
4. **SF1**: the 10em minimum width makes the table wider on phones.

### Clean-up
I removed my temporary cda1d9dc worktree and my helper files. The comparison scripts, table outputs, logs and screenshots stay in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/` (5 MB) as evidence. Delete it once it has been read. The comparison script is `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/kwfix/scripts/switchoff.mts`. The `/tmp/acc-*`, `r72-*` and similar folders were not created by these runs; the newest are from 23:56, before them.