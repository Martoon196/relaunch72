# Adversarial review: Affiliate Studio slice 1, release 2 (screens and product articles)

Worktree `/home/user/r72-affiliate`, head `b81e2a1480a794523dc5ef8c163c80e48e4a32e9`, diff `d4e5527..b81e2a1`. Reviewed 17 November 2026. The worktree is untouched (`git status` empty at the end). No connector tool, no paid supplier, no send.

**REPORT.md was not written.** The Write tool refused it ("Subagents should return findings as text, not write report files"), and I did not work round that. This message is the full report; please save it to `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-affiliate-screens/REPORT.md` if you want the file.

My scripts and their output are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-affiliate-screens/` (`scripts/`, `out/`, `web/`, `base/`, `pg/`, `pg2/`).

"RAN" means I ran it and saw it. "READ" means I read the code and believe it.

## Verdict

- **Safe to merge with the switch off: yes.** With `AFFILIATE_STUDIO` absent, 73 pages, routes, prompts, stored versions and published files are byte-identical to d4e5527, and the full suite has no failure.
- **Not safe to switch on yet.** Seven things must be fixed or decided first (M1 to M7). The two worst: a product article can be published with no approval at all (M1), and a stranger's Amazon tag can silently become the business's own (M3).

## MUST-FIX before merge

None.

## MUST-FIX before the switch is ever turned on

### M1. A product article can go out with no approval (RAN)
- **Script:** `scripts/e1-approval.mts`, case E1b; output `out/e1.out`.
- **Steps, all ordinary portal actions:** remove every product link (or delete the product parts in the editor), switch "needs my approval" off, press "write it again", with auto-publish on.
- **What happened:** the rewrite put all 3 links back, `requiresApproval` stayed `false`, and the article published at its time with `policy.rule = auto_unflagged` and `approval = null`. The live page carried 3 affiliate links. The check that links match current products never ran.
- **Where:**
  - `src/seo-blog/engine.ts:2679-2687`: the flag is only protected while the current version has links.
  - `engine.ts:1548`: the flag is set once, when the article row is created.
  - `src/seo-blog/policy.ts:106`: the gate trusts the stored flag.
  - Routes that reach it: `seo-blog-router.ts:1349`, `:1239`, `:1325`.
- **Should have happened:** held for approval.
- **Smallest fix:** in `evaluatePublication`, treat a version with product links as "approval required" whatever the flag says. Set the flag back to true in `appendVersion` whenever a body has links. Add this sequence as a test.

### M2. With the switch on, Results and Settings answer "not found" for any business the session is not signed in to (RAN, real PostgreSQL, real router)
- **Script:** `scripts/db1-isolation.mts`; output `out/db1.out`, section "The owner of B signed in to their home workspace".
- **Cause:** a business made with "Add a business" is a new workspace, so its id is not the session's selected workspace (printed `A false, B false`).
- **What happened, same owner and business:**

| Page | Switch off | Switch on |
|---|---|---|
| `results` | 200 | 404 |
| `publishing` (Settings) | 200 | 404 |
| `articles` | 200 | 200, with a Products pill that leads to 404 |

- **Where:** `seo-blog-router.ts:489` composes the stores for every business. The cards at `:566` and `:651` call `own()` (`affiliate-routes.ts:26`), which throws 404 and takes the whole page with it.
- **Smallest fix:** compose `affiliate` only when `identity.workspaceId === brandId`, on GET and POST.

### M3. The tracking ID is taken from a pasted link and saved as the owner's own, unseen (RAN)
- **Script:** `scripts/e7-tag-social.mts`, E7a; output `out/e7.out`.
- **Input:** first product pasted as `https://www.amazon.co.uk/Wind-Up-Torch/dp/B0TORCH001?tag=stranger-21&linkCode=ll1`, tracking ID box left empty (it is not required), both boxes ticked.
- **What happened:** "Product added." The saved tracking ID became `stranger-21`. The next plain product page was stored as `...?tag=stranger-21`. The form never showed which ID it would save, although the owner had ticked "This tracking ID is mine".
- **Why it matters:** if the first product link is copied from someone else's page, it can carry their tag. Commission would then go to them.
- **Where:** `src/portal/affiliate-routes.ts:103`.
- **Smallest fix:** never save a tracking ID the owner did not type or explicitly confirm on screen, and name the saved ID in the success message.

