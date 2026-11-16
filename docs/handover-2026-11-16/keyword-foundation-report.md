## Keyword-first planning foundation: report

The foundation is built and committed locally on `claude/keyword-foundation` (not pushed). Nothing is wired in, and production behaviour is unchanged: a new test fails if any existing file imports the new modules. Both full test runs passed, typecheck is clean, and no paid call was made.

**HEAD:** `f6e492b91230b15bf7dbad0431a49e210a836605`. The tree is clean. There are 4 commits on c00c928: client, estimate, pool, store shape plus isolation test.

**`git diff c00c928 --stat`:** 20 files, 8,466 insertions, 1 deletion.
- `src/keyword/dataforseo-labs.ts` (+458)
- `src/keyword/types.ts` (+62/−1, additive only)
- `src/seo-blog/keyword-pool.ts` (+631)
- `src/seo-blog/traffic-estimate.ts` (+191)
- `src/seo-blog/keyword-store-shape.ts` (+204)
- 10 fixtures in `test/fixtures/dataforseo-labs/`
- 5 new test files: `keyword-dataforseo-labs`, `seo-blog-keyword-pool`, `seo-blog-traffic-estimate`, `seo-blog-keyword-store-shape`, `keyword-foundation-isolation`

All paths above are under `/home/user/r72-keywords/orchestrator/`.

**Tests:**

| Run | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| `CONTENT_AREA_PREVIEW` unset | 5078 | 4965 | 0 | 0 | 113 |
| `CONTENT_AREA_PREVIEW=enabled` | 5078 | 4965 | 0 | 0 | 113 |

- There were no timing failures, so nothing needed a re-run.
- 5,000 candidates rank in about 200–260 ms.

**/tmp clean-up:**
- After run 1 I removed the 110 scratch folders it created.
- After run 2 I removed nothing. Two other builders' full suites were running at the same time and leave folders with the same names, so I could not tell mine apart. About 326 new entries are in /tmp from that window (`r72-runs-*`, `r72-migrations-*` and similar).

## Verification note

All pages are on docs.dataforseo.com/v3 and were read on 16 Nov 2026. The fixtures are the docs' own example responses, and each names its page in `_fixture_source`.

**Facts that hold for every Labs endpoint:**
- POST `https://api.dataforseo.com/v3/dataforseo_labs/google/<name>/live`, Basic auth, one task per call.
- Up to 30 calls at once and 10,000 a minute.
- **Labs data is country-level only.** The Labs locations page says "Country is the only supported location_type".
- **Difficulty and intent come back in the same row**, with no second call needed:
  - ranking difficulty is `items[].keyword_properties.keyword_difficulty` (0–100, logarithmic, may be null);
  - intent is `items[].search_intent_info.main_intent` plus `foreign_intent[]`.
- Volume is `keyword_info.search_volume`, with the month series in `keyword_info.monthly_searches[{year, month, search_volume}]` and the date in `keyword_info.last_updated_time` ("yyyy-mm-dd hh:mm:ss +00:00").
- Ad competition is `keyword_info.competition` (0–1). It is not difficulty.
- The cost is `tasks[0].cost` (falling back to the top-level `cost`).
- The bulk difficulty and search intent endpoints are only needed to fill nulls. I built them anyway.

**Per endpoint (UK = `location_code: 2826`, `language_code: "en"` unless noted):**

