# Current media implementation after independent audit repairs

This describes source code, not a live product. All media screens/handlers still require Claude's integration. No production SQL, routes, service or external effects were activated.

## Private media and rendering

`PrivateMediaFiles` stores private immutable objects under validated workspace/source UUIDs and SHA-derived keys. Source limit is 1 GiB, parts 8 MiB. Upload assembly and probe/render boundaries verify complete hashes. Range requests inspect an O_NOFOLLOW-opened inode, size and immutable file mode without rehashing the file. Status reads bounded 64-byte part receipts; assembly verifies actual part bytes. A private durable disk must be shared by upload server and worker.

`renderLocalVideo` / `renderLocalVideoFile` render clips sequentially into temporary H264/AAC segments, then copy through the concat demuxer. No multi-clip decode fan-out is sent to FFmpeg. Captions and mandatory #ad disclosure are burned into every segment. Inputs are constrained to H264, at most 1920 pixels on either axis, at most 2,073,600 pixels, and at most 60 fps. The child codec/container/protocol whitelists and single decoder/filter/encoder threads are explicit. Linux `prlimit` enforces address-space/CPU/file-descriptor limits; a renderer RSS watchdog and wall deadline also fail closed. The export ceiling remains below 20 MB.

Measured synthetic stress evidence is in `rl72-media-audit-evidence/synthetic-1080p-memory.json`. It uses 180 seconds of moving 1080p/30 footage, not padded bytes. It is **synthetic testsrc2**, not Claude's requested real camera footage, and does not close that audit gate. The repeatable harness is under `orchestrator/test/tools/media-memory-*`.

## Offline service and limits

`npm --prefix orchestrator run media:worker -- serve` is prepared, default disabled. Its single-concurrency loop discovers at most ten workspace IDs, performs retention and expired-upload cleanup before each bounded offline tick, and handles shutdown/error backoff. It does not submit paid renders or publish. Existing individual maintenance commands remain useful for diagnosis.

Render claims have tokens, leases and heartbeat renewal. Expired claims are fenced from settlement; deterministic offline failures may retry after backoff, up to three attempts. There are at most 20 active queued/claimed jobs per workspace, at most 50 retained local outputs and at most 200 MB of retained local output bytes. Physically erased outputs stop consuming the cap. Private object staging has three concurrent uploads and a 10 GiB source/staging ceiling. These are enforced in SQL, not just UI.

## Erasure, retention and takedown

`PgMediaErasureOwner` records owner-scoped source/output tombstones. Source erasure also tombstones derived local outputs. Tombstones block new relevant private reads/render claims/native distribution checks. The supervised worker deletes filesystem source payloads and staging and overwrites PG media payloads with a one-byte erasure marker, retaining referential audit identities/digests. Failed filesystem deletion remains pending for retry. Automatic media retention is 30 days. Expired/cancelled staged uploads are swept automatically in bounded batches. Click receipts have a separate 30-day bounded retention sweep.

This does not delete database backups, logs or copies already accepted by an external provider. Claude must connect the canonical provider takedown flow and operational backup-retention policy; do not describe a tombstone as proof an already published provider copy was removed.

## Canonical publication and accounts

Standalone unpaid signup and the separate media Stripe checkout/webhook rail are removed. Use canonical paid-order provisioning and billing. There is no media-owned setup email endpoint.

Canonical queue approval controls publication; the redundant video authorize action is removed. The video adapter retains a separate withdrawal action. Private review records prepare evidence and can invalidate a draft; they are not public approval. The current canonical handoff still uses 15-minute source attestations. A proper fresh-observation path for multi-day scheduled jobs and an authentic planner-to-calling integration test remain unresolved; the adapter must remain dark.

## Owner UI and click observations

Owner-visible content hashes and micro-USD labels were removed; currency is formatted as dollars and evidence is selected as a document. Affiliate timelines reject missing #ad at both TypeScript and SQL boundaries. No owner can switch that disclosure off through the editor.

Merchant links remain direct with required disclosure. Application HMAC verification uses constant-time comparison. SQL stores a signing-key digest, never the key. Public read credentials cannot record clicks; a separate backend capability records only after verification. A server-derived source hash produces a stable daily page nonce, so reloads cannot mint unlimited distinct countable tokens. Index-backed daily caps and 30-day retention bound ingestion. These remain unverified observations, susceptible to distributed abuse; orders/commissions come only from merchant reports.