### M4. Prices, ratings, stock, "we tested" and the shop's name are not checked outside the body text (RAN)
- **Scripts:** `scripts/e2-checks.mts` E2a (owner edit) and `scripts/e3-model-research.mts` E3a (writer output).
- **Input:**
  - Title: "Best power cut kit under £19.99 on Amazon.co.uk (4.5 stars, in stock, free delivery)".
  - Search title: "Power cut kit from £9.99 | 20% off today".
  - Description: "We tested every torch. Now £19.99 at amazon.co.uk with next-day delivery and 2,000 reviews, rated 4.8 out of 5."
- **What happened:** no critical issue; approval accepted. They appear in `<title>`, `<h1>` and the meta description of the published page.
- **Where:** `src/affiliate/article.ts:201` (approval check covers opening, parts, questions and closing only) and `:142` (write-time check).
- **Smallest fix:** add title, search title, description, summary and picture words to both checks.

### M5. Research reads Amazon's own pages and can publish somebody else's affiliate link as a source (RAN)
- **Script:** `scripts/e3-model-research.mts` E3c.
- **Input:** the search answers with `m.amazon.co.uk`, `smile.amazon.co.uk`, `www.amazon.de`, `amzn.eu` and `a.co` addresses.
- **What happened:**
  - Our fetcher requested all five, and they were kept as sources.
  - The writer was shown "£12.99, 4.6 out of 5 stars" from Amazon's page as research.
  - The published page listed `<a href="https://m.amazon.co.uk/dp/B0TORCH001?tag=stranger-21" rel="noopener">` among its sources.
- **Where:** `engine.ts:2646` lists three hosts; `research.ts:297` compares exact host names only.
- **Smallest fix:** exclude the whole site family (`amazon.<tld>`, `amzn.<tld>`, `a.co`, `amzlink.to`, with subdomains), check the address after redirects, and drop any such source before citations are built.

### M6. The ad label is only inside the article; the ASA expects it before the click (ASA page read 17 Nov 2026; code RAN)
- **What the code does:** "Ad." is the first thing in the article on every renderer, before the first link. It is not in the title, summary, blog index teaser or social drafts (`out/e6.out`).
- **What the ASA advice says** (`web/asa.txt`, page dated 22 Mar 2023):
  - For content that "wholly concerns affiliate linked products... the commercial nature of the content should be clear prior to consumer engagement", most simply "an identifier, for example 'Ad', in the title... clear to consumers before they click through".
  - In the MailOnline ruling a top-of-article disclaimer was "insufficient, not least because... 'may earn an affiliate commission' was ambiguous". Ours says "we may earn a commission" (`programmes.ts:249`).
  - A social post that leads to affiliate content can count as an affiliate ad even with no link in it.
- **Smallest fix:** an owner decision, ideally with advice. Then show the label wherever the title is shown, change "may earn" to "earn", and either make no social drafts for these articles (S2) or label them.

### M7. On the Property Predator site the links lose `rel="sponsored nofollow"`, and nothing checks the published page (sanitiser RAN, verification READ)
- **Script:** `scripts/pp-sanitiser-check.py`. It copies that site's own sanitiser (`/home/user/propertypredator/backend/services/blog_content.py:180-249`) and runs it on our fragment.
- **What happened:** `rel="sponsored nofollow noopener" target="_blank"` came out as `rel="noopener"` (line 206 rewrites every rel). 3 sponsored before, 0 after. The label text and "(paid link)" survived.
- **Missing from the diff:** the plan's post-publish check that the label and each rel survived, with a visible alert. `publishers/types.ts` is unchanged; `verifyPublicUrl` (`types.ts:98-108`) looks for the version marker only.
- **Smallest fix:** build the planned check and hold or alert when it fails; let the receiving site keep `sponsored` and `nofollow`. Needed before switching on for any business that publishes to that site.
- **WordPress:** READ only. `wp_kses_post` (plugin `class-r72pub-publisher.php:296`) should keep `rel`, `target` and `class`; I did not run WordPress.

## SHOULD-FIX

- **S1. Approved, then changed (RAN, E1d).** After approval I changed the tracking ID to `corrected-21` and retired a product. The article still published with `tag=harbour-21`. Fix: clear the approval of unpublished linked articles when the details change or a product is retired.
- **S2. Product articles do get social drafts (RAN, E6a, E7b).**
  - Docs and comments say none. Each gets a 2-post pack (Instagram, LinkedIn) and a 6-post campaign; only the model call is skipped (`engine.ts:1741-1768`).
  - Every product article also writes an Activity line an ordinary owner sees: "Accompanying drafts use labelled article-text templates because model output was unavailable or incomplete. No automatic correction call was made." It names the model and is untrue.
  - I could not exercise approving those drafts (see "Could not verify").
  - Fix: build no pack and no campaign when the body has links, and write no such line.
