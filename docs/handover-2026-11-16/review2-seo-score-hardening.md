# Review: claude/seo-score-hardening @ 6ae1e26 (base 46dedb7)

## Verdict: SHIP AFTER FIXES (as the read-only report only)

Two small fixes before it ships:
1. Leave checks the owner cannot act on in the current state out of the "Three things would take this from X to Y" sum (S5).
2. Stop the title check saying "it repeats words" when the repeat is only the business name after a separator (S4f).

The score is not fit to be the target of an automatic loop: rubbish outscores good writing. The worktree is clean and still at 6ae1e26.

## Builder's claims
- **Confirmed:** nonsense fixture 40 (cap 40); strong fixture 92; weights total 100 (title-start 1, opening 2, varied wording 4, questions 7); cap of 59 on any must-fix issue; matching on `targetQuery`; picture-in-article check gone; score computed once per page; dark-mode marks (computed contrast at least 5.4:1 in all four palettes).
- **Not confirmed:** "fit to be an automatic target".

## BLOCKER (for the loop, not for the report)

**B1. Rubbish scores higher than good writing.**

| Article | Score |
|---|---|
| Word salad (10-word sentences of random nouns, every limit met), checks clean | 99 to 100 |
| Same, outside link flagged as the real checks would | 97 |
| Same, as target, checks not yet run | 96 |
| One empty paragraph repeated in 12 parts, one adjective swapped per sentence | 98 |
| Strong fixture plus 36 "appraising property deals" variants | 95 (clean fixture: 92) |
| Strong fixture padded to 29,897 words with one 12-item checklist repeated 240 times | 92 |
| Strong fixture plus 60 bullets "Appraise a property deal today" | 91 |
| Strong fixture stuffed to 38 exact uses (3.4%) | 88 |
| My three good natural articles (how-to, comparison, long guide) | 91, 90, 91 |

The counterweights stop the "So go. But big." family and nothing else. No word-matching check can tell meaning, so the loop needs a guard outside this score.

## SHOULD-FIX

**S1. "Varied wording" only sees word-for-word repeats** (`seo-score.ts:455-465`, `395-407`, `707`).
- List items are never checked for repeats.
- The vocabulary measure only looks 50 words back.
- Tighten: compare sentences ignoring one or two changed words, include list items, add a whole-article measure.

**S2. Length has no teeth.** "Too long" costs 4 points (`:564-566`). Cap the score above 5,000 words.

**S3. Phrase count misses most stuffing** (`:522-535`).
- Uses in sentences shorter than the phrase plus three words, and in short bullets, are not counted: the 60-bullet article reads "used 2 times (0.2%)".
- "-ing" and reordered forms are never counted.
- Real stuffing fails only a 3-point check.
- Tighten: count every occurrence and cap the score when stuffed.

**S4. Good natural writing is marked down or pushed to get worse.**
- a. **Linking words** (`:703`): all three of my articles and the builder's own strong fixture measure 26 to 30% and get "Partly" (−2). Lower the floor to about 20%.
- b. **Picture description must hold the exact phrase** (`:636-641`): −2 on all three. This rewards stuffing the description.
- c. **Two exact uses in different parts** (`:535`): natural articles use the exact phrase once and variants after ("bleed radiators", "bleeding"). −1.5 on all three. Count close forms.
- d. **Questions false-fail** (`:725-729`): the fixture's "How long should a property appraisal take?", answered "about an hour for a first look and an afternoon…", counts as unanswered (−3.5). So does a good answer under the heading "Make it a yearly habit".
- e. **Two checks contradict each other** (`:513-516` against `:721-731`): scored against "garden office", the guide needs the five questions as headings, then gets "6 sub-headings use the phrase. More than two reads as forced." A loop would oscillate. Exempt headings that match an on-record question.
- f. **Title "repeats words"** (`:471-474`): "Appraise a property deal | Martin Howard Property" is "Partly" (−3 with title-start). It hits every "property" phrase for this brand, and base passed it.
- g. **Length:** a 933-word how-to is told to add words (−2).
- h. **Starts** (`:688-689`): 17% of sentences starting with "the" is "Partly".
- i. **Address** (`:491-496`): `bleed-radiator` for "how to bleed a radiator" is "Partly", with a to-do it already meets.

**S5. The headline can promise what cannot be done** (`seo-score.ts:794`, `seo-blog-seo-panel.ts:172-187`). On a live article with the phrase missing from the address, it says "Three things would take this from 89 to 97". One of the three is the page address, which has no link and cannot change once live.

