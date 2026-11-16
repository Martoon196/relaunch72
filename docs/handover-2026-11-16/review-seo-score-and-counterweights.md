# Review: SEO score and report panel, claude/article-seo-panel @ 3ea5d3a (base c00c928)

HEAD is 3ea5d3ac1c4a89d66e877f830b56a071f97ca1c4; the tree is clean before and after.

## Verdict for shipping as a read-only report now: SHIP
Nothing blocks a read-only report: the live page is safe and the panel itself reveals nothing it should not. Five small fixes are worth doing soon (end of this report). The score is **not** ready to be an automatic target: a nonsense article scores 97, the maximum possible today.

One thing outside this branch needs a decision: the existing **Topics page prints the data supplier's name** next to measured search numbers. On the real engine it shows "Measured: 880 searches/month (dataforseo, 2026-11-01)" (`seo-blog-view.ts:297`, unchanged since base). That already breaks the owner's rule wherever measured numbers are on.

## 4. Safety of the live page: holds
My own differential, `git archive c00c928` against HEAD through the real router, pinned ids and clock, with my own marker removal (not the builder's).

- 9,991 request pairs over five modes (absent; absent + cookie; `true` + cookie; enabled without cookie; enabled with cookie).
- 9,028 are byte-identical in status, headers, body and engine calls.
- 963 are article reading pages, identical once the two marked pieces are removed.
- 0 other differences. The edit view and every other page and POST are untouched.
- **The stripping cannot hide a difference.** Every piece is exactly one `<p class="ap-quiet-line sp-line">` or one `<details id="seo">`, balanced, with no form, script, button, input or main action. A hostile body containing the end marker is escaped.
- `?open=seo` opens the fold; unknown and script-bearing `open` values change nothing.
- **Hostile text** in every brief and body field, rendered in Chromium for 24 pages and both looks: 0 dialogs, 0 injected elements. Main actions on the page are unchanged (0 or 1).
- **Brief isolation:** an article pointed at another business's plan shows "not on record"; another user gets 404.
- **"What to do" links:** across 21 written states every link lands on a working control. The address link is correctly dropped once live; while publishing only rewrite and picture links remain. One edge: an article with no sections gets "Edit the sub-headings" with nothing to edit.

## 3. Honesty and confidentiality: the panel is clean
- 552 pages rendered (23 states × 12 briefs × 2 looks). The panel never shows the supplier, the competition figure, model or maker names, pack or plan ids, "prompt", "provider" or "API". It has no hidden fields, data attributes or comments.
- The search block shows only the number and date. Null, negative, non-numeric or undated values fall back to "We do not have search numbers for this phrase yet."
- Secrets planted in every other brief field reached no article route in either look (page, edit, campaign, posts, preview, both exports, image status JSON). `articleBrief` is read only by the panel.
- The start-up log line carries only on/off states.
- The "data for search engines" statements match the renderer and the WordPress plugin.
- For you to judge: the tags card names "Rank Math or Yoast", "our own WordPress plugin" and "BlogPosting". That is publishing mechanics, not the writing method.
- NOTE: a measured value of 0 reads "0 searches a month in Google", which may really mean "too low to measure".

## 1. Correctness of the score
- **SHOULD-FIX: "Pictures inside the article" always fails.** It costs 3 points for something impossible, so the best score today is 97 and "Not yet" always has an item saying "Nothing for you to do". Leave it out like the other checks that cannot run (`seo-score.ts:422`).
- **SHOULD-FIX: plurals and possessives fail outright.** For "bridging loan", the title "Bridging loans explained for investors" fails title, start and address. "Buy-to-let mortgages: a plain guide" fails for "buy to let mortgage". A phrase with an apostrophe can never pass the address check.
- **SHOULD-FIX: syllable rule is wrong for -ces/-ges words.** 27 of 29 are one short ("mortgages" 2, "prices" 1, "services" 2), because the exception at `seo-score.ts:241` can never match. Vowel pairs are short too ("valuation" 3, "area" 2). Against known values: Wikipedia's 69.0 sentence scores 74.3; the 37.5 sentence scores 37.5; a hand-counted Gettysburg opening (about 68.4) scores 69.3. Reading ease can be about 5 points generous near the 60 line.
- **Double counting.** With an opening under 60 words, "phrase in the opening paragraph" and "the opening gets straight to the point" are the same fact, worth 8 points. Title and title-start are 7 for one edit.
- **"Questions people ask" is weak both ways.**
  - False passes: "Bridging loan basics" answers "How much does a bridging loan cost?"; any heading with "HMO" answers "What is an HMO?"; "Survey types compared" answers "Do I need a survey?".
  - False fails: the same answer in other words, or answered fully in the text under a heading "Fees".
- **Links.** A link to the home page or to the article itself passes; so does a link the quality checks flag as broken, and an outside link they flag as unverified. A sub-domain of the owner's site counts as outside.
- **Density.** It counts phrase words, so a nine-word phrase used twice in 600 words is "a little high" and three times is "stuffed". A phrase split across a heading and the first word below it counts as a use.
- **Sentences.** Decimals, "e.g.", "Mr.", "U.K." and quotes are right. "The answer is no. Then we stopped." and "etc. Then…" merge into one sentence.
- **Scaling.** No brief gives 89 for an article that scores 93 with its brief, and 63 with a phrase it never uses; the panel says what was left out. An empty article still earns 10 of 25 for reading.
- **Figures.** Reuses the check results only when they ran on this exact version, otherwise the check is left out. Other fact problems do not affect it.
- Boundaries (30/65, 70/160, 60/80, 600/1,200) and word counting behave as documented.

## 5. Performance
- Typical article: 0.5 ms per score. The article page goes from 3.6 ms to 5.1 ms because the score runs twice per view (summary line and fold).
- 12,800 words: 14 ms. 41,600 words: 46 ms.
- Worst input I found: 20,000 "[a](" fragments, about 290 ms.
- No cache is needed. Compute it once per page; cache by version id only when lists or the improve loop need it.

## 6. Plain English and tone
- Wording is plain: no jargon, no long dashes.
- No sideways scroll at 390 or 320; no heading skips; focus rings visible.
- **It is a wall on a phone.** A typical article today scores 58 with 8 "Not yet" and 7 "Nearly there". Open, the report is 4 screens on desktop and 7 on a 390 px phone.
- **Smallest change to make it feel achievable:** lead with "Three things would take this from 58 to 71" (main picture +5, phrase in the opening +4, linking words +4 on the fixture) and fold the rest away, as "Already good" is.
- **SHOULD-FIX: dark mode.** The white tick, cross and "!" sit on pastel circles at 1.6 to 2.0:1. The text tag beside each still reads.
- NOTE: the 15 "what to do" links are about 20 px tall; the link from the summary line lands with the report heading under the sticky action bar; on a live article the address advice remains with nothing he can do.

## 7. Checks
- `tsc`: exit 0.
- Score, panel, article-page, shell and portal files: 106/106 with the variable unset and 106/106 with it enabled.
- Full suite, unset: tests 5064, pass 4951, fail 0, cancelled 0, skipped 113.
- Full suite, enabled: tests 5064, pass 4951, fail 0, cancelled 0, skipped 113. Another agent's suite was running during this run; nothing failed.

## Worth fixing soon (not blocking the read-only report)
1. Leave "pictures inside the article" out of the score.
2. Accept plural and possessive forms of the phrase, and compare the address without apostrophes.
3. Fix the -ces/-ges syllable rule.
4. Dark-mode marks.
5. Compute the score once per page.

## 2. For the improve loop: what needs a bound or a counterweight
Proof: an article of two-word nonsense sentences ("So go. But big. Then win.") scores **97**. It has the phrase alone as a sentence and a heading, five headings, three copied questions each answered "So yes. But go.", one link to the home page, one link to anywhere and a button labelled "Go"; reading ease is 120. Padded to 29,418 words with 145 headings it still scores 93.

| Check | Why it can be gamed | Counterweight |
|---|---|---|
| Short sentences, reading ease | One- and two-word fragments score best | Floor on average sentence length (about 10 words); cap the share under 4 words; no extra credit above ease 80 |
| Phrase placement and use | The phrase alone as a sentence or heading counts; up to 2.5% passes | It must sit inside a real sentence; cap near 1.5%; spread it out; at most two headings |
| Google title and description | Phrase plus filler passes | Reject repeated words; require a sentence |
| Article length | No upper bound; repetition counts | Full marks in a band (about 1,200 to 2,500); penalise duplicate sentences |
| Sub-headings and spacing | A heading every 50 words passes | Minimum words per part; cap headings per 1,000 words; headings must differ |
| Questions and answers | Three one-line answers pass | Minimum answer length; the answer must share the question's key words; cap the count |
| Questions people ask | Copying the question as a heading passes | Require a real answer under it; match on meaning words, including plurals |
| Linking words | "So" or "But" at the start of every sentence passes | Pass band (about 30% to 60%); require variety; cap sentence-initial use |
| Varied starts | Alternating two words passes | Cap any one starting word at about 15% of sentences |
| Link to your own site | Home page, self-link or broken link passes | Not the home page or itself; use the existing broken-link check; anchor of two words or more |
| Outside source | Any outside link passes | Use the existing unverified-link check; prefer a shown citation |
| Picture description | The phrase alone passes | Minimum words; must not equal the phrase |
| Next step | Any label with any https address passes | Label of two words or more; address on the owner's site |
| Figures | Left out when the checks have not run | For the loop, fail closed |
| Whole score | Ignores the quality checks, so nonsense can score high | Cap the score while any must-fix issue is open; add a repetition and vocabulary-variety floor; require a brief |
| Opening, title | One edit is paid twice | Merge the pairs or halve one of each |
| Exact-match phrase | Pushes the loop towards ungrammatical exact repeats | Accept plural and possessive forms |

Everything is in /tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/shell-review/seo/ :
- scripts/
- base-all.json and head-all.json
- out/ (rendered pages)
- shots/
- full-unset.log and full-enabled.log