- **S3. Shop links typed into the text (RAN, E2b, E2f).**
  - Approved: `https://www.amazon%2Eco.uk/...`, a full-width letter, an ideographic full stop, `amzlink.to`, `amzn.asia`, a redirect site, an eBay affiliate link.
  - Node's URL parser resolves the first three to `www.amazon.co.uk`. All render with `rel="noopener"` only.
  - Once an article has no code-made links, the shop-address check does not run at all (`article.ts:198`).
  - Fix: parse each link and compare its real host; run the check for every article with `brief.products`.
- **S4. What the Results card says (RAN, E4b to E4d).**
  - A file holding only other people's tracking IDs shows "Earnings £814.00" for this business.
  - One hidden earnings cell shows "Earnings £2.00"; a hidden clicks cell correctly shows "Not shown by Amazon" (`affiliate-views.ts:115`).
  - A totals row called "Totals:", "Total:", "Grand Total:" or "TOTAL (all IDs)" doubles the figures (`amazon-tracking-report.ts:143`).
  - "1,50" reads as £150.00; "(-1.50)" as +£0.50.
  - Fix: headline the saved tracking ID's row or say "all tracking IDs in this file"; show "Not shown by Amazon" when any earnings cell is unknown; get one real UK export before go-live.
- **S5. Research spend not recorded, and repeated (RAN, E3d).** Two searches made, the second failed: 0 recorded. One rewrite made another: still 0. The owner is told nothing (`engine.ts:2640-2652`). Fix: record in a `finally`, save the empty result, write one Activity line.
- **S6. The strict setting does not apply to product articles (RAN, E3f).** With `requireFullEngine` on and research not live, a product article was written with 0 sources; an ordinary plan was refused. Decide and document.
- **S7. A product name can turn an error into an unrelated one (RAN, E5).** 98 sentences checked; all the fixed ones are unchanged. But "The link for OpenAI mug was made with a different tracking ID..." is shown as "Image generation could not finish. Nothing was published or approved. You can try again." Names with "API token", "GPT-4" or "Anthropic" do the same (`article.ts:73`). Fix: put the name in quotation marks, or leave it out.
- **S8. Pressing "Add a product" twice (RAN, db2).** The second press answers "This was already sent once with different details", because each call invents a new product id (`product-store.ts:264`). Fix: derive the id from the form's id.
- **S9. A name of invisible characters is accepted (RAN, db2).** The card shows an empty name, and the heading check would then demand an empty heading (READ), so an article using it cannot be written. Fix: refuse a name that is empty after cleaning.
- **S10. An expired form on the Amazon UK details card lands on "not found" (RAN, db2).** The general handler redirects to `/b/:id/affiliate`. Fix: send it to Settings.
- **S11. Rewriting one part (RAN, E2e).** The writer is not given the product rules there; the body checks still apply afterwards.
- **S12. The price and rating wording list is narrow (RAN, E2c).** 14 of 15 phrases passed, for example "It costs 19.99 at the moment", "Half price this week", "Rated five stars by buyers", "Tested by experts".

## NOTES

- **N1.** A person who manages both businesses, signed in to A, can call the stores for B directly (known from the 0158 review). Every route refused it (RAN).
- **N2.** The article page in the portal and the HTML copy carry live Amazon links. Amazon: "All Special Links must be accessed directly from your Site." The Markdown copy leaves them out and says so (RAN).
- **N3.** Sending the same part id twice in an edit renders the same link twice (RAN).
- **N4.** The same product can be added twice under two names (RAN).
- **N5.** The same file is accepted again for another month; months to 2099-12 are accepted (RAN).
- **N6.** Tracking IDs `'=1` and full-width `＝1+1` are accepted. Nothing exports them today, and the HTML is escaped (RAN).
- **N7.** A report upload is read up to 21 MB into memory before the 2 MB check (existing limit).
- **N8.** The Topics page shows the product plan like any other, with "Select" and "Generate selected articles" (RAN).
- **N9.** Already in d4e5527: the Activity line "...no model call was made." on every edit is visible to ordinary owners (RAN on the base export).
- **N10.** The plan's `{ model: 'none', promptVersion: 'product-brief@1' }` is printed by no portal view (READ), and no rendered page contained it (RAN).
- **N11.** The repo's scripted writer cannot answer with zero research sources (it reads `sources[0]`), so the no-research path has no test.