**S6. Target mode does not fail closed.** With checks not run, only the 3-point figures check fails and no cap applies (`:765-767`, `:779`). Related questions are still left out when none are on record (`:737`), against the header comment at `:56`.

## Is 95+ reachable honestly?
Not without bending the writing. The how-to reached 93 with two harmless edits and 95 only after putting the phrase in the picture description.

Points a text-only loop cannot move:
- Picture: 7. No-picture versions of my articles score 85 to 86; the polished how-to scores 88.
- Address once live: 5.
- Own-site link and outside source: 10, when no live page or research source exists.
- Figures: 3, until checks run.

## Correctness
- **Plurals and possessives:** correct for "Bridging loans…", "Buy-to-let mortgages…", "Landlords' insurance" and `dont-pay-stamp-duty`. "loan"/"loaned" and "let"/"letter" do not match.
- **Small misses:** "glass" matches "glasses"; "bus" misses "buses"; "café insurance" can never match `cafe-insurance`; `landlord-s-insurance` is only "Partly".
- **Syllables:** mortgages 3, prices 2, services 3, valuation 4, area 3 are all right. 31 of 146 hard words are still wrong:
  - metres 1;
  - tables, titles and articles one short;
  - client, quiet, science, being, video one short;
  - something, sometimes, business, therefore one over;
  - ago 1.
- **Reading ease:**
  - "cat sat on the mat": 116.1 against 116.
  - Wikipedia's 69.0 sentence: 74.3, as the earlier review found.
  - Wikipedia's 37.5 sentence: 24.4 (the earlier review measured 37.5). "Australian" and "reptilian" now count 4 syllables.
  - Gettysburg first sentence: 46.7 against my hand count of 41.0.
- **Left out and scaled:** works. No brief gives 61/66 = 92; checks not run gives 88.5/97 = 91; as target with no brief gives 66.
- **Cap of 59:**
  - Applies only when an issue marked critical is recorded for this exact version (`seo-blog-seo-panel.ts:42`). A stale result cannot cap.
  - In the stale case the page still says "1 thing to fix before this can go out" (`seo-blog-article-view.ts:717`) while the report shows 91.
  - The wording is plain. It says "before it goes out" even on a live article and has no link to the thing to fix.
  - Any critical issue triggers it, including an unconfirmed brand profile.
- **Double counting left:** no picture loses 7; a description that is not a sentence is paid twice; a broken own-site link loses 2.5 and also caps.
- **Fuzz:** 6,000 junk inputs, 0 throws, score always 0 to 100.

## Panel
- **Arithmetic:** the fixture says 62 to 75. After applying the three fixes the score is 78, because the opening fix also lifts two other checks. It understates, never overstates, apart from S5.
- **Confidentiality and safety:** 336 renders (9 states × 9 briefs × 2 looks × open/closed, plus hostile bodies) had 0 problems. No supplier, model, method or internals. No form, button, input, script or comment inside the pieces. Hostile text is escaped in every field, including a planted end marker.
- **Rest of the page:** 264 article pages at base and head are identical once the two pieces are lifted out and the random command id is pinned. Only the two source files changed, and the strip helper and golden file are untouched.
- **Rounding:** "30% of sentences use a linking word" shows as "Partly" beside "aim for one in three"; the true figure is just under 30.

## Performance
- Under load, 857 words takes 3.5 ms (base 1.8 ms); 10,400 words 31 ms; 32,000 words 90 ms.
- The article page at 12,000 words renders in 37 ms.
- Worst junk input: 170 ms.

## Checks
- `tsc`: exit 0.
- Score, panel, article-page and shell files: 108/108 with the variable unset and 108/108 enabled.
- Full suite, once, enabled: tests 5168, pass 5053, fail 0, skipped 115. Another suite was running; nothing failed.

## Fit as a loop target, and the bar
No, not as something a loop maximises. Above about 90 the score cannot tell good from rubbish, and the last points come from exact-phrase picture descriptions, exact repeats, added linking words, padding and copied question headings. Use it as a gate: **85 out of 100 today (80 with no picture), then stop**. Accept a rewrite only if the quality checks ran clean on that exact version, and only with a guard outside the score that the text still says the same true things. Fix S1 to S4 and S6 before raising the bar.

Everything is in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-score/`:
- game.ts, game2.ts, game3.ts, game4.ts
- good.ts (the three articles), good-run.ts, good2.ts, good3.ts
- correct.ts, syl.ts, cap.ts, fuzz.ts
- panel.ts, lead.ts, stale.ts, stale2.ts
- dump.mts
- full-enabled.log