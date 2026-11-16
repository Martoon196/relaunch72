# Native media branch: actual integration boundary

This branch contains unmounted media modules. It does not contain working media HTTP routes, production migration assignments or a deployed service. Claude owns those changes. PR #108 remains a draft. All feature flags and operator policies remain disabled unless explicitly configured outside this build.

Read `rl72-media-final-components.md` for the current module inventory and `rl72-astra-audit-brief.md` for unresolved audit gates. These rewritten documents replace earlier claims of full readiness.

## Components and proposed integration seams

| Existing module | Prepared capability | Claude's integration work |
| --- | --- | --- |
| `orchestrator/src/creative-studio/media-product-pg-store.ts` and `media-link-evidence.ts` | Owner product revisions and programme evidence | Authenticated product/evidence handlers; compute evidence digest from uploaded document using `media-owner-input.ts` |
| `media-video-source-pg-store.ts` | Small private source intake | Owner multipart handler and private preview |
| `media-object-sources.ts` and `media-private-files.ts` | Large private resumable source intake, ranges, source probe, staging cleanup | Owner begin/status/part/complete/cancel handlers and durable shared private disk |
| `media-edit-pg-store.ts` and `media-local-render-pg-store.ts` | Immutable timelines and local render queue | Owner edit/enqueue/list handlers |
| `media-local-render.ts` and `media-source-probe.ts` | Sequential segment rendering; bounded Linux child processes | Install FFmpeg/FFprobe and util-linux `prlimit`; isolate and supervise worker |
| `orchestrator/src/workers/creative-media/cli.ts` and `service.ts` | Disabled supervised offline loop | Mount as a worker service only after audit gates pass |
| `media-output-review.ts`, `media-local-output-review.ts`, `media-canonical-handoff.ts` | Private evidence preparation and canonical pending video draft | Compose into canonical queue; private checks are not publication approval |
| `media-video-release.ts` | Native video resolver and withdrawal capability | **Blocked:** prove canonical planner, multi-day schedule and actual calling trigger first |
| `media-retention.ts` and `orchestrator/src/portal/creative-media-erasure-view.ts` | Owner erasure request, bounded automatic payload erasure | Owner/CSRF erase handler, confirm action; provider takedown remains canonical integration |
| `media-affiliate-pages.ts` | Direct merchant page and bounded unverified click observations | Public page/read pool and separate backend click command pool; server-derived source hash |
| `amazon-report-pg-store.ts` | Merchant-reported earnings ingestion | Owner report import/list handlers |

The `orchestrator/src/portal/creative-media-*.ts` modules export HTML renderers, not mounted screens. Serve owned scripts from `media-cut-editor.ts`, `media-scene-timeline.ts`, `media-streaming-sha256.ts` and `MEDIA_LARGE_UPLOAD_SCRIPT` only where the corresponding view is mounted. No route names in this document imply an implemented router.

## SQL and ownership

`orchestrator/src/creative-studio/migration-drafts/apply-to-disposable.mjs` is the authoritative ordered list of remaining media draft files. Its filename prefixes are historical draft names, **not production migration numbers**. No draft has been renumbered for integration. Claude assigns actual production migration numbers, orders dependencies and reviews grants before applying anything.

The superseded `resumable-video-uploads.sql`, its small-buffer uploader/store, standalone signup and separate media Stripe rail were removed. Canonical paid-order provisioning and billing are required; this branch supplies neither a replacement signup endpoint nor a second webhook/checkout flow.

## Configuration required, all dark

Use the actual module gates: `CREATIVE_MEDIA=enabled`, `RL72_MEDIA_WORKER_ENABLED`, `RL72_MEDIA_LOCAL_RENDER_ENABLED`, `RL72_MEDIA_DISPATCH_ENABLED`, `RL72_MEDIA_SERVICE_ENABLED`, `RL72_MEDIA_RETENTION_ENABLED`, `RL72_MEDIA_PRIVATE_FILES_ENABLED`, `RL72_MEDIA_PRIVATE_FILES_ROOT`. No service is started by these code changes. Paid-provider submit/read permissions remain separate and are never exercised by the offline loop.

Proposed owner handlers must derive workspace from selected authenticated session, enforce owner capability/CSRF and bound request bodies. Digests and immutable IDs are server/browser implementation data, not owner-entered fields. Uploaded evidence must be bounded to 5 MB; use `mediaEvidenceDigest` server-side for multipart forms. The large uploader computes its own document digest.

Affiliate page enablement additionally needs reviewed origin/programme eligibility, `RL72_MEDIA_AFFILIATE_PAGES_ENABLED`, a 32-byte signing key in application secret configuration, **only its SHA256 digest** in the SQL policy, and a separate restricted backend click command pool. The `r72_public` role cannot record clicks. Do not accept a browser-provided source hash or untrusted forwarding header. Missing server-derived source hash renders a direct merchant link without a beacon token. Counts are unverified, pseudonymously deduplicated source/page/day observations, not unique people or sales; rotating source networks can still inflate them.

## Release gates

Do not mount publishing or declare the product complete until the independent audit gates in `rl72-astra-audit-brief.md` are closed. In particular the real-footage memory run and canonical planner → scheduled video → calling proof are still required. Do not widen canonical 15-minute freshness just to make a multi-day schedule pass.
