## Affiliate Studio fix round: report

All of the briefed items are done, and the foundation is merged in. The full test suite passes with the switches off and again with `CONTENT_AREA_PREVIEW=enabled`. With `AFFILIATE_STUDIO` unset, the 129-entry scenario matches the foundation exactly. Each fix has its own commit, and every commit is pushed.

**Head:** `3d6d4fe44f1452ed156af1ec907ec136d733b5b5` on `origin/claude/affiliate-fixes` (confirmed with `ls-remote`). Base was `9d709f5b`. No pull request, no merge into the foundation, no deploy, no `mcp__*` tool, no supplier, model or Amazon call.

### Step 1: merge (`db9cfee9`)
Merged foundation `cda1d9dc` with `--no-ff`. The two conflicts were resolved exactly as the review says:
- `engine-stamp.ts` `EngineGap`: the union of both sides.
- `types.ts` `TopicPlan`: the foundation's documented `keywordPlanning` (with `unfit?`/`withdrawn?`), then this branch's `productResearchAt`.

`tsc` exits 0. Tests: 152/152 with the switches off and 105/105 with them on (affiliate plus seo-blog engine/strict/panel/portal files).

### Step 2: what changed
Every new test is in `orchestrator/test/affiliate-fixes.test.ts`. Each one was run against the source with the fix taken out and failed there, then passed with it.

| Item | Commit | Where | Change | Test |
|---|---|---|---|---|
| **P1** | `fab4e4d9` | `affiliate/article.ts:303,312`; `engine.ts:2719,2726,2917,3033` | A version with product links is held at the publish gate (both dispatch and resend) when its page's host is not `affiliate.registeredSite`. Scheduling and Approve-and-publish refuse up front. The reason names both websites. | "P1: an article with product links goes only…" |
| **P1 follow-up** | `fbefe217` | `article.ts` `linkStatus` | If the Amazon website changes, an article's existing links count as changed. Without this, an old version could be approved again and still pass the gate on the old website. | "P1: after the Amazon website is changed…" |
| **P2** | `ffc43feb` | `engine.ts:3226,3516`; `page-check.ts` | The "paused for this website" block only applies to versions that still have links, so a link-free version publishes over the failed page. The alert, block, not-checked text and delivery note are reworded in plain English. They tell the owner they can fix it alone, and say what to ask a website person if they have one (with `rel="sponsored nofollow"` spelled out for that person). "Paid-link marking" and "whoever looks after" are gone. | "P2…"; the M7 test's expected opening was updated to the new wording |
| **S-a** | `7cae99b8` | `affiliate-routes.ts:105-123,172-180`; `engine.ts:2689` | Approvals are taken back before the save, then again after it, checked against what is stored. A replayed or stale form whose details are already saved counts as saved: no "changed somewhere else". Retire works the same way. Activity now only logs an approval that was actually taken back. | "S-a…" (three cases) |
| **S-b** | `0dfa2198` | `article.ts:157-205` plus the product-name rule | Price words required near "only/from + d.dd"; "Save N% of your…" is not a discount; "N out of 5" only counts next to rating words; energy/hygiene/hotel star ratings are allowed; "free returns are not…" is allowed. "We tested/reviewed/checked" only counts when followed by it/them/a count/"the products" or a word from a product's name; checking against manuals or advice is allowed. | "S-b" (unit and engine) |
| **S-c** | `ba7b7ab8` | `amazon-tracking-report.ts:63,168` | A row with filled cells beyond the header is refused with a plain message. Empty trailing cells are still read. | "S-c" |
| **S-d** | `3d6d4fe4` | `affiliate-views.ts:22,154+` | Pills, tick and radio labels, "Stop using", form buttons and "Open Products" are at least 44px. The pills now carry their own style, because the Articles list had them unstyled at 20px. | "S-d" (static CSS assertions) |
| **S-e** | `405d3146` | `affiliate-views.ts:134,139`; `affiliate-routes.ts:222` | The "same figures" tick only appears on the page reached through that specific refusal. | Updated "N5 and N6" |
| **S-f** | `5cc5abcd` | `safe-fetch.ts:48,141`; `research.ts:305` | New `FetchOptions.allowUrl`, checked before every hop; research passes its exclusion through it. | "S-f" (production transport with its single-request step stubbed) |
| **N-5** | `ac336850` | `affiliate/render.ts:31,40` | When "Ad: " pushes the served description past 160 characters, it is cut at a word and ends with "…". The stored text is unchanged. | "N-5" |
| **N-6** | `faf232e3` | `affiliate-views.ts:98` | The card now says saving a new tracking ID or website takes back approvals and what to do next. | "N-6" |
| **N-9** | `f2ada9d7` | `seo-blog-router.ts:266` | Report uploads, only when they would reach the affiliate routes, are read with a 2 MB + 64 KB cap and refused with the size message. | "N-9" (a 15 MB upload now stops below 2.3 MB; it was read in full before) |
| **Mutation gaps** | `298b843d` | tests only | M04, M06 and M07 each have their own test. | "M04", "M06", "M07" |

