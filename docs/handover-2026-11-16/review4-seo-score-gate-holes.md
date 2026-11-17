# Review 4: `claude/seo-score-gate-holes` @ e1eeb7c (on d4e5527)

**`REPORT.md` was not written.** The Write tool refused it ("Subagents should return findings as text, not write report files"), and I did not work round the block. This message is the full report; save it as `REPORT.md` if you want the file. All scripts and outputs are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review4-seo-score/`.

Nothing in the worktree was changed or committed (`git status` clean, head still e1eeb7c). Every number below came from a script in that folder unless marked "read".

## Verdict

- **Merge: yes, after four named fixes (A1 to A4).** A1 and A2 are plain bugs this diff introduces, about five lines each, and I tried both fixes on a scratch copy. A3 and A4 are the new lines holding good writing down in the report owners already see.
- **Is `seoGate` fit to be the pass mark for an automatic rewrite loop beside a meaning check: no, not yet. Yes after A1 to A4 and B1 to B4.**
  - It refuses ordinary good pages: an FAQ page whose answers open "Yes." or "No.", a thorough checklist post, a 400-word local page that says its four-word phrase four times, a service page that follows the report's own advice.
  - It still passes several kinds of rubbish at 93 to 100, one of which was refused before this diff.

What holds up:
- The builder's claim that no good fixture lost a point is true: all eight, on both trees, are identical check by check.
- The two changed assertions got stricter.
- The check, the cap, the measure and the gate agree at 2.5% and 3.5% in 381 generated articles.
- Output is deterministic.
- The panel renders every cap state cleanly.
- `tsc --noEmit` exits 0.
- Full suite: 5,278 tests, 5,162 pass, 0 fail, 116 skipped.

## What was run

- Diff and `seo-score.ts` read in full; the panel's score card read.
- Base tree extracted with `git archive d4e5527` into `base/`, so `h.ts` scores every article on both trees.
- 16 good articles written for this review (about 11,500 words), 20 natural variants, about 70 attacks, boundary sweeps, timing, odd input, other languages, 26 panel renders.
- Tests: `seo-score.test.ts` + `seo-blog-seo-panel.test.ts` 62 of 62; `content-area-shell.test.ts` (golden pages) + `seo-blog-article-page.test.ts` 16 of 16; full `npm test` as above (plain run only).

---

## Findings

### MUST-FIX before merge

**A1. Answers that open "Yes." or "No." are now counted as repeated sentences. A good FAQ page drops from 92 to 70. New in this diff.**
- Input: `variants2.ts`, article 3b. A 645-word MOT questions page with twelve answers, six opening "Yes." and six "No.", each followed by the reason.
- Observed at e1eeb7c: score 70, cap "Parts of the wording repeat earlier sentences", "8 sentences and list items repeat an earlier one word for word or nearly" (fail), gate refused with and without a picture.
- At d4e5527: 92 / 87, gate passes. It should still be 92.
- Cause (read): `repetition()` now counts a sentence of under four words as a repeat from its third appearance, in prose as well as lists. The code comment says honest prose "is measured exactly as before"; it is not.
- Milder cases lose points without the cap. In a 300-word test page, three "Yes." answers give "Partly"; five give the cap (`bounds.ts`).
- The owner cannot find the fault: the report names no sentence. In a loop this is churn on every FAQ-shaped article.
- Smallest fix: a one-word sentence of prose is never a repeat: `exact = short ? times >= 2 && (list >= 0 || t.length > 1) : times >= 1`. On the scratch copy (`patched/`, `patched-check.ts`) the page scores 92 again and everything else below still holds.

**A2. Different short bullets now dilute both repetition measures. Rubbish that was held at 70 passes at 93 to 98. New in this diff.**
- Input: `dilute.ts`, `dilute2.ts`. The builder's own "some repetition" fixture (`R2.make(R2.GEN.platitude)`, the one the panel test uses) plus 20 different one-word bullets after every part ("- Leeds", "- Bradford"). That is 180 bullets, 14.7% of 2,133 words.
- Observed: d4e5527 scores 70, refused. e1eeb7c scores **98 / 93, gate passes**. Two- and three-word bullets give the same result.
- The four-templates fixture plus 40 one-word bullets per part: 70 before, **95 / 90, passes** now.
- Heavier repetition is let down a step: an article followed by a synonym-swapped copy of every part scores 40 before and 70 now with ten bullets per part.
- Cause (read): every list item is now a counted unit, and a list is read as one run of words, so each new short bullet adds to both denominators. Before, items under four words added to neither.
- The new test "F1 honest lists are not marked down" passes because of this. It asserts "Varied wording" is a pass, but the same article without the list is "Partly" on both trees. Eight tools bullets take the strong fixture from 97 to 99 (`dbg2.ts`).
- Smallest fix: count a short list item only when it is a repeat, and add list-run windows to the total only when they repeat. Keep items of five words or more measured one by one as before.
- On the scratch copy with that fix:
  - both fixtures are back at 70 at every bullet count;
  - pasted lists stay at 40;
  - all 7 bullet attacks, all 17 caught dodges, both known limits and all 14 round-two rubbish articles hold;
  - the eight good fixtures match d4e5527 check by check;
  - my 16 good articles still pass.
- Four of the five honest-list fixtures then score 97, the same as without the list. That test's "pass" and "at least the base score" assertions need restating.

**A3. The stuffing cap fires at four uses on a short page. An older flaw that this diff widens.**
- Input: `variants.ts`, article 10a. "Mobile dog groomer Leeds", 401 words, with the phrase in the opening, one sub-heading, once in the text and once in the closing line.
- Observed: "comes up 4 times in 401 words. That is too many: it reads as stuffed", cap 60. At d4e5527: 91, passes.
- Removing the closing use (10b) gives 91 and a pass, so one mention costs 31 points.
- Four uses in 400 words is ordinary for a local page. "Stuffed" is false.
- Cause: the measure is uses times main words over all words, with only three uses free. Lowering the line from 4 to 3.5 widened the range where four uses of a four-word phrase cap, from pages under 400 words to pages under about 451.
- Smallest fix for merge: do not apply the 60 cap, or the word "stuffed", below six uses. The gate line is B1.

**A4. The new short-items cap holds a thorough checklist post at 70 (93 before).**
- Input: `variants.ts`, articles 1b and 1c. The end-of-tenancy checklist with 66 list items of mostly five to nine words ("Clean the oven, shelves and door glass"), an opening, a lead-in to each room and five answered questions.
- 1b is 977 words with 42.7% in short items. 1c, with one-line lead-ins, is 45.8%.
- Observed: cap 70, "…until more of it is written out in full sentences", plus three reading checks held at "Partly" (-7.5). At d4e5527: 93.
- A checklist post is supposed to be mostly checklist. The advice makes it worse.
- Smallest fix for merge: keep the "Partly" hold and drop the cap for items of four to nine words, or move that line to 60%. The better shape is B2.

### MUST-FIX before the gate is used by the loop

**B1. The 2.5% refusal leaves no room on short pages, counts the on-record questions against the article, and is tripped by the report's own advice.**
- Article 11 (a 514-word "boiler service" page, score 98) is told "All the uses are in one part … use it … in another part of the article too". Adding one such sentence ("A boiler service takes between 45 minutes and an hour") gives 7 uses, 2.7%, **gate refused** at 98 (11a).
- Four of those seven uses are sub-headings and questions; three are the on-record questions, which another check rewards with 7 points.
- Article 9a: 468 words, "emergency electrician Bristol" in the opening, the on-record question as a sub-heading, once in the text, once in the closing. 2.6%, refused at 94.
- What the lines allow (`out-allowed-uses.txt`). The first number is the most uses the gate accepts; the second is where the 60 cap starts.

| words | 1 main word | 2 | 3 | 4 |
|---|---|---|---|---|
| 350 | 8 / 13 | 4 / 7 | 3 / 5 | 3 / 4 |
| 400 | 10 / 15 | 5 / 8 | 3 / 5 | 3 / 4 |
| 450 | 11 / 16 | 5 / 8 | 3 / 6 | 3 / 4 |
| 500 | 12 / 18 | 6 / 9 | 4 / 6 | 3 / 5 |
| 600 | 15 / 22 | 7 / 11 | 5 / 8 | 3 / 6 |
| 800 | 20 / 29 | 10 / 15 | 6 / 10 | 5 / 8 |
| 1,000 | 25 / 36 | 12 / 18 | 8 / 12 | 6 / 9 |

- The placement checks need three uses (opening, a sub-heading, another part). Three is also the most allowed under about 470 words for three main words, and under about 630 words for four. A fourth mention in any close form or word order is a refusal.
- Smallest fix: leave out of the count any sub-heading or question that asks an on-record question, and make four uses, not three, never too many. The code already computes this as `asks` and already exempts it from the two-headings limit.
- By my arithmetic (not run), 9a, 10a, 11a and 11b then pass, and the review-3 case (13 uses in 997 words) is still stuffed.

**B2. The 40% short-items line measures the wrong thing: it refuses honest checklists and still passes keyword bullets.**
- Too tight: A4 above.
- Too loose: the builder's own `distinctBullets(34)` (136 bullets like "- flats in York", 39.6%) scores **99 and passes**, two points above the same article without them. 240 one-word bullets each used twice (34.1%) score **100** (`attack.ts` SHUF-2).
- Easy to step round: items of exactly ten words are not "short". 240 keyword bullets of ten words, 74% of the article, score 90 / 85 and pass. The cheapest way for a writer to clear the cap is to pad each item to ten words.
- Item length is what separates them (`attack2.ts` part c, `numbers.ts`). Figures are shares of prose and item words.

| | items under 4 words | items of 4 to 9 words |
|---|---|---|
| my 16 good articles | 0% to 2.6% | 0% to 27.3% |
| builder's good fixtures | 0% to 5.7% (recipe) | 0% to 23.6% |
| thorough checklist 1b / 1c | 1.3% / 1.4% | 41.4% / 44.4% |
| keyword bullets X1, X2, X3b, X5 | 60% to 97% | under 2% |
| `distinctBullets(10)` / `(34)`, both pass at 99 | 15.2% / 36.5% | 4.2% / 3.1% |
| X4 ("We find cheap houses in Leeds daily") | 0.5% | 70.9% |

- Smallest fix: two lines in place of one.
  - Cap when items under four words hold over about 12% of the words. Good writing is at most 5.7%, and this also catches the keyword bullets that pass today.
  - Cap when items of four to nine words hold over about 60%. Checklists sit in the 40s; X4 is 71%.
  - X4-style filler under 60% is the documented "fluent filler" limit and belongs to the meaning check.

**B3. Sub-headings inside a part ("### ") are invisible to the phrase count, the repetition measures and the short-items share.**
- This is older than the diff, but the new header says every occurrence in sub-headings counts.
- The writer prompt allows "### " (read: `prompts/seo-blog-article.md` rule 5) and the page shows them as headings (read: `render.ts`).
- `attack.ts` results:
  - the phrase as ten "### " lines in every part (120 uses): measure 0%, **98, passes**;
  - 480 keyword "### " lines (1,920 junk words, 69% of the page): **96, passes**;
  - the stuffing fixture (5.3%, cap 60) with keyword "### " lines added is diluted to 1.9%: **98, passes**.
- Smallest fix: read a "#" line as a short list item of its block (two or three lines in `paragraphs()` / `listItems()`).

**B4. The bullet fix only sees "- ", "* " and "1." lists. The round-three attack with another marker, or none, still passes at 97.**
- `attack2.ts` part b: X3b (360 keyword bullets, 56% of the article, cap 70 as built) written with "+ ", "• ", "> ", "– " or no marker scores **97 / 92 and passes**, as on d4e5527. The page shows them run together as one paragraph of keywords.
- Related and older: keyword lines as blockquotes score 100; one 140-word run-on keyword sentence per part scores 94.
- A measure that separates them (`longsent.ts`) is the share of prose words in "sentences" of over 50 words. Good articles are at 0%; the regulation fixture is 6%; the re-marked attack is 61.6%.
- Smallest fix: cap at 70 when over about 20% of prose words are in sentences of over 50 words.

### SHOULD-FIX

- **C1. Panel advice under the new state is wrong** (`panel.ts`). The owner reads "1% of sentences are longer than 20 words … Split the longest sentences in two" and "32% of sentences use a linking word … About one sentence in six is plenty".
- **C2. Seven-word template sentences with one word changed** (twelve templates, 120 sentences, half the article): 96, passes, same as before. The near-repeat check starts at eight words. The builder lists the list-item form as a known limit; the prose form has no 40% bound.
- **C3. Derived forms are not uses.** "property deal appraisal" in 24 added sentences: 0%, 100, passes. The gate's refusal text ("use other words for the same idea") invites exactly this.
- **C4. "Neither can hide a use or a repeat" is only partly true** (`attack2.ts` part a; 16 added phrase sentences, plain form caps at 60).
  - Still hidden, scoring 97 to 100 and passing: U+034F, U+FE0F and U+0332 (which split the word), Hangul filler U+3164, dotless i, Latin alpha, Armenian o, Greek omicron with tonos, accented vowels, unmapped Cyrillic.
  - Covered as claimed: zero-width space, soft hyphen, the listed Cyrillic and Greek letters, full-width letters, hyphens.
  - A writer model will not produce these, so either reword the header or strip the three character ranges.
- **C5. Quadratic time on a long run of spaces or tabs** (older; `perf2.ts`).
  - 10,000 spaces take 0.3 s, 20,000 take 1.1 s, 40,000 take 4.3 s, 80,000 take 16 to 22 s. 500,000 did not finish in 3.5 minutes. d4e5527 is the same.
  - Cause: `readable()`'s `/[ \t]*\[src:…\]/g`. Alone it takes 3.0 s at 80,000 spaces; without the leading `[ \t]*` it takes 0.1 ms.
  - The same pattern is in `render.ts` and `citation-edit.ts`.
  - Fix: `(?<![ \t])[ \t]*\[src:`.
- **C6. A room-by-room checklist repeating shared jobs** ("Mop the floor" in each of four rooms): cap 70 on both trees (1d). With three-word jobs it was 96 and is now 94 (1e).
- **C7. The short-items measure is not rounded once like the phrase measure.** 1,001 of 2,500 words (40.04%) reports 40 and is treated as over 40.

### NOTE

- **N1. Other languages** (`i18n.ts`).
  - 72 of 86 common Russian words, 21 of 30 Ukrainian and 33 of 52 Greek are rewritten in Latin letters.
  - Some become English small words ("не" to "he", "то" to "to", "по" to "no").
  - Outcomes do not change, because such articles were already capped at 40.
  - Welsh, Polish, French, German, Spanish and Turkish are untouched.
  - Greek symbols in English fold too ("ρ" to "p").
- **N2. Two older throws.** A search intent named "constructor", "toString", "__proto__" or "valueOf" throws `TypeError` at `seo-score.ts:930`; a `null` context throws. Nothing else threw (37 of 40 odd bodies and briefs, 8 of 9 contexts).
- **N3.** 5,000 on-record questions against 2,000 parts takes 19.6 s (older, unrealistic).
- **N4.** The spacing check says a part "runs over 300 words without a sub-heading" when it has two "### " sub-headings (older).
- **N5.** The phrase in the page title (H1), summary and button label is not counted. Five times in the H1 scores 97 and passes (older).
- **N6.** The phrase measure reports 0 for three uses or fewer whatever the share.
- **N7.** FAQ answers are squeezed from the other side too: page 3b written "Yes, …" with a comma scores 90 / 84 on both trees and is refused without a picture, because 39% of its sentences are then over 20 words.
- **N8.** The builder's four stated limits are accurate.

---

## The good articles

All sixteen were written without counting anything first (`good1.ts`, `good2.ts`, `good3.ts`), scored in strict mode with checks run and clean.

| # | Article | Words | Phrase | Phrase % | Short items % | Score | Cap | Gate with / without picture | Deserved? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Checklist post | 916 | end of tenancy cleaning checklist | 0 | 28.7 | 96 | none | pass / 90 pass | yes |
| 2 | Step-by-step how-to | 816 | how to change a fuse in a plug | 0 | 1.8 | 100 | none | pass / 95 pass | yes |
| 3 | FAQ page, short answers | 634 | MOT test | 0 | 6.8 | 96 | none | pass / 90 pass | yes |
| 4 | Price guide (price list) | 628 | boiler service cost | 0 | 11.2 | 99 | none | pass / 95 pass | yes |
| 5 | Glossary | 856 | conveyancing terms explained | 0 | 6.2 | 94 | none | pass / 90 pass | yes |
| 6 | "10 best" list | 741 | best plants for shade | 0 | 11.2 | 95 | none | pass / 92 pass | yes |
| 7 | Recipe-style post | 666 | sourdough starter recipe | 0 | 14.8 | 95 | none | pass / 90 pass | yes |
| 8 | Local page, 2-word phrase | 491 | plumber Harrogate | 0 | 8.3 | 98 | none | pass / 92 pass | yes |
| 9 | Local page, 3-word phrase | 543 | emergency electrician Bristol | 0 | 9.0 | 95 | none | pass / 90 pass | yes |
| 10 | Local page, 4-word phrase | 522 | mobile dog groomer Leeds | 0 | 4.2 | 94 | none | pass / 90 pass | yes |
| 11 | Service page, phrase names the thing | 514 | boiler service | 2.3 | 10.5 | 98 | none | pass / 92 pass | yes |
| 12 | Product comparison | 815 | laminate vs vinyl flooring | 1.5 | 2.2 | 98 | none | pass / 93 pass | yes |
| 13 | Legal explainer | 824 | landlord electrical safety certificate | 0 | 6.3 | 98 | none | pass / 95 pass | yes |
| 14 | Short news update | 357 | Making Tax Digital for Income Tax | 0 | 0 | 92 | none | pass / 88 pass | yes ("thin" is fair) |
| 15 | Long pillar | 1,766 | loft conversion | 0.7 | 2.8 | 94 | none | pass / 91 pass | yes |
| 16 | Explainer, one main word | 727 | what is conveyancing | 0.7 | 4.6 | 94 | none | pass / 90 pass | yes |

All sixteen pass with and without a picture, and score the same on both trees. The pages came out at 491 to 543 words; the 350-to-450-word versions are 8a, 9a/9b and 10a/10b below.

The same articles after ordinary edits (`variants.ts`, `variants2.ts`):

| Variant | Words | Phrase % | Short items % | Score (before cap) | Cap | Gate | d4e5527 | Deserved? |
|---|---|---|---|---|---|---|---|---|
| 3b FAQ page, answers opening "Yes." / "No." | 645 | 0 | 0 | 70 (88) | repetition 70 | refused | 92 pass | **no** (A1) |
| 1b thorough checklist, 24 more items | 977 | 0 | 42.7 | 70 (86) | short-items 70 | refused | 93 pass | **no** (A4) |
| 1c the same, one-line lead-ins | 916 | 0 | 45.8 | 70 (86) | short-items 70 | refused | 93 pass | **no** (A4) |
| 10a 4-word phrase, four usual placements | 401 | 4.0 | 3.9 | 60 (90) | stuffing 60 | refused | 91 pass | **no** (A3) |
| 10b the same, three placements | 397 | 0 | 3.9 | 91 | none | pass / 87 pass | same | yes |
| 9a 3-word phrase, four usual placements | 468 | 2.6 | 10.3 | 94 | none | refused | 94 pass | **no** (B1) |
| 9b the same, three placements | 457 | 0 | 10.6 | 96 | none | pass | same | yes |
| 8a 2-word phrase, four placements | 422 | 2.4 | 9.7 | 99 | none | pass | same | yes |
| 11a boiler service + the sentence the report asks for | 518 | 2.7 | 10.4 | 98 | none | refused | 98 pass | **no** (B1) |
| 11b each question answered in a full sentence | 523 | 3.4 | 10.3 | 98 | none | refused | 98 pass | arguable; I say no |
| 1d checklist repeating four shared jobs per room | 951 | 0 | 31.5 | 70 (94) | repetition 70 | refused | 70 refused | arguable, older (C6) |
| 1e the same with three-word jobs | 934 | 0 | 30.1 | 94 | none | pass | 96 pass | -2 is new |
| 7a recipe with "Stir well." in each step | 679 | 0 | 18.2 | 93 | none | pass | 95 pass | -2 is new, mild |
| 1a, 4a, 12a (questions as FAQs, fuller price list, pros and cons lists) | 676 to 872 | 0 to 1.4 | 6.7 to 31.9 | 93 to 99 | none | pass | same | yes |
| 3c FAQ page with "Yes," (comma) | 645 | 0 | 0 | 90 | none | pass / 84 refused | same | older (N7) |
| 15a pillar scored against "loft conversion cost" | 1,766 | 0 | 2.8 | 80 | none | refused | same | yes: not written for that phrase |
| 16a against "conveyancing"; 3a against "MOT" | 727; 634 | 0.7; 1.1 | 4.6; 6.8 | 97; 99 | none | pass | same | yes |

### Are the lines right?

- **3.5% (cap 60): too tight on short pages, about right on long ones.** It catches 13 uses in 997 words as intended, and also four uses of a four-word phrase in 401 words. The fault is the measure (uses times main words), not the number.
- **2.5% (gate refuses): right from about 800 words; too tight below about 470 to 630 words for three- or four-word phrases; loose for one-word phrases** (15 uses in 600 words allowed). My natural articles measure 0% to 2.3%, and one more ordinary sentence takes two of them to 2.6% and 2.7%.
- **40% short items: too tight for checklists (42.7%, 45.8%) and too loose for keyword bullets (39.6% passes at 99).** Split it by item length (B2).
- Close-form matching did not over-count on common words in practice. The over-count comes from sub-headings and questions, mostly the on-record ones (four of seven uses in 11a).

---

## Rubbish that passed the gate

Host is the strong fixture (97 clean) unless noted.

| Attack | Words | Score | Gate | d4e5527 |
|---|---|---|---|---|
| Platitudes fixture + 20 different one-word bullets per part (A2) | 2,133 | **98** | passes | 70 refused |
| Four-templates fixture + 40 one-word bullets per part (A2) | 2,479 | **95** | passes | 70 refused |
| 120 uses of the phrase as "### " lines (B3) | 1,457 | 98 | passes | 98 |
| 480 keyword "### " lines, 69% of the page (B3) | 2,777 | 96 | passes | 96 |
| Stuffing fixture (5.3%) diluted with "### " lines to 1.9% (B3) | 2,993 | 98 | passes | 98 |
| X3b keyword bullets with "+ ", "• ", "> ", "– " or no marker (B4) | 1,937 | 97 | passes | 97 |
| Keyword lines as blockquotes | 1,433 | 100 | passes | 100 |
| One 140-word run-on keyword sentence per part | 2,501 | 94 | passes with picture (89 without) | 94 |
| 136 keyword bullets at 39.6% (builder's known limit) | 1,265 | 99 | passes | 97 |
| 240 one-word bullets, each used twice, 34.1% | 1,169 | 100 | passes | 98 |
| 240 keyword bullets of exactly ten words | 3,257 | 90 | passes | 92 |
| Twelve 7-word templates in rotation, 120 sentences (C2) | 1,697 | 96 | passes | 96 |
| 24 sentences of "property deal appraisal" (C3) | 1,152 | 100 | passes | 100 |
| 16 phrase sentences hidden with U+034F, U+FE0F, U+3164, dotless i or accents (C4) | 1,073 to 1,121 | 97 to 99 | passes | same |
| The phrase five times in the page title (H1) | 857 | 97 | passes | 97 |

Caught as claimed:
- a pasted list of any item length (40);
- synonym-swapped copies of whole parts (40 or 70);
- keyword table rows (40);
- zero-width spaces, the listed look-alikes, full-width letters and the hyphenated phrase;
- the phrase in list items, table cells, link text, section sub-headings and answers;
- HTML comments and link titles (the page shows these literally and they are counted);
- the picture description saying the phrase twice.

---

## Determinism, timing, odd input

- **Deterministic.** 18 articles hashed forwards, in reverse, after flooding both memo tables past 50,000 entries, and from deep copies: all identical. Inputs are not mutated.
- **Timing**, one call each, on a shared machine at load 6 to 9:

| Input | e1eeb7c | d4e5527 |
|---|---|---|
| 10,000 words of prose | 116 ms | 128 ms |
| 50,000 words | 289 ms | 355 ms |
| 200,000 words | 790 ms | 688 ms |
| 200,000 words as one paragraph / one sentence | 892 / 914 ms | |
| 200,000 times one token / one-word sentence | 974 / 1,146 ms | |
| 100,000 different three-word list items | 2.0 to 2.7 s | 1.5 to 2.4 s |
| 100,000 identical items / one-word items | 1.1 s / 0.4 to 0.6 s | |
| 200,000 look-alike words | 1.5 s | |
| 5,000 FAQs / 5,000 parts | 0.6 s / 0.5 s | |
| 1 MB of zero-width spaces, full stops or "?!" | 44 to 186 ms | |
| 5,000 on-record questions with 2,000 parts | 19.6 s (N3) | |
| 80,000 spaces in a row | 16 to 22 s (C5) | same shape |

- Everything grows in step with size except the last two rows, and both are older. Nothing in this diff adds a blow-up.
- **Odd input**: empty, null, wrong types, whitespace only, lone surrogates, right-to-left text, emoji sequences, stacked combining marks, control characters. None threw, and scores were finite and in range. The only throws are N2.

## Consistency

- **2.5% and 3.5%**: 381 generated articles, zero disagreements between check, cap, measure, gate reason and wording. 2.5478% reports 2.5 and passes; 2.5559% reports 2.6 and is refused. 3.5443% has no cap; 3.5533% is capped.
- **40% and 100 words**: exactly 40.000% is not held and 40.1% is. 99 words has no cap and 100 words does. One rounding gap (C7).
- **Third appearance**: a three-word item twice is free and three times is counted; a four-word item is counted on its second appearance. The same rule in prose is A1.
- **Picture description**: the phrase once passes; twice fails the check and the gate gives that one reason.
- **Panel** (13 states, both looks):
  - every cap sentence shows in plain English, including the new one;
  - the lower cap shows when two apply;
  - there is no supplier, model or method word, no jargon, no control and no raw value;
  - hostile text is escaped in the title, description, heading, list items, picture description, search phrase and starting word;
  - the only fault is C1.
- **Cap kinds elsewhere**: the only use outside the score is `seo-blog-seo-panel.ts:190`, which needs no change. Typecheck and the golden test pass.

## The tests

- **Pinned scores equal d4e5527** (`pinned.ts`). The eight good fixtures were scored as a report, as a gate and without a picture, along with the pillar (96), strong fixture (97, 97), realistic fixture (72) and long varied guide (93). There are zero differences, including every individual check result.
- **Both changed assertions got stricter** (`changed-asserts.ts`).
  - The "alone" test's original input still fails the use check on both trees. The old message is now asserted on a longer input and a stronger message on the original.
  - The 3.9% case went from "partly" to "fail" plus the cap.
- **One new test is weaker than it reads**: the honest-lists test passes because the lists dilute the repeat share (A2).
- **Missing cases**: answers opening "Yes." / "No."; a checklist post; a 350-to-450-word page with a three- or four-word phrase; "### " lines; a bullet attack with a marker other than "- ".

## What I could not verify

- Whether anything upstream limits the size of owner-edited article text. I found no limit in `limits.ts` or the edit path, so C5 may be reachable from a pasted document.
- How Rank Math and Yoast will judge the same phrase once it is passed to them. I believe they count density per occurrence, so they may call a page low where this gate calls it high; I did not check or test this.
- The meaning check that is to sit beside the gate. It does not exist in this branch.
- What the writer model actually produces under a rewrite loop. The "good" side of this review is my own writing.
- The suite with the environment variable earlier reviews switched on. I did not find its name, so only the plain run was done.
- The B1 fix was worked out by hand, not run. Only the A1 and A2 fixes were tried in code.

## Files

Everything is in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review4-seo-score/`:
- Harness: `h.ts`, `base/` (d4e5527), `patched/` (scratch copy for A1 and A2)
- Good writing: `good1.ts`, `good2.ts`, `good3.ts`, `run-good.ts`, `variants.ts`, `variants2.ts`, with `out-good.txt`, `out-variants.txt`, `out-variants2.txt`
- Rubbish: `attack.ts`, `attack2.ts`, `dilute.ts`, `dilute2.ts`, `longsent.ts`, with matching `out-*.txt`
- Boundaries, panel, tests: `bounds.ts`, `panel.ts`, `pinned.ts`, `changed-asserts.ts`, `patched-check.ts`, `dbg2.ts`, `numbers.ts`, with matching `out-*.txt` and `out-allowed-uses.txt`
- Timing and safety: `perf.ts`, `perf2.ts`, `perf2.sh`, `i18n.ts`, with `out-perf-first-run.txt`, `out-perf-rest.txt`, `out-perf2.txt`, `out-i18n.txt`
- Logs: `typecheck.log`, `full-suite.log`