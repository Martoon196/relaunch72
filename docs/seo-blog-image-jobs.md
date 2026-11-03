# Durable image job coordinator (010)

This isolated component orders existing transport and JPEG preparation behind injected committed database boundaries. It does not configure credentials, change a budget, approve media, expose private images, release a blog hero, or publish social posts. The later SQL adapter and native product integration are required before activation.

## Intent and private inputs

Only a claimed `write` task in `running` state with `payload.stage=image` and `image.schema=relaunch72.seo-image-intent/v1` is accepted. The versioned `seo-image-source-v1` snapshot, current article/version/content and sponsor, policy version/hash, lease owner/attempt and source/profile/visual digests are required. Opaque UUIDs, digest shape and bounded private prompt are validated. `prepareImageGenerationRequest` is the single pure request preparation function reused by transport; it yields the exact UTF-8 wire SHA without credentials or a network request. Private command/body and source snapshots are frozen copies and omitted from ordinary metadata JSON. The SQL adapter independently compares every input against current trusted rows; caller hashes do not authorise spending.

## Ordering and recovery

1. `admitCommitted` owns the transaction: reserve cost, nonce and one image allowance together, returning a fresh grant only after positive COMMIT acknowledgement. A thrown or ambiguous acknowledgement never authorises a provider call. An already-started attempt holds, even on reclaim. Existing receipts recover locally even when the provider key has since been removed.
2. A fresh acknowledged matching nonce invokes the fixed transport at most once, outside SQL. No transport retry occurs. A known pre-call abort, provider rejection and unknown result remain distinct persisted outcomes.
3. `persistReceiptCommitted` commits safe evidence, original candidate bytes and accounting before decoding. A lost acknowledgement replays only the same database receipt operation once. A second storage failure holds. Reserved and received wire SHA are separate; a mismatch retains actual hashes but strips candidate attachment and prevents application.
4. Load the exact private candidate and verify its SHA before bounded JPEG preparation. Original dimensions must be the requested1536x1024. All three distinct reviewed JPEG profiles must be present. Local preparation failure is recorded without recalling the model; transient recovery starts with stored bytes.
5. Persist all derivatives atomically, verify the committed candidate/recipe/SHA identities, then call `applyPreparedCommitted`. That boundary rechecks current claim, source, sponsor, pause and policy and attaches private proposals only. A late or stale result can retain accounting/assets but cannot replace owner edits or approve/release content.

All result/progress codes come from a bounded safe vocabulary. Results contain opaque IDs and state, without prompt, credentials, raw provider response or image bytes. Immutable receipt and preparation identity remains the database adapter's responsibility.

## Evidence and remaining integration

The focused coordinator cases use the actual JPEG codec fixture and inject committed boundary outcomes to test ordering and recovery. They are not a PostgreSQL proof. Actual-role migration/admission/receipt/concurrency tests, worker routing and lease handling, source SQL adapter, owner image review/use authorisation, preallocated hero release, campaign calendars and existing canonical social dispatch remain separate integration work. Unknown paid attempts must never be reset by a generic retry. The operator policy and per-brand image opt-in remain disabled until deliberately configured within approved limits.
