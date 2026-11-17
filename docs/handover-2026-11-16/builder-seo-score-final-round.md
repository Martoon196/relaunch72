## Round five: SEO score fixes, `claude/seo-score-gate-holes`

All the must-fix items are done except one cost I could not avoid: two genuinely good checklist pages now score a few points below d4e5527, though both still pass the gate. No good page is refused.

**Head:** `4d483490fea8c90d43cca4a6e2103240c0f40c4d`, pushed; the remote branch is at the same SHA. It has 8 commits on 2e74c7e, with no merge, no force-push and no PR.

**Files changed:**
- `orchestrator/src/seo-blog/seo-score.ts`
- `orchestrator/src/seo-blog/citation-edit.ts` (one line, line 120)
- `docs/seo-blog-engine.md` (new section "Known limits of the SEO score")
- Tests: new `seo-score-review5-good.ts`, `seo-score-review5-rubbish.ts`, `seo-score-review5-baseline.json` and `seo-score-review5.test.ts`; edits to `seo-score.test.ts`, `seo-score-review3-fixtures.ts` and `seo-score-review4-rubbish.ts`.

**Things you didn't ask for or that differ from the brief:**
- The panel file is untouched (0 lines). There is no new cap kind; the panel only shows caps.
- The public shape gains one field, `measures.phraseHeadings`. Nothing is removed.
- G1: the one-per-question allowance applies in the heading check only for phrases of two or more main words. Applied to one-word phrases it costs the MOT page (P3) a point, because its natural FAQ questions all say "MOT".
- G1 also gets one new gate reason.

### Corpus as fixtures
- The 21 good articles are in with their d4e5527 scores and a check-by-check baseline.
- The review's rubbish is all 59 rows from `attack5.ts`, `attack5b.ts`, `shared.ts` and `dbg3.ts`, byte-identical to the reviewer's articles (checked one by one).
- I added one row of my own, G2r, as the worked example of the remaining bullet limit.

### Per finding

| Finding | Change (`seo-score.ts` unless noted) | Before (2e74c7e) → after |
|---|---|---|
| **M1** | Very-short-items line 12% → 25%, line 318; the "partly" hold moves with it | P1 70 REF → **93 pass / 87** (d4: 96/90); P6 70 REF → **93 / 88** (d4: 92/87); P7 70 REF → **93 / 87** (d4: 94/88) |
| **M2** | Shared items must be at most half of their list and at most 5 per list, lines 759, 792 | Pasted list + 11 different: 97 pass → **40 REF**; the other three pasted-list rows → 40 REF; room-by-room checklist 1d stays 96 |
| **G1** | One excused heading per on-record question, never a `###` line, lines 939, 1061, 1110; heading check 1079; gate reason when the phrase is stamped on more than 2 headings and over half of them, lines 270, 1081, 1513 | E1 100 → **60**; E4 99 → **60**; E9 93 → **60**; E6 100 → **99 REF** (heading reason); 9a / 11a / 11b stay 96 / 99 / 99; P3 stays 100 |
| **G2** | List items enter the repetition measures only when they repeat, lines 834, 845; list numbering is not a word (lines 558, 984, 1169); phrase share measured without items under ten words, line 987 | D2 94 → **70**; D3 91 → **70**; D6 98 → **70**; phrase 2.6% + numbered bullets 99 pass → **96 REF** |
| **G3** | Run-on = over 40 words, line 323 (cap stays 20%); a pasted item of short sentences compared whole, lines 859, 958; 2–3-word prose sentence repeats from its sixth appearance, lines 757, 843; headings and questions said again are repeats, line 976 | O1 97 → **70** run-on (46.7%); O4, O5, X1 → 70; I4 98 → **40**; S2 90 → **40**; S4 93 → **40**; S1 92 → **40**; regulation fixture 14.7% and N6 6.6% stay uncapped |
| **Extra holes the property test found** | Small-word share also read without items under ten words, line 993 | One "not sentences" page went **40 → 93** with six-word bullets added; now stays 40. No good page changed |
| **S1** | `citation-edit.ts:120`: `(?<![ \t])` added to the typed-marker pattern | 80,000 spaces through `restoreCitationsDetailed`: **11.8 s → 6 ms** (500k: 20 ms). Identical on 36,000 random calls across all 9 exports, 200,000 random strings, plus an in-repo test of 5,000 |
| **S2** | `sentences()` judges each full stop on a 24-character window, lines 580, 594–595 | 1 MB of "No. 5 " through the score: **over 60 s → 1.4 s**. Identical splits on 100,000 random strings and 44,488 corpus texts (5,000 plus the corpus in-repo, against an embedded copy of the old function) |
| **S3** | The two dodges that were refused only by a heavy dose are now asserted as `repetition`; `KNOWN_LIMIT4` holds its one real row instead of being asserted empty; `KNOWN_LIMITS` kept exact in both directions | — |
| **S4, S5** | H4 (the same question 100 times) is now caught (95 → 40). The rest are known limits: counting two of three phrase words refuses the good price guide (2.7%) | — |
| **N9** | A leading "the", "a" or "an" in a list item is not its start, line 1327 | 99 → **100** |
| **12a** | Not restored | Stays 97. Its two-word items would have to count towards part length, which reopens A2 |

**Bullet fuzz, reviewer's script (3,159 trials).** Raised / flipped:

| Words per bullet | 2e74c7e | Now |
|---|---|---|
| 1–3 | 0 / 0 | 0 / 0 |
| 4 | 43 / 0 | 34 / 0 |
| 5 | 58 / 2 | 32 / 0 |
| 6 | 71 / 3 | 29 / 0 |
| 7 | 63 / 3 | 23 / 0 |
| 8 | 70 / 5 | 22 / 0 |
| 9 | 58 / 2 | 22 / 0 |

