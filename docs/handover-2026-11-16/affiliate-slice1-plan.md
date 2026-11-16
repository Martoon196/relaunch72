# Affiliate Studio, slice 1: implementation plan

Read-only; nothing was written. Line numbers are from `/home/user/r72-shell` at HEAD `97f913e` (clean). `src/seo-blog/*` and `src/db/*` are unchanged since `744a19d`; `seo-blog-router.ts` and `content-area-*.ts` moved after it, so re-check those numbers. Paths are under `/home/user/r72-shell/orchestrator/` unless stated.

## Recommendation

Do not build a second content system or a new article kind. A product article is a one-article plan with products attached, flowing through the existing plan job, write job, checks, approval, calendar and publishers.

- **Links and disclosure are structured data**, held on the article body and rendered by code. They are never in the prose the model writes or the owner edits.
- **No first-party click counting in slice 1.** The Results page shows the clicks, items and earnings Amazon itself reports in the uploaded Tracking ID Summary file.
- **Affiliate articles never auto-publish and get no social drafts** in this slice.

## Findings that shape the design

- **Links can leak into social captions today.** `writeArticlePromotions` passes the whole `ArticleBody` to the social prompt (`src/seo-blog/generation.ts:175`, and `:194`). Any link data on the body must be stripped there, or promotion skipped.
- **The article is rendered in three places.** `renderArticlePage` (`src/seo-blog/render.ts:158-197`), `renderArticleFragment` (`src/seo-blog/publishers/content-api.ts:33-45`, also used by WordPress) and `readingColumn` (`src/portal/seo-blog-article-view.ts:393-406`). One shared helper must feed all three.
- **A click beacon cannot run on WordPress.** The plugin passes content through `wp_kses_post` (`/home/user/r72-shell/wordpress-plugin/relaunch72-publisher/includes/class-r72pub-publisher.php:296`), which strips scripts. Content-API sites sanitise too (`render.ts:60-65`), so the markup must be plain `<p>`, `<strong>` and `<a rel>`.
- **The planner cannot make one article.** It is fixed to one pillar plus six supporting (`/home/user/r72-shell/prompts/seo-blog-plan.md`). Slice 1 composes the single brief in code, with no planner model call.
- **The worker has no owner session.** The draft product function requires `seo_media_owner` (`0137_seo_blog_media_storage.sql:273-288`), so product data is snapshotted into the brief at request time.
- **Critical checks already block publication** (`src/seo-blog/policy.ts`; `engine.ts:2229-2240`). Compliance rules become critical checks.
- **`editArticle` spreads `...version.body`** (`engine.ts:2081-2088`). A body-level field survives edits if it is pinned the way `citations` is.
- **Briefs, plans and versions are jsonb** (`0131_seo_blog_engine.sql:36-40, 73-80`). New optional fields need no schema change; job kind `plan` is reused, so no CHECK change.

## Data model: one migration, `0158_affiliate_studio.sql`

Follow 0155 to 0157: `SET LOCAL lock_timeout='5s'; statement_timeout='60s'`, FORCE RLS, `SECURITY DEFINER SET search_path=pg_catalog`, `workspace_table_registry` rows, execute granted to `r72_content_command` only. It is purely additive apart from registry inserts and execute grants.

**Role.** New `r72_affiliate_definer`, NOLOGIN NOINHERIT, with the attribute and membership guard of `0157_email_connect_allowlist.sql:37-52`. Do not reuse `r72_creative_studio_definer`; it carries wide 0144 grants. Grant it what 0144 grants its definer (`0144:101-102`) and `seo_media_owner` as in `0145:17`.

**Tables** (all append-only via `app_private.seo_blog_append_only()`, owner policy plus workspace-scope policy):

