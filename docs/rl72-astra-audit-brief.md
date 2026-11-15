# RL72 Media Engine — Astra / Codex adversarial review

**Review target:** https://github.com/Martoon196/relaunch72/pull/108
**Canonical base:** codex/relaunch72-platform-foundation
**Legacy reference ONLY:** PR #107. Do not merge legacy portal code unchanged.
**Disposition:** DRAFT. No production deployment, publishing, AI-provider spending or subscriptions authorised.

## Mission

Perform deep, line-by-line, high-effort review of the complete RL72 AI Media Engine that must power two storefronts: existing Relaunch72 marketing platform AND standalone affiliate/Amazon creator product. Investigate real code and actual deploy wiring, not only PR descriptions. Do not create a second tenant database or competing Creative Studio. Preserve existing CRM, Brand Brain, video, media, Zernio/social, billing, RLS, approval and product profile capabilities.

## Security and reliability examination

- **Migration 0156:** apply all migrations on disposable PostgreSQL 18. Audit forced RLS, definer role attributes, grants, SQL execute surface, immutable history, input validation, idempotent command digest, revision conflict, replay after session expiry and cross-workspace access.
- **Owner/session checks:** enforce selected workspace and genuine active owner session at the SQL boundary. Simulate forged tenant IDs, stolen/expired tokens, removed memberships, CSRF failures, unsafe role grants, malicious affiliate destinations and concurrent updates.
- **Providers:** inspect current Vizard and Shotstack API documentation. Validate Vizard create/query codes, temporary seven-day clip URLs, Shotstack render IDs and credits, unknown outcomes, provider timeouts/429, source duration/format/size restrictions and server-only keys.
- **Paid generation:** no API call without persistent atomic workspace-authorized cost reservation, exact reviewed payload digest, global kill switch and owner consent. Default spending zero. Test worker crash/retry, duplicate webhooks, debit/refund, rate limits, overages, uncertainty and tenant quotas.
- **Source/rights:** no third-party YouTube clipping without rights evidence; no assumption a URL implies permission. Verify upload MIME/size/hash/duration, private media blob ownership, signed URL expiry, SSRF/DNS/IP guards, controlled provider destination and user deletion.
- **Visual editor:** real embedded white-label timeline, preview, trim/split, track editing, titles, transitions, captions, audio, multi-aspect, undo/redo, save/reload, browser accessibility. Check Shotstack SDK commercial/resale licence. JSON text fields are NOT the promised editor.
- **Creative quality:** no hallucinated product specs, safety claims, testimonials, prices, merchant eligibility or earnings. Use Brand Brain, actual evidence, explicit ad/Amazon statements, synthetic-media and platform rules. Editing invalidates approval.
- **Publishing:** reuse established RL72/Zernio rails, proper OAuth separation and selected social accounts, explicit approved exact-version publication, deduplication, cancellation, retries, audit receipts, pause-all and no spam.
- **Commerce:** proposed versus merchant-accepted Special Links; site/account eligibility and disclosures; no forbidden Amazon content scraping. Separately label real outbound clicks, actual merchant-reported orders/commissions and estimates. Never invent an order from a click.
- **Standalone:** shared backend but separate product presentation, onboarding, subscription, entitlements, usage credits, brand pages, analytics and customer support. Never mark incomplete features as available.
- **Threat model:** cross-tenant IDs, XSS, CSRF, open redirects, webhook signature replay, path traversal, signed blob leaks, DNS rebinding, upload bombs, overspend, secrets in logs and runaway background workers.
- **CI and UX:** exact HEAD SHA, compile, full unit/regression, disposable PG integration, browser tests and real editor tests. Validate responsive mobile experience, user error recovery and product workflows.

## Required review output

Severity-ranked findings with code file/line, reproduction, exploit or failure path, fixes and tests. Clearly mark implemented-but-unwired, mocked, production-ready, and blocked. Fix self-contained failures on a review PR, but DO NOT merge, deploy, publish or spend. Record exact CI IDs and migrations actually verified. Reuse the native Creative Studio, avoid parallel systems.

## Release gate

Never claim the product is done until an authorised full journey passes: product and rights approved -> source or AI creation -> clips and editable timeline -> actual render -> fresh owner approval -> social schedule/publish with receipt -> tracked outbound affiliate link -> merchant-confirmed earnings -> accurate credits and billing. Operator/API keys, SDK licensing and real external payment/publication steps require explicit human action.


## Canonical media hardening review — 15 November additional implementation

Please audit exact changes introduced by commits `2bc073d5` through `899abb4a` on draft PR #108, not old PR #107. Review the following code paths and try to prove a counterexample:

- `orchestrator/src/creative-studio/media-work-executor.ts`: verify that a failed/lost database receipt, provider timeout or stale claimed job never results in a second external paid call; check the distinction between local validation failures and network failures.
- `orchestrator/src/db/migrations/0158_creative_media_video_jobs.sql`: check SQL owner-session validation, zero-default caps, immutable approved exact request bytes, digest binding, single-use worker leases, terminal unknown state and failure to settle above the reservation.
- `orchestrator/src/creative-studio/media-providers.ts` and `media-admission-pg-store.ts`: ensure no provider secret reaches public HTML, no caller-controlled payload can replace the approved SQL snapshot, and the provider cannot be invoked with another tenant's lease or command.
- `orchestrator/src/db/migrations/0159_creative_media_source_videos.sql`: try direct table access as `r72_content_command` and another workspace owner, SQL function misuse, binary/metadata spoofing, concurrent same-command replays, unauthorised blob insertion and forged rights evidence.
- `orchestrator/src/portal/seo-blog-router.ts`, `creative-media-video-sources-view.ts`, `media-video-source-pg-store.ts`: check CSRF, multipart limit and parsing, filename sanitisation, content sniffing, HTML escaping, owner session expiry, disabled feature gate and error responses.
- **Deliberately unresolved:** real AV decoding and source rights, 20 MB upload ceiling, protected worker scheduler, permanent output capture and reconciliation, global cost caps, authentic merchant/programme approval, licensed video editor, tenant billing, auto-publishing constraints and live E2E tests. Do not approve merger on mock provider contracts or green CI alone.

CI proof for current implementation: https://github.com/Martoon196/relaunch72/actions/runs/43754549564 (exact head `899abb4a`; disposable local PG, no paid providers).
