# Central Relaunch72 content application

Task R72-CONTENT-CENTRAL-001; base213cd8e067b9e968f30ee24f7fa0a8691e3fda11. Root owns DNS, production configuration and release; this source lane has no production effects.

## Host and identity contract

`R72_CONTENT_ENABLED=true` and `R72_CONTENT_ORIGIN=https://app.relaunch72.com` add a dedicated exact-Host mount to the existing HQ process. Forwarded host headers never select it. Unknown routes terminate in the mount. The separate payments deployment, global PP product profile/base URL and production guard remain unchanged.

Reuse canonical PostgreSQL password/setup/session services. Use request-local Relaunch72 presentation, `__Host-r72_content` session cookie and a distinct host-only login-CSRF cookie. Both are Secure, HttpOnly, Path=/ and carry no Domain. Derive a domain-separated central CSRF secret from the existing session secret without modifying environment state. Require a current managing canonical membership before SEO delegation, including its early-return route; deny non-managers without creating a brand or invoking the engine. Root and `/portal` open Brands. Only central native authentication, SEO routes/assets, linked content/calendar and readiness are eligible.

## Editorial and social contract

The existing bounded daily worker continues autonomous planning/accepted-plan writing. The editorial diary includes unscheduled generated articles on their brief's proposed date, labelled awaiting review; this creates no external publication schedule. Publication approval, policy, website connection, missed-slot and exact-version checks stay intact.

Each immutable article version carries automatically derived platform-specific promotion proposals with exact brand/article/version/hash/profile provenance. Workers do not impersonate an owner to call canonical company-content commands. A genuine owner Approve promotion action materialises and approves canonical `social_post` versions with source system `relaunch72.seo-blog`; new article or URL bindings create new versions and stale only linked prior approvals. No manual import chore is part of the intended product. No promotion can dispatch before a verified current public article URL exists. Keep social scheduling and website publication separate.

Generic social account binding and dispatch must resolve the selected brand's actual connected account and preserve existing exact approval/provider/cap boundaries. PP startup defaults are never inherited by a new brand. Any missing connection is a truthful hold, not a claim that a prepared draft was scheduled or published. Astra reviews the bounded extension separately; the task is not complete merely because proposals exist.

## Allowed source areas and checks

Minimal server app/index host composition; new central mount; portal cookie/CSRF/profile seams; existing SEO view/router/engine/storage JSON extension; generic canonical social adapter and calendar facade; focused tests and configuration docs. Migration0131, checkout, CRM, courses, email/calls and unrelated provider architecture are excluded. Present any unavoidable additive SQL design to Astra before implementation.

Focused checks cover raw-host spoof/forwarded-host, native cookies/login-CSRF/origin/owner denial, unchanged PP/MHP handling, two newly created brand workspaces, autonomous draft/proposed-date display, linked draft idempotency and staleness, unavailable blog URL and foreign account holds. Root owns the one final integrated Linux gate and live acceptance; no public test article/social post follows from this implementation.

## Implementation checkpoint — unfinished; do not deploy

Central host routing, distinct native login/session/CSRF and pre-SEO manager guard are implemented. `/` and `/portal` redirect to Brands. The editorial calendar displays generated unscheduled drafts on suggested brief dates and can move those suggestions without scheduling publication. Article versions automatically receive two brand-grounded model social proposals; stage failures produce a visibly labelled excerpt fallback, with no image-generation claim.

The canonical promotion command builder, review UI and PostgreSQL adapter are scaffolding, **not a working end-to-end approval/dispatch journey**. The runner currently references the not-yet-written132 `r72_content_assert_article_promotion` capability. Its initial attestation currently uses the article creation time; this must be replaced with a real owner observation while retaining replay-safe exact input, before any database use. Shared canonical idempotency/validator semantics have not been changed. Automatic approval review rejected a proposed shared timestamp-idempotency relaxation; retain that boundary and implement a separate source/job-bound solution.

No0132 migration exists at this checkpoint. Astra ratified its bounded design, and Root confirmed production ends at exact0131 (`904c4651c51da6507370ca7eb2f271ca0347a27d76c60b0f24a19aba01695784`). Required remaining work: own-brand Zernio profile/connection/verified account registration; zero/off owner-configured caps and trusted worker registry discovery; genuine-session target-brand canonical review; narrow SEO source planning compatibility; enqueue and final-call/resend parent guards; delayed-job exact-source JIT attestation; separate social calendar; existing-worker iteration retaining the old PP binding path.

Existing0097 embeds `daily=1;monthly=3` in immutable enqueue/effect hashes. Generic caps require a registry-only hash/policy branch, preserving the PP branch and rechecking current lower/zero limits at effect time. Existing0101 planning admits only the two PP source systems; add a narrow exact-parent SEO branch. Existing source-attestor accepts only the PP source/origin: do not relabel SEO or extend expiry. Instagram needs a real approved image; LinkedIn text must be independently eligible.

Before production SQL: freeze exact132 checksum; build/test a213-based131→132 checksum bridge with no132 bundled; roll it across all active strict schema consumers; retain it for recovery. Final132 application returns to normal strict matching. Never rewrite0131 or down-migrate.

Native central sign-in reuses existing PostgreSQL passwords. A founder with only PP SSO must first complete native password setup through the existing private founder reissue procedure at the HQ origin, then sign in centrally. Central `/portal/setup` can consume a genuine setup token, but no new token-issuance/email transport is implemented or claimed.

Verification at this checkpoint: central host/auth focused tests4 passed/0 failed/0 skipped; automatic promotions/proposed calendar/provenance/edited-parent tests3 passed/0 failed/0 skipped. These are offline synthetic tests and establish no real HTTP/database/provider acceptance. Full TypeScript compiler attempts were interrupted after remaining without output; there is no compiler-pass receipt. No full suite, database test, provider call, publication or deployment ran in this source lane.