**Wider fuzz (7,416 trials, with and without a picture, 12 markers):**
- One to three words: 0 raised, 0 flipped.
- Four to nine words: raises happen only through length, part length and the sentence-length check.
- The one linking-words gain came from a single unmarked line, which is a paragraph, not a bullet.
- All 17 flips came through the sentence-length check, on the FAQ page 3c without a picture (refused at 84).
- The repo's property test asserts exactly this residue. Closing those three channels instead lowers 11, 9 and 4 good pages.

**Allowed-uses table:** identical to the review's 2e74c7e table.

**Reviewer's consistency script:** 0 disagreements in 2,668 articles once its hard-coded 12% is changed to 25% (my copy), plus a new 22–28% sweep with 0 disagreements.

**Reviewer's panel script:** reports 4 "problems". They are its two M1 cases (P1, P6) expecting the short-items cap, in both looks, which M1 removes. X3b and X4 still show the cap sentence.

**Render and citation diff:** 0 differences, and `safety.ts` (determinism, 89 odd inputs) is unchanged.

### Good articles (73 across all corpora)
Every good article passes the gate with and without a picture and scores at or above d4e5527, except:

| Page | d4e5527 | Now | Why |
|---|---|---|---|
| P1 kit list | 96 / 90 | 93 / 87 pass | Very short items don't count towards length or a part's length |
| P7 hospital bag checklist | 94 / 88 | 93 / 87 pass | Same: one part counts as thin |
| Honest list (strong fixture + 6 steps, synthetic) | 99 | 97 | Its 99 came from the list diluting two repeated sentences in the host. It now scores the host's own 97, which the existing test requires as the floor |
| 12a (variant the review called deserved) | 98 | 97 | Unchanged since 2e74c7e |
| N6 legal explainer | 90 / 84 REF | 90 / 84 REF | Same as d4e5527 |

The P1/P7 rule is what stops different short bullets from ever raising a score (the A2 property). Counting their items would break that property and the existing A2 test, so I left the rule and named both pages in the test.

The original 8 good fixtures, pillar, strong, realistic and long guide are pinned exactly and unchanged.

### Rubbish
Every round-five row is refused the way its fixture says, with and without a picture, or it is a listed known limit. Every earlier round's row is refused except the known limits below. Of the 133 rows in my comparison set, 16 pass, and every one is in `KNOWN_LIMITS`.

### Known limits (`KNOWN_LIMITS`, mirrored in `docs/seo-blog-engine.md`)
The test fails if an entry stops passing or if any passing row is missing from the list.

1. **Fluent empty filler** (98): only meaning separates it from writing.
2. **Very short keyword items under 25%**, e.g. keyword lines as blockquotes (98), keyword bullets at 11.5% (97), the one-word-changed list in two parts (97): a kit list is 19.8%.
3. **15-word keyword items with no full stop** (L1 98, L4 94): a thorough checklist has as many items that long.
4. **Different 2–3-word prose sentences** (S3 92, S5 90, I5 98): only repeats can be caught.
5. **Four-word templates** (M4, 95): at four words any two plain sentences would match.
6. **One 140-word run-on** (O2, 97): it is 16.9% of the prose, and the regulation fixture is 14.7%.
7. **Two of three phrase words** (U2, 100): counting them refuses the good price guide.
8. **Phrase split across two items** (97).
9. **A 60-word keyword page title** (U3, 97).
10. **Keyword questions with empty answers** (H1 97, H3 96): when the quality checks run they flag a part under 25 words as must-fix, which holds the score at 59.
11. **Different 4–9-word bullets count as content** (G2r: 84 refused → 89 pass).

### Timing (one process per case, load 4–8)

| Input | Time |
|---|---|
| 10k / 50k / 200k words | 97 / 332 / 1,118 ms |
| 100k different three-word items | 2.6 s |
| 80,000 spaces through the score | 48 ms (500,000: 115 ms) |
| 80,000 spaces through `restoreCitationsDetailed` | 6 ms |
| 1 MB of "No. 5 " | 1.4 s |
| 200 questions × 100k `###` lines | 6.1 s → 1.9 s |
| 5,000 questions × 2,000 parts | 19.6 s (not addressed, as before) |

### Tests
- `npm run typecheck`: exit 0.
- Score, round five, panel, units/citation and the five render/article-page files: 151 of 151 pass.
- Full suite, plain: **5,302 tests, 5,186 pass, 0 fail, 116 skipped.**
- Full suite with `CONTENT_AREA_PREVIEW=enabled`: **5,302 / 5,186 / 0 / 116.**
- That is 16 tests more than 2e74c7e's 5,286, all new. No test was skipped or weakened. Moved measured numbers are each explained in their test: share 4.0 → 4.1, regulation run-on 6 → 14.7, line 12 → 25.
- My last commit after the full runs only corrected a number in the docs; I re-ran the round-five test file after it (16 of 16 pass).

### Verified vs assumed
- **Verified:** everything above, by running it.
- **Not verified:** the meaning check, which doesn't exist yet; what the writer model produces inside a rewrite loop; whether the writer can emit an empty answer.
- **Not addressed:** `seoGate({})` still throws on a malformed score (the review's note; nothing calls it that way today).
- I ran one `git fetch` of origin to confirm the remote SHA.

The reviewer's scripts and their outputs (`out5-*.txt`) are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/r5work/`.