| Endpoint | Request I send | What I read / notes |
|---|---|---|
| `keyword_ideas` | `{keywords ≤200, location_code, language_code, limit}` | default 700, max 1000; reads `result[0].items[]` |
| `keyword_suggestions` | `{keyword, location_code, language_code, include_seed_keyword: true, limit}` | location is *optional* here and leaving it out means **all locations**, so I always send it; the seed's own numbers come back in `seed_keyword_data`, which gives the "wider phrase" rung a measured parent |
| `related_keywords` | `{keyword, location_code, language_code, depth 0–4, limit}` | items are nested: `items[].keyword_data.{keyword, keyword_info, keyword_properties, search_intent_info}`; the depth-0 item is the seed itself |
| `keywords_for_site` | `{target, location_code, language_code, limit}` | target must be a bare domain (no https://, no www.) |
| `ranked_keywords` | `{target, location_code, language_code, item_types:["organic"], limit, order_by:["keyword_data.keyword_info.search_volume,desc"]}` | position is `items[].ranked_serp_element.serp_item.rank_group`, url is `.url`; `ranked_serp_element.keyword_difficulty` is also present; location is optional and leaving it out means all locations |
| `competitors_domain` | `{target, location_code, language_code, exclude_top_domains: true, limit}` | reads `items[].domain`, `avg_position`, `intersections` |
| `keyword_overview` | `{keywords ≤700 (≤80 chars, ≤10 words each), location_code, language_code}` | same row shape as ideas |
| `bulk_keyword_difficulty` | `{keywords ≤1000, location_code, language_code}` | reads `items[].keyword_difficulty` |
| `search_intent` | `{keywords ≤1000}` only | the docs list no location or language field; reads `items[].keyword_intent.{label, probability}` and `secondary_keyword_intents[]` |
| Questions people ask | GET `serp/google/organic/task_get/advanced/{id}` | **free** ("charged only for posting a task"); reads `people_also_ask.items[].title`, `related_searches.items[]` (strings), `people_also_search.items[]`; the GET echoes the posting cost, so the client reports 0 to avoid counting it twice |

**Corrections to the plan:**
1. Difficulty and intent are inline, so the plan's separate difficulty/intent step is a fallback only.
2. The Labs price disagreement is settled. The pricing page says **$0.012 per task + $0.00012 per item**. The docs' example costs ($0.0103 and similar) are the older $0.01 + $0.0001 rate.
3. The Google Ads volume price the existing provider pays is now verified at **$0.06 Standard / $0.09 Live per task** (up to 1,000 keywords).
4. Questions people ask cost nothing extra if we read the research tasks we already post. Otherwise a Standard search result costs $0.0006; Priority is $0.0012 and Live $0.002. Expanding questions costs +$0.00015 per click. The "advanced" read costs the same as "regular" because only posting is billed.
5. `include_clickstream_data` doubles the price. I never send it.
6. The docs' `keyword_suggestions` example is malformed (it has two result objects although `result_count` is 1). I repaired the fixture and said so inside it.

**Error codes:**
- 40102 ("no search results") is treated as "no data", not a failure, and its cost is still recorded.
- Supplier errors are returned with the shared `researchDiagnostic` categories (only 40101 can be retried). Nothing retries by itself. A timeout or network failure is "unknown", which means the charge is uncertain.

**Pricing pages used:**
- https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
- https://dataforseo.com/pricing/serp/google-organic-serp-api
- https://dataforseo.com/pricing/keywords-data/google-ads

**Still unverified:**
1. That a task posted for the regular read can also be read through `task_get/advanced`. The docs strongly imply it (one task, a GET per format by id, postback type regular/advanced/html) but never say it in one sentence.
2. 2826 is not in the docs' shortened locations example. A free GET of `/v3/dataforseo_labs/locations_and_languages` would confirm it; the existing research code already uses 2826.
3. Whether `seed_keyword_data` and a 40102 "no data" answer are billed.
4. What `search_volume` means exactly. The field table says "average monthly", the intro says "last month", and in the example 368,000 is not the latest month (450,000). I label the month from the latest entry in the monthly series.

## Ranking formula and difficulty bands

**Formula:** opportunity = 0.35·V + 0.30·E + 0.25·F + 0.10·Q.
- **V (volume):** min(1, log10(searches+1)/4), so 10,000 searches a month scores 1.
- **E (ease):** (100 − difficulty)/100, or 0.5 when unrated.
- **Q (quick win):** 1 when the site already ranks 11–30 for the phrase.
- **F (fit):**
  - 1.0 for a learn or compare phrase that matches an offer;
  - 0.9 for a learn phrase that matches an audience;
  - 0.8 for a compare phrase that matches an audience;
  - 0.6 for a buy phrase that matches an offer, or an unrated phrase that matches;
  - 0.3 otherwise.

  I lowered "buy" from the plan's 1.0. Results pages for buying searches are mostly product and service pages, which an article rarely displaces.

**Ordering:** measured rows come first, then wider-phrase rows, then observed-only rows. Within each group rows sort by score, with the de-duplication key breaking ties, so the result does not depend on input order.

**Bands:** Easier 0–29, Medium 30–49, Harder 50+, "Not rated yet" when there is no number.
- Harder is kept only when the site already ranks 11–30 for the phrase.
- The reasoning is the plan's: these are young small-business sites, the scale is logarithmic, and 30 is roughly where an article needs links too.

**Other rules:**
- Under 20 searches is too small, unless the wider phrase is measured at 20 or more.
- 0.6 similarity to a planned brief's phrase counts as cannibalising.
- Each pick gets one sentence, for example: "We chose this because it is searched about 590 times a month, it is moderately hard to rank for and it ties in with your Fully managed lettings."
  - No user text in a reason except a cleaned offer name.
  - An offer name that contains a banned word becomes "one of your services".

## Stored-shape proposal

Types and a pure reducer are in `keyword-store-shape.ts`.
- **Pool, rows and cost ledger:** `inventory.keywordPool`. Rows are capped at 300 and ledger entries at 200, plus totals per month. The wiring release will need:
  - a locked read-modify-write, because `saveInventory` overwrites blindly;
  - the pool carried over in the daily inventory refresh.
- **Owner choices:** `settings.programme.keywordChoices` holds dismissed, chosen (idempotent by key and command id) and owner-typed seeds. It must stay outside the programme input hash, or every dismissal would invalidate a running plan.
- **Freshness:** measurements are fresh for 30 days, shown with their month up to 90 days, then expired. Own rankings last 14 days; top-results analysis 30 days.
- **Reducer guarantees:** a dismissed phrase never comes back; a thin rebuild carries good rows over instead of erasing them; expired rows are pruned.
- **Size:** 500 rows are about 300 KB (about 7% of the 4 MB record limit); the 300-row cap is about 180 KB.
- **Table or jsonb:** jsonb is right for now. A shared table keyed by phrase, country, language and month becomes the better answer once we want ranking history, or want one measurement to serve every business in the same country. Measurements do not depend on the business, so sharing them saves money. Choices would stay in per-business jsonb.

## Estimated spend to fill one business's list (verified rates)

| Call | Rows | Cost |
|---|---|---|
| Site phrases | 200 | $0.036 |
| Own rankings | 200 | $0.036 |
| Ideas | 300 | $0.048 |
| Suggestions, 3 seeds | 3 × 101 | $0.072 |
| Core total | | **≈ $0.19** |
| Competitor list | 10 | $0.013 |
| 3 competitors' rankings | 3 × 140 | $0.086 |
| Total with competitors | | **≈ $0.29** |
| Related searches (3 seeds) + 20 owner phrases | | +≈ $0.05 |
| Total with everything | | **≈ $0.35** |

These figures assume every requested row comes back; real costs are lower when fewer rows are returned. Reading questions from the research tasks we already post is free. A monthly refresh costs about the same again.

## Where the wrong difficulty measure is used today

- `src/keyword/dataforseo.ts:60` puts Google Ads `competition_index` into `KeywordMetric.difficulty`.
- `src/seo-blog/engine.ts:1287` stores it on briefs as `demand.competition`. It is stored but not shown: `portal/seo-blog-view.ts:297` prints volume only.
- `src/keyword/cli.ts:68` writes it into the keyword report JSON.
- `src/keyword/mock.ts` fills the same field.

I left the field unchanged and only added a doc comment. The correct measure is `KeywordCandidate.rankingDifficulty`.

## Things I'm unsure about, or chose myself

1. **No locations on the Brand DNA profile.** It has no locations field, so the caller passes `locations` in.
2. **Gaps in the shared diagnostic mapping.** These codes fall to "unknown": 40210 insufficient funds, 40202 per-minute limit, 40209 too many at once, 40201 account paused, 40501/40503/40506 bad request, 50301/50303 temporarily unavailable. The mapping's messages also name the supplier (the leak the plan already recorded). I did not change it, because that would change production.
3. **Wording when the low end rounds to 0.** The addendum doesn't cover this. I wrote "up to about 10 visits a month…".
4. **Roll-up rounding.** The total is the sum of the numbers shown on each row, rounded once more on the same steps.
5. **Off-topic test.** A phrase is off-topic if it shares no word with the offers, audiences or page titles. Town names deliberately don't count. Phrases from the site's own data are exempt.
6. **Unsafe-topic list.** It is deliberately small, a backstop rather than a classifier.
7. **Commit trailer.** Commits use the Fable 5.2 trailer as your brief asked, which matches the repo's earlier commits. The session's own attribution notice named a different model.