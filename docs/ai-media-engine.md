# RL72 AI Media Engine — unified product build contract

**Status:** Full-scope, end-state engineering contract; NOT evidence of a deployed or integrated product.
**Date:** 2026-11-15
**Source of truth / constraints:** [Relaunch72 Build HQ](https://app.notion.com/p/3923aeb85fd981818e72d14eab145474), [Platform Architecture](https://app.notion.com/p/3a83aeb85fd981649061ea8b0bd59d09), `docs/platform-architecture.md`, portal, CRM, manager and social adapters in this repository. The broader GHL-vs-owned-CRM decision in Notion remains unresolved. This module must work with either backing platform.
**Product decision:** One native, multi-tenant RL72 media workspace. No separate Vizard/Shotstack login or user-facing orchestration. All production publication requires human sign-off; existing no-invented-proof policy applies.

## Definition of done — ONE coherent release

A logged-in RL72 tenant can create a video campaign from a product/affiliate brief, uploaded owned media, a video they own on YouTube, or an approved licensed source; research and validate claims; draft a script and storyboard from their existing brand brain; produce original narration/visual assets; select AI highlights; edit all outputs in a native RL72-branded timeline; apply captions, branding, multilingual variants and all aspect ratios; preview and render; approve; schedule/publish to available connected social accounts; route clicks to relevant owned affiliate landing pages; and view the per-campaign funnel, actual billable processing costs and available commission data. No feature is counted complete merely because its API connector exists.

### Required customer screens

1. **Studio home:** campaigns, drafts, scheduled jobs, review queue, rendered assets, channel connections, spend cap/credits.
2. **New campaign:** one wizard, multiple input modes: original brief / owned YouTube URL / file upload / product catalogue / podcast. Tenant brand brain is inherited automatically; override allowed.
3. **Product discovery & research:** find candidate products and audience questions. Cite sources, save evidence for claims, mark unverified claims, request manual approval of product choices. NEVER silently auto-scrape other creators.
4. **Script/storyboard:** platform-aware hooks, narration, scene plan, product CTA, approved asset references, disclosure flag and source evidence.
5. **AI create & repurpose:** original video/voice generation through adapters, AI clip detection, resizing/reframing, automated captions, B-roll suggestions, thumbnail and title variants.
6. **Full timeline editor:** embed Shotstack Studio SDK inside an authenticated RL72 front end. Add trim/split, track reorder, music, volume ducking, captions, transitions, overlays, template presets, subtitles, logo/watermark, aspect ratios 9:16 / 1:1 / 16:9, undo/redo. Persist the native edit JSON so it can be rendered reproducibly. Check the SDK commercial licence for our exact packaging before release.
7. **Variants:** generate and review multiple hooks/CTAs or languages from one master edit. Track lineage to original campaign and associated rights.
8. **Approval & publishing:** show every finished asset and its claim/disclosure checks. On approval only, schedule/publish via configured social rail; where available, reuse the existing `AyrsharedPublisher` or Zernio connector, not both inadvertently. Maintain native per-platform status, retry idempotently.
9. **Affiliate commerce:** product cards with genuine eligibility and price/source freshness, compliant Amazon special links, approved affiliate landing pages, tracking/attribution for *owned-page clicks*. The user owns and controls tracking tags. An Amazon sale is recorded only when supported by actual Associates reporting; no invented per-click checkout attribution or fictitious conversions.
10. **Analytics & unit economics:** views (where API permits), watch metrics, content-to-site clicks, outbound affiliate clicks, Amazon reported orders/commission where supported, direct affiliate data, provider cost per source minute, video output minute and campaign. Weekly rollup plus CSV export.
11. **Workspace operations:** per-tenant role access, credit quotas, asset storage/retention, webhook logs, job status/retries, audit entries, deletion/export, one-click rerun and per-brand templates.

### Single-product architecture

```
RL72 client portal (/portal/studio) [same tenant session]
  ├─ Campaign/project/asset library
  ├─ Studio timeline (Shotstack Studio SDK embedded)
  ├─ Research + script + agent + brand brain + QA
  ├─ Review queue + editor + affiliate page builder
  ├─ Calendar/publishing + analytics + billing
  └─ Workspace settings / connections / credits
            |
       RL72 Media API (server-side; tenant enforced on EVERY route)
            |
       Durable jobs / outbox / callback signatures
            |
   ┌────────┼────────┬───────────┬───────────┐
   |        |        |           |           |
 Vizard  Shotstack  Original AI  Social rail  Affiliate links
 clips   renders    creation    (existing)  + reports
           |
       Object storage/CDN + isolated DB + usage ledger
```

The UI and job contract are RL72-owned. Providers are adapters with no provider URLs or keys exposed in browser data. An alternative vendor can replace any adapter without changing the media campaign state machine.

### Provider contracts

- **Clipping** `submit(source, policy, style) -> externalJobId`; `status(jobId) -> candidateClips`; Vizard API create/query paths: `POST /hvizard-server-front/open-api/v1/project/create` and `GET /.../project/query/{projectId}`, header `VIZARDAI_API_KEY`. Restrict sources to owned/licensed inputs. Prefer `clip_v2` only after confirming its 1.25x credit consumption and quality on representative media. Save full request/response metadata, provider charges and thumbnails without storing API keys.
- **Edit/Render** `save(editJson)`, `preview(editJson)`, `render(editJson) -> jobId`, `status(jobId)`. Use Shotstack Studio SDK for native editing and Shotstack Edit API for cloud rendering. Support multiple aspect ratios and branded templates. Do not confuse minutes uploaded to Vizard with finished video minutes billed by Shotstack.
- **Original creation** `generate(script, approvedAssets, brand, outputSpec)`. Use a provider-agnostic interface; Vizard Agent is a candidate, but price and API contract must be checked before live customer charges. Synthesised testimonials/people and unverified product claims are prohibited.
- **Publisher** `linkAccount`, `publish`, `schedule`, `status`, `delete`. Adapt existing `orchestrator/src/social/ayrshare.ts` or installed Zernio workflow, not a parallel accidental account system. Publishing tokens server-side; platform restrictions/limits surfaced honestly.
- **Affiliate** `validateSpecialLink`, `trackOutboundClick`, `importMerchantReport`. All linking must satisfy merchant policies. Separate real sales from estimated click-value projections.

### Tenant-safe data model

- `MediaCampaign(id, tenantId, brandId, title, mode, state, brief, sourceRights, createdBy, budgetLimit, createdAt, updatedAt)`
- `MediaSource(id, tenantId, campaignId, sourceType, sourceUrl|objectKey, ownerAttestation, licenceRef, duration, checksum, allowedUse)`
- `MediaProduct(id, tenantId, merchant, asinOrSku, canonicalLink, affiliateLink, lastVerifiedAt, claimEvidence[])`
- `MediaProject(id, tenantId, campaignId, scriptVersion, storyboard, masterEditJson, styleTemplateId)`
- `MediaVariant(id, tenantId, projectId, format, language, platform, hookId, editJson, approvalState, outputObjectKey)`
- `MediaJob(id, tenantId, idempotencyKey, kind, provider, status, externalId, attempts, dueAt, result, errorCode, startedAt, completedAt)`
- `MediaApproval(id, tenantId, variantId, reviewerId, decision, claimChecks, at)`
- `MediaPublish(id, tenantId, variantId, platform, accountRef, scheduledAt, externalPostId, status, error)`
- `MediaLink(id, tenantId, campaignId, productId, destination, affiliateProgram, trackingTag)`
- `MediaEvent(id, tenantId, campaignId, variantId?, eventType, source, timestamp, eventId, metadata)`
- `MediaUsage(id, tenantId, campaignId, provider, jobId, unit, quantity, providerCost, retailCredits, billedAt)`
- `MediaAudit(id, tenantId, actor, action, subject, at, detail)`

Every persistent query is `tenantId`-scoped. Never trust tenantId in browser payloads; resolve it from authenticated session. Store media files privately using signed expiring URLs. Separate analytics aggregation from event ingestion.

### State machine

`draft -> researching -> assets_ready -> generating -> editing -> awaiting_approval -> approved -> scheduled -> published -> measured`.
Failures are explicit `failed` with retry/park; `cancelled` and `archived` terminal. Generation cannot publish. Edit changes invalidate previous approvals. A rejected variant returns to editing and retains audit history. Webhook callbacks must be authenticated, deduplicated and checked against a known pending external job. Provider failures never mark an asset published.

### API surface (tenant cookie session + CSRF protection)

- `GET/POST /portal/api/media/campaigns`; `GET/PATCH /portal/api/media/campaigns/:id`
- `POST /portal/api/media/assets/sign-upload`; `POST /portal/api/media/assets/confirm`
- `POST /portal/api/media/campaigns/:id/research`; `POST /script`; `POST /generate`; `POST /repurpose`
- `GET/PATCH /portal/api/media/variants/:id/edit`; `POST /variants/:id/render`; `POST /variants/:id/approve`; `POST /variants/:id/reject`
- `POST /portal/api/media/variants/:id/schedule`; `GET /portal/api/media/calendar`
- `GET /portal/api/media/products`; `POST /portal/api/media/links`
- `GET /portal/api/media/analytics?campaignId=...`; `GET /portal/api/media/usage`
- `POST /api/media/webhooks/:provider` (verify signature or equivalent authenticating secret; never a tenant-session endpoint)

### Quality, rights, compliance gates

- Original video, appropriately licensed video, or authorised repurposing only. YouTube URL alone conveys no reuse rights.
- Use independent factual sources or actual tests for claims. Do not assert a product works, price, capacity, safety, commission or review score without evidence and freshness.
- Amazon Special Links + merchant-specific site eligibility; show clear `#ad` near promotions and the required Associate programme disclosure. Never publish an affiliate link to a site/social property not permitted under the applicable Associates terms.
- Amazon Program Content must be accessed/used under its actual licence, not scraped from product pages.
- Short-form videos may need affiliate CTAs via bio or owned landing page because outbound links differ by social platform.
- Safety-sensitive products (indoor heating, generators, water filtration, battery storage) require explicit domain checks: no outdoor fire pit indoors, no unverified purification assurances.
- Content with AI voice/visuals must observe applicable platform synthetic-media disclosure rules.
- Maintain moderation, anti-spam pacing, duplicate detection, rights attestation and consent for voice/likeness.
- User confirmation required for live publication and money-spending provider calls unless tenant has explicitly enabled an approved auto-publish policy. Global spend caps and kill switch.

### Cost/credit control

- Never sell "unlimited" until provider usage and abuse data justify it.
- Before any chargeable job, compute an estimate from source input minutes, output render minutes, model tokens, voice/video generation units and storage; reserve tenant credits atomically.
- Webhook on job completion reconciles actual consumption. Refund reserved credits for genuine provider failures.
- Separate wholesale provider costs from retail credits; show campaign ROI from actual reported data, not hypothetical commission.
- Queue concurrency by tenant, retry with backoff, honour rate limits and refuse work over cap.

### Observability and acceptance tests

A release is complete only with:
- End-to-end test: brand brain -> owned 20-min source -> suggested clips -> editable captioned 9:16 render -> explicit approval -> scheduled post -> tracked click -> imported actual commission report.
- End-to-end original brief -> approved original video with narration and storyboard -> editor -> render -> publish.
- Cross-tenant test: cannot read, edit, render, publish or retrieve any other tenant's projects or signed assets.
- Failure tests: provider timeout, duplicate webhook, bad signature, retries, credit exhaustion, missing connection, expired asset, licence not granted, edit after approval, social platform rejection.
- QA tests: unsupported product claims, missing #ad, unsafe stove advice, provider price unverified, fabricated testimonial.
- Cost tests: actual units ledgered, limits applied before external spend, reconciliation correct.
- Analytics test: clicks are distinct from tracked purchases and imported real commissions, never shown as equivalent.
- UI acceptance: mobile browser, keyboard, accessible controls, responsive editor, onboarding, template editing and account disconnect.
- Operational acceptance: health metrics, job queue dashboard, webhook logs, support audit trail and recovery from interrupted renders.

### Build integration into THIS repository

- Backend `orchestrator/src/media/`: domain, storage, provider ports, job runner, rights/QA, report import, analytics.
- Native client UI `/portal/studio`: same session and tenant as `orchestrator/src/portal/router.ts`; studio frontend may be a separately bundled React application embedded under this path, because the existing portal is server-rendered HTML and the Shotstack SDK is browser-oriented.
- Job coordination extends existing `orchestrator/src/manager/`, not a second scheduler.
- Publishing reuses existing `orchestrator/src/social/` adapters or one selected provider; brand brain reads existing tenant runDir.
- Tenant billing, credits and reporting integrate with existing portal billing and CRM activity.
- Keep mock-first tests with explicit `mock` status; never represent synthetic results as live publishing or actual commissions.

## Provider documentation / research verified 2026-11-15

- Vizard clipping API: https://docs.vizard.ai/docs/quickstart
- Vizard API pricing: https://docs.vizard.ai/docs/pricing
- Vizard v2 clipping credit multiplier: https://vizard.ai/blog/api-update-vizard-now-supports-the-v2-ai-clipping-model
- Shotstack Studio SDK: https://shotstack.io/docs/guide/studio-sdk/
- Shotstack Edit API model: https://shotstack.io/docs/guide/
- Amazon UK Associates agreement: https://affiliate-program.amazon.co.uk/help/operating/agreement?redirect=false
- Amazon disclosure: https://affiliate-program.amazon.co.uk/help/node/topic/GPXFHVYZMTGPUMPE

## Implementation honesty

This document locks the complete target product and integration seams. It is not an assertion that live adapters, UI, tokens, legal rights, billing or E2E verification are finished. Do not merge or market it as a working Media Engine until the stated acceptance tests pass.