### Before and after with the reviewer's scripts
Outputs are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review2-affiliate/out/`.
- **A4 (P1), `a4-pagecheck.after.out`:** scheduling to bay.example is now refused, naming both sites. Before, it published 3 unmarked links there.
- **A4 on the registered site (P2):** the original A4 now stops at P1, so I made a variant, `scripts/a4b-pagecheck-registered.mts`.
  - Before (`a4b-pagecheck.before.out`): "Held … live page still has product links: 3".
  - After (`a4b-pagecheck.after.out`): "Published … 0".
- **A6 (S-a), `a1-attacks.after.out`:**
  - Before: the resent form said "changed somewhere else" and the article published with `tag=harbour-21`.
  - After: the resent form is accepted ("1 approved article … waits") and the article is held `missing_approval` with nothing on the site.
- **`fp.mts` (S-b):** all 9 sentences on the review's list now pass (`fp.before.out` vs `fp.after.out`). "Best seller" and "Rated 5/5" are still caught on purpose.
- **E4 (S-c), `e4-report.after.out`:** the only changed line is unquoted "1,50": it was read as 100 pence and is now refused. No slow shapes.
- **Playwright walk (S-d), 16 screens at 390 and 1280 px:**
  - Every affiliate screen now has 0 small targets; before, there were up to 14.
  - No horizontal scroll anywhere.
  - The remaining small targets are shared foundation controls on Settings and the article page. I left them alone so pages with the switch off stay identical.
  - Screenshots: `out/shots-after/` (with `walk.json`); before is `out/shots-before-sd/`; summary in `out/walk-after.txt`.
- **Mutation run (`mutate.py`, all 25 mutants):** all 25 caught. M16's original target line no longer exists after the S-a rewrite, so I ran the equivalent mutant by hand: it failed 3 tests.

### Must stay true
- **Switch off:** I re-ran the 129-entry `g2-off.mts` scenario on `cda1d9dc` and on head. The only differences are 3 `websiteSnapshot.requestSha` values, and two runs of the foundation alone differ in the same 3. Everything else is identical. Files: `out/g2-off.r3-found.json`, `r3-found2.json`, `r3-head.json`.
- **Migrations:** `git diff cda1d9dc HEAD -- orchestrator/src/db` is empty.
- **No supplier, model or method names in client-facing text:** the walk's word scan only hits "nan" inside "tenancy", as before.

### Test totals
- `npm run typecheck`: exits 0.
- Full suite, switches off: 5,420 tests, 5,299 pass, 0 fail, 121 skipped. Log: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/affiliate-r3-full-plain.log`
- Full suite, `CONTENT_AREA_PREVIEW=enabled`: 5,420 tests, 5,299 pass, 0 fail, 121 skipped. Log: `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/affiliate-r3-full-preview.log`
- All 121 skips need PostgreSQL integration or a disposable database: 105 run only through `test:db:integration`, plus creative-studio, a seo-blog database and an HQ proof configuration. I started no Postgres, so none is left running. The temporary worktree is removed.

### Skipped, verified vs assumed, and limits
- **Nothing on the list was skipped.**
- **Verified only with in-memory doubles:**
  - Real PostgreSQL: the S-a path relies on PostgreSQL treating a stale or replayed save the same way as the test double. I read the SQL replay and stale branches but did not run them.
  - A real WordPress site.
  - A real Amazon report file.
- **One DNS lookup on the "before" run:** S-f's test on the old code tried to resolve www.amazon.co.uk, and the sandbox refused. No HTTP request was sent; the fixed code never looks it up.
- **Existing problem, not fixed (for the backlog):**
  - The product store never rebuilds a product's saved link when the tracking ID changes; `saveSettings` in migration 0158 does not touch products.
  - So after a tracking-ID change, "Update the links" will drop every link until the products are added again.
  - Fixing it means a migration or a design change, both outside this round.
- **Behaviour change to accept:** P2 leaves articles with links blocked on that website even after a link-free republish. Only a product page that passes the check can unblock it, so once the old page is overwritten, publishing a page with links there again needs a manual step or a design decision.

### What a reviewer should attack first
1. **The S-a ordering.** Approvals are taken back before saving with the typed details. What happens when the save is then refused for another reason (they end up taken back needlessly), and what about the `alreadySaved` match on `siteHost` comparison?
2. **P1's host rule.** It is exact apart from `www.`, so a `blog.` subdomain is held. Also check the address it judges for WordPress and website-target versions, and that `linkStatus` now marks every link changed when the website changes.
3. **P2's narrowed block.** Look at the race between the version read before the lock and the locked version (the block is read once and applied using the locked version's links).
4. **S-b's new patterns.** Product-name words come from section headings, so an unusual heading broadens what counts as a testing claim; sentence-window edge cases are worth probing.
5. **N-9's condition** for when the smaller cap applies.