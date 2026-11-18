# Adversarial review: Affiliate Studio fix round, `claude/affiliate-fixes` @ 9d709f5b (delta 7b5ccf2..9d709f5b)

I did not change the repository: no commit, no push, no deploy. `git status` is clean at 9d709f5b. I made two scratch worktrees (`base` at 7b5ccf2 and `merge`) and removed both with `git worktree remove`. I used no connector tool, no supplier or model call, and no public host. Playwright aborted every request that was not to 127.0.0.1. My own PostgreSQL 16 cluster on 127.0.0.1:54881 is stopped (the machine restarted).

Scripts and outputs are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review2-affiliate/` (`scripts/`, `out/`, `out/pages/`, `out/shots/`).

**RAN** means I ran it and saw the result. **READ** means I read the code only.

## Verdict

**(a) Safe to merge and deploy with the switch off: yes.**
- **Ordinary data is untouched (RAN).** I drove the same scenario on 7b5ccf2 and on 9d709f5b with `AFFILIATE_STUDIO` and `CONTENT_AREA_PREVIEW` unset. The scenario covered 50 pages and 14 POSTs in the old and new look, briefs, plans, research sources, every stored version, publications, the GitHub site files, a content-site payload, a WordPress payload, prompts, web requests, usage, jobs and activity: 129 entries in all.
  - All 129 are identical once sealed credentials are masked.
  - Only `publications[].websiteSnapshot.requestSha` differs. It also differs between two runs of the same base tree, so it is run-to-run noise, not the delta.
- **Affiliate-bearing data does change with the switch off (RAN).** On rows that already carry affiliate data, the head behaves differently:
  - "Ad: " titles appear.
  - The disclosure wording is new, but its version string `amazon_uk.2026-11` is unchanged.
  - Links show as words in the portal.
  - Product plans are hidden from Topics.
  - A product article whose approval flag was forced to false is now held instead of auto-published.
  - Such rows can only exist if the switch was ever on (the plan is created only through the affiliate stores). It has never been on in production, so this is safe. I could not check production data.
- **The scratch merge is clean.** It needs two trivial conflict resolutions (below). `tsc` exits 0. 181 tests pass with the switches off and 105 pass with them on, 0 fail.
- **No migration change (RAN).** The delta does not touch `orchestrator/src/db/` (empty `git diff 7b5ccf2 9d709f5b -- orchestrator/src/db`, which covers `migrations/`, `runtime-readiness.ts` and `migrate.ts`). After merging, `src/db` equals the foundation's.

**(b) Ready for a supervised one-business pilot with the switch on: no.** Three things first:
1. P1: product articles can go to a website that is not the one registered with Amazon.
2. P2: once a published page fails its check, the owner has no way out on that website.
3. The pilot website must be one proven to keep `rel="sponsored nofollow"`. The Property Predator site is not one until its sanitiser is fixed.

## MUST-FIX before the pilot (not before merge)

### P1. A product article can be published to any connected website, not only the one registered with Amazon (RAN)
- **Script:** `scripts/a4-pagecheck.mts`, output `out/a4-pagecheck.head.out`.
- **Set-up:** the business website and Amazon-registered site are `harbour.example`. I connected a content site `bay.example`.
- **What happened:**
  - The checks reported no critical issue.
  - Approve and schedule were accepted.
  - The article was published on `bay.example` with 3 live tagged links.
- **Cause:** `src/affiliate/article.ts:372-375` (`affiliate.site_mismatch`) compares the business's `brand.website` with the registered site. It never compares the destination's public host. Neither does `websiteTarget` in the publish gate.
- **Why it matters:** Amazon only allows links on sites listed in the Associates account.
- **Smallest fix:** in `evaluatePublication`, or in the `decide` step of `publish` (`engine.ts:~3125`), hold a product article whose destination host is not `affiliate.registeredSite`. Add a test with two destinations.

### P2. After a failed page check there is no way to correct the page; even a link-free version of the same article is blocked (RAN)
- **Script:** same as P1. The content site rewrote every `rel="sponsored nofollow noopener"` to `rel="noopener"`, as the Property Predator sanitiser does.
- **What worked:** the check failed ("A product link is not marked as a paid link."), the alert was raised, and the website was blocked.
- **What did not:** I removed every link, approved the link-free version and scheduled it. It was held with "Product articles are paused for this website…". The live page still has 3 unmarked links. No publisher can take a page down (stated in `page-check.ts`).
- **Cause:** `affiliateDestinationBlock` applies to every `isProductArticle(version, brief)`. That includes versions with no links, because the brief still has products (`engine.ts:3119-3133`).
- **Smallest fix:** let the block skip a version that carries no product links, at least for the article whose page failed. That is the only remedy the owner has. Also tell the owner in the alert that removing the links and publishing again is the fix.
- **Pilot rule:** until the receiving site keeps `rel`, the first article still goes out unmarked. Choose a pilot site where a test page has passed the check.

## SHOULD-FIX

### S-a. Approvals are taken back in a second step, not atomically (RAN)
- **Script:** `scripts/a1-attacks.mts`, section A6.
- **Steps:** I made `affiliateDetailsChanged` fail once (as a lost database connection would), right after the settings were saved.
- **What happened:**
  - The first press threw (500). The tracking ID was already saved as `corrected-21`; the approval was still there.
  - The same form sent again was refused with "This was changed somewhere else a moment ago…", which is misleading. Nothing was taken back.
  - At its time the article published with `tag=harbour-21`.
- **Same pattern for retiring a product:** a replayed retire does not clear approvals (`affiliate-routes.ts:162`). READ.
- **Where:** `src/portal/affiliate-routes.ts:102-114`.
- **Smallest fix:** take approvals back before saving. Or, on a replayed or stale save where the stored ID equals the typed one, run the take-back anyway.

### S-b. The new wording rules block honest sentences (RAN, `scripts/fp.mts`)
- **Flagged as critical:**
  - "The cable is only 2.50 metres long." (price)
  - "Our shop is open from 10.30 to 4.00" (price)
  - "Save 10% of your phone battery…" (price)
  - "It has a 4-star energy rating." (rating)
  - "Use 3 out of 5 settings" (rating)
  - "Free returns are not something we can promise" (stock)
  - "We tested the smoke alarm button every month" (testing)
  - "I have reviewed the government advice" (testing)
  - "We checked the products against the manufacturer manuals" (testing)
- **Why it matters:** each blocks approval. If the writer produces one twice, the write fails and the allowance is spent.
- **Where:** `article.ts:137-169`.
- **Smallest fix:** require a currency or price word near the amount for the "only/from + d.dd" rule. Make "N out of 5" a rating only beside stars, rated or reviews. Make "we tested/reviewed/checked" match only when "the product/it/them" follows.

### S-c. Report rows with more cells than the header are accepted (RAN, `out/e4-report.head.out`)
- An unquoted continental amount `1,50` in a comma file is read as £1.00 (the extra cell is ignored).
- **Smallest fix:** refuse any row with more cells than the header.

### S-d. Tap targets below 44 px on the affiliate screens (RAN, Playwright)
- **Measured at 390 px and 1280 px:**
  - "Stop using" button: 72×29.
  - Articles/Products pills: 40 px tall, and 20 px on the Articles list.
  - "I have used this myself" and the Write-page radio labels: 24–25 px.
  - The new "This file is for the month above…" tick: 25 px at 1280.
  - "Open Products" link on the empty Write page: 24 px.
- **Mostly pre-existing:** most of these were already in 7b5ccf2. The new tick box is part of this delta.
- **No horizontal scroll** at either width on any of the 16 pages. Output: `out/shots/walk.json`.

### S-e. The "same figures" tick box is always shown on Results (RAN)
- It confuses a non-technical owner.
- **Where:** `affiliate-views.ts:133`.
- **Fix:** show it only on the page reached through the "exactly the same figures" error.

### S-f. Research blocks the Amazon family only at the start and end of a redirect chain (READ)
- `research.ts:300,304` checks the search hit and `page.finalUrl`. The transport follows up to 5 redirects itself (`safe-fetch.ts:135`), so a middle hop on Amazon is still requested. Its content is discarded.
- **Why it matters:** the claim "never fetches" is not strictly true.
- **Fix:** pass `excludeUrl` into the transport's per-hop check.

## NOTES

- **N-1. Tests changed in the delta (READ).** Nothing was materially loosened.
  - One assertion went from exact equality to `!r.notice.startsWith('Product added.')` (`affiliate-screens.test.ts:316`).
  - The preview check moved to `renderArticlePage`. The words-only preview is now covered in `affiliate-fixes.test.ts` N2.
- **N-2. Mutation run (RAN, 25 mutants; output in `out/mutants.txt` and `out/mutants25.txt`).**
  - 22 of 24 single mutants were caught:
    - approval gate
    - flag reset
    - approval switch
    - router GET scoping
    - `rel`
    - disclosure
    - pasted tag adopted
    - tracking-ID validation
    - switch flag
    - "Ad:" prefix
    - page-check `rel`
    - website block
    - approvals taken back
    - Amazon-family research
    - brief-aware checks
    - drafts
    - schedule and approve link checks
    - totals rows
    - non-UK IDs
    - live links in the portal
  - **Survived:**
    - M04: `publish` passing no `brief` to the gate. Low risk: only a link-free version would then publish without approval.
    - M06: the router's POST scoping alone.
    - M07: `own()` alone.
  - M06 and M07 back each other up: removing both was caught. Add one test per guard if you want each layer pinned.
- **N-3. Workspace isolation on real PostgreSQL (RAN, `out/db1.head.out`).**
  - 169 checks held: every route, store and engine path for another business's product, article and report ids (read, add, edit, retire, write, refresh, remove, import), direct SQL as three roles, and row rules.
  - The 2 lines marked "BROKEN" are my old script expecting 404. Results and Settings now return 200 without the affiliate cards for a non-signed-in business, which is the M2 fix. The card absence is asserted by `affiliate-fixes.test.ts` M2 (RAN, passes).
  - With the switch off and on, B's pages return the same status codes.
- **N-4. Page alert (RAN).**
  - It shows as `role="alert"` at the top of the article and in Activity, in plain words.
  - A one-off failure to read the page leaves the check "not checked" and blocks the website. It cleared by itself after re-observation (30 simulated hours, no owner action).
- **N-5. "Ad: " is prefixed to the meta description too.** The length check reads the stored text, so the served description can be 4 characters over 160. Cosmetic.
- **N-6. Settings card wording (READ).** "Changing the tracking ID does not change links already in articles" is still true, but it does not say that saving takes back approvals. The success message does say it.
- **N-7. The Markdown copy of a product article carries no "Ad" label (RAN).** It also carries no links, so this is acceptable.
- **N-8. Research still feeds prices from price-tracker sites to the writer (RAN, E3c).** The output rules then catch them.
- **N-9. Earlier N7 is not addressed.** A report upload is still read up to the general body limit before the 2 MB check.
- **N-10. Property Predator sanitiser (`backend/services/blog_content.py:206`): nothing in this branch depends on it with the switch off.** With the switch off no product article can be created, and the affiliate HTML and page check run only when a body has product links (RAN). With the switch on it matters (P2).

## Before and after (my own reproductions, re-run on both trees)

| Finding | 7b5ccf2 | 9d709f5b |
|---|---|---|
| M1 approval skipped | Remove links, flag off, rewrite → published, `auto_unflagged` (E1b) | Flag change refused; held `missing_approval`; nothing on the site. My edit, part rewrite, rewrite, title, picture words, link removal, old-version press, forged approval for an old version or old hash, and edit after publication: all held (A1–A3). FIXED |
| M2 non-signed-in business | Results and Settings 404 | 200, same as switch off (PG and test). FIXED |
| M3 pasted tag adopted | Saved `stranger-21` | Refused until typed; typed ID named; pasted tag replaced and said (E7a, test). FIXED |
| M4 price etc. outside body | Approved with £ and stars in title and description | 11 critical issues; write-time retry, then not saved (E2a, E3a). FIXED, but see S-b |
| M5 research on Amazon | Fetched 5 Amazon hosts; cited `m.amazon` with stranger's tag | 0 fetched, 0 cited; tags removed (E3c). FIXED (S-f) |
| M6 label before click | None in title or teaser; "may earn" | "Ad: " on title, `og`, description, teaser, WordPress and content payloads; "We earn" (E6b, test). FIXED |
| M7 no after-publish check | None | Check, alert and block built (E6c, A4). PARTLY: P2 dead end; the first page still goes out unmarked |
| S1 approved then details changed | Published with old tag | Approval taken back and held (test). PARTLY: not atomic (S-a) |
| S2 social drafts | Pack plus 6-post campaign plus model-naming Activity line | None (E6a, E7b). FIXED |
| S3 typed shop links | 7 encodings approved | All refused (E2b). FIXED |
| S4 Results numbers | Others' IDs as own; hidden cell summed; totals doubled; "1,50" = £150 | Own row headline or "all tracking IDs in this file"; "Not shown by Amazon"; totals skipped; "1,50" and "(-1.50)" refused (E4). PARTLY: unquoted extra cell (S-c) |
| S5 research spend | 0 recorded; bought again | 2 recorded; rewrite buys 0; one Activity line (E3d). FIXED |
| S6 strict setting | Product written with 0 sources | Refused at request, or held on thin research (E3f, test). FIXED |
| S7 names change errors | 4 of 98 sentences changed | 0 changed (E5). FIXED |
| S8 double add | "Already sent with different details" | "That product was already added." (test). FIXED |
| S9 invisible name | Accepted | Refused at route and store (test). FIXED |
| S10 expired form | Landed on not found | Back to Settings (test). FIXED |
| S11 part rewrite | No product rules | Rules and kept heading (E2e). FIXED |
| S12 narrow wording list | 14 of 15 passed | 0 passed (E2c). FIXED (S-b) |
| N2 live links in portal and HTML copy | 3 live | Words only (E2d, test). FIXED |
| N3 duplicate part id | Link twice | Once (E2e). FIXED |
| N4 same product twice | Accepted | Refused (test). FIXED |
| N5 future month or same file | Accepted | Future refused; twin needs a tick (test). FIXED (S-e) |
| N6 `'=1`, `＝1+1` IDs | Accepted | Refused; UK `-21` only (E4, test). FIXED |
| N8 Topics shows product plan | Yes | Hidden (golden diff, test). FIXED |

