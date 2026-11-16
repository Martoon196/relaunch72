# Addendum: the traffic estimate on Keywords and Home (owner decision: show it)

This supersedes owner decision 5 and the "What this could bring" bullet in section 2 of my earlier report. Read-only design; nothing was written.

One thing changed under me: the working directory is now `/home/user/r72-article-page` (HEAD d9747dd). There, `orchestrator/src/portal/content-area-pages.ts` differs from c00c928 by 12 insertions and 8 deletions, so its line numbers below are for that checkout. All other citations in the earlier report remain for `/home/user/r72-shell` at c00c928.

## The estimate

**Rule:** estimated visits = measured monthly searches × the share of searchers who click a result at a given position.

**The curve (constant `CLICK_SHARE_V1`):**

| Position | Share of searches that click | Status |
|---|---|---|
| 1 | 28.5% | Verified (Sistrix study of 80M+ keywords, as reported by Search Engine Journal and Bruce Clay) |
| 2 | 15% | Verified (same) |
| 3 | 11% | Verified (same) |
| 4 | 8% | UNVERIFIED, house assumption (interpolated) |
| 5 | 7% | UNVERIFIED, house assumption |
| 6 | 5% | UNVERIFIED, house assumption |
| 7 | 4% | UNVERIFIED, house assumption |
| 8 | 3% | UNVERIFIED, house assumption |
| 9 | 3% | UNVERIFIED, house assumption |
| 10 | 2.5% | Verified (same) |

- I could not open the original study from this session; the four verified figures come from search snippets of secondary coverage.
- Other public studies put position 1 higher (about 32-43%), so this curve is the conservative choice.
- The study predates AI answers on results pages, which reduce clicks. That is a known reason the estimate may run high; say so in the disclosure.

**Per row:** the range is "position 3 to position 1".
- low = searches × 11%, rounded down
- high = searches × 28.5%, rounded up
- rounding step: 5 below 100, 10 below 1,000, 100 above

