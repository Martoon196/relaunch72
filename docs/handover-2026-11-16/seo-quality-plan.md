# Plan: every Relaunch72 article strong for search, end to end

Read-only design. Nothing was written to any repository. All paths are under `/home/user/r72-shell`; the checked-out tree is byte-identical to c00c928 (`git diff --stat c00c928 HEAD` is empty), so line numbers apply to both. `orchestrator/src/seo-blog/seo-score.ts` does not exist yet; I designed to consume it as specified.

## 0. Headline findings

1. **Search numbers almost never reach a brief today, even when switched on.** Numbers are looked up for the research seeds, not for the phrase the planner later chooses (`orchestrator/src/seo-blog/research.ts:331`). A brief is "measured" only if the planner's phrase equals a seed exactly (`engine.ts:1277`). The planner never sees any numbers (`generation.ts:450-498`), and its prompt tells it not to mention them (`prompts/seo-blog-plan.md` line 18).
2. **The "difficulty" stored today is the wrong measure.** It is Google Ads advertiser competition, not how hard it is to rank (`orchestrator/src/keyword/dataforseo.ts` ~line 60, endpoint `keywords_data/google_ads/search_volume/live` ~line 14).
3. **Numbers and the writing method both fall back silently.**
   - Numbers need `SEO_BLOG_KEYWORD_METRICS=dataforseo` and the un-prefixed `DATAFORSEO_LOGIN/PASSWORD` (`portal/seo-blog-service.ts:76`), while research also accepts `SEO_BLOG_DATAFORSEO_*` (`research.ts:159-160`). A deployment using only the prefixed names gets research but no numbers, with no error.
   - The method returns the plain writer without a word in three places: `method-packs.ts:237` (switch off), `:249` (business has no assignment), `:253` (no pack selected).
4. **The method cannot be on for client businesses today, by construction.**
   - Scope is fixed to `private-owned-brands` by database CHECKs (`db/migrations/0138_seo_blog_method_packs.sql:26,53`) and in code (`method-packs.ts:88`).
   - Only operator-enrolled, founder-owned organisations qualify (0138:36-49). Enrolment rows are append-only, so an organisation enrolled without automatic defaults cannot be flipped (0138:48-49, 0140).
   - Public commercial use is recorded as blocked (`docs/relaunch72-rule-packs/releases/0.1.1/RELEASE.json`; `OWNER-DECISIONS.txt` items 4 and 6).
5. **The planning method forbids a bare keyword as the target.** Rule `plan.question-not-keyword` in `orchestrator/method-packs/0.1.1/editorial-planning.json` requires a real question in the audience's words. The packs are hash-pinned, and a new pack version needs a migration. So the design keeps `target_query` as the question and adds a separate measured phrase beside it.
6. **The planning method also fixes a plan at exactly one pillar plus six supporting articles** (`plan.cluster-contract-exact`; `generation.ts:403`). This shapes how "tick some keywords" and autopilot must work (section 2).
7. **The WordPress plugin does not pass a focus phrase.** It writes title, description, robots and social fields into Yoast and Rank Math, but not `_yoast_wpseo_focuskw` or `rank_math_focus_keyword` (`wordpress-plugin/relaunch72-publisher/includes/class-r72pub-seo.php:148-173`; payload at `publishers/wordpress.ts` ~157-189). Those plugins therefore show no score.
8. **Pictures already exist but are off.** A full main-picture pipeline is built and off by default for every business (`engine.ts:1502-1516`, `docs/seo-blog-campaign-media.md`). In-body pictures are blocked by the schema: `slot text NOT NULL CHECK(slot='hero')` (0137:136), so they need a migration.
9. **Three client-visible leaks exist now.**
   - The supplier's id is printed in the Topics table (`portal/seo-blog-view.ts:297`).
   - The supplier's name is in research error text (`seo-blog/programme.ts:23-25`, rendered at `seo-blog-view.ts:168,283`).
   - The model name and its maker are on the Publishing page (`seo-blog-view.ts:393`).
10. **Supplier data is cheap; writing tokens dominate.** Filling a business's keyword list costs roughly $0.20-0.40. A written article costs roughly $0.20-0.45 in model tokens. Supplier prices are only partly verified (section 10).

## 1. Current truth

### What supplier data an article gets at each stage

| Stage | Today | Weakness |
|---|---|---|
| Topic choice | The model chooses the topic. Seeds are audience and category sentences from the profile (`research.ts:213-245`; `engine.ts:1240-1244`), up to 8 Google searches via `serp/google/organic` regular results, organic items only (`research.ts:94,151`), top ~4 pages fetched per query with one 600-character passage each (`research.ts:281-325`). | Searches are run on descriptions of the business, not on phrases people type. No questions-people-ask, related searches or competitor headings are kept. |
| Target phrase | `target_query` is written by the model (`generation.ts:382`). | Never checked against measured demand. |
| Numbers | One batch call for the seeds only (`research.ts:327-335`; programme path `engine.ts:1143`). | See findings 1 and 2. Location comes from an environment setting, not the business's locale (`seo-blog-service.ts:77`). |
| Sources | The plan's sources, filtered by the planner's `source_ids`. If fewer than 2, silently the first 12 plan sources (`engine.ts:1406-1411`). | Sources may not match the article's subject. |
| Outline | The model, from profile, site inventory and sources. | No view of what the current top results cover. |
| Writing | The brief gives target query, intent, related questions (model-invented), outline, key points and call to action (`generation.ts:562-566`). | No placements, secondary phrases, real questions or coverage gaps. `checks.ts:1-8` says "Scores are not produced". |

### Silent fallbacks, and what the owner sees