## Merge with the foundation (`cda1d9dc`)

`git merge-tree --write-tree 9d709f5b cda1d9dc` reports 2 conflicts.

1. **`orchestrator/src/seo-blog/engine-stamp.ts`, `EngineGap`.** Take the union:
   ```ts
   export type EngineGap = 'research' | 'numbers' | 'numbers_unknown' | 'numbers_off' | 'numbers_allowance' | 'thin_research' | 'method' | 'planned_without_numbers' | 'product_research' | 'thin_product_research';
   ```
   `ENGINE_GAP_MESSAGE` auto-merged with both sets of keys.
2. **`orchestrator/src/seo-blog/types.ts`, `TopicPlan`.** Keep the foundation's documented `keywordPlanning` (with `unfit?`/`withdrawn?`) and add the branch's field after it:
   ```ts
   /** A product article's plan only: when its research ran, even if it found nothing (so it is never bought again). */
   readonly productResearchAt?: IsoInstant;
   ```

**Checked after merging (RAN):**
- `engine.ts` auto-merged. The strict "planned without numbers" hold still exempts product briefs (`!brief.products`, merged line 1639).
- `tsc --noEmit` exits 0.
- Switches off: affiliate-amazon-tracking-report, affiliate-fixes, affiliate-isolation, affiliate-programmes, affiliate-screens, affiliate-stores, seo-blog-engine, seo-blog-engine-strict, seo-blog-engine-strict-fixes, seo-blog-engine-strict-autopilot, seo-blog-seo-panel, seo-blog-portal, seo-blog-article-page, seo-blog-wordpress and content-area-shell: 181 of 181 pass.
- Switches on: affiliate-* plus panel and portal: 105 of 105 pass.

## Plain-English and client-visible wording (RAN: Playwright at 390 and 1280 px on 16 rendered screens, plus a banned-word scan)

- **No supplier, model or method names** on any new screen, error or Activity line. The scan's only hit was "nan" inside "tenancy", a false positive.
- **Messages are clear and specific:** "Type your Amazon UK tracking ID (it ends in -21). We never take it from a link you paste…", "Product added. Its link uses your tracking ID “harbour-21”…", and "An article about products always waits for your approval."
- **Jargon:** "paid-link marking" in the alert is the only phrase a child might not follow. "Ask whoever looks after your website" is a dead end when the business has nobody (P2).

## What I could not verify

- WordPress end to end: no WordPress here, so I read `wp_kses_post` only.
- A real Amazon UK report export.
- Production data: whether any affiliate-bearing rows exist (they should not).
- A real writing model or search supplier.
- The full suite: not run, as briefed.
- The database screen script (`db2`): it was not re-run after the restart, so idempotent add on real PostgreSQL rests on the in-memory test plus my reading of the SQL replay logic in `0158_affiliate_studio.sql:238-246`.