Examples:
- 400 searches gives "about 40 to 120" (matches the coordinator's example).
- 1,300 searches gives "about 140 to 380".
- If the high end is under 10, show "fewer than 10 visits a month".

**Wording on the row:** "Could bring about 40 to 120 visits a month if it reaches the top three. Estimate."

**When it is not shown:**
- Never when there is no measured search number for that exact phrase.
- A phrase measured only through a wider parent phrase shows the parent's searches, labelled as the wider phrase, and no estimate.
- An observed-only phrase shows "No search number yet, so no estimate".

**Disclosure** ("How we work this out", one tap):
"We take how many times a month people search this phrase and the share of searchers who usually click the first, second or third result (between about 1 in 9 and 2 in 7). It is an estimate, not a promise. Many articles take months to reach the top three and some never do. The harder the keyword, the less likely."

The difficulty band sits beside the estimate on every row, so the likelihood is always in view. The supplier is never named; searches read "measured October 2026".

## Per-business roll-up

**What is counted:**
- One primary phrase per article, for phrases in the states chosen, being written, ready and live.
- Secondary phrases are not added. They are close variants and would double count.
- Suggested and dismissed phrases are not counted.
- Phrases without a measured number are not counted, and the line says so.

**Formula:** sum of the row lows to sum of the row highs, on the same curve and rounding. It can be computed from briefs alone: `brief.seo.primary.searches` where `basis` is `measured`. `ContentAreaData` already carries `briefs` (`/home/user/r72-article-page/orchestrator/src/portal/content-area-pages.ts:25-33`), so Home needs no new data loader. A selection that is still queued reads its phrases from the keyword pool.

**Wording** (Keywords header and one quiet card on Home, linking to Keywords):
"The 9 keywords you have chosen could bring about 380 to 1,000 visits a month if they all reach the top three. Estimate. 2 more have no search number yet and are not counted."

**While autopilot is on with nothing chosen:** "The 7 keywords autopilot will write next could bring about X to Y…".

**Honesty guards:**
- The condition "if they all reach the top three" is always in the sentence.
- The word "Estimate" is always present.
- The roll-up is never shown as a headline figure without its sentence.
- It is never mixed with real numbers.

**Optional second line** (my suggestion, his call): "If they reach the first page but not the top three: about A to B" (2.5% to 8%). It makes the picture more realistic at the cost of a second number.

## Results page

Its promise must change with this. Today it says "you will not see guessed numbers" (`content-area-pages.ts:516` in the current checkout; 512 at c00c928).

New wording: "Estimates of what your keywords could bring are on Keywords. Real visits from Google will show here once your website's search results are connected."

Results stays actual-only.

## When Search Console is connected later

Nothing for it exists in the repository today: a search for "search console" or "webmasters" across `orchestrator/src` finds nothing.

**Connection.** The owner connects Google once per website, read-only. The token is sealed with the existing `SeoBlogCredentialVault`, attached to the website's destination record, so no new record kind is needed.

**Data.** For each live article address: clicks, impressions and average position for the last 28 days. Fetched by the worker at most daily and stored as the latest snapshot on the article (jsonb): `article.results = {source, period, clicks, impressions, avgPosition, fetchedAt}`. History over time is the same optional migration B as in release 14.

**Replacement rule.** For a live article with at least 28 days of data, the row drops the estimate and shows the real figure: "Brought 86 visits from Google in the last 28 days. Average position 6." It is labelled "Actual". Before 28 days it shows "Live since 3 November. Real numbers after 4 weeks." and keeps the estimate.

**Roll-up after connection.** Two parts, never summed into one number:
"Your live articles brought 310 visits from Google in the last 28 days. The keywords still to come could bring about X to Y more if they reach the top three. Estimate."

**Later refinements:**
- Once a business has enough live articles, compare its real click share at its real positions with the curve and use its own curve for its estimates. Label that "based on your own results".
- Use the real position to drive the re-optimise pass.

**Cost.** I believe the Google interface is free with daily quotas; exact scope name, delay and quota are UNVERIFIED.

## Changes to the release sequence

- **Release 6 (Keywords page, read-only)** now includes the per-row estimate, the disclosure and the roll-up line on Keywords.
  - New pure module `orchestrator/src/seo-blog/traffic-estimate.ts`: curve constant with a version, range, rounding and roll-up. One file, no I/O.
  - It is called from the new `portal/content-area-keywords.ts`.
- **Release 7 (Keywords actions)** adds:
  - the Home card (`contentHomePage`, `content-area-pages.ts:265` in the current checkout);
  - the Results wording change;
  - the "autopilot will write next" variant.
- **Release 14** is split:
  - 14a "Real clicks": connect Search Console, latest snapshot per article, replacement on Keywords, Home and Results. No migration.
  - 14b: re-optimise from real positions, the business's own curve, and history (migration B only if history is wanted).
- **Cost of the estimate itself:** none. It is arithmetic on numbers already paid for.

**Tests:**
- Range and rounding table, including the "fewer than 10" case.
- No estimate without a measured number, in all three unmeasured cases.
- Roll-up counts one phrase per article and reports the uncounted ones.
- The words "Estimate" and "if … top three" are present wherever a number is shown (banned-terms-style render test).
- Supplier name absent from every rendered page.
- A live article with 28 or more days of actuals shows "Actual" and is excluded from the estimated part.

**Risks:**
- The owner or a client reads the range as a promise. The condition and label are the mitigation. Keep the roll-up off any sales or marketing screen unless the same sentence travels with it.
- The top-three condition is optimistic for "Harder" keywords. Autopilot already skips those, and the band is shown beside the number.

## Decisions left for the owner on this point

1. One line only, or add the "first page but not top three" second line?
2. Accept the curve above as the house curve, with positions 4-9 as assumptions, until it is checked against the original study or replaced by each business's own results?

## UNVERIFIED on this point

- Positions 4-9 of the curve, and the study's year.
- That the supplier's monthly search number groups close variants (the reason secondary phrases are not added).
- Search Console specifics: scope, delay, quotas.
- Whether an existing Google sign-in in the product can be reused for the connection.

Sources:
- [Search Engine Journal: Google first page clicks](https://www.searchenginejournal.com/google-first-page-clicks/)
- [Bruce Clay: The latest on click-through rate by SERP position](https://www.bruceclay.com/blog/the-latest-on-click-through-rate-by-serp-position/)
- [Sistrix study page](https://www.sistrix.com/?p=74722)
- [Ignite Visibility: how SERP ranking impacts click-through rates](https://ignitevisibility.com/?p=26655)
- [Safari Digital: position one click share](https://www.safaridigital.com.au/?p=5070)