- **Research not configured:** not silent. Readiness lists it (`engine.ts:374`), planning is refused (`:1214`), the worker holds (`:1124`).
- **Numbers off, wrong credential names, or lookup failed or skipped for allowance:** silent downgrade to "qualitative" (`engine.ts:1042-1045, 1057-1059, 1096, 1288`). The old Topics page shows "Qualitative" and a small notice. The new look shows nothing about demand.
- **Method switch off:** silent. The "Production rules" link simply is not there. The only trace is a missing `generation.methodReceiptId`.
- **Method on but business unassigned or all packs switched off:** silent (`method-packs.ts:249, 253`).
- **Method on but not enough allowance:** a clear stop (`method-packs.ts:256-257`).
- **Thin research:** a plan proceeds with any non-zero number of sources (`engine.ts:1250`). Failed queries are notes only (`research.ts:274`).
- **Pictures:** silently skipped unless enabled (`engine.ts:1503`), leaving a warning-level check (`checks.ts:115`).

Which of these are set in production is not visible in the repository (`render.yaml` has no `SEO_BLOG_*` entries).

### What "on for every article, with a clear failure" takes

- **One credential resolution** for research and numbers. Numbers are on whenever credentials exist; the setting becomes opt-out.
- **A strict setting** (name: `SEO_BLOG_REQUIRE_FULL_ENGINE`). With it on, planning holds with a neutral message if numbers are unavailable for a reason other than "the supplier answered and has no data". Writing stops clearly if the method is expected for that business and is not active. Thin research holds instead of proceeding.
- **An engine stamp on every plan, brief and version** (jsonb): research live, numbers measured / no data / off, method receipt id. A founder-only table shows this per business and per article.
- **For owned businesses:** `SEO_BLOG_METHOD_PACKS=true` on both portal and worker (`seo-blog-service.ts` engineFor ~118 and worker ~137); organisation enrolled; each existing business switched all-on in Production rules (`engine.activateReviewedMethods`, `engine.ts` ~2163); a confirmed profile (`method-packs.ts:251`).
- **For client businesses:** a recorded commercial decision plus a migration (release 15). Until then the honest state is "house standard, method not licensed", recorded and never pretended.

## 2. Keyword-first planning and the Keywords section

### Principle

All numbers come from the supplier. The model only chooses among measured candidates and writes the brief. `target_query` stays a real question (the method requires it); a new `seo.primary.phrase` is the measured phrase that question maps to.

### Supplier endpoints

Request shapes are from the supplier's documentation as I recall it; confirm against live docs before coding. UK = `location_code: 2826`, `language_code: "en"`. The existing locale table is at `research.ts:58`.

| Purpose | Endpoint | Request body | Use |
|---|---|---|---|
| Phrases relevant to the site | `dataforseo_labs/google/keywords_for_site/live` | `[{target:"domain", location_code, language_code, limit:200}]` | Yes; no seed words needed |
| What the site already ranks for | `dataforseo_labs/google/ranked_keywords/live` | `[{target, location_code, language_code, limit:200, order_by}]` | Yes; quick wins, cannibalisation, later results |
| Ideas from seeds | `dataforseo_labs/google/keyword_ideas/live` | `[{keywords:[up to 200], location_code, language_code, limit:300, filters}]` | Yes |
| Long-tail of a seed | `dataforseo_labs/google/keyword_suggestions/live` | `[{keyword, location_code, language_code, limit:100}]` | Yes; top 3 seeds and "Find more" |
| Related searches | `dataforseo_labs/google/related_keywords/live` | `[{keyword, depth:1, limit}]` | Optional |
| Competitor discovery | `dataforseo_labs/google/competitors_domain/live` | `[{target, limit:10}]` | Optional; empty for new sites |
| Competitors' phrases | `ranked_keywords` per competitor | as above | Yes, for 2-3 competitors |
| Numbers, difficulty and intent for exact phrases | `dataforseo_labs/google/keyword_overview/live` | `[{keywords:[...], location_code, language_code}]` | Yes; owner-typed phrases and re-measuring |
| Questions people ask, related searches, top results | existing `serp/google/organic/task_post`, read with `task_get/advanced/{id}` | existing body (`research.ts:77-80`) | Yes; replaces the regular read at `research.ts:89` |
| Local numbers | existing Google Ads volume endpoint with a region or city code | existing | Later, for local businesses |

