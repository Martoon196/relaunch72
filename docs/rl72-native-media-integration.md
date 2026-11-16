# Native RL72 affiliate media — canonical Growth HQ integration

**Status (2026-11-15):** A small, real integration milestone submitted for review. Not deployed or sellable; no provider, merchant, publishing or payment call was made.

## Canonical architecture

The foundation is `codex/relaunch72-platform-foundation`. It already includes the multi-brand **Creative Studio** (image generation from approved assets, local rendering, video storyboards, exact-version approval and hand-off), the private asset library, PostgreSQL workspace/session enforcement, a brand kit carrying disclosures, and existing content/social/CRM rails.

The older media prototype, [PR #107](https://github.com/Martoon196/relaunch72/pull/107), targets the legacy portal and writes per-tenant JSON files. Its Vizard/Shotstack providers, scripts and signed click tracking are reusable *design references* but not a production storage, auth or scheduling subsystem. **Do not merge #107 unchanged.**

This branch adds an affiliate-product intake path inside **that existing** Creative Studio form/service. It does not spin up a second `/studio` tenant system:

- Source radio: **An affiliate product** (requires **Product promotion** purpose).
- Merchant/product names supplied by the owner; conservative template copy deliberately contains no invented review, price, return, testing, result or commission.
- Server refuses unconfirmed brand facts, missing #ad in the brand's required rendering disclosure, and missing Amazon Associate earnings wording for the Amazon mode.
- Owner must acknowledge that product details, channel/site eligibility and media rights have been checked. These are **owner attestations**, not externally verified proofs.
- Destination still comes **only** from that brand's confirmed conversion pages. Direct browser-supplied affiliate URL is not accepted.
- Draft is stored and rendered via the **existing** Creative Studio session/PG command boundary, with the same context digest and renderer disclosure. Editing/approval/hand-off follow the same exact-version and no-auto-publish controls; no new migration or provider permission.
- New tests cover false disclosure, attestation, forged destinations and unreviewed content. CI typechecks, checks the Creative Studio regressions and uses disposable PG for real owner-session/tenant boundary proof.

## Deliberate release limitations

An owner attestation is not a licence check. The record stores a generic short brief, not a durable product object or signed eligibility receipt. The UI does not yet provide a catalogue, Amazon special-link validation/issuance, merchant import, tracked outbound redirects, actual order/commission data, import/repurposing of long source videos, Vizard jobs, Shotstack timeline SDK, external renders, or independent standalone checkout. The existing locally-rendered storyboard video is not a replacement for clipping user-owned long videos.

The source mode is a draft-intake convenience; it must **never** be treated as affiliate compliance clearance or publishing authorisation. A subsequent code change must introduce programme- and version-scoped evidence before permitting affiliate links in automatic distribution.

## Next engineering slices (in-place, not a second product)

1. **Durable programme/product/rights records in PG** under the signed-in brand/workspace boundary, with migration, exact owner session guard and true cross-tenant integration tests. Distinguish input provenance, approved destination and merchant special link; version evidence and policy acceptance; connect records to existing `CreativeSet` rather than duplicating the creative library.
2. **Owned/permissioned source ingestion** into the existing private asset store: signed upload, hash/length/MIME verification, source rights and permitted destinations. Do not assume YouTube URL conveys reuse permission.
3. **Queued paid-media reservation** before provider calls: tenant cap, idempotent command/attempt ledger, zero-default kill switch, uncertain-outcome handling and audited manual consent. Only then port Vizard/Shotstack adapters behind the existing worker/approval rails; never do chargeable provider calls in HTTP request handlers.
4. **Editor integration**: approved source asset -> editable timeline -> output asset with digest/version -> render receipt -> exact version approval. License-check Shotstack Studio SDK before embedding or reselling.
5. **Existing social calendar & outbound links** only after explicit owner approval, platform permission and merchant compliance checks. No auto-publish route in this branch.
6. **Standalone SKU** through existing portal billing/provisioning for a different tenant tier; the same engine and database, not a separate file store.
7. **Real analytics**: label click data as clicks only; actual Amazon orders/commission can only come from authorised merchant reporting.

## Acceptance before selling

All CI green on the exact SHA, disposable PG isolation passes, product eligibility and disclosures reviewed for intended geographies and platforms, confirmed direct-owner source rights, provider cap and reconciliation working, editor verified in browser, full render and approval proof, publisher permission checks and recorded real external receipts. A green unit test by itself does **not** demonstrate live AI video, publishing, or affiliate sales.


## 15 November implementation extension

This branch now includes more than the initial affiliate Creative Studio intake.

- Migration 0156: signed-owner PostgreSQL product catalogue, immutable revisions, replay-safe commands and tenant RLS.
- Native Creative Studio -> Manage affiliate products: create and revise private merchant/product proposals and rights assertions. A proposed merchant link is not automatically published.
- One-click Create artwork and video from this product: securely loads the saved product from that workspace and pre-fills the existing approved Creative Studio Product promotion flow. Fresh rights and programme confirmations are required; existing local video storyboards, rendering and exact-version approval are reused.
- Migration 0157: append-only merchant-report imports by signed brand owner, source hash, date range, idempotency and private selected-workspace data.
- Creative Studio -> Import Amazon earnings reports: UTF-8 .txt/.csv upload, report date range, distinct known/unknown earnings, Others/unallocated handling and non-fabricated click totals. Source raw reports are not retained.
- A separate affiliate_studio product presentation profile backed by the same PostgreSQL customer accounts and creative tools (standalone billing/onboarding still needs implementation).
- Disabled-by-default Vizard/Shotstack provider adapters and mock contract tests. They are NOT authorised to charge until durable cost reservations and jobs exist.
- A complete security and product-level Astra audit checklist in docs/rl72-astra-audit-brief.md.

### Feature flags

The private product catalogue is visible with CREATIVE_STUDIO_ENABLED=true and RL72_MEDIA_PRODUCTS_ENABLED=true after migration 0156.

The merchant report importer additionally needs RL72_MEDIA_REPORTS_ENABLED=true after migration 0157. Both new features are off unless explicitly enabled. They do not publish social content, charge video APIs or register merchant affiliate accounts.

### Reporting integrity

The Amazon UK Tracking ID Summary is a user-uploaded merchant report, NOT a verified live Amazon API response. Hide or mark unknown rows as unknown, not zero. Do not allocate Others earnings to a particular product, clip or creative. Do not confuse dispatched-item earnings with collected payouts or clicks with confirmed purchases.

### Not yet a sellable all-in-one creator

Still blocking release: approved live product links and redirects, provider budget reservation/worker claims, owned video ingestion, embedded real editing SDK licensing and implementation, cloud render/output reconciliation, approved publishing through existing Zernio/social rails, standalone onboarding/subscriptions/credits, and E2E browser/live provider proofs. No merge, deployment, public publishing or external spending without operator review.


## 15 November — private source-video intake (migration 0159)

This branch now includes an **owner-session authenticated** `/creative/sources` page in the SAME Creative Studio and existing brand/workspace. The route is gated by both `CREATIVE_STUDIO_ENABLED=true` and `RL72_MEDIA_VIDEO_SOURCES_ENABLED=true` (default off). Enable only after migration 0159 has been reviewed and applied.

- `orchestrator/src/creative-studio/media-video-source-pg-store.ts`: checks owner consent, .mp4/.webm extension and container magic, bounds raw bytes to 1 KB–20 MB, computes SHA256 and sends the exact bytes over the existing content-command transaction.
- `0159_creative_media_source_videos.sql`: stores bytes in **existing** `app.seo_blog_blobs`, records append-only source metadata, requires owner session through `seo_media_owner`, enforces workspace-scoped RLS and SQL-side byte digest and container checks. No second object store or permissive runtime table access.
- The page lists private source digests, MIME and declared rights, but provides no public URL or unchecked outgoing provider request.
- `awaiting_probe` is the **only** source state. Signature matching is not video decoding, duration/fps/audio measurement, licence verification, nor permission to redistribute. No uploader is connected to the Vizard/Shotstack paid worker; a real trusted source-to-provider pipeline and result preservation must come before that.
- CI covers TypeScript, MIME/attestation tests and real disposable PG tests for upload idempotency, blob-digest match, cross-tenant isolation and unprivileged direct-table rejection.

### Next hard blockers (must be built before releasing video product)

1. Source-media probe and permitted-source attestation: trusted decoding of every video stream, duration and dimensions; licence document and permitted destinations validated, server-side review states and an audit trail. Source assertions alone are not programme or copyright clearance.
2. Resumable direct-to-private-object-storage upload for files larger than the existing 20 MB PostgreSQL blob ceiling, with server-side checksum confirmation, media scanning, signed temporary reads, expiry and tenant isolation.
3. Paid worker scheduling that atomically reads the immutable source and edited timeline, reserves cost, claims once and hands exact bytes to providers. The submission runner exists, but no background-dispatch bridge is currently enabled.
4. Provider result reconciliation, durable downloaded clip renders and non-public output artifacts; distinguish provider status, incurred credits, failed/unknown outcomes and retained costs. Avoid auto-retry when a paid outcome is uncertain.
5. Owner-review UI for media version/rights/claim disclosures, exact-version approval and explicit social distribution through canonical Zernio controls. Never translate "stored" or "AI generated" into "approved" or "published".
6. Merchant-authorised special links and verifiable click/commission analytics, plus standalone signup/entitlement/credit accounting built on the same tenant and account infrastructure. No invented sales or earnings.

Source intake is a useful, tested slice, not a production-eligible ingestion-to-publishing chain. Keep PR draft; no provider charge, live publish, deployment or merge.


## Upstream foundation merge and migration collision resolution

Canonical `codex/relaunch72-platform-foundation` independently added `0156_email_sending_protection.sql` while this draft was in progress.
This draft now includes that exact upstream migration unchanged and moves RL72 Media Engine's seven new migrations forward **one number** to `0157`–`0163`, preserving a contiguous sequence.
The renamed media SQL bodies are semantically unchanged (the original comments may refer to the earlier working number).
The PR branch includes a merge parent pointing at upstream commit `8eca59d3bfefa3c0fcc4d74d4cb02621768f5a71` and preserves upstream email protection settings. **Never overwrite upstream/Claude changes to make CI green.**


## Repair handover: active migrations quarantined (November 15)

Claude verified that production foundation and its email protection release expect migration `0156` as the current latest.
The unchanged full `npm test` failed only three tests while 11 draft media migrations were discoverable under `src/db/migrations`: they enlarged the role allowlist and contradicted the expected live migration ledger.

To preserve the foundation's unchanged tests and comply with Claude's control over migration numbering, **all 11 media SQL files were copied byte-for-byte** to `orchestrator/src/creative-studio/migration-drafts/` and removed from the active migration scan. They are NOT applied by the production migrator. Claude should consolidate/renumber them when the media suite is reviewed.

For media-specific PG integration proof, our new GitHub Actions workflow first bootstraps the existing canonical schema and then applies these drafts in sequence to a disposable localhost test database using `apply-to-disposable.mjs`. The script rejects remote or production database URLs. The normal `npm test` sees only the foundation's active migrations, ending at `0156`. No existing test, DB runtime, live Render service or foundation file was changed.

## Integration handover — measured provider output and exact private owner review

The feature branch adds a **non-numbered** `orchestrator/src/creative-studio/migration-drafts/output-private-review.sql` to the offline draft set. The production migrator still sees only the canonical sequence ending at 0156. Claude must consolidate/assign migration number and review permissions before integration. The draft adds:
- `creative_media_output_probes`: immutable technical measurements of existing privately captured provider output bytes, SHA-bound to that output and limited to an authorised worker role
- `creative_media_output_reviews`: append-only, owner-session-confirmed exact output SHA and three separate attestations (rights, content claims, disclosures), versioned to support withdrawal and another owner review
- `creative_media_output_review_commands`: idempotent command replay receipts, preventing a second decision from being substituted at the same command ID
- `creative_media_output_probe_bytes`/`creative_media_output_probe_save`: scoped worker functions for technical-only ffprobe measurements
- `creative_media_output_review`: signed-in owner workspace `list`/`review` actions with revision checks and a technical-probe prerequisite for `reviewed_private`

The `PgMediaOutputProbeWorker` and `PgMediaOutputReviewOwner` services in `media-output-review.ts` both fail closed unless `CREATIVE_MEDIA=enabled`, and the worker additionally requires `RL72_MEDIA_WORKER_ENABLED=true`. These flags are code/runtime gates only; do not set them in production as part of this draft. They do **not** authorise paid provider requests. The complete worker never publishes or schedules. `reviewed_private` is **not** a public release permission, external copyright verification, merchant clearance, social account authorisation, financial settlement or completed marketing evidence.

**Routes and hooks for Claude to connect later (DO NOT implement in this PR):**
1. GET `/portal/seo-blog/b/:brandId/creative/outputs/review` — under the existing authenticated selected-brand context, use `new PgMediaVideoOutputOwner(contentCommandPool, principal).list(brandId)` and `new PgMediaOutputReviewOwner(contentCommandPool, principal, env).list(brandId)`, then render `creativeMediaOutputReviewPage(shell, outputs, reviews, randomUUID)`
2. POST the same owner route — use existing CSRF check, current owner-session checks, same brand ID and one-use command ID; parse `outputId`, `outputSha256`, `expectedRevision`, `decision`, and the rights/claims/disclosure checkboxes. Call `PgMediaOutputReviewOwner.review(...)`, then redirect to the review page. No public redirect or social scheduling
3. Private preview remains the existing **draft media route** `creative/outputs/:outputId/stream`; Claude must explicitly decide whether and where to connect the owner-only stream handler from the new portal files
4. Optional worker job command (not scheduled): `new PgMediaOutputProbeWorker(workerPool, requestId, env).probe(workspaceId, outputId)`. This needs ffprobe on the isolated worker host, the scoped worker role and a separately reviewed operator enablement policy. No automatic retry of unknown paid-provider submissions
5. Do **not** map `reviewed_private` into `creative-studio/service.ts`'s existing public distribution or campaign approval path. Future release requires separate exactly-scoped content approval and publisher policy through the canonical Zernio/social rails

Tests: `orchestrator/test/media-output-review.test.ts`, `creative-media-output-review-view.test.ts`, and disposable `db/creative-media-output-review-pg.integration.test.ts`. The integration test injects a **synthetic video probe result** strictly to check DB immutability, authorisation and replay semantics. It does not claim a genuine decoded provider clip.

### Isolated CLI entry point (not scheduled or deployed)

The existing owned `orchestrator/src/workers/creative-media/cli.ts` now accepts a **manual-only** `probe-output <workspaceUuid> <outputUuid>` command alongside `probe`, `submit` and `reconcile`. It uses the same `r72_worker` database role and `PgMediaOutputProbeWorker` technical receipt functions, never a browser route. It requires `RL72_MEDIA_WORKER_ENABLED=true` and `CREATIVE_MEDIA=enabled`. It needs **neither** paid-provider-submission permission nor social publication permission and does not invoke Vizard or Shotstack. Claude must validate the worker service configuration and ffprobe sandbox before any operator enablement.

## Native offline rendering — exact source + timeline + private MP4 handover (no live wiring)

**New code, zero paid provider calls:**
- `orchestrator/src/creative-studio/media-local-render.ts` provides real FFmpeg rendering from **privately stored source bytes**: trims/reorders up to 12 clips, speed 0.5/1/2, 720p portrait/square/landscape scale/pad, optional captions and affiliate disclosure burn-in, fade-to-black, original audio or silence. It uses a unique 0600 temporary directory, no shell or remote URLs, 90-second processing deadline, 20MB output ceiling, and an independent second FFprobe measurement. Every output is a **private unapproved candidate**.
- `media-local-render-pg-store.ts` implements `PgLocalRenderOwner.enqueue/list/outputs/load`, `PgLocalRenderWorker.claim/complete/fail`, and `runQueuedLocalRender`. The owner checks an immutable saved edit revision and separate source rights confirmation; SQL requires its latest revision and the source's verified technical probe. The worker claims exactly once, rereads the original SHA-matching bytes/plan, renders locally and stores the MP4 in existing workspace-scoped blob storage. Missing or ambiguous settle receipts are never automatically retried.
- `orchestrator/src/creative-studio/migration-drafts/local-render-jobs.sql` contains **draft SQL only**, not an active migration. It introduces `creative_media_local_render_jobs` (one-shot per-workspace job/lease) and `creative_media_local_render_outputs` (SHA-bound local media bytes and versioned provenance), with scoped owner and worker definer functions. Claude must consolidate, assign one compatible migration number and inspect the RLS/privileges and availability of worker FFmpeg before any integration.
- `orchestrator/src/portal/creative-media-local-render-view.ts` is the **unmounted** native UI with source technical readiness, rights checkbox, exact saved plan/source digest, job status and private playback. No production URL is wired by this PR. It does not have a publish button.
- `orchestrator/src/workers/creative-media/cli.ts` adds `render-local <workspaceUuid> <jobUuid>`, a manual one-job action guarded by `CREATIVE_MEDIA=enabled`, `RL72_MEDIA_LOCAL_RENDER_ENABLED=true`, `RL72_MEDIA_WORKER_ENABLED=true`. No Vizard/Shotstack submission or social send is possible through this command. No scheduled worker or Render service was created.
- Real FFmpeg smoke: `orchestrator/test/media-local-render.test.ts`, and full disposable PG path: `orchestrator/test/db/creative-media-local-render-pg.integration.test.ts`. CI installs its own FFmpeg binaries; no application-level package dependencies were added. No test or migration outside the media-owned draft/test directories was modified.

**Claude-only route wiring proposal — DO NOT mount from this feature branch:**
1. GET `/portal/seo-blog/b/:brandId/creative/local-renders` — under the same owner-session/selected workspace boundary, compose `PgMediaEditStore.list(brandId)`, `PgCreativeVideoSources.list(brandId)` and `probeStatuses(brandId)`, and `PgLocalRenderOwner.list/outputs(brandId)`; render `creativeMediaLocalRenderPage(shell, {projects,sources,probes,jobs,outputs,newCommand:randomUUID,newJob:randomUUID})`.
2. POST `/portal/seo-blog/b/:brandId/creative/local-renders` — only after existing signed-in owner+CSRF validation. Parse `jobId,commandId,projectId,revision,sourceSha256,planSha256,rightsConfirmed` from the form; call `PgLocalRenderOwner.enqueue({workspaceId:brandId,...})`; redirect to owner GET. Never enqueue an external paid provider job or a social post here.
3. GET|HEAD `/portal/seo-blog/b/:brandId/creative/local-outputs/:id/stream` — private selected-brand owner session only. Call `PgLocalRenderOwner.load(brandId,id)` and reuse existing `videoByteRange` helper; ensure `private,no-store`, `nosniff`, `noindex`, `referrer-policy:no-referrer`, 206/416 single byte range behavior and no cross-tenant caching. This is preview only, NOT a public URL.
4. The operator may manually invoke `media:worker -- render-local <brandId> <jobId>` in a separate, reviewed worker environment. **Do not create a scheduled worker, auto-process queue, or activate environment variables until approved.** The worker requires FFmpeg with the H.264/AAC encoders, drawtext/font support and FFprobe. It does not need Vizard/Shotstack keys or provider funds.
5. Private local output review and publishing are future controlled hooks. **Do not** treat `completed` as `approved` or `published`; no affiliate link or social rail may read an unreviewed candidate. Existing `creative_media_output_reviews` are for paid-provider capture records; local outputs require a compatible, independently reviewed review path before any release. Claude owns integration with existing Creative Studio exact-version approvals and Zernio scheduling.

**Release constraints:** source size ≤20 MB and private output size <20 MB are deliberate PostgreSQL-blob pilot ceilings; larger production media needs separate protected object storage. Technical probe is not licence verification. The source fixture is synthetic, not a merchant asset. No production provider, send, billing, schedule, deployment or root dependency changes.


## 16 November continuation — exact private review of native local outputs

Foundation `96545c199dbe6c7acf63f8f09459e875920f3927` merged without conflicts; upstream email protection files are preserved.

- New **draft only** `migration-drafts/local-output-private-review.sql`, applied only after `local-render-jobs.sql` in the disposable test harness. No active migrations added. Separate append-only local output review and command tables avoid mixing local output IDs with paid-provider captures.
- `PgLocalOutputReviewOwner` in `media-local-output-review.ts` uses the canonical signed owner session, selected workspace and existing content-command transaction. Both `CREATIVE_MEDIA=enabled` and `RL72_MEDIA_LOCAL_RENDER_ENABLED=true` are required; defaults remain off.
- Acceptance binds the original SHA256 to its completed local-render job, immutable source/timeline hashes and exact private blob bytes. Three fresh owner attestations cover rights, claims and disclosures. Technical rendering does not verify licensing. Decisions can be rejected, withdrawn and re-reviewed; revisions and single-use command hashes protect concurrent changes and altered retries. All records remain private.
- `creativeMediaLocalOutputReviewPage` in `creative-media-local-output-review-view.ts` is **unmounted**. It previews only the existing private local stream, carries exact digest/revision/command/CSRF fields, and offers no distribution action. A mismatched review SHA cannot be displayed as acceptance of another output.

**Claude-only integration hooks (do not mount in this branch):**
1. GET `/portal/seo-blog/b/:brandId/creative/local-outputs/review`: after canonical owner-session/selected-workspace checks, compose `PgLocalRenderOwner.outputs(brandId)` and `PgLocalOutputReviewOwner.list(brandId)`, then `creativeMediaLocalOutputReviewPage(shell, outputs, reviews, randomUUID)`.
2. POST the same path: enforce canonical CSRF and owner checks; parse `outputId,outputSha256,expectedRevision,commandId,decision` plus three boolean attestations, call `PgLocalOutputReviewOwner.review({workspaceId:brandId,...})`, redirect to the owner review page. Missing unchecked boxes become `false`; never trust browser workspace IDs.
3. Use the previously proposed owner-only `local-outputs/:id/stream` handler with private/no-store byte-range headers. Do not expose a CDN/public URL or connect review to a publisher.
4. The new SQL must be consolidated/numbered and permissions reviewed by Claude. `reviewed_private` grants no public-release, calendar, provider, merchant or billing authority. No production flags, routes, schedule or deployment changed.

Verification extends the real disposable PostgreSQL + FFmpeg path with exact local review, null/missing SQL-field rejection, cross-tenant denial, replay conflicts, stale revisions and append-only withdrawal/re-review. UI and service tests cover disabled flags, worker identity refusal, fresh attestations and digest mismatch. Results must be checked at the pushed commit; a synthetic test fixture is not merchant media or a licence receipt.

## 16 November — remaining implementation pass (all screens still unmounted)

This pass adds working internal code and disposable tests; it does not override Claude's integration ownership or claim a live, saleable end-to-end service.

### Authoring and browser behaviour
- `media-cut-editor.ts`: split at playhead, duplicate, playhead start/end, 100-step undo/redo, keyboard undo outside native text inputs, per-clip mute/volume and bounded clip playback. Optional volume preserves existing immutable edit digests when absent. Native FFmpeg burns literal captions without interpreting percent expansion and applies the saved clip volume.
- `media-editor-browser.test.ts`: explicitly enabled real Chromium test. CI must run it, rather than treating the DOM stub as browser proof. Local sandbox restrictions may prevent local Chromium; CI is the browser authority.
- `creative-media-suite-view.ts`: shared agency/affiliate home, correct service counts, visible integration status and no invented plan prices or sales. `AFFILIATE_STUDIO_PRESENTATION` is an unmounted presentation adapter, not a new identity system.

### Resumable source intake
- New `resumable-video-uploads.sql` and `PgResumableMediaUploads`: 1 MB checksum-bound parts, exact whole-source checksum, three active sessions/workspace, 24-hour expiry, cancellation, altered-part conflict and idempotent finalization into the SAME existing source/blob store. Completed/expired staging bytes are removed. Canonical **20 MB** ceiling remains; this is not an implemented large-object backend.
- `creativeMediaResumableUploadPage` and `MEDIA_RESUMABLE_UPLOAD_SCRIPT`: pause/resume/cancel owner UX, same-file resume, bounded browser checksum and CSRF on every request. Serve the script as `/portal/seo-blog/media-resumable-upload.js` only at integration.
- Claude routes: GET `creative/uploads`; POST `creative/uploads/begin` parses bounded JSON and calls `.begin(brandId,uploadId,{byteLength,sha256,metadata})`; GET `creative/uploads/:id` calls `.status`; PUT `creative/uploads/:id/parts/:part` bounds raw body to 1,000,000 bytes and calls `.part`; POST `creative/uploads/:id/complete|cancel` calls corresponding methods. Enforce owner session, selected workspace, same-origin CSRF and request limits. JSON must be <=3.5 KB. Feature gates: `CREATIVE_MEDIA=enabled`, `RL72_MEDIA_RESUMABLE_UPLOADS_ENABLED=true` (default off).

### Bounded offline dispatch
- `media-worker-dispatch.sql`, `PgOfflineMediaDiscovery`, `runOfflineMediaTick`: scope discovery to ONE explicit workspace and <=10 tasks; process sequentially with source/output probes and existing one-shot offline render leases. No paid submit or social operation. Failed/ambiguous work is held, never implicitly reissued.
- Manual `media:worker -- tick <workspace>` processes one batch (default 3). Requires `CREATIVE_MEDIA`, `RL72_MEDIA_WORKER_ENABLED`, `RL72_MEDIA_LOCAL_RENDER_ENABLED`, `RL72_MEDIA_DISPATCH_ENABLED`. No scheduler, Render service or production flags created. Claude decides process supervision and scheduling separately.

### Canonical video draft and approval request
- `local-video-canonical-handoff.sql` and `PgLocalVideoCanonicalHandoff`: recheck current exact local review and source/plan/blob/brand evidence in every canonical transaction; create an immutable **kind=video** version using existing `CompanyContentService` and request its existing canonical approval. Does not decide that approval.
- Fresh private review must be less than 14 minutes old; its exact evidence attestation expires after 15 minutes. Withdrawal/re-review or brand changes invalidate a fresh handoff. Both actual adapter and content-command pools are needed.
- Proposed POST `creative/local-outputs/:id/canonical-review`: CSRF, owner and selected brand; parse `outputSha256,reviewRevision,commandId,title,caption,platform`, call `.request({workspaceId:brandId,outputId:id,...})`. Flag: `RL72_MEDIA_CANONICAL_HANDOFF_ENABLED=true` plus `CREATIVE_MEDIA`.
- **No video publication adapter or public byte release exists in this pass.** The canonical pending review is not connected to image-only Zernio media authority. Claude must implement/review a video-specific release bridge that rechecks current media withdrawal/review at effect time. A generic approved content row alone must never publish these private video bytes.

### Merchant evidence
- `affiliate-link-evidence.sql`, `PgMediaLinkEvidenceOwner`: append-only, 30-day owner programme/site/tag assertions bound to exact stored product revision, link SHA and disclosure version. Changing the product makes the old evidence non-current. Existing direct Amazon UK link validation remains; no redirect, tag substitution or automatic merchant verification.
- `creativeMediaLinkEvidencePage`: proposed GET/POST `creative/links`, owner/CSRF protected, `RL72_MEDIA_LINK_EVIDENCE_ENABLED=true` plus `CREATIVE_MEDIA`. Get products and `.list`, POST `.save`. Licensed documents/merchant credentials are not independently verified by an evidence checksum.
- No public click endpoint is mounted or issued. Orders and commission continue to come from actual owner-uploaded merchant reports; unknown and unallocated values remain unknown. End-to-end live click attribution is still a release blocker.

### Native media billing adapter (no live Stripe call performed)
- `media-billing-receipts.sql`: operator-only price policy (no enabled seed prices), owner checkout intents, durable Stripe session binding, one subscription binding/workspace/mode, immutable-by-privilege webhook event receipts and existing media access grants. No duplicate account/auth system.
- `createMediaSubscriptionCheckout` uses only operator-reviewed Stripe price IDs, mode=subscription, quantity=1, fixed reviewed HTTPS return origin and a server idempotency key. The URL is returned only after durable owner-bound session storage. Existing canonical onboarding still creates identities/workspaces; this adapter upgrades an existing signed-in owner workspace. It does not independently implement anonymous standalone signup or create Stripe products/prices.
- `handleMediaBillingWebhook`: actual SDK verification of bounded raw bytes, dedicated signing secret, expected Stripe mode, no connected-account event, retrieval of current subscription/latest invoice, exact quantity/price, paid active status, and original owner-bound checkout/session/customer proof before grants. Unknown/stale events cannot restore a revoked grant; cancellation/payment trouble creates a zero-limit denial grant. Duplicate raw event bytes never extend credits. API retrieval can be retried; no payment or provider generation call is performed by the webhook.
- `PgMediaBillingWebhook` requires the canonical **r72_webhook** pool, not a user pool. It discovers a workspace only from a stored owner intent or subscription binding, never from email or browser workspace metadata. Owner checkout uses content-command pool.
- Proposed POST `creative/billing/checkout`: owner session/CSRF, selected workspace and validated tier/command; compose `PgMediaBillingOwner.intent/bind` with injected existing Stripe SDK `.checkout.sessions.create`, then redirect to the returned Stripe URL. Review configured `RL72_MEDIA_BILLING_ORIGIN`. Proposed dedicated raw POST webhook `/api/webhooks/rl72-media/stripe` uses the handler and webhook pool. Do not reuse a different product's signing secret. Flags: `CREATIVE_MEDIA=enabled`, `RL72_MEDIA_BILLING_ENABLED=true`; config `RL72_MEDIA_STRIPE_WEBHOOK_SECRET`, `RL72_MEDIA_STRIPE_LIVEMODE`.
- `creativeMediaBillingPage` receives enabled, operator-labelled plans; no hardcoded commercial pricing. Its displayed micro-USD entitlement ceilings are not a remaining balance or provider invoice. Existing grant admission now totals current UTC-month reserved/unknown/actual costs atomically, so repeated subscription updates do not reset monthly headroom.
- Plan changes, a replacement subscription after cancellation, tax/refund/dispute decisions and production customer-portal setup require reviewed commerce policy. No live sale or refund proof has been obtained.

### Delivery and genuine remaining gates
All new SQL stays in migration-drafts; production migration scan is untouched. All new owner routes remain proposals. Browser, unit, genuine PG/FFmpeg, canonical and billing role tests must pass at the pushed SHA.

**Still not complete/live:** Claude route/schema integration; private large-object backend for >20 MB; video-specific public release and existing social adapter integration with withdrawal-at-effect checks; actual merchant eligibility/link distribution and click reporting; anonymous standalone signup through canonical onboarding; reviewed live products/prices and subscription lifecycle policy; actual authorised provider, merchant, billing and publication receipts. The code must not claim these external/integration gates passed merely because internal tests are green.
