# Native video integration handoff

All capabilities are dark. PR #108 stays draft. Claude owns route/server wiring, production migration names/numbers, service mount and live verification. Do not run the disposable bootstrap on production.

Production's affiliate layer is authoritative. Duplicate creative-media product/report/link-evidence stores and drafts, the shared Creative Studio service hook, and paid-provider modules/views are removed. No shared application source or package manifest differs from the merged foundation; `.env.example` only documents dark native gates.

## Active drafts, exact application order

1. `native-video-role.sql`
2. `media-erasure-table.sql`
3. `source-videos.sql`
4. `source-private-preview.sql`
5. `source-video-probe.sql`
6. `edit-projects.sql`
7. `local-render-jobs.sql`
8. `local-output-private-review.sql`
9. `media-worker-dispatch.sql`
10. `local-video-canonical-handoff.sql`
11. `private-object-sources.sql`
12. `native-video-release.sql`
13. `media-retention.sql`
14. `native-video-jit.sql`
15. `native-video-planner.sql`
16. `native-video-call-trigger.sql`

`migration-drafts/apply-to-disposable.mjs` is authoritative for this native-only list. All draft filenames are descriptive, without production-style numbers. `affiliate-link-distribution.sql` remains parked and unchanged, outside this manifest, for the later affiliate-article rework. It cannot apply without its retired affiliate schema and must not be included in production's native migration batch.

## Required integration hooks

- Source owner upload/private streaming: `media-video-source-pg-store.ts`, `media-object-sources.ts`, `PrivateMediaFiles`, source/large-upload views. H.264 up to 1080p; durable private disk shared between upload and worker. Root is configured using `RL72_MEDIA_PRIVATE_FILES_ROOT`.
- Saved timeline/editor: `media-edit-pg-store.ts`, editor view and cut-editor script. Plan JSON is hidden transport, never an owner-facing fallback. Always-visible `#ad` is a fixed renderer overlay; captions wrap and shorten to four lines.
- Queue/render/status/preview: `media-local-render-pg-store.ts`, local render view and byte-range helper. Export cap: 20 MB. SQL rejects estimates that cannot fit before queueing. Keep immutable exact-source/edit checks.
- Private review: `media-local-output-review.ts`, `media-private-review.ts`, local output review view. Canonical approval remains the publication approval; no second media authorization.
- Erasure and retention: `PgMediaErasureOwner.erase` and `.setRetention`, erasure/retention forms. Owner session, CSRF and explicit consent required. NULL retention means indefinite; never silently opt an existing library into expiry. Missing disk leaves deletion pending. Connect provider takedown and backup policies separately.
- Native calendar: `PgNativeVideoPlanner` and `PgNativeVideoJitWorker`. Use the existing canonical campaign revision, enqueue, scoped revalidation proof, claim and calling transport. Current rails: Instagram/LinkedIn. Original planning attestations may expire while waiting; near-slot JIT proof remains exactly 15 minutes.
- Calling: `native-video-call-trigger.sql` owns classification grants and installs a video-only WHEN condition. Keep the canonical classifier independent of the media role, and preserve its grants to canonical posting roles. Wrap the existing media resolver with `createNativeVideoMediaResolver`; preserve canonical emergency/provider-effect gates and settlement.
- Worker: invoke `node --import tsx orchestrator/src/workers/creative-media/cli.ts serve` from repository root. No npm package hook is added. Native commands: serve, tick, probe, render-local, cleanup-objects, attest-native. Paid submit/reconcile/probe-output commands no longer exist. Native service does not call the parked click-retention SQL.

## Dark gates

`CREATIVE_MEDIA=enabled` plus the applicable boolean flags (all false in `.env.example`):

- `RL72_MEDIA_WORKER_ENABLED`
- `RL72_MEDIA_LOCAL_RENDER_ENABLED`
- `RL72_MEDIA_DISPATCH_ENABLED`
- `RL72_MEDIA_SERVICE_ENABLED`
- `RL72_MEDIA_RETENTION_ENABLED`
- `RL72_MEDIA_PRIVATE_FILES_ENABLED`
- `RL72_MEDIA_CANONICAL_HANDOFF_ENABLED`
- `RL72_MEDIA_NATIVE_CALENDAR_ENABLED`
- `RL72_MEDIA_VIDEO_RELEASE_ENABLED`

The parked page gate `RL72_MEDIA_AFFILIATE_PAGES_ENABLED` also stays false. Public pages, beacon signing/verification, and their legacy SQL remain unmounted for a later production affiliate-article adapter. Owner publication fails explicitly until that adapter exists. Do not revive the deleted duplicate stores.

## Verification

`media-visible-disclosure.test.ts` OCRs actual exported frames with a 240-character caption across three canvases. `native-calendar-local-run.mjs` bootstraps a fresh disposable PostgreSQL and the native-only manifest, then runs the native render and three-day clock tests. CI repeats these checks. FFmpeg, FFprobe, DejaVu Sans Mono Bold and Tesseract are required for pixel/OCR tests.

The clock proof uses libfaketime solely in PostgreSQL, not Node, and real canonical planner/claim/calling functions. A separate rolled-back cloned text-job fixture tests trigger isolation with revoked media grants; it is not planner proof. No triggers, foreign keys or replication settings are disabled. Provider inventory/webhooks remain explicit fixtures. Live OAuth, provider publishing and platform previews remain Claude's integration checks.