## Builder's leads

- **No `engine` stamp:** it is a hole in the strict setting unless intended (S6).
- **No `seo` field:** by design as far as I could see; I found no defect.
- **`ownerWords`:** confirmed for product names (S7); fixed sentences are safe.
- **Plan `generation`:** not shown anywhere (N10).
- **`productSources`:** confirmed under-count and hidden failure (S5), plus the host hole (M5).
- **`isFounder` before the affiliate branch:** it was already at that place in d4e5527; nothing changes with the switch off.
- **Merge:** every line of d4e5527 removed in the six files (15 lines) is one of the feature's own replacements; nothing lost or reordered.

## The ten claims

1. **Disclosure cannot be removed or hidden: held inside the article, not outside it.** It held across the published page, website fragment and portal column, after edits, a tampered field, a rewrite and a part rewrite. There is nothing before the click (M6) and no check after publishing (M7).
2. **Links by code only: broken.** M3, M5, S3 and M7. The link reader itself held: 36 hostile addresses gave 32 refused, 4 rebuilt into our own form, 0 wrong.
3. **No links where they must not be: held** for social copy, the Markdown copy, meta and structured data. Exceptions: M5, N2, S2.
4. **Approval always required: broken** (M1). Held for autopilot, the worker, approve-and-schedule and the plain auto-publish case.
5. **Tenant isolation: held.** 171 checks passed on real PostgreSQL, none broken.
6. **Switch off means untouched: held.** With it on there is a regression (M2).
7. **Clients never see the machinery: held on the new screens,** broken by one Activity line (S2) and by S7.
8. **Report upload is safe: held for safety, not for accuracy.** The hang is fixed: 20 hostile 2 MB files, slowest 201 ms; 4,331 random files, none threw. Accuracy is S4.
9. **Ordinary web safety: held.** A wrong CSRF value, another origin, wrong methods and the old look were all refused and nothing was written. Hostile names, notes, topics and report cells came back escaped.
10. **Compliance wording: partly held.** The Associates statement is exact and at the top of each article, links are direct, and no price is stored. Not held: M4 and M6.

## What I checked on the rules (17 November 2026)

WebFetch could not resolve either host; `curl` through the session proxy could, and that is what I used.

- **Amazon UK Operating Agreement** (updated 15 October 2025), section 5: "You must clearly and prominently state the following... on your Site...: 'As an Amazon Associate I earn from qualifying purchases.'" The code prints exactly that.
- **Amazon UK Program Policies** (updated 14 April 2026):
  - Prices and availability only through Amazon-served links or its API.
  - No customer reviews or star ratings except through the API.
  - No cloaking, and no shortening that hides the Amazon destination.
  - No printed material or ebooks.
  - Links are allowed in solicited emails, so the code is stricter than needed there.
- **ASA advice "Affiliate marketing":** quoted under M6.

## Could not verify

- **WordPress end to end:** no WordPress here; read only.
- **The real Amazon UK report layout:** no real export exists in the repo.
- **Approving and scheduling the social drafts of a product article:** the promotions service is not composed in my harness, and I made no sends.
- **A real writing model under prompt injection:** no paid calls. I tested what the checks do with scripted output.
- **The October 2026 ASA/CAP/CMA guidance** named in the plan: not read.
- **Production settings:** whether the strict setting is on, and how many live sessions are signed in to a workspace other than the business they work on (M2).
- **The full database integration suite:** I ran only the affiliate file.

## Test totals

- **Full suite with `CONTENT_AREA_PREVIEW=enabled`:** 5,281 tests, 5,165 pass, 0 fail, 116 skipped.
- **Full suite with `AFFILIATE_STUDIO=enabled` as well:** the same totals.
- **Affiliate tests alone:** 11 of 11 under three environments. `tsc` exit 0.
- **Database-backed affiliate tests:** `test/db/affiliate-studio.integration.test.ts` passed 2 of 2 on my second cluster (port 54878).
- **Database for my own checks:** PostgreSQL 16.15, my own cluster on port 54877, migrations applied through 0158 by the repo's runner (`applied 158; last 0158_affiliate_studio.sql`).

Both clusters are stopped; their data is kept under `pg/` and `pg2/`. The integration run left 4 `/tmp/r72-affiliate-*` directories, which I did not delete.