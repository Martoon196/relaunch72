# Review 5: `claude/seo-score-gate-holes` @ 2e74c7e (on d4e5527; fix round e1eeb7c..2e74c7e)

Nothing in the worktree was changed or committed (`git status` clean, head still 2e74c7e). Every number below came from a script in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review5-seo-score/` unless marked "read". The three trees are d4e5527 (`d4/`), e1eeb7c (`e1/`) and the worktree.

## Verdict

- **Merge: yes, after two named fixes (M1, M2).** Both are regressions against d4e5527 that this fix round introduces. M1 takes three ordinary good pages from 92 to 96 down to 70. M2 lets a pasted list that both earlier trees refused pass at 97.
- **Is `seoGate` fit to be the pass mark for the automatic rewrite loop beside a meaning check: no, not yet. Yes after M1, M2 and G1 to G3.**
  - Every row of review 4's rubbish table is now refused, and every good variant it called undeserved passes again.
  - But each new line has a way round one step further out: 15-word bullets, 49-word run-ons, numbered bullets, and the new on-record-question exemption, which hides the phrase 40 times.
  - I got low-value text to 90 to 100 in 29 new ways (table below).

What holds up:
- Review 4's A1, A3, A4, B1, C1, C3, C4, C6, C7, N1, N2 and N4 are fixed as claimed.
- The baseline file in the repo is exactly a fresh d4e5527 run (0 differences in 44 articles), and the fixtures' "was" scores are exact.
- Check, cap, measure, gate reason and wording agree in 2,668 generated articles around every threshold, with 0 disagreements.
- Output is deterministic, and 89 odd-input calls threw nothing.
- `render.ts` and `citation-edit.ts` give byte-identical output to d4e5527.
- The score object is additive, and `npm run typecheck` exits 0.

## What was run

- `seo-score.ts` read in full; both diffs read; the score and panel test files run (70 of 70 pass).
- The previous reviewer's own scripts run unchanged against the head, plus the builder's copy of that corpus on three trees (`rub3.ts`).
- 21 new good articles written without counting first (about 14,500 words), about 55 new rubbish attempts, a seeded bullet fuzz of 3,159 trials per tree, boundary sweeps, timing, odd input, other languages, 14 panel states in both looks.
- The existing render, citation and golden-page tests (61 of 61 pass). The full suite was not re-run, as instructed.

---

## Review 4's findings, three columns

Cells are score and gate with a picture / without. REF = refused.

| Finding | d4e5527 | e1eeb7c | 2e74c7e | Status |
|---|---|---|---|---|
| **A1** FAQ page, answers opening "Yes." / "No." (3b) | 92 pass / 87 pass | 70 REF | 92 pass / 87 pass | Fixed |
| **A2** platitudes + 20 one-word bullets per part | 70 REF | 98 pass | 70 REF | Fixed for this input |
| **A2** four templates + 40 one-word bullets | 70 REF | 95 pass | 70 REF | Fixed for this input |
| **A2** the property "different short bullets never raise a score or flip the gate" | 560 raised, 40 flips | 496 raised, 147 flips | 363 raised, 15 flips | **Partly**: holds for dashed bullets of 1 to 3 words only (G2, M2) |
| **A3** 401-word page, 4-word phrase, four uses (10a) | 91 pass | 60 REF | 93 pass | Fixed |
| **A4** thorough checklists (1b, 1c) | 93 pass | 70 REF | 93 pass | Fixed, but the same fault is back for items of 1 to 3 words (M1) |
| **B1** 9a / 11a / 11b | 94 / 98 / 98 pass | all REF | 96 / 99 / 99 pass | Fixed, but the exemption is too wide (G1) |
| **B1** review-3 stuffing case, 13 uses in 997 words | n/a | stuffed | stuffed, 60 | Still refused (asserted by the test, which passes) |
| **B2** 136 keyword bullets at 39.6% | 97 pass | 99 pass | 70 REF | Fixed |
| **B2** 240 one-word bullets, each twice | 98 pass | 100 pass | 70 REF | Fixed |
| **B2** 240 keyword bullets of exactly ten words | 92 pass | 90 pass | 70 REF | Fixed at ten words; **fifteen-word bullets score 100** on all three trees (G3) |
| **B3** phrase as 120 "### " lines | 98 pass | 98 pass | 40 REF | Fixed for this brief; **not fixed** when an on-record question holds the phrase (G1) |
| **B3** 480 keyword "### " lines / stuffing diluted by them | 96 / 98 pass | 96 / 98 pass | 70 / 70 REF | Fixed |
| **B4** keyword bullets with "+", "•", ">", "–" or no marker | 97 pass | 97 pass | 70 REF | Fixed |
| **B4** keyword lines as blockquotes | 100 pass | 100 pass | 70 REF | Fixed |
| **B4** one 140-word run-on per part | 94 pass | 94 pass | 70 REF | Fixed at 140 words; **a 49-word one per part scores 97** (G3) |
| **C1** panel advice under the short-items state | n/a | wrong (review 4) | "Write more of the article as full sentences…" | Fixed (ran `panel5.ts`) |
| **C2** twelve 7-word templates | 96 pass | 96 pass | 40 REF | Fixed; 4-word templates still pass at 95 |
| **C3** 24 sentences of "property deal appraisal" | 100 pass | 100 pass | 60 REF | Fixed; gate wording no longer invites rewording |
| **C4** phrase hidden with U+034F, U+FE0F, U+3164, U+0332, dotless i, accents, Latin alpha, Armenian o, tonos | 97 to 99 pass | same | 60 REF, all nine | Fixed; header now says it is not a full table |
| **C5** 80,000 spaces in the opening | over 40 s | over 40 s | 52 ms (500,000: 76 ms) | Fixed in the score, `render.ts` and `withoutCitations`; **one more pattern of the same shape remains** (S1) |
| **C6** room-by-room checklist (1d / 1e) | 70 REF / 96 | 70 REF / 94 | 96 pass / 96 | Fixed, but the fix opened M2 |
| **C7** one rounding for the list measures | n/a | gap | 0 disagreements in 827 list articles | Fixed |
| **N1** Russian / Ukrainian / Greek words rewritten | 0 | 72 of 86 / 21 of 30 / 33 of 52 | 3 / 3 / 12, accents only, none into English | Fixed |
| **N2** intent "constructor", "__proto__", "toString"; `null` context | throws | throws | no throw | Fixed |
| **N4** a 330-word part split by two "### " lines | "partly" | "partly" | "pass" | Fixed |
| **N5** phrase five times in the page title, 857 words | 97 pass | 97 pass | 96 REF | **Partly**: on 2,127 words it is 1.1% and passes at 96 |
| N3 (5,000 questions x 2,000 parts) | n/a | 19.6 s | 19.4 s | Not addressed (unrealistic) |
| N7 FAQ page with "Yes," comma (3c) | 90 / 84 REF | same | same | Unchanged |

---

## New findings

### MUST-FIX before merge

**M1. The new 12% line for very short items refuses ordinary kit lists and price lists. New in this round.**
- Input: `new-good4.ts` P1, `new-good5.ts` P6 and P7, all written before any scoring.
  - P1: a family camping checklist from a campsite, 611 words, 59 items of one to three words ("Tent", "Spare pegs").
  - P6: a salon price list in three tables ("Wet cut | £28 | £38"), 441 words.
  - P7: a hospital bag checklist with advice between the lists, 464 words.
- Observed:

| Page | Very short items | d4e5527 | e1eeb7c | 2e74c7e |
|---|---|---|---|---|
| P1 kit list | 19.8% | 96 pass / 90 pass | 96 pass / 90 pass | 70 REF (uncapped 85) |
| P6 price list | 13.8% | 92 pass / 87 pass | 92 pass / 87 pass | 70 REF (uncapped 86) |
| P7 hospital bag | 13.8% | 94 pass / 88 pass | 94 pass / 88 pass | 70 REF (uncapped 85) |

- The owner reads "Much of the article is short list items rather than sentences… until more of it is written out in full sentences". For a packing list or a price list that advice makes the page worse, and a loop would churn on it.
- The header says "good articles measure up to 6%". That is true of the corpus only, which has no kit list or short-row price table.
- Removing the cap alone is not enough: the three reading checks are also held at "partly" (7.5 points), which is why the uncapped scores are 85 to 86.
- Smallest fix: move `TINY_ITEMS_CAP`, and the "partly" hold with it, to about 25%, and add these three pages as fixtures. On a scratch copy (`patched/`, `patched-check.ts`) all three then score 93 and pass.
- The cost: two rubbish rows reopen, keyword lines as blockquotes (23.8%, 98) and a one-word-changed list in two parts (22.2%, 97). No share separates them from the kit list at 19.8%, so whichever line you pick, both groups belong in the tests and the remainder is for the meaning check.

**M2. A pasted list passes at 97 when different bullets are added to it. Refused on both earlier trees. New in this round (the C6 fix).**
- Input: `shared.ts`. The strong fixture with the same ten six-word keyword bullets ("- We sell cheap houses near Leeds daily") after four parts, then eleven different six-word bullets added to each of those four lists.
- Observed:

| Article | d4e5527 | e1eeb7c | 2e74c7e |
|---|---|---|---|
| The pasted list alone | 40 REF | 40 REF | 40 REF |
| The same + 11 different bullets per list | 70 REF | 70 REF | **97 pass / 92 pass** |

- Adding bullets raises the score from 40 to 97, a direct counter-example to the A2 property.
- Cause (read): an item that comes back in up to four parts is free "as long as such items are no more than half of their list". Different bullets bring a pasted list under half.
- The previous reviewer's own `dilute.ts` shows the same thing: "12 sentences said again" is 40 as it is and 70 with ten one-word bullets per part.
- Smallest fix: also require at most five such items per list (checklist 1d has four). On the scratch copy all four pasted-list rows are refused at 40 and 1d still scores 96.

### MUST-FIX before the gate is used by the loop

**G1. The on-record-question exemption hides the phrase without limit.**
- A heading "asks a question on record" when it holds three quarters of that question's main words. A real "people also ask" question usually holds the search phrase, so every heading or "### " line with the phrase is exempt.
- Input: `attack5.ts` E1 and E4, `attack5b.ts` E6 and E9. Host for E1, E6: my good article N4 ("rising damp treatment"; on record: "How much does rising damp treatment cost?").

| Attack | d4e5527 | e1eeb7c | 2e74c7e |
|---|---|---|---|
| E1: N4 + 40 lines "### Rising damp treatment Leeds" | 100 pass | 100 pass | **100 pass / 95 pass**, phrase share 0 |
| E4: the stuffing fixture with its 16 added phrase sentences turned into "### " lines, one more on-record question "How do I appraise a property deal?" | 97 pass | 97 pass | **99 pass / 94 pass** (60 as plain sentences) |
| E6: the phrase at the front of every part heading and question (7 headings) | 99 pass | 99 REF | **100 pass / 95 pass** |
| E9: heat pump article + 30 lines "### Air source heat pump installation cost Leeds" | 92 pass | 92 pass | 93 pass / 88 pass |

- With a one-word phrase and "How much is an MOT?" on record, every heading that says "MOT" is exempt.
- Smallest fix: one excused heading or question per on-record question, and never a "### " line. On the scratch copy E1 and E4 are held at 60 and 9a, 11a, 11b are unchanged. E6 needs the same allowance in the heading check, which still says "7 sub-headings use the phrase" and passes.

**G2. Bullets of four to nine words, and numbered bullets, still dilute.**
- Fuzz: `fuzz-bullets.ts`, 117 corpus articles, 27 trials each, bullets of 1 to 9 made-up words, 1 to 40 per part, six markers. Trials: 351 per bullet length.

| Words per bullet | d4e5527 raised / flipped | e1eeb7c | 2e74c7e |
|---|---|---|---|
| 1 | 73 / 0 | 82 / 15 | 0 / 0 |
| 2 | 68 / 2 | 66 / 15 | 0 / 0 |
| 3 | 62 / 6 | 54 / 20 | 0 / 0 |
| 4 | 68 / 5 | 57 / 21 | 43 / 0 |
| 5 | 64 / 6 | 54 / 16 | 58 / 2 |
| 6 | 74 / 7 | 68 / 25 | 71 / 3 |
| 7 | 55 / 4 | 36 / 11 | 63 / 3 |
| 8 | 55 / 5 | 39 / 9 | 70 / 5 |
| 9 | 41 / 5 | 40 / 15 | 58 / 2 |

- Worst case at the head: the builder's own held-at-70 platitudes fixture plus eight bullets of eight words per part scores 98 and passes.
- With real words (`attack5.ts`): platitudes + 20 six-word keyword bullets per part is 94 pass on all three trees; four templates + 20 nine-word bullets is 91 pass (70 REF at e1eeb7c).
- Numbered bullets (`dbg3.ts`): `strongPlusPhrase(5)` is 98 REF at 2.6%. Add four bullets per part written "1. Leeds" and it is **99 pass** at 2.5%. With "- Leeds" it stays 98 REF. The item's number is counted as a word.
- The repo's property test uses "- " bullets of one to three made-up words at three doses, so it cannot see any of this.
- Smallest fix: a list item of any length enters the repetition measures only when it repeats, and the list number is not a word. On the scratch copy the two real-word rows go back to 70, and 9 flips remain in 3,159 trials, all by diluting the phrase share on one host.

**G3. Each new line can be stepped round one notch further out.** All on the strong fixture (97 clean), `attack5.ts` and `attack5b.ts`.

| Attack | d4e5527 | e1eeb7c | 2e74c7e |
|---|---|---|---|
| L1: 60 bullets of 15 keyword words ("cheap houses in Leeds and best flats in York and …"), 45% of the page | 100 pass | 100 pass | **100 pass / 95 pass** |
| L4: 120 such bullets, 1,800 keyword words, 68% of the page | 94 pass | 94 pass | 94 pass / 89 pass |
| O1: one 49-word keyword sentence per part, 41% of the page | 97 pass | 97 pass | 97 pass / 92 pass |
| O4: two per part, 1,200 keyword words | 91 pass | 91 pass | 91 pass / 85 pass |
| I4: one 15-word bullet of five 3-word keyword sentences, pasted 36 times | 98 pass | 40 REF | **98 pass / 93 pass** |
| S2: "Cheap houses Leeds." as 30 separate paragraphs | 90 pass | 40 REF | 90 pass / 85 pass |
| S4: "Call us today." as 24 separate paragraphs | 93 pass | 40 REF | 93 pass / 87 pass |
| X1: all kinds at once, each under its line, about 65% junk | 97 pass | 97 pass | 97 pass / 92 pass |

- I4, S2 and S4 were refused at e1eeb7c and pass again: the A1 fix made every prose sentence under four words "never a repeat", where review 4 asked only for one-word sentences.
- Smallest fixes:
  - Run-ons: measure words in sentences of over 40 words. In 66 good articles the highest is 14.7% (the regulation fixture); O1 is 46.7% (`longwords.ts`).
  - I4: when an item's short sentences are read as prose, still compare the whole item for exact repeats.
  - S2, S4: a two- or three-word sentence is a repeat from about its sixth identical appearance ("Stir well." four times stays free).
  - L1, L4: either give the taper no upper end for items with no full stop, or list them as a known limit for the meaning check. Today they are neither caught nor listed.

### SHOULD-FIX

- **S1. C5 is not finished: `TYPED` in `citation-edit.ts:117` has the same shape and was left.** `restoreCitationsDetailed`, on the owner's save path (`seo-blog-router.ts:1247`), takes 0.17 s at 10,000 spaces, 2.9 s at 40,000 and **11.8 s at 80,000** (`typed-perf.ts`). Fix: the same `(?<![ \t])`.
- **S2. A second quadratic in `sentences()`** (older, same on d4e5527; `perf-no5.ts`). A paragraph of "No. 5 " takes 1.2 s at 80,000 characters, 4.3 s at 160,000 and over 60 s at 1 MB. "etc. and" and "co. ltd." behave the same; ordinary text with abbreviations is linear. Fix: test the abbreviation patterns on the last 20 characters, not the whole sentence so far.
- **S3. The tests read stronger than they are.**
  - Two dodges were moved this round from "repetition" to "gate" (`seo-score-review3-fixtures.ts`): pasted short lines without bullets, and as short sentences. They are now refused only because 360 fragments drag the score to 83. At a lighter dose they pass (S2, S4).
  - The A2 property test is scoped to what the code does (dashed, one to three words).
  - `KNOWN_LIMIT4` is empty and asserted empty, while real limits exist: keyword bullets up to 11.4% (97 pass), 15-word bullets, and two of three main words.
- **S4. Two of three main words are never a use.** 24 added sentences saying "property deal" for "appraise a property deal" score 100 and pass (99 at d4e5527).
- **S5. Headings and questions are outside the repetition and short-item measures.** 150 keyword questions with empty answers score 97; the same question 100 times scores 95; a 60-keyword page title scores 97. 200 keyword headings over empty parts score 96 here, but the quality checks mark a part under 25 words as must-fix (read: `checks.ts:103`), so that one is blocked in practice.

### NOTE

- One good variant scores lower than at d4e5527: 12a (pros and cons lists) is 98 then 97. The test names it and allows it because "deserved" variants are only held to the same gate outcome.
- My local guide N9 is 100 at d4e5527 and 99 since e1eeb7c: a list of five pub names all starting "The" counts as a run of same-word starts.
- My legal explainer N6 is 90 with a picture and 84 (refused) without, on all three trees. Its 26% of long sentences are mostly quoted statute.
- Accents are now dropped in every language (Welsh "tŷ" to "ty", "größe" to "große", Russian "й" to "и"). Both sides of every comparison get the same treatment and no score changed.
- `seoGate({})` throws on a malformed score. Nothing stores scores (read: only the panel uses them), so this is not reachable today.
- The run-on cap shows its sentence in the panel, but no check names the sentences that run on.
- A cold first call on 10,000 words takes 110 to 150 ms; the test's 50 ms holds only once warm.

---

## New good articles

All written without counting first (`new-good1.ts` to `new-good5.ts`), strict mode, checks run and clean.

| # | Article | Words | Phrase | d4e5527 | e1eeb7c | 2e74c7e | Deserved? |
|---|---|---|---|---|---|---|---|
| N1 | How-to, numbered steps, tips, six "### " | 861 | how to regrout bathroom tiles | 94 / 88 | 94 / 88 | 96 / 90 pass | yes |
| N2 | Seasonal advice | 761 | garden jobs for November | 95 / 89 | same | 95 / 89 pass | yes |
| N3 | "X vs Y" with a table | 957 | sole trader vs limited company | 100 / 95 | same | 100 / 95 pass | yes |
| N4 | Case-study style | 834 | rising damp treatment | 100 / 95 | same | 100 / 95 pass | yes |
| N5 | Very short opening-hours update | 305 | Christmas opening hours | 91 / 85 | same | 91 / 85 pass | yes |
| N6 | Long legal explainer, quoted statute | 1,311 | consumer rights faulty goods | 90 / 84 REF | same | 90 pass / 84 REF | arguable, older |
| N7 | Recipe | 734 | cheese scone recipe | 96 / 90 | same | 96 / 90 pass | yes |
| N8 | Product care guide | 802 | how to care for oak worktops | 96 / 91 | same | 96 / 91 pass | yes |
| N9 | Local area guide | 728 | dog friendly Whitby | 100 / 95 | 99 / 94 | 99 / 94 pass | -1 not deserved, mild |
| N10 | Jargon-buster, 30 one-line definitions | 976 | mortgage jargon explained | 95 / 90 | same | 95 / 90 pass | yes |
| N11 | FAQ, one-word and one-sentence answers | 562 | skip hire questions | 90 / 86 | 88 REF / 84 REF | 90 / 86 pass | yes, on the bar |
| N12 | Several "### " per part | 900 | air source heat pump installation | 92 / 87 | 92 / 87 | 95 / 90 pass | yes |
| N13 | One-word topic | 834 | probate | 99 / 93 | same | 99 / 93 pass | yes |
| N14 | Price list page with a table | 599 | dog grooming prices | 94 / 89 | same | 94 / 89 pass | yes |
| P1 | Kit-list post | 611 | family camping checklist | 96 / 90 | 96 / 90 | **70 REF** | **no** (M1) |
| P2 | Service page, phrase names the service | 484 | oven cleaning | 98 / 92 | 98 REF | 98 / 93 pass | yes |
| P3 | Short page, one-word topic | 491 | MOT | 100 / 95 | same | 100 / 95 pass | yes |
| P4 | 30 one-line ideas (42.5% step-sized items) | 610 | rainy day activities for toddlers | 96 / 90 | same | 96 / 90 pass | yes |
| P5 | Short recipe | 326 | easy flapjack recipe | 90 / 85 | same | 90 / 85 pass | yes ("thin" is fair) |
| P6 | Salon price list in tables | 441 | hairdresser prices | 92 / 87 | 92 / 87 | **70 REF** | **no** (M1) |
| P7 | Hospital bag checklist | 464 | hospital bag checklist | 94 / 88 | 94 / 88 | **70 REF** | **no** (M1) |

- The phrase rules gave no false refusal: the one-word pages measured 0% because natural writing says "it" and "the test" more than I expected.
- The run-on line gave none either (highest 6.6%).

## New rubbish

About 55 attempts (`attack5.ts`, `attack5b.ts`, `shared.ts`, `dbg3.ts`, the fuzz). Those that pass at the head:

| Attack | Score with / without picture | Finding |
|---|---|---|
| Pasted list of 10 in four parts + 11 different bullets per list | 97 / 92 | M2 |
| Phrase as 40 "### " lines under an on-record question (E1) | 100 / 95 | G1 |
| Stuffing fixture as "### " lines (E4) | 99 / 94 | G1 |
| Phrase at the front of all 7 headings and questions (E6) | 100 / 95 | G1 |
| 30 seven-word phrase "### " lines (E9) | 93 / 88 | G1 |
| Platitudes + 8 eight-word bullets per part (fuzz) | 98 | G2 |
| Platitudes + 20 six-word keyword bullets per part (D2) | 94 / 89 | G2 |
| Four templates + 20 nine-word bullets per part (D3) | 91 / 86 | G2 |
| Phrase at 2.6% + four numbered one-word bullets per part | 99 | G2 |
| 60 / 120 bullets of 15 keyword words (L1 / L4) | 100 / 95; 94 / 89 | G3 |
| One / two 49-word keyword sentences per part (O1 / O4) | 97 / 92; 91 / 85 | G3 |
| Three 49-word sentences in every other part (O5) | 96 / 91 | G3 |
| One 137-word run-on in the whole article, 16.9% (O2) | 97 / 92 | G3 |
| Pasted bullet of five 3-word sentences, 36 times (I4); different ones (I5) | 98 / 93 | G3 |
| Same 3 keyword lines as paragraphs, 12 times (S1) | 92 / 87 | G3 |
| "Cheap houses Leeds." 30 times (S2); "Call us today." 24 times (S4) | 90 / 85; 93 / 87 | G3 |
| 36 or 60 different three-word keyword sentences or paragraphs (S3 / S5) | 92 / 87; 90 / 85 | G3 |
| Majority-junk mix (X1) | 97 / 92 | G3 |
| 24 sentences of "property deal" (U2) | 100 / 95 | S4 |
| 150 keyword questions, empty answers (H1); same question 100 times (H4) | 97 / 92; 95 / 90 | S5 |
| Page title of 60 keyword words (U3) | 97 / 92 | S5 |
| 200 keyword headings over empty parts (H3) | 96 / 91 | S5, blocked upstream |
| 60 four-word template sentences (M4) | 95 / 89 | review 4's C2, shorter |
| Keyword bullets at 11.4% (M2 in the script) | 97 / 92 | the line itself |

Caught as intended (40 to 70, or refused by the phrase rule):
- 100 or 60 phrase "### " lines at a heavier dose, and 12 extra keyword parts;
- six-word bullets over 60%, and the stuffing fixture diluted by them;
- bullets of two-word "sentences", wide keyword table rows, 240 fifteen-word template bullets;
- three 45-word sentences per part (87);
- the phrase split by a full stop, and five-word template bullets;
- every row of review 4's table, in the reviewer's own scripts.

## Allowed uses, regenerated (`allowed.ts`)

First number: most uses the gate accepts. Second: where the 60 cap starts. Head only; the other two trees are in `out-allowed.txt`.

| Words | 1 main word | 2 | 3 | 4 |
|---|---|---|---|---|
| 350 | 5 / 9 | 4 / 7 | 4 / 6 | 4 / 6 |
| 400 | 6 / 10 | 5 / 8 | 4 / 6 | 4 / 6 |
| 450 | 7 / 11 | 5 / 8 | 4 / 6 | 4 / 6 |
| 500 | 8 / 12 | 6 / 9 | 4 / 6 | 4 / 6 |
| 600 | 10 / 15 | 7 / 11 | 5 / 8 | 4 / 6 |
| 800 | 13 / 19 | 10 / 15 | 6 / 10 | 5 / 8 |
| 1,000 | 16 / 24 | 12 / 18 | 8 / 12 | 6 / 9 |
| 1,500 | 25 / 36 | 19 / 27 | 12 / 18 | 9 / 14 |
| 2,000 | 33 / 48 | 25 / 36 | 16 / 24 | 12 / 18 |

- No row refuses three or four natural uses.
- A one-word phrase is no longer absurdly loose: 10 in 600 words, where e1eeb7c allowed 15 and d4e5527 24.
- The tightest ordinary case is a two-word phrase on a 350-word page, where a fifth use is refused. I think that is defensible.
- The table understates what is allowed in practice, because headings that "ask a question on record" are not counted at all (G1).

## Timing (head, one process each, shared machine at load 4 to 7)

| Input | 2e74c7e | d4e5527 |
|---|---|---|
| 10,000 / 50,000 / 200,000 words | 151 / 408 / 1,282 ms | 127 / 309 / 1,215 ms |
| 200,000 words as one sentence | 2.1 s | |
| 100,000 different three-word items | 2.6 s | 2.2 s |
| 100,000 "### " lines / short lines with no marker | 2.5 s / 2.7 s | |
| 100,000 six-word items in one list | 4.1 s | 3.3 s |
| 1 MB single line of words / one word / zero-width spaces | 572 / 169 / 336 ms | 554 ms / n/a / n/a |
| 80,000 / 500,000 spaces in a row | 52 / 76 ms | over 40 s |
| 200 questions on record x 100,000 "### " lines | 6.1 s | |
| 5,000 questions on record x 2,000 parts | 19.4 s | (older) |
| 1 MB of "No. 5 " | over 60 s (S2) | same shape |

Nothing in this round adds a blow-up.

## Consistency, safety, panel, shape

- **Boundaries** (`consist.ts`): 1,774 phrase articles, 427 very-short-item, 400 step-item and 67 run-on articles, 0 disagreements. Four uses always measure 0; five uses over 3.5% are "a little high" and refused but never "stuffed" (20 such cases); 12.0% is not held and 12.1% is; the 100-word floor holds.
- **Deterministic** (`safety.ts`): 83 articles hashed forwards, in reverse, after flooding the memo tables and from deep copies, all identical; inputs not mutated.
- **Odd input**: 89 calls (null and wrong-typed bodies, briefs and contexts, the five odd intents, lone surrogates, a `__proto__` key), 0 throws, all scores in range.
- **`render.ts` and `citation-edit.ts`** (`render-diff.ts`): 13 exported functions, 5,000 random inputs each (1,250 for whole pages), 0 differences against d4e5527. The old and new patterns agree on 200,000 random strings.
- **Panel** (`panel5.ts`): 14 states in both looks, 0 problems. Every cap sentence is plain English, the lower cap shows when two apply, hostile text is escaped, and there is no supplier, model or method word, control or raw value. The only fault is M1's advice on a good page.
- **Shape**: one new export (`PHRASE_HIGH`), two new cap kinds, three new fields in `measures`; nothing removed or retyped. `src/portal/` is untouched in the whole diff.

## What I could not verify

- Whether anything limits the size of an owner's edited text before `restoreCitationsDetailed` runs. I found a 1,500-character limit on answers only.
- Whether the writer's output contract allows a question with an empty answer (S5).
- The full suite on this head: not re-run, by instruction.
- The meaning check, which does not exist in this branch. Several rows above (15-word keyword bullets, keyword bullets under the line) are only safe if it catches them.
- What the writer model produces under a rewrite loop. The good side is my own writing.
- The scratch fixes were run on the corpora and the fuzz, not against the repo's test files.

## Files

Everything is in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review5-seo-score/`:
- Harness and trees: `h.ts`, `d4/`, `e1/`, `patched/` (scratch copy with four candidate fixes)
- Review 4 on three trees: `rub3.ts`, `variants.ts`, `variants2.ts`, `misc3.ts`, `baseline-check.ts`, plus the previous reviewer's `attack.ts`, `attack2.ts`, `dilute.ts`, `dilute2.ts`, `numbers.ts` run unchanged (`out-r4-*.txt`)
- Good writing: `new-good1.ts` to `new-good5.ts`, `run-new-good.ts`, `run-new-good4.ts`
- Rubbish: `attack5.ts`, `attack5b.ts`, `shared.ts`, `fuzz-bullets.ts`, `dbg2.ts`, `dbg3.ts`, `longwords.ts`
- Boundaries and safety: `allowed.ts`, `consist.ts`, `safety.ts`, `i18n.ts`, `panel5.ts`
- Timing and the two published-page files: `perf5.ts`, `perf-no5.ts`, `typed-perf.ts`, `render-diff.ts`
- Scratch fixes: `patched-check.ts`, `fuzz-bullets-patched.ts`, `shared-patched.ts`
- Each script's output is beside it as `out-*.txt`; `out-typecheck.txt` and `out-tests.txt` hold the typecheck and the two test files.