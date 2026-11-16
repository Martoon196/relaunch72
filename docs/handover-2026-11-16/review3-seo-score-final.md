# Final delta review: claude/seo-score-hardening @ 1ca36aa (builder commit 45aff05 on da2d441, then a merge of 475ab11)

## Verdict for the read-only report: SHIP

Nothing in this commit makes the report say something false about a real article, and no cap holds good writing down.

**As a gate at 90 / 85: not yet.** One hole must close first: short bullet items are invisible to the reading and repetition checks (F1). After that it is fit as a necessary condition beside a meaning check, which is how the code now describes it.

The tree is clean at 1ca36aa. Score and panel test files: 56/56 with the variable unset and 56/56 enabled. I did not run the full suite or `tsc`, as instructed.

## Scores (strict mode, with picture / without)

| Good writing | Score | Gate |
|---|---|---|
| How-to (bleed a radiator) | 99 / 94 | pass |
| Comparison | 100 / 95 | pass |
| Long guide | 98 / 93 | pass |
| Listicle of 15 | 96 / 91 | pass |
| Recipe-style steps (667 words) | 94 / 88 | pass |
| Glossary | 94 / 90 | pass |
| Article quoting a regulation | 94 / 90 | pass |
| Buy page | 98 / 92 | pass |
| Pillar, 5,475 words | 96 / 91 | pass |

| Rubbish | Score |
|---|---|
| **Round one** | |
| Nonsense fixture, word salad, spun paragraph, padding with a repeated checklist (up to 29,897 words), bullet and "-ing" stuffing | 40 |
| Round-one phrase stuffing with unique sentences | 60 |
| **Round two** | |
| "It is the case that…", spun platitudes, 4,700 to 5,700 words of platitudes | 40 |
| Four or twelve templates; fragment-built platitudes | 70 |
| Phrase at 4.4% to 6.9%, including 5.7% | 60 |
| Phrase at 3.9% (13 uses in 997 words) | 98 |
| Documented: grammatical-looking filler | 100 / 95 (4,983 words: 97 / 92) |
| Documented: word salad with 26 to 36% small words | 100 / 95 |
| **New this round, each added to the strong fixture (97 / 92 clean)** | |
| 480 fragment bullets ("- So houses cheap.") | 98 / 93 |
| The same 30 bullets ("- houses in Leeds") after every part, 12 times over | 98 / 93 |
| That list 36 times over (4,097 words) | 94 / 89 |
| That list 300 times over (27,857 words) | 92 / 87 |
| 360 different keyword bullets with a small word each | 98 / 93 |
| 240 bullets all starting "We", no linking words | 98 / 93 |
| Every part nothing but keyword bullets | 92 / 87 |
| Keyword bullets with no small words | 40 |
| The same list as four-word bullets | 40 |
| A word slipped inside the phrase ("appraise your next property deal") | 60 |

## Findings

**F1. BLOCKER for the gate, SHOULD-FIX for the report: short list items dodge the checks.**
- Items under 10 words are left out of sentence length, reading ease and linking words (`seo-score.ts:967-968`).
- Sentence starts are judged on prose only (`:1013`).
- The repetition measure ignores items under 4 words and has no 5-word runs to compare in them.
- With the length cap gone, this reopens padding: the strong fixture plus one 30-bullet list repeated 300 times scores 92 / 87 and passes the gate. So "padding is still held low by repetition" is true for sentences and longer items, not for short bullets.
- My round-two advice to drop the length cap rested on repetition catching padding. For short bullets it does not.
- Fix:
  - Count every list item in the repetition measure, whatever its length.
  - When short items make up more than about 40% of the words, hold the reading checks at "Partly" or cap at 70. My good pieces measure 0 to 8%; the recipe measures 29%.
- Reproduction: `lists.ts` and `lists2.ts`.

**F2. SHOULD-FIX for the gate: 3.9% still passes.** 13 uses in 997 words scores 98 and is only marked "a little high" (−1.5). The cap now starts at 4%, the figure I suggested. Simplest fix: have `seoGate` refuse while the phrase check is not a pass.

## The nine checks
1. **R1 done, with the F1 exception.** The cap and its "more than one article" sentence are gone. The pillar scores 96 / 91 and loses only the 2-point length check. Padding with sentences or longer items is still held at 40.
2. **R2 done.** All twelve states: nine make a promise and none overstates. The strong body now says "One thing would take this from 97 to 99", and the real result is 99.
3. **G2 done, apart from F2.** 5.7% now scores 60. The good pieces are unaffected (phrase share 0 to 2.1%).
4. **G1 handled honestly.**
   - `seoGate` is exported with `sufficient: false` always.
   - The file header and the gate both say "NECESSARY, NOT SUFFICIENT" and require a separate meaning check.
   - A test keeps two filler articles scoring 95 or more on purpose.
   - Nothing new claims to judge meaning.
   - The gate is not wired into any page or job.
5. **Good shapes all pass the gate** (table above).
   - "Boiler service in Leeds" now counts as the phrase.
   - The one-repeated-word title passes.
   - 667 words is "a good length for a guide or how-to".
   - The recipe is still told its sentences are short (−5.5), which is fair for its clipped prose.
6. **Syllables.**
   - My first list: 0 of 146 wrong.
   - My second list: 4 of 314 wrong, all arguable (familiar, valuable, comfortable, jewellery).
   - A third list never shown to the builder: 21 of 295 wrong, about 11 clearly. These are mostly compounds with a silent "e" (guideline, pipeline, framework, wholesale, homepage, elsewhere), counted one over.
   - No regressions.
   - Reading ease: Wikipedia's 69.0 sentence gives 69.0; my Gettysburg hand count of 41.0 gives 41.0; Wikipedia's 37.5 sentence still gives 24.4.
7. **Above 70 besides the two documented cases:** the seven bullet articles under F1 and the 3.9% phrase case under F2. Nothing else.
8. **List-item exclusion:** highest reachable is 98 / 93 (F1).
9. **Panel.**
   - 356 renders, 0 problems: the earlier 336 plus 20 new cap states in both looks. No supplier, method, model or mechanism; no form or button; hostile text escaped.
   - The cap sentences are plain and true for stuffing, heavy repetition, some repetition, not sentences, must-fix and stale checks.
   - When stale checks and another cap both apply, the lower one shows.
   - NOTE: when held at 70 for some repetition, the headline reads "What is left to improve" with no top item. The cap sentence and the "Varied wording" entry below still explain it.

Everything is in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-score/r3/`:
- good-all.ts
- lists.ts, lists2.ts
- caps-panel.ts, caps2.ts
- syl.ts, syl3.ts
- lead-states.ts, lead-apply.ts
- new-rubbish.ts, new-rubbish2.ts, new-rubbish3.ts