| Table | Columns that matter |
|---|---|
| `app.affiliate_products` | PK `(workspace_id, product_id, revision)`; `programme` CHECK `'amazon_uk'`; `merchant_name`; `product_name`; `merchant_product_id` (ASIN); `product_url`; `affiliate_url` NOT NULL with an `https://www.amazon.co.uk/` CHECK; `info_url` NULL (maker's page); `notes` (up to 2000); `owner_used` boolean; `status` `active`/`retired`; `created_by`, `created_at` |
| `app.affiliate_product_commands` | Idempotency ledger, as drafted |
| `app.affiliate_programme_settings` | PK `(workspace_id, programme, revision)`; `tracking_id` CHECK ending `-21`; `registered_site` (https origin); `site_listed_confirmed` and `account_confirmed`, both CHECK true; who and when |
| `app.affiliate_report_imports` | As drafted |

**Functions:** `app_private.affiliate_product_command`, `affiliate_programme_command`, `affiliate_report_command`, each `(p_workspace uuid, p_session bytea, p_action text, p_input jsonb)`.

**What to do with the draft SQL** (`/home/user/r72-media/orchestrator/src/creative-studio/migration-drafts/`):

| Draft | Verdict |
|---|---|
| `0157_creative_media_products.sql` | **Take** the revision model, commands table, replay and advisory-lock logic, policies, and the grant/revoke bracket around `CREATE ON SCHEMA app_private`. **Change** names, definer role, `network` to `programme` (drop `'other'`; it has no policy), `proposed_affiliate_url` to `affiliate_url` NOT NULL. **Add** ASIN, `info_url`, `notes`, `owner_used`, `status`, a retire action and a 500-product cap. **Drop** `source_rights`, `evidence_sha256`, `owner_media_rights_confirmed`, `disclosure_version`, the two owner booleans and their CHECKs (video concerns, or moved to programme level). |
| `affiliate-link-evidence.sql` | **Drop.** It needs typed SHA-256 values, has a 30-day expiry, no `lock_timeout` and a loose UUID regex. Its intent (programme, site and tag ownership confirmed by a named person) becomes the two tick-boxes plus tracking ID in `affiliate_programme_settings`. |
| `0158_creative_media_reports.sql` | **Take almost whole.** Rename, change the definer role, fix the header (it says 0157). |
| `affiliate-link-distribution.sql`, `affiliate-studio-signup.sql`, everything else | **Drop** for this slice. |

**Readiness gate:**
- New `src/db/affiliate-schema.ts` with `AFFILIATE_MIGRATION` and `AFFILIATE_CHECKSUM` (sha256 of the LF-normalised file, `migrate.ts:32-33`) and a compatibility note like `src/db/email-allowlist-schema.ts`.
- In `src/db/runtime-readiness.ts`, add an admission block after `:411-417`: 158 files, exactly 0158 pending with the pinned checksum, exact 0157 and 0156 applied.
- Add the successor bridge after `:320-325`: a 157-file build stays ready after the exact 0158.
- App code treats `42883`, `42P01`, `3F000` as "not opened yet" (pattern at `src/email-connections/allowlist.ts:22`).

## Owner flow

Everything sits behind the new look and a new `AFFILIATE_STUDIO=enabled` switch, default off. The sidebar keeps exactly seven places (`content-area-layout.ts:54-57`).

- **Products lives inside Articles**, as two pills "Articles | Products" on the Articles page (`content-area-pages.ts:427`). `placeFor` (`:60`) maps products to `articles`; add one "Products" link in `otherTools` (`:74`).
- **Earnings live in Results**, which today says "we do not count readers yet" (`content-area-pages.ts:509-515`).
- **Programme details live in Settings**, as one card.

| Screen | What the owner does | Main action |
|---|---|---|
| Products, empty | Paste the Amazon link. We read the product code, tracking ID and a suggested name from the address. Optional: "What you know about it", "I have used this myself", maker's page. | Add a product |
| First product only | Same form shows: "We found your tracking ID x-21", "Which website will carry these links?", two ticks (site is listed in my Amazon account; this ID is mine). | Add a product |
| Products, with items | Cards show name, "Amazon UK", "used in N articles", quiet "Stop using". | Write an article |
| Write | Pick Buying guide, Comparison (2-4) or Shopping list (3-15); tick products; one line "What is it about?". | Write it |
| Article page | Locked label under the title exactly as readers see it; each product part ends with its button and an "Affiliate link" pill; a fold lists each link's full destination with "Remove this link". | Approve and publish (unchanged) |
| Results | "What Amazon reported" card. | Add Amazon's report |

Short `amzn.to` links are refused with one sentence: paste the full link, or the product page and we add your tracking ID. No hashes, revisions or technical fields are shown anywhere.

## How product facts reach the writer

1. `engine.requestProductArticle` runs in the owner's session. It reads current products and settings, validates links, and enqueues a `plan` job carrying an immutable snapshot.
2. `runPlan` (`engine.ts:1228`) branches to `runProductPlan`. It runs the existing research, seeded by topic and product names, excluding merchant hosts. It fetches `info_url` through the existing guarded fetch as a normal cited source. It never fetches Amazon pages.
3. Code composes one accepted plan and one brief. The outline has one heading per product, exactly the product name. `brief.products` holds the snapshot. `searchIntent` is `buy` or `compare`.
4. `writeArticle` (`generation.ts:544`) gets a `<products>` data block and a rules addendum appended in code. Do not edit `seo-blog-article.md`; its version is pinned.

**What the writer may say:** the name and merchant as stored; statements in the owner's notes; research facts with `[src:]`. First-hand wording only when `owner_used` is ticked.

**What it may not say:** prices, discounts, stock, delivery, star ratings, review counts, "best seller", "Amazon's Choice", or testing claims.

**Links by code only:**
- The validator (`generation.ts:578-588`) already rejects unlisted links. Add an explicit block on merchant hosts, and require exactly one section per product heading.
- Code then builds `body.affiliate = { programme, disclosureVersion, links: [{ productId, revision, name, url, sectionId }] }`. It is inside `contentSha`, so approval binds to the exact links.
- `editArticle` pins `affiliate` like `citations` and prunes links whose section was deleted. `regenerateSection` (`engine.ts:2181`) carries it over.

**New critical checks in `runChecks` (`checks.ts:92`):** `affiliate.raw_merchant_link`, `affiliate.link_invalid`, `affiliate.price_stated`, `affiliate.rating_or_stock`, `affiliate.untested_claim`, `affiliate.site_mismatch`. Product notes join the evidence text at `checks.ts:78-83`.

## Compliance by construction

A registry in `src/affiliate/programmes.ts` holds, per programme: link hosts, `parseLink`/`validateLink` (adapted from the media branch's `affiliate-direct-link.ts:18-51`), disclosure text and version, `rel`, link label, rule flags and report kinds. A second programme is a new entry plus a one-line CHECK extension.

- **Disclosure** is derived from `disclosureVersion`, not stored as editable text. It is the first element of the article in all three renderers: "**Ad.** This article contains affiliate links… As an Amazon Associate I earn from qualifying purchases." It cannot be removed while `links.length > 0`.
- **Links** render as `<a href="{exact amazon.co.uk url}" rel="sponsored nofollow noopener" target="_blank">See {name} on Amazon</a> (paid link)`. No redirect, no shortener.
- **Approval:** `requiresApproval` is forced true (`engine.ts:1445`) and cannot be switched off (`:2224`). `approve` re-reads the catalogue and blocks with a one-press "Update the links" if a link changed or was retired.
- **Email, documents, social:** the Markdown export (`render.ts:270`) omits links with a note. `appendVersion` is called with `skipPromotionGeneration=true`, and both promotion functions strip `affiliate`.
- **After publishing:** extend the page verification (`publishers/types.ts:83-95`) to confirm the disclosure and each link's `rel` survived the site's sanitiser. Raise a visible alert if not.

**Verification status.** I could not open `affiliate-program.amazon.co.uk` or `www.asa.org.uk`; both are outside this session's allowed network and must be allowed in its network settings before a recheck. What follows comes from search snippets, some third-party.

| Rule | Status |
|---|---|
| Operating Agreement section 5 requires the Associate statement "clearly and conspicuously" on the site | Verified from Amazon help snippet; exact current wording UNVERIFIED |
| Offline use barred: "printed material, mailing, SMS, MMS, email or attachment to email"; Special Links "not permitted… in emails" | Verified from Amazon.com help snippets; UK text UNVERIFIED |
| Link shorteners must not make the Amazon destination unclear; no cloaking of the referring site | Shortener rule from Amazon.com linking page snippet; cloaking wording third-party only, UNVERIFIED |
| Prices and availability only via Amazon-served links or its API, with timestamp | Third-party summaries only, UNVERIFIED |
| Reviews and star ratings only via the API | UNVERIFIED |
| Up to 100 tracking IDs | Amazon.com resource snippet; UK limit UNVERIFIED |
| Policies updated 14 April 2026 | Seen on Amazon's "What's Changed" page; contents unread |
| CAP Code rule 2.1: affiliate content must be obviously identifiable; whole piece is covered when it is all about affiliate products; publisher is liable | Verified from ASA advice snippet |
| "Ad" as the required label, and its position | UNVERIFIED |
| New ASA/CAP/CMA guidance, October 2026 | Lewis Silkin summary only; unread |
| ASA upheld four rulings against review sites implying independent testing | CMS summary; dates unconfirmed |

Also UNVERIFIED: the real UK report column headers (get one real export from the partner as a test fixture), whether building `…/dp/ASIN?tag=` ourselves is acceptable (run the first link through Amazon's Link Checker), and Amazon's position on automated page access (the design never fetches Amazon).

## Click measurement: option (c)

- **(a) Redirect through our domain:** rejected. It hides the Amazon destination and the referring site, which is what the cloaking rule targets.
- **(b) Beacon:** rejected for now. It cannot run on WordPress or sanitising sites, needs a new public endpoint with abuse and bot handling, and would still undercount.
- **(c) Amazon's own figures:** the parser already reads Clicks, Ordered items, Shipped items and Earnings per tracking ID.

Results can then truthfully show: "Amazon's report for October, uploaded 3 Nov: Clicks 412 · Items ordered 9 · Items dispatched 8 · Earnings £23.40", plus "N published articles carry affiliate links". No per-article numbers and no conversion rates. Slice 1 uses one tracking ID per business.

## Earnings report import

- Copy `amazon-tracking-report.ts` verbatim to `src/affiliate/`. It is pure and sound: tab or comma, unknown cells stay null, "Others" is never allocated, totals are skipped, 2 MB cap.
- Adapt `amazon-report-pg-store.ts` (rename the function; map a month to start and end dates).
- The owner uploads the Tracking ID Summary file and picks the month. The router's multipart parser already takes one file (`seo-blog-router.ts:237-239`).
- Wording: always "Amazon reported", "in the file you uploaded on…". Clicks are labelled "Clicks counted by Amazon" and never sit next to a sales total as a rate. Unknown cells read "Not shown by Amazon"; "Others" reads "Not tied to a tracking ID".

## Files

**Add**
- `src/db/migrations/0158_affiliate_studio.sql`: tables, role, three functions.
- `src/db/affiliate-schema.ts`: filename, checksum, compatibility note.
- `src/affiliate/programmes.ts`: programme registry and Amazon UK rules.
- `src/affiliate/product-store.ts`: products and settings store, from `media-product-pg-store.ts:88-110`.
- `src/affiliate/amazon-tracking-report.ts`, `src/affiliate/report-store.ts`: parser and import store.
- `src/affiliate/article.ts`: brief builder, section binding, checks, refresh and remove.
- `src/affiliate/render.ts`: the one disclosure and link HTML helper.
- `src/portal/affiliate-products-view.ts`, `src/portal/affiliate-results-view.ts`: new pages. Do not port `creative-media-products-view.ts`.

**Change**
- `src/db/runtime-readiness.ts`: admission and bridge.
- `src/seo-blog/types.ts`: optional `ArticleBrief.products`, `ArticleBody.affiliate`.
- `src/seo-blog/engine.ts`: `requestProductArticle`, `runProductPlan`, `runWrite` (`:1422`), `editArticle` (`:2076`), `regenerateSection` (`:2181`), `approve` (`:2229`), approval flag (`:2224`), export (`:2520`).
- `src/seo-blog/generation.ts`: product block, validator, strip in promotions.
- `src/seo-blog/checks.ts`, `render.ts`, `publishers/content-api.ts`, `publishers/types.ts`: checks, rendering, verification.
- `src/portal/seo-blog-article-view.ts`: reading column, locked label in editing (`:412-425`), links fold.
- `src/portal/seo-blog-router.ts`, `seo-blog-service.ts` (`affiliateFor`, pattern at `:95`), `content-area-pages.ts`, `content-area-layout.ts`.

## Routes

All inside `handleSeoBlog`, under `/portal/seo-blog/b/:brand/`. Portal session required; the workspace is re-checked in SQL. Every POST passes the existing same-origin check (`:230-234`) and `_csrf` (`:241`). All answer today's 404 unless the new look is on, `AFFILIATE_STUDIO` is enabled and 0158 is applied.

| Method | Path | Purpose |
|---|---|---|
| GET | `products` | List and add form |
| POST | `products` | Add (plus first-time settings) |
| POST | `products/:id` | Edit |
| POST | `products/:id/retire` | Stop using |
| GET, POST | `products/write` | Request an article |
| POST | `affiliate/settings` | Tracking ID, site, ticks |
| POST | `articles/:id/affiliate-refresh` | Update links to current |
| POST | `articles/:id/affiliate-remove` | Remove one link |
| POST | `results/report` | Upload (multipart) |
| GET | `results/report/:id` | Report detail |

## Tests

- **SQL contract** (`test/db/sql-contract.test.ts`, pattern at `:2043`): only new tables altered, every function a checked definer, timeouts present.
- **Readiness** (`test/db/runtime-readiness.test.ts`): 0158 pending admitted only with the exact checksum on exact 0157; two pending refused; bridge works.
- **Tenant isolation** (integration): workspace A cannot list, get, save or import for B; a worker or a missing session gets 42501; direct table access by `r72_content_command`, `r72_web`, `r72_worker` is denied; updates and deletes are blocked.
- **Disclosure cannot be removed:** edit, section regenerate, full regenerate and put-back all keep it; all three renderers emit it first; it disappears only when the last link is removed.
- **Links by code only:** the validator rejects any merchant-host link in prose; rendered `href` equals the stored URL byte for byte with the required `rel`; a tampered `affiliate` field in an edit POST is ignored.
- **Checks:** price, rating, stock, testing claim and site mismatch are each critical and block approval.
- **Approval:** stale or retired link blocks; the flag cannot be turned off; auto-publish never publishes an affiliate article.
- **Social and export:** the promotion prompt input contains no merchant URL; no pack is generated; the export has no links.
- **WordPress harness:** `wp_kses_post` keeps the disclosure and `rel`.
- **Parser:** port the media branch tests and add a real UK export fixture.
- **Unchanged pages:** with the preview off, or `AFFILIATE_STUDIO` unset, every existing page and the shell golden are byte-identical and the new routes 404.

## Release steps

1. Merge code plus the 0158 file; pin the checksum; run the contract, readiness and disposable-database integration tests.
2. Deploy to all nine services. Each must report ready with exactly 0158 pending; nothing is visible.
3. The owner applies 0158 by hand. Confirm the ledger row and checksum, and that all services are still ready.
4. Set `AFFILIATE_STUDIO=enabled` on the portal service only.
5. Dry run on the chosen site: add a product, write, publish, confirm the live page shows the label and `rel`, and put the first link through Amazon's Link Checker.
6. After 0158 there is no rollback to a build without the gate. If another branch takes 0158 first, rename and re-pin.

## Risks

- A site's sanitiser strips `rel` or the label; mitigated by the dry run and post-publish verification.
- Amazon's current UK wording differs from the snippets above; read both documents before step 4.
- The real report layout differs from what the parser expects; needs a real file.
- A one-brief plan may look odd on the Topics page; test it.
- The method-pack structured writing path (`article-output.ts:95`) has its own contract; confirm the heading-binding validator runs there too.
- The media branch will need its stores pointed at the new table names when it merges.
- Published articles keep an old link after a product is retired; slice 1 only lists them for republishing.

## Out of scope, and why

- Video, public sign-up, billing, 1 GB uploads, renderer, Zernio trigger: per the audit and the brief.
- First-party click counting and redirects: compliance risk and not runnable on the target sites.
- Prices, images, ratings and any Amazon API: programme restrictions.
- Social posts and emails for affiliate articles: needs per-platform ad labelling and listed accounts.
- A second merchant programme, per-article tracking IDs, per-product earnings (Amazon's Earnings report): next slices; the model allows them.
- Affiliate links in autopilot or cluster plans, or in free-text prose.

## Questions for the owner

1. Which business goes first: the partner's preparedness audience or your landlord brands?
2. Whose Amazon Associates UK account and tracking ID is used for that business, and is that person the one ticking the confirmations?
3. Which website carries the articles, and is it already listed in that Amazon account?
4. Can the partner send one real Tracking ID Summary export now, for the test fixture?
5. Are you content that affiliate articles always wait for your approval and get no social posts in this slice?
6. Label wording: "Ad" at the top of the article, or a different approved label after someone reads the current ASA guidance?

Sources:
- [Amazon UK Associates Operating Agreement](https://affiliate-program.amazon.co.uk/gp/associates/agreement)
- [Amazon UK: What's Changed](https://affiliate-program.amazon.co.uk/help/operating/compare)
- [Amazon UK: identifying yourself as an Associate](https://affiliate-program.amazon.co.uk/help/node/topic/GHQNZAU6669EZS98)
- [Amazon UK: reports overview](https://affiliate-program.amazon.co.uk/welcome/topic/reports)
- [Amazon.com Program Policies](https://affiliate-program.amazon.com/help/operating/policies)
- [Amazon.com Linking Requirements](https://affiliate-program.amazon.com/gp/associates/help/operating/linking/)
- [Amazon.com Participation Requirements](https://affiliate-program.amazon.com/help/operating/participation/)
- [Amazon.com: Offline Use of Associates Links](https://affiliate-program.amazon.com/help/node/topic/GQ5CMSPVXBXSFDFV)
- [Amazon.com: boosting earnings with reports](https://affiliate-program.amazon.com/resource-center/boost-your-earning-using-associate-reports)
- [ConductAtlas: Amazon Associates Program Policies](https://conductatlas.com/platform/amazon-associates/amazon-associates-program-policies/)
- [ASA advice: affiliate marketing](https://www.asa.org.uk/advice-online/affiliate-marketing.html)
- [Lewis Silkin: new ASA, CAP and CMA influencer guidance](https://www.lewissilkin.com/insights/2026/10/23/new-influencer-guidance-from-the-asa-cap-and-cma-what-has-changed-and-what-to-d-102o6ar)
- [CMS: ASA upholds complaints against four review websites](https://cms.law/en/gbr/legal-updates/asa-upholds-complaints-against-four-misleading-product-review-websites)
- [Osborne Clarke: affiliate posts must be clearly labelled](https://marketinglaw.osborneclarke.com/advertising-regulation/hidden-cost-of-the-comment-link-trend-asa-rules-affiliate-posts-must-be-clearly-labelled/)

### Critical Files for Implementation
- /home/user/r72-shell/orchestrator/src/seo-blog/engine.ts
- /home/user/r72-shell/orchestrator/src/seo-blog/generation.ts
- /home/user/r72-shell/orchestrator/src/seo-blog/render.ts
- /home/user/r72-shell/orchestrator/src/db/runtime-readiness.ts
- /home/user/r72-media/orchestrator/src/creative-studio/migration-drafts/0157_creative_media_products.sql