**Public prices (web search; the supplier's own site was not reachable from this session):**
- Labs endpoints: about $0.01-0.012 per call plus $0.0001-0.00012 per returned row. Two official pages disagree.
- Google search results: $0.0006 standard queue, $0.002 live. Expanding questions-people-ask adds $0.00015 per click.
- Google Ads volume: $0.05-0.06 standard, $0.075-0.09 live per call of up to 1,000 phrases. Sources conflict.

### Building the candidate list

1. **Seeds.** Offer names, audience noun phrases and category labels through the existing `phrase()` cleaner (`research.ts:221-231`); town names from Brand DNA; titles and headings of existing pages (`InventoryPage`, `types.ts:308-324`); the site's own domain; competitor domains (owner-confirmed, or hosts that recur in results). If this yields fewer than about 30 candidates, one small model call turns Brand DNA into 10-20 plain search seeds. The model proposes words only, never numbers.
2. **Filter**, each exclusion recorded with a reason:
   - too small (under 20 searches a month, unless backed by a parent phrase);
   - too hard (see bands below);
   - wrong intent (navigational, or a competitor's brand name);
   - contains a Brand DNA exclusion or a voice "don't" phrase — this stops search and voice fighting later;
   - already covered (`assessDuplicate`, `dedupe.ts:94`, verdict skip or update, or the site already ranks in the top 10 for it);
   - cannibalising: similarity of 0.6 or more to an existing brief's phrase. Note `engine.ts:1268` compares articles by slug only; use the brief's phrase.
3. **Cluster** deterministically by token overlap (`topicTokens`, `dedupe.ts`) and shared top-result addresses. The broadest phrase in a cluster with enough volume is the pillar candidate.
4. **Rank** (this is exactly what "autopilot picks the best" means):
   `opportunity = 0.35·V + 0.30·E + 0.25·F + 0.10·Q`
   - V = min(1, log10(searches+1)/4)
   - E = (100 − difficulty)/100, or 0.5 when unrated
   - F = 1.0 for a buy or compare phrase matching an offer; 0.7 for a learn phrase matching an audience or offer; 0.3 otherwise
   - Q = 1 if the site already ranks 11-30 for it
   Weights are constants to tune after a pilot.
5. **Explain each pick** with a one-sentence template built from the same factors, never from the model: "We chose this because about 1,300 people a month search for it, it is easier to rank for, and it leads to your Lettings management page."

### Feeding the existing machinery

- **Autopilot.** When `runDaily` needs to fill days (`engine.ts:3103-3111`), the server pre-selects the best cluster of seven phrases (one pillar, six supporting). It runs the existing 8-search research on those phrases instead of on audience sentences. The planner then writes exactly seven briefs, each bound to a supplied candidate id, and the server validates membership. This satisfies the method's one-plus-six contract unchanged. Existing acceptance rules stay: proposed unless `autoAcceptPlans` (`engine.ts:1176-1178`).
- **Owner selection ("Write articles for these").** A plan job carries the chosen candidate ids. One phrase = one article. Chosen phrases join an existing pillar of the same cluster where there is one. The plan is accepted by the act of choosing, with the actor recorded. Writes are queued through the existing `write:<briefId>` jobs.
  - A selection that is not exactly seven cannot run under the pinned planning method. Recommended now: brief owner-selected phrases with a house briefing prompt (same server validators, no planning pack); the writing method still applies at the writing stage. Record this honestly on the plan. A variable-size planning method would be a new pack version (migration plus review) — owner decision.
  - Limits: 1-10 per press as today (`engine.ts:1384`). Budget preflight uses the existing `requireBudget`. Ticking is capped to the room under the backlog ceiling: "You can choose up to 4 more".
- **Receipts and budgets.** Extend the attempt kinds (`programme.ts:44`) from `serp | metrics` to add `site | ranked | ideas | suggestions | overview`, all through `programmeSearch` (`engine.ts:1031-1107`). Each call reserves one research attempt before it starts, saves its receipt and supplier-reported cost, and is never repeated automatically.
  - `USAGE_ESTIMATES.searchPerPlan` (`engine.ts:144`) rises from 8 to about 16.
  - `retryJob` recomputes the expected queries from profile seeds (`engine.ts:3076-3077`); it must read a saved shortlist instead.

### Storage (jsonb only; no migration)

- **Candidate list and measurements:** `inventory.keywordPool`, on the existing inventory record. Precedent: `inventory.editorial` (`types.ts:335`), and the note at the top of `programme.ts`. The record limit is 4 MB (0131:40); cap the pool at 300 rows.
  - Row: `{id, phrase, searches, difficulty, intent, cpc, basis, parent?, clusterId, covered?:{url, how, position?}, ownPosition?, measuredAt, opportunity, why}`.
  - Needs a locked read-modify-write store method and carry-over in the daily inventory refresh, because `saveInventory` is a blind upsert (`store.ts:428`).
- **Receipts:** in the job that fetched them, as research receipts are today.
- **Owner choices:** `settings.programme.keywordChoices = {dismissed:[{phrase, at, by}], ownerSeeds:[...]}`. Confirm these stay outside the programme input hash (`programmeInputSnapshot`), or every dismissal would invalidate a running plan.
- **Per-phrase states are derived, not stored**, except "dismissed":
  - suggested = in the pool, no brief
  - chosen = a queued or running selection job, or an accepted brief
  - being written = brief `generating`
  - ready = brief `generated`, not published
  - live = article `delivery: published`
  - already covered = the pool row's `covered`
  - dismissed = in the owner list
- **On the brief** (`ArticleBrief` is a jsonb record):
  `seo: {schema:1, primary:{phrase, searches, difficulty, intent, basis:'measured'|'parent_phrase'|'observed'|'none', parent?, locationCode, measuredAt, candidateId}, secondary:[up to 6], questions:[{text, source}] up to 8, serp?:{analysedAt, top:[{url, title, words, headings}], medianWords, commonTopics}, cluster:{id, pillarBriefId, role}, ownRanking?, why}`.
  Keep `demand` filled for old screens, with a neutral provider label.
- **A proper table** is worth a migration only when ranking history per phrase is wanted (release 14).

**Freshness:** searches and difficulty are fresh for 30 days, shown with their month for up to 90, and re-measured before use after that. Own rankings: 14 days. Top-results analysis: 30 days. A page view never spends. The same lookup inside its window is served from the pool.

### Cost of filling the page for one business

| Call | Rows | Approx cost |
|---|---|---|
| Phrases for the site | 200 | $0.036 |
| Own rankings | 200 | $0.036 |
| Ideas from seeds | 300 | $0.048 |
| Suggestions, 3 seeds | 300 | $0.072 |
| Competitors (optional) | ~420 | $0.09 |

That is about 6-9 research attempts and $0.20-0.40 per fill, with the same again for a monthly refresh. "Find more" is 1-2 attempts, about $0.03-0.05. Top-results analysis per chosen phrase is $0.0006-0.002. All of this assumes the $0.012 / $0.00012 rate.

### Supplier has no data for a niche

An honest ladder, labelled internally and never given a made-up number:
1. **Measured.**
2. **Parent phrase measured.** Shown as the wider phrase's number, clearly as the wider phrase.
3. **Observed.** The phrase appears in questions-people-ask or related searches. Tag only, no number.
4. **None.** Today's Brand-DNA-led planning with the existing prompt, flagged internally.

A failed supplier call is not "no data": it holds under strict mode.

### The Keywords page (new look)

**Placement.** An eighth place between Brand DNA and Calendar. Add `['keywords','Keywords','keywords']` to `PLACES` in `orchestrator/src/portal/content-area-layout.ts:54-56`. `PHONE` (line 58) is unchanged, so Keywords falls under More on phones automatically. Extend the `byTab` map (line 63) and add an icon.

**Topics.** Keep it under More tools unchanged at first (`content-area-layout.ts` ~78), because autopilot holds link to `topics#research-status` (`content-area-pages.ts:197-203`). Once Keywords has actions, move the hold notice onto Keywords as a plain "We could not refresh your keywords. Try again" card and rename Topics to "Earlier plans" as read-only history. Do not delete it: plans are the provenance record.

**Each row:**
- **The phrase.**
- **Searches.** "About 1,300 searches a month · measured October 2026". Never the supplier.
- **Difficulty**, in three bands from the supplier's 0-100 rating: **Easier 0-29, Medium 30-49, Harder 50+**; "Not rated yet" when missing. Why these: the customers are small businesses with young sites, for whom anything at 50 or above is realistically out of reach for a new article, and 30 is the usual line between "a good article can rank" and "needs links too". Autopilot skips Harder unless the site already ranks 11-30 for the phrase. Calibrate later per site from its own rankings.
- **What the searcher wants.** Buy / Compare / Learn, mapped from transactional / commercial / informational. Navigational phrases are filtered out.
- **What this could bring.** Recommendation: include it, but only for measured phrases, only as a conditional range, with the rule shown. "If this reaches Google's first page: roughly 10 to 130 visits a month (estimate)." The rule is 1% to 10% of monthly searches (bottom of page one to top three), rounded, behind a "How we work this out" line that also says many articles never reach page one. Never a total; never shown for unmeasured phrases.
  - This is an owner decision, because the Results page currently promises "you will not see guessed numbers" (`content-area-pages.ts:512`).
  - The 1% and 10% figures are my recollection of public click-share studies and need checking before shipping.
  - If he says no, show a non-numeric audience size instead: small (under 100) / medium (100-1,000) / large (over 1,000).

**Actions.**
- Tick rows, then one amber button: "Write articles for these".
- "Find more keywords", with an optional box: "A phrase your customers use".
- "Not for us" per row.

**Autopilot line**, from the existing `autopilot()` (`content-area-layout.ts` ~95-106):
- On: "Autopilot is on. If you do not choose, we will write these 7 next to fill your Tuesdays and Thursdays." Those rows are marked "Next up" with their one-sentence reason.
- Off: "Nothing is written until you choose."
- Auto-accept off: "We have lined up these 7. Say yes to start."

**Little or no data.** "We could not find search numbers for your niche yet. That is common for specialist and local businesses. We will still write about the questions your customers ask, and we will mark those 'no search number yet'." Plus the box for his own phrase.

## 3. Writing to the standard

### Giving the writer the requirements

Add `search_requirements` to the `<brief>` data block (`generation.ts:562-566`):
- primary phrase and acceptable natural variants
- up to 5 secondary phrases
- up to 6 real questions to answer
- topics the top results commonly cover — headings only, never their text, and only to be covered where the supplied sources support it
- a length band from the top results' median, clamped to the business's length preference (`generation.ts:534-538`)
- required internal links (money page, pillar, published siblings)

**New prompt file, not an edit.** `prompts/seo-blog-article-v2.md` (version 2.0.0, same stage name so model overrides still apply). Used only when the brief has `seo`; old briefs keep `seo-blog-article.md@1.1.0`. Every version already records file, version and hash (`generation.ts:149`), so old articles stay reproducible. Same pattern for `seo-blog-plan-v2.md` and a parts-aware section prompt.

**The added wording keeps facts first.** The primary phrase goes once in the title, once in the first 100 words and once in the description; variants are used elsewhere; it is never repeated beyond what reads naturally. A fact is never altered, added or left uncited to fit a phrase. A requirement that conflicts with a hard rule or the brand voice is skipped. The six hard rules are untouched.

**Other changes in the same step:**
- Capture H2/H3 headings and word count of pages already being fetched (`research.ts:293-311`): no extra supplier cost.
- Ask for three title options and two description options in the same call; the server picks by deterministic checks. Risk: the structured article schema is constrained natively and has hit grammar limits before (`article-output.ts` comment; `llm/client.ts` `providerJsonSchema`). Carry the options as one bounded string field if needed.
- The validator at `generation.ts:578-588` is unchanged; the score is not a rejection reason.

### Bounded improve loop

Runs inside `runWrite`, between the article call and `appendVersion` (`engine.ts:1474-1495`), so the owner sees one version and social copy is written from the final text.

- **Bar:** score of 80 or more out of 100, and no failed essential check (phrase in title; phrase or variant in the opening; description length; answers the searcher; a link to the money page when one exists).
- **Cap:** N = 2 passes.
- **Free fixes first.** Title and description failures are fixed by choosing among the returned options, with no model call.
- **Each pass** picks the weakest part (the section with the most failed checks, or the intro or conclusion) and calls the existing `rewriteSection` (`generation.ts:593-623`). The failed checks become the instruction (the prompt already says the instruction cannot override the rules). The original method receipt is passed so the same pinned method applies (`engine.ts:2188`).
- **A pass is kept only if all of these hold:**
  - `runChecks` (`checks.ts:92`) shows no new critical issue;
  - there are no more voice warnings than before;
  - exact-phrase count stays under an over-use cap (ask the score builder for an over-use check; otherwise a small guard here);
  - the score is strictly higher.
  Otherwise the pass is discarded and counted.
- **Stops** on the bar, the cap, low allowance, or no eligible part.

**Recorded** on the version outside `body`, so `contentSha` is unaffected: `seo: {scoreVersion, bar, initial, final:{score, checks}, passes:[{n, part, findings, accepted, rejectReason, before, after, tokens, generation}], stopped}`. Usage is recorded per pass.

**Crash safety.** Save the unimproved draft on the article record before the loop (precedent: `article.campaignGeneration`), so a crash never buys the article again.

**The owner sees** a better article, "Search score 86", and up to three plain suggestions when below the bar. Recommended default: a below-bar article sets the existing `requiresApproval` flag, so it never auto-publishes without his yes.

### Cost per article in tokens

| Item | Estimate |
|---|---|
| Article call | 32,000 (`USAGE_ESTIMATES.article`) |
| Method headroom, already checked separately | compiled/3 + 8,000 (`method-packs.ts:256`) |
| v2 requirements block | +600 to 1,200 input |
| Improve loop, new `articleImprove` | 16,000 (2 × `section` 8,000) |
| Preflight for a write | 48,000 |

A method-wrapped revision pass carries the whole method package, so the realistic worst case for two passes is nearer 60,000 tokens. At the pinned model's list price ($3 / $15 per million), a typical article is about $0.20-0.30, and up to about $0.45 with two method-wrapped passes.

Optional later saving: cache the stable system prefix. The client has no caching today and counts only `usage.input_tokens` (`llm/client.ts:56-61, 83`), so the allowance ledger must count cache tokens in the same change.

### How voice, method and search combine

Order of precedence on conflict:
1. **Facts, sources and safety** — prompt hard rules; critical checks in `checks.ts:151-188`; production-core.
2. **Brand DNA voice and exclusions** — the core pack calls exclusions absolute.
3. **The writing method** — answer first, headings that carry meaning, format.
4. **Search requirements.**

Search loses at writing time, so conflicts are prevented at planning: phrases containing exclusions or voice "don't" wording are never chosen. The score should mark a requirement "not applicable", not failed, when a higher rule prevents it.

**Voice today.** It reaches the writer as the extracted profile voice (`profileForPrompt`, `generation.ts:441-448`). It is enforced only by two warning-level checks, and `voice.brand_rule` only matches "don't" items of four words or fewer (`checks.ts:205-215`). The loop therefore treats any new voice warning as a rejection. A small deterministic voice group in the score (don't-phrases, cliché count, UK spelling for en-GB) is a cheap later addition.

## 4. Beyond the plugins, ranked by value for effort

1. **Real questions answered, plus FAQ structured data.** FAQ data exists in the body but `render.ts:188` emits headings only, with no FAQPage. Low effort. Note that Google limited FAQ rich results in 2023; it still helps machine readers.
2. **Search intent match.** Supplier intent and results-page make-up against the brief's intent and format. Low effort once candidates carry intent.
3. **Coverage of what the top results cover.** Headings captured during fetches already made. Medium effort, high value.
4. **Title and description options** chosen for click appeal within limits. Low effort.
5. **Structured data completeness.** `render.ts:117-133` emits BlogPosting with headline, description, date, language, publisher, author and image URL. Missing: BreadcrumbList (the crumb nav at `:180` has none), `dateModified`, image as an object with size, publisher logo, FAQPage, `og:image:alt`, Twitter card. Low effort.
6. **Cannibalisation guard** from the site's own rankings. Low effort after release 4.
7. **Internal links** to the money page and cluster siblings, required and scored; then adding a link to the new article in older ones. The second half creates new versions of published articles, which the exact-version approval rules require the owner to approve. Medium effort.
8. **Freshness and re-optimise when rankings arrive.** A monthly own-rankings call (about $0.04); articles at positions 5-20 get a targeted pass. Higher effort, long-term value.
9. **Authority and AI-answer hooks.** `authority-providers.ts:8-9` (link gap, AI mentions) could later feed "is this business cited for this phrase". Out of scope now.

## 5. Pictures

**What exists.**
- `FeaturedImage` kinds: `brand_asset | uploaded | generated | none` (`types.ts:466-473`).
- An automatic request once per first version (`engine.ts:1502-1516`).
- One fixed request: `gpt-image-2`, medium, 1536×1024 (`image-generation.ts:4-8`).
- Three real crops: blog 1600×900, Instagram 1080×1350, LinkedIn 1200×627.
- Owner review of the actual crop and alt text, hero release, and separate social use of the same picture (`docs/seo-blog-campaign-media.md`).
- The Creative Studio for typed briefs and uploads.

**The gates, all off by default:** `SEO_BLOG_IMAGE_API_KEY` on the worker (`portal/seo-blog-media-service.ts:27`); the operator image policy (0137:191, disabled with zero headroom); the business opt-in `settings.media.imageGenerationEnabled`; `budgets.imagesPerMonth`.

**Smallest change for a main picture on every article (no migration, almost no code):**
- Set the key and the operator policy.
- Make the opt-in and a picture allowance part of business set-up.
- Add one "picture style" line per business as a `visual_guidance` document, drafted from the site's look. The prompt already reads this (`image-intent.ts:54-55, 67`), so that is the one consistent style.
- Change the alt-text instruction in the v2 prompt: describe the picture truthfully and use the phrase or a natural variant only where it fits.

Approval and change already exist. The decision left is automatic-with-review versus per-article yes.

**In-body pictures need one migration.** The release `slot` CHECK and the `use_kind` CHECK (`blog_hero` / `social_variant`, 0137:125) must change, as must the once-per-version paid admission. They also need:
- a `section.image` field (not Markdown images — rule 5 and the renderer forbid them; `render.ts:66-103`);
- rendering in `render.ts` and `renderArticleFragment` (`publishers/content-api.ts:33-45`);
- WordPress plugin import of more than one attachment per article.

**Cost.** About $0.04-0.05 per picture (third-party tables for this model and size; not confirmed on the maker's own page). One per article now; about $0.12-0.15 with two in-body pictures. Each counts against `imagesPerMonth` and the operator's reservation.

## 6. WordPress

**Passed today:** Google title, short description, robots, social title, description and image (`class-r72pub-seo.php:148-173`); image alt text (`class-r72pub-media.php:63,120`).

**Not passed:** the target phrase. The plugins' scores are also worked out in the browser when a person opens the post, so a post published by connection shows no score.

**Needed:**
1. **Payload.** Add `wordpress.seo = {focusPhrase, secondaryPhrases}` from `brief.seo` in `publishers/wordpress.ts` ~180-188. It is additive; the current plugin ignores unknown keys. It changes the payload hash for new publications only.
2. **Plugin 1.2.0.** Write `_yoast_wpseo_focuskw` and `rank_math_focus_keyword` (comma-separated; first is primary), under the same "preserve what a person changed" rule (`apply`, `:181-212`).
3. **Recalculation.**
   - Rank Math: call its own score update after writing, if the function exists (a support thread names `rank_math()->update_post_score($post_id)`), else point to its "recalculate scores" tool.
   - Yoast: I found no server-side recalculation. Its traffic light stays grey until someone opens and saves the post. Do not write its score field ourselves; that would be a faked score.
4. **Make the content pass their checklists.** The focus phrase sent is the exact primary phrase. The slug contains it; the slug is set at planning and fixed after publication (`engine.ts:1603`), so the v2 planner must derive it from the phrase. The phrase also appears in title, description, first paragraph, one subheading and alt text, with internal and external links present. Ask the score builder for a "plugin parity" group mirroring those tests.
5. **Optional.** A "Relaunch72 score" column in the WordPress posts list, showing our number only, for all modes including standalone.

## 7. Confidentiality

Client-facing places that can reveal the supplier, the method or a model:

| Place | Evidence | Fix |
|---|---|---|
| Topics table prints the supplier id | `seo-blog-view.ts:297` | Print "measured, Oct 2026" only |
| Research status text names the supplier, shows "Supplier details", codes and task ids | `programme.ts:23-25`; `seo-blog-view.ts:168,283` | Neutral owner message; raw detail founder-only |
| Publishing page names the model, its maker and their pricing page | `seo-blog-view.ts:393` | "Writing allowance" wording only |
| "Production rules" page lists pack ids and product names; shown whenever methods are enabled | `campaign-creator-view.ts:161-164`; `content-area-layout.ts` ~84; `seo-blog-router.ts:330` | Founder-only; clients see nothing or "Your writing standard: on" |
| Job errors and the activity log carry raw messages | `engine.ts:3047-3056`; method errors with pack ids (`method-packs.ts:71-74, 96-98`); rejection text with rule ids (`generation.ts:161`); "writing model could not be reached (…)" with the SDK's text (`generation.ts:120`) | One owner-message mapping at the job boundary; raw text kept privately |
| Readiness and allowance wording ("research provider", "model API key", "model tokens", "supplier attempts", "simulated") | `engine.ts:374-375, 192-199`; `seo-blog-view.ts:171, 233` | Neutral dictionary |
| Stored but, as far as I traced, not rendered: `generation.model`, `promptVersion`, `source.provider`, `demand.provider` | `types.ts:433-441, 347-360` | Allowlist serialisers plus a test over every JSON response |
| Published HTML and WordPress: `r72-blog-*` meta tags, index comment, plugin name, `/wp-json/relaunch72/`, media host | `render.ts:173-176, 213`; `class-r72pub-seo.php:290-300` | These reveal the platform name only, not supplier, method or model. White-labelling is an owner decision |
| Markdown export | `render.ts:270-296` | Clean today; keep under the test |
| Emails | I found no mail-sending in `src/seo-blog` | Nothing today; future notices use the dictionary |
| Score screen | new | Show check names and results; never weights, thresholds or formula; compute on the server |
| Keywords page | new | Month measured, never the supplier; "How we work this out" explains arithmetic only |

**Mechanism:** one neutral dictionary, a founder/client split using the existing shell flags, and a regression test that renders every client page, export, published page and plugin payload from fixtures and asserts a banned-terms list (supplier names, model and maker names, pack ids and product names, "prompt", "method pack").

## 8. Release sequence

Each release is independently shippable. None before release 13 needs a migration; every new field is jsonb on existing records.

**1. Engine verifiably on.**
- Owner gets: certainty that research, numbers and (for his own businesses) the method ran for every article, or a clear stop.
- Files:
  - `portal/seo-blog-service.ts` — one credential resolution; numbers on by default; expose `keywords` and `methods` status.
  - `seo-blog/engine.ts` — strict holds, readiness items, engine stamp, minimum-evidence hold.
  - `seo-blog/method-packs.ts` — strict mode replaces the three silent returns for expected businesses.
  - `keyword/dataforseo.ts` — location from the business locale.
  - founder limits view — engine status per business.
  - `docs/seo-blog-engine.md` — settings table.
- Settings: `SEO_BLOG_REQUIRE_FULL_ENGINE`; `SEO_BLOG_KEYWORD_METRICS` becomes opt-out.
- Operational steps (no code): flags on portal and worker, enrolment, all-on per business.
- Cost: one research attempt per plan, as today when numbers are on.
- Tests: prefixed-credentials case; each silent path now holds; "no data" does not hold; stamp present on plan, brief and version.
- Risk: strict mode can stop production for a misconfigured business — that is the point; pilot on one business first. Measured coverage stays low until release 5; say so.

**2. Neutral words.**
- Owner gets: nothing client-facing names the supplier, method or model.
- Files: `seo-blog/programme.ts` (diagnostic wording); `portal/seo-blog-view.ts` (lines 168, 283, 297, 393); `seo-blog/engine.ts` (owner-message mapping at job errors, readiness and allowance text); `portal/campaign-creator-view.ts` and both layouts (founder-only gate); new banned-terms test.
- Cost: none.
- Risk: founder loses detail unless the founder view keeps it.

**3. Search score shown.**
- Owner gets: a score out of 100 and plain fixes on every article.
- Files: `seo-blog/engine.ts` (compute beside `checkVersion`, store `article.seo`); article page views (old and `content-area-pages.ts`); consumes `seo-score.ts`.
- Cost: none.
- Tests: score recomputed on edit; stale detection as for `checksAreCurrent`.
- Risk: until release 5 the "phrase" is the question-form target, so placement checks under-score; label the score "beta" until then.

**4. Keyword data foundation.**
- Owner gets: nothing visible; the founder gets a preview of the measured list for a business.
- Files: new `keyword/dataforseo-labs.ts` (calls with cost and diagnostics); `keyword/types.ts` (candidate type; `difficulty` correctly sourced); new `seo-blog/keyword-pool.ts` (seeds, filter, cluster, rank, reason — pure); `seo-blog/programme.ts` (attempt kinds); `seo-blog/engine.ts` (`plan` job with `payload.stage='keywords'` through `programmeSearch`); `seo-blog/store.ts` and `pg-store.ts` (locked inventory update); `seo-blog/inventory.ts` (carry the pool over); `seo-blog/limits.ts` and `USAGE_ESTIMATES`.
- Cost: about $0.20-0.40 per fill.
- Tests: fixture responses; cache hit spends nothing; budget hold; uncertain outcome is never repeated; pool survives an inventory refresh.
- Risk: field shapes and prices unverified; one authorised live call on one business first.

**5. Measured planning.**
- Owner gets: every autopilot brief carries a measured phrase, secondary phrases, the reason, and the honest ladder when data is thin.
- Files: `prompts/seo-blog-plan-v2.md`; `seo-blog/generation.ts` (`primary_phrase_id` and `secondary_phrase_ids` in the plan schema, validator membership check, `<search_candidates>` block capped to fit the 150 KB method request limit at `method-packs.ts:162`); `seo-blog/engine.ts` (`runPlan` shortlist, searches on measured phrases, `brief.seo`, saved shortlist for `retryJob`); `seo-blog/types.ts`.
- Cost: no extra searches; about 2-3k more planning tokens.
- Tests: an unknown candidate id is rejected; method rule satisfied (question kept); v1 path byte-identical when no pool; fallback tiers.
- Risk: the planning method's model-reported checks may fail more often on first live runs; pilot.

**6. Keywords page, read-only.**
- Owner gets: the eighth place, with phrases, searches and month, three bands, intent, states, and the plain autopilot statement.
- Files: `portal/content-area-layout.ts` (place, icon, tab map); new `portal/content-area-keywords.ts`; `portal/seo-blog-router.ts` (route); `portal/seo-blog-view.ts` (tab type).
- Cost: none; page views never spend.
- Tests: state derivation for all seven states; no-data wording; phone More list; banned-terms test.
- Risk: the "could bring" range ships only after the owner's decision.

**7. Keywords actions; Topics demoted.**
- Owner gets: tick and "Write articles for these"; "Not for us"; "Find more keywords"; holds explained on Keywords; Topics becomes "Earlier plans".
- Files: `seo-blog/engine.ts` (`requestKeywordArticles`, `dismissKeyword`, `requestMoreKeywords`, selection-mode plan); new `prompts/seo-blog-brief.md`; `seo-blog/generation.ts`; router POST handlers with CSRF and command ids; `content-area-pages.ts` (`fillOutlook` links).
- Settings: a daily cap on "Find more" (constant).
- Cost: one planning call per selection; one search per chosen phrase; one article each.
- Tests: idempotent command; backlog and budget limits; dismissed never returns; an owner-typed seed is treated as data.
- Risk: owner-selected briefs run without the planning pack (decision 4).

**8. Writer gets the requirements.**
- Owner gets: articles written to the search standard from the first draft.
- Files: `prompts/seo-blog-article-v2.md`; `seo-blog/generation.ts` (`search_requirements` in the brief block; title and description options); `seo-blog/research.ts` (advanced read; questions and related searches; headings and word counts); `seo-blog/html.ts` (heading capture); `seo-blog/types.ts`.
- Cost: +0.6-1.2k tokens per article; expanding questions is optional.
- Tests: old briefs use the v1 file and hash; validators unchanged; structured-schema size test.
- Risk: grammar limit on the structured article schema; advanced-read pricing unverified.

**9. Bounded improve loop.**
- Owner gets: a better article and a higher score, with nothing else to see.
- Files: `seo-blog/engine.ts` (loop in `runWrite`, saved draft, per-pass usage, `requiresApproval` when below the bar); `seo-blog/generation.ts` (intro and conclusion as parts); new section prompt file; `seo-blog/checks.ts` (shared context builder); `USAGE_ESTIMATES.articleImprove`.
- Cost: 0-2 passes; preflight 48,000; worst case about +60,000 tokens with the method.
- Tests: stops at bar and at cap; a pass with a new critical issue or voice warning is discarded; over-use guard; crash resumes without buying the article again; other sections byte-for-byte unchanged.
- Risk: cost; optional follow-up 9b adds prefix caching with correct accounting.

**10. WordPress and structured data.**
- Owner gets: Rank Math shows a real score; Yoast has its keyphrase set; FAQ and breadcrumb data on every page.
- Files: `publishers/wordpress.ts` (payload); plugin `class-r72pub-seo.php` (fields, recalculation, schema), `readme.txt`, version 1.2.0 zip; `seo-blog/render.ts` (FAQPage, BreadcrumbList, `dateModified`, image object, social tags); `docs/seo-blog-wordpress.md`.
- Cost: none.
- Tests: the existing playground scenarios (standalone, rank_math, yoast, hold) with the new fields; human-edit preservation; old plugin ignores the new block.
- Risk: plugin internals change; guard every call with existence checks.

**11. Main picture for every article.**
- Owner gets: a picture in one consistent style on every article, reused by social, with approve or change.
- Files: set-up and settings views (opt-in and allowance in onboarding); `seo-blog/engine.ts` or `brand-dna.ts` (draft the style document); v2 prompt alt rule; operator policy set by hand.
- Settings: `SEO_BLOG_IMAGE_API_KEY` (exists).
- Cost: about $0.04-0.05 per article.
- Tests: existing image suites; style document reaches the prompt.
- Risk: first live paid picture has never been run (`docs/creative-studio.md` ~line 81).

**12. Internal links.**
- Owner gets: every article links to the money page and its cluster; older articles gain a link to new ones after his approval.
- Files: `seo-blog/engine.ts` (required links from `brief.seo.cluster`; a "link update" proposal creating a new version of an older article); score checks; article page.
- Cost: a section pass per updated article.
- Risk: republishing live pages; approval per exact version stays mandatory.

**13. In-body pictures.** Migration A, its own hand-applied release behind the readiness gate; code deployed compatible first. New slot and use-kind values and admission for more than one picture per version. Then `section.image`, rendering, and plugin multi-attachment. Cost: about +$0.08-0.10 per article.

**14. Results feedback and re-optimise.** A monthly own-rankings call; positions on Keywords and Results; re-optimise pass for positions 5-20. jsonb is enough for the latest snapshot. Migration B only if per-phrase history is wanted.

**15. Method for client businesses.** Migration C (public approval and scope or enrolment) plus a new release record. Only after the commercial-use decision.

## 9. Decisions only the owner can make

1. **Strict mode.** Should an article be stopped rather than written when numbers or the method are unavailable? Recommended: yes.
2. **Monthly data allowance per business.** In research attempts; suggested default about 60, roughly $1-2 of supplier spend.
3. **The method for paying clients.** A commercial-use review and decision (`OWNER-DECISIONS.txt` items 4 and 6), then migration C. Until then clients get the house standard, recorded honestly.
4. **Owner-ticked keywords and the planning method.** Accept that they are briefed outside the planning method (the writing method still applies), or commission a variable-size planning pack?
5. **"What this could bring".** Show the conditional visits range, the non-numeric audience size, or nothing?
6. **Difficulty bands** (0-29 / 30-49 / 50+), and whether autopilot may ever pick "Harder".
7. **Score bar (80) and pass cap (2).** And should below-bar articles always wait for his approval?
8. **Pictures.** Automatic with review, or a per-article yes; pictures per month per business; whether to add in-body pictures at about three times the picture cost.
9. **Competitors.** May each business confirm two or three competitor sites to learn from?
10. **Platform name on client sites.** The Relaunch72 name appears in the plugin and page markers: acceptable, or white-label?
11. **Updating older live articles** to add links: approve each one, or allow automatically?
12. **Local businesses.** Pay for "in your area" numbers as a second lookup?

## 10. UNVERIFIED

- **Production settings and data:** which `SEO_BLOG_*` and credential names are set; whether owned organisations are enrolled and with automatic defaults; whether the picture policy and key are set. None is in the repository.
- **Supplier prices and shapes.** `dataforseo.com` is outside this session's allowed network, so prices come from web search snippets only.
  - Two official pages disagree on Labs rates ($0.01 / $0.0001 versus $0.012 / $0.00012).
  - Google Ads volume: $0.05-0.06 standard, $0.075-0.09 live.
  - Whether the advanced read costs the same as the regular one.
  - Whether every Labs row carries difficulty and intent.
  - Whether Labs is country-level only.
  - Exact request and response field names.
- **Picture price** (about $0.041 for this model, quality and size) comes from third-party tables, not the maker's page.
- **Click-share figures** (1% to 10%) and the common difficulty bands are from memory of public studies.
- **Rank Math and Yoast behaviour:** the score-update function name is from a support thread; the exact test lists are from memory; no server-side Yoast recalculation was found.
- **Token figures** are the code's estimates, not measurements of live runs. Method-wrapped revision size is inferred from `method-packs.ts:139, 256`.
- **Client-facing JSON:** whether any response returns version or plan objects with model, prompt or provider fields was not traced exhaustively; the allowlist test in release 2 settles it.
- **Creative Studio and campaign-creator screens** were not checked for model names.
- **`programmeInputSnapshot`:** whether owner keyword choices in settings would change the programme input hash was not checked.
- **`seo-score.ts`** does not exist yet; its check names, over-use check and "not applicable" state are assumptions to agree with its builder.
- **FAQ rich-result eligibility** in Google's current rules.

### Critical Files for Implementation
- `/home/user/r72-shell/orchestrator/src/seo-blog/engine.ts`
- `/home/user/r72-shell/orchestrator/src/seo-blog/generation.ts`
- `/home/user/r72-shell/orchestrator/src/portal/seo-blog-service.ts`
- `/home/user/r72-shell/orchestrator/src/seo-blog/research.ts`
- `/home/user/r72-shell/orchestrator/src/portal/content-area-layout.ts`

Also central:
- `/home/user/r72-shell/orchestrator/src/seo-blog/method-packs.ts`
- `/home/user/r72-shell/orchestrator/src/seo-blog/programme.ts`
- `/home/user/r72-shell/orchestrator/src/keyword/dataforseo.ts`
- `/home/user/r72-shell/orchestrator/src/portal/content-area-pages.ts`
- `/home/user/r72-shell/orchestrator/src/portal/seo-blog-view.ts`
- `/home/user/r72-shell/orchestrator/src/seo-blog/render.ts`
- `/home/user/r72-shell/orchestrator/src/seo-blog/publishers/wordpress.ts`
- `/home/user/r72-shell/wordpress-plugin/relaunch72-publisher/includes/class-r72pub-seo.php`
- `/home/user/r72-shell/prompts/seo-blog-article.md`
- `/home/user/r72-shell/prompts/seo-blog-plan.md`
- `/home/user/r72-shell/orchestrator/src/db/migrations/0138_seo_blog_method_packs.sql`
- `/home/user/r72-shell/orchestrator/src/db/migrations/0137_seo_blog_media_storage.sql`

Sources (web lookups for prices and plugin behaviour):
- [DataForSEO Labs Google API pricing](https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api)
- [DataForSEO Labs keyword research](https://dataforseo.com/apis/dataforseo-labs-api/keyword-research)
- [DataForSEO Google Organic SERP API pricing](https://dataforseo.com/pricing/serp/google-organic-serp-api)
- [The cost of additional SERP API parameters](https://dataforseo.com/help-center/serp-api-cost-explained)
- [DataForSEO Google Ads keyword data pricing](https://dataforseo.com/pricing/keywords-data/google-ads)
- [DataForSEO Keyword Planner API](https://dataforseo.com/keyword-planner-api)
- [Related Keywords endpoint docs](https://docs.dataforseo.com/v3/dataforseo_labs-google-related_keywords-live/)
- [GPT Image 2 reference pricing (Opper)](https://opper.ai/openai/gpt-image-2)
- [GPT Image 2 pricing (Segmind)](https://www.segmind.com/models/gpt-image-2/pricing)
- [Rank Math support: score not shown in list view](https://support.rankmath.com/?p=1120752)
- [Rank Math support: post meta](https://support.rankmath.com/?p=765266)
- [Yoast SEO Metadata API](https://developer.yoast.com/customization/apis/metadata-api/)