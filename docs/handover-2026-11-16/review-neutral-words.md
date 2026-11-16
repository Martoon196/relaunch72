# Review: claude/neutral-words @ 1086915 (base 46dedb7)

## Verdict: SHIP AFTER FIXES

The rule "only words and who can see detail change" holds in the code, and tsc and the tests are green. But clients can still see supplier and internal words on five surfaces the builder's test never reaches, and the dictionary now tells owners (and the founder) untrue things in three cases.

Worktree left untouched. My scripts and output are in `/tmp/claude-0/-home-user/437a5277-f9bf-563b-9330-1386174fa1df/scratchpad/review-neutral/` (`crawl.mts`, `scan.mjs`, `repro2.mts`–`repro5.mts`, `words.mts`, `golden.mjs`).

## What I ran
- **Crawl:** my own link-and-form crawl through the real router as a non-founder owner, both looks, about 900 responses. It covered 400/403/404/405/503 bodies, redirects with decoded notices, JSON endpoints, exports, article preview, the served JS files and all response headers.
- **Term list:** my own 417 terms, pack ids and product names read from `orchestrator/method-packs` and `docs/relaunch72-rule-packs`.
- **Not crawled:** creative studio and campaign creator routes were not wired in my fixture. I checked those by source scan and direct renders instead.
- **Tests:** tsc exit 0. Targeted files (neutral-words, shell, portal, article-page, allowance, creative-studio and others) 208/208. One full suite with `CONTENT_AREA_PREVIEW=enabled`: 5166 tests, 5051 pass, 0 fail, 115 skipped.

## Leaks the builder's test misses (both looks, client view)

1. **SHOULD-FIX: Social page names the social posting supplier.** `GET /b/:id/social` prints `discovery.detail` raw (`seo-blog-view.ts` ~l.446–455).
   - With the real `createSocialProviderInventory` returning no linked profile, the client reads: "No provider profile is explicitly linked to this brand. In Zernio, set its externalId to this brand workspace ID…".
   - When discovery fails: "Provider accounts could not be verified…".
   - The builder's fixture used `social: 'unavailable'`, so this state was never rendered. Zernio is on the builder's own banned list.

2. **SHOULD-FIX: Article campaign page and its status JSON print image task text raw.**
   - `GET /b/:id/articles/:id/campaign`, "Advanced task details" (`seo-blog-campaign-view.ts:67`), and `GET /b/:id/image/status` (`engine.ts:2936`, sent unmapped at `seo-blog-router.ts:316`).
   - Real stored strings from `image-worker.ts:10,21` reach the client: "Image generation is not configured. No provider call was made." and "The image provider did not return an accepted candidate…".
   - `campaign-image-status.js` also writes that JSON `detail` into the page.
   - The builder's image-status check used a random job id, so it only saw a 404.

3. **SHOULD-FIX: Error pages bypass the dictionary.** Any refusal on a GET, or with status 500 or above, is printed as-is (`seo-blog-router.ts` catch block, l.541–556).
   - Reproduced with a stubbed engine throwing the real messages: 503 page shows "The provider is temporarily unavailable." (`seo-blog-social-pg.ts:40,208`). A 5xx POST refusal carrying "DataForSEO HTTP 503" is shown verbatim.
   - Other real candidates: "The provider callback is invalid." and "The provider callback could not be recorded." (`seo-blog-social-pg.ts:215–224`).

4. **SHOULD-FIX: Creative studio wording.**
   - Brief page figcaption "· provider usage not reported" (`creative-generation-view.ts:87`), reproduced by rendering `briefPage` with a generation that has no usage. The builder's scene had `generations: []`.
   - Set page ladder: stage label "Provider accepted" (`distribution.ts:55`) and evidence "No provider receipt yet." / "The provider attempt failed (…)" / "…recorded by the provider receipt." (`distribution.ts:95–110`). These are printed raw at `creative-studio-view.ts:222`. I ran `postLadder` for the strings; the page render is by source reading.

5. **NOTE: Raw engine text travels in the redirect URL.** `POST /generate` refused gives `Location: …/topics?e=<base64url>`, which decodes to "…remaining 0 model tokens. Action estimate 32,000…". The page shows neutral words, but the address bar holds the raw text. This would carry the Zernio messages too. Fix by mapping before signing.

6. **NOTE: markup and softer wording.**
   - Form names and ids: `name="modelTokens"`, `id="token-budget-guide"`, `name="providerProfileId"`, `name="providerAccountId"`.
   - "Model-written copy is checked…" (`creative-studio-view.ts:73`).
   - "A logo is never drawn by a model." (`brand-context.ts:78`).
   - The dictionary is a blacklist: `max_tokens`, `stop_reason` and `request_id` pass through. No current engine path stores them, because unknown errors are already made generic at `engine.ts:3066`.

Clean on my list: every other crawled page, the article preview and both exports, post exports, all seven JS files, all headers and Set-Cookie, and the 400/403/404/405 bodies.

## Untrue or unhelpful: the three worst

1. **SHOULD-FIX (the most damaging): the dictionary rewrites the owner's own words.** Activity lines and page notices carry business names, article titles and URLs, and they all go through `ownerWords`.
   - Through the real route `POST /briefs/:id/omitted`, the Activity line became "“How to choose a building research service” marked omitted." The title was "…building supplier".
   - Using the engine's own message formats: "Brand “Northside Care Provider” created." became "Brand “Northside Care connected service” created."
   - Brands named Opus Kitchens, Token Coffee Roasters, Gemini Lettings or Prompt Plumbing, and "Published and verified at …/claude-monet-prints… (version 2)", each became "Something stopped this task before it finished. Nothing was published. You can try again from Activity." That is a success shown as a failure.
   - The comment in `owner-words.ts` that ordinary titles and names pass is false. Fix: apply the dictionary only to error and progress text, not to success lines or quoted owner text.

2. **SHOULD-FIX: exhausted research retries read as "we will retry".**
   - The engine stores "…The bounded retry allowance or search ceiling is exhausted. Explicit owner resume is required." (`engine.ts:1108`, hold `retries_exhausted`, category still `transient`).
   - Topics, Overview and Activity now say "The research service had a temporary problem. We try again automatically, at most twice, within your research allowance." under the heading "Research needs your attention". Nothing will retry.
   - On base, Activity said the truthful sentence.

3. **SHOULD-FIX: real instructions collapse into the generic stop.**
   - Founder: after `POST /methods/update` or `/disable` (303, saved), the page shows "Something stopped this task before it finished…" in place of "Production pack choices saved for this brand." There is no Technical detail on notices.
   - "Register the brand’s Zernio profile first." and "Enter the 24-character account id from Zernio." become the same generic sentence, with the wrong next step ("try again from Activity").
   - A website check result "<label>: The token can read the repository but cannot write to it." (`github-static.ts:116`) becomes the generic stop. That hides a real "fix your website connection".

**Arithmetic is correct.** `floor((ceiling − used) / 32,000)` matches `requireBudget` (`used + estimate > ceiling` refuses).

| Case | Result |
|---|---|
| Unlimited | "There is no monthly limit on writing." |
| Ceiling 0 | "No writing allowance is set yet…" |
| Exactly 32,000 left | "about 1 more article" |
| 31,999 left | "not enough left this month for another article" |
| Over-used | 0 |
| 2,000,000 fresh | 62 |
| 412,000 used of 2,000,000 | 49 |

Two small points: Publishing says "7,200 writing units (about 0 articles’ worth)" because it rounds; and the count ignores plans (40,000 each) and posts sharing the same allowance, though the page does say "an estimate".

## Behaviour unchanged

- **Confirmed:** no engine, store, publisher, approval or billing file is in the diff. The `programme.ts` and `generation-service.ts` changes are display strings only, and nothing matches on them. Stored records keep raw text.
- **Production rules for a non-founder:** GET and POST (`/methods`, `/update`, `/disable`, `/activate`) return the same 404 as a missing route, with identical status and headers and the same body once the path is normalised, in both looks. The only header difference is `content-length`, from the path length in the new-look body. The founder gets 200.
- **Links:** no client page links to `/methods` (the nav and the campaign-creators link are both gated).
- **NOTE: permission change with a consequence.** On base any owner could switch packs (the old `rl72-upgrade` test did so as a plain owner). Now a client whose email or request-kit pack is off sees "…switched off" with no way to turn it on and no hint who to ask.

**What the founder lost:**
- Success and refusal notices are neutralised with no Technical detail. The budget refusal no longer shows used, ceiling and shortfall anywhere on the page, and the Production rules save reads as a failure (above).
- The Topics table shows "(measured, Oct 2026)" in place of the supplier id and exact date.
- The profile and creative status JSON carry only the neutral sentence.

## Founder check
- Founder = `limits.allowed()`, which calls `app_private.seo_limits_command(…, 'allowed')` with the session hash on every request (`seo-blog-limits-service.ts:45`). It is the same check that guards Usage and limits, and is unchanged.
- `technicalDetail` needs `limitsAvailable === true` strictly. Query parameters (`?founder=1`, `?limitsAvailable=true`, `?technical=1`), cookies and an `x-founder` header had no effect. The error-page shell never carries it.
- NOTE: if that database function is missing, `allowed()` is false and the founder also loses Production rules.

## Golden re-record
Decoded both files: 245 entries each, same keys, 26 differ.
- The 14 scenario overview/root entries, plus the engine and after-posts overview, topics and social: identical tag skeleton, forms and links. Text only.
- Setup: one `<p>` merged.
- Publishing: the pricing link and its paragraph removed, one `<small>` added. Form controls are identical.
- Methods (2 entries): 200 → 404 not-found body.
- No form, hidden-field or route change otherwise.

## Smallest fix list
1. Stop the dictionary touching owner text and success notices (titles, business names, URLs; "Production pack choices saved").
2. Give the `retries_exhausted` hold its own true sentence.
3. Pass `discovery.detail`, the campaign page's image task detail, the `image/status` JSON and the error-page message through the dictionary. Also change "provider usage not reported", "Provider accepted" and the ladder evidence strings.
4. Decide how Zernio is handled for clients: either the page keeps naming it for clients who use their own dashboard, or the instructions get real neutral wording. Today it leaks in one place and is blanked in another.
5. Extend the test fixture to cover: social live with no profile, an image job on the article, a generation without usage, a handed-off creative set, a 5xx refusal, and a brand or title containing "supplier", "provider" or "token".