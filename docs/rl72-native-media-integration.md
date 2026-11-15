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
