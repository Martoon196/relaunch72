# Current media implementation after independent audit repairs

This describes source code, not a live product. All media screens/handlers still require Claude's integration. No production SQL, routes, service or external effects were activated.

## Private media and rendering

`PrivateMediaFiles` stores private immutable objects under validated workspace/source UUIDs and SHA-derived keys. Source limit is 1 GiB, parts 8 MiB. Upload assembly and probe/render boundaries verify complete hashes. Range requests inspect an O_NOFOLLOW-opened inode, size and immutable file mode without rehashing the file. Status reads bounded 64-byte part receipts; assembly verifies actual part bytes. A private durable disk must be shared by upload server and worker.

`renderLocalVideo` / `renderLocalVideoFile` render clips sequentially into temporary H264/AAC segments, then copy through the concat demuxer. No multi-clip decode fan-out is sent to FFmpeg. Captions and mandatory #ad disclosure are burned into every segment. Inputs are constrained to H264, at most 1920 pixels on either axis, at most 2,073,600 pixels, and at most 60 fps. The child codec/container/protocol whitelists and single decoder/filter/encoder threads are explicit. Linux `prlimit` enforces address-space/CPU/file-descriptor limits; a renderer RSS watchdog and wall deadline also fail closed. The export ceiling remains below 20 MB.

Live-action evidence is now in `rl72-media-audit-evidence/live-action-1080p-memory.json`; the earlier synthetic evidence is retained separately. The test uses 180 continuous seconds of Tears of Steel (CC BY 3.0, Blender Foundation / mango.blender.org), with its 1920×800 HD picture letterboxed to a full 1920×1080 frame. It does not upscale, loop or pad the file with unused bytes. It decodes 4,320 actual frames. The repeatable preparation and benchmark are `orchestrator/test/tools/media-real-footage-memory.sh`. Source and output film files are not published or committed.

## Offline service and limits

`npm --prefix orchestrator run media:worker -- serve` is prepared, default disabled. Its single-concurrency loop discovers at most ten workspace IDs, performs retention and expired-upload cleanup before each bounded offline tick, and handles shutdown/error backoff. It does not submit paid renders or publish. Existing individual maintenance commands remain useful for diagnosis.

Render claims have tokens, leases and heartbeat renewal. Expired claims are fenced from settlement; deterministic offline failures may retry after backoff, up to three attempts. There are at most 20 active queued/claimed jobs per workspace, at most 50 retained local outputs and at most 200 MB of retained local output bytes. Physically erased outputs stop consuming the cap. Private object staging has three concurrent uploads and a 10 GiB source/staging ceiling. These are enforced in SQL, not just UI.

## Erasure, retention and takedown

`PgMediaErasureOwner` records owner-scoped source/output tombstones. Source erasure also tombstones derived local outputs. Tombstones block new relevant private reads/render claims/native distribution checks. The supervised worker deletes filesystem source payloads and staging and overwrites PG media payloads with a one-byte erasure marker, retaining referential audit identities/digests. Failed filesystem deletion remains pending for retry. Automatic media retention is 30 days. Expired/cancelled staged uploads are swept automatically in bounded batches. Click receipts have a separate 30-day bounded retention sweep.

This does not delete database backups, logs or copies already accepted by an external provider. Claude must connect the canonical provider takedown flow and operational backup-retention policy; do not describe a tombstone as proof an already published provider copy was removed.

## Canonical publication and accounts

Standalone unpaid signup and the separate media Stripe checkout/webhook rail are removed. Use canonical paid-order provisioning and billing. There is no media-owned setup email endpoint.

Canonical queue approval controls publication; the redundant video authorize action is removed. The video adapter retains a separate withdrawal action. Private review records prepare evidence and can invalidate a draft; they are not public approval. The handoff now prepares separately versioned canonical caption and video assets. `PgNativeVideoPlanner` refreshes current exact owner planning observations, creates the native-source intent through the canonical planning schema and calls the existing connected-account Zernio enqueue function. No second posting queue or transport exists.

`PgNativeVideoJitWorker` independently rechecks the exact approved pair, output bytes, source/probe/edit evidence, disclosure, brand, erasure and current approvals within the ten-minute pre-slot window. It appends canonical post AND media proof lasting 15 minutes. The original planning attestations may expire while a post waits days; they are not extended or mutated. Actual send readiness uses the current short-lived proof.

The prepared service invokes this worker only with `RL72_MEDIA_NATIVE_CALENDAR_ENABLED=true`; all gates remain dark. `attest-native <workspace>` is a scoped diagnostic command. The native calendar adapter supports Instagram/LinkedIn, matching the current canonical rail. The enabled calling trigger independently checks current native evidence and writes its immutable check receipt; source/caption mutations, withdrawal or erasure cannot authorize an old job. The isolated elapsed-clock test proves the actual route through canonical planner tables, enqueue, JIT, lease and begin-call, without disabling constraints or triggers.

## Owner UI and click observations

Owner-visible content hashes and micro-USD labels were removed; currency is formatted as dollars and evidence is selected as a document. Affiliate timelines reject missing #ad at both TypeScript and SQL boundaries. No owner can switch that disclosure off through the editor.

Merchant links remain direct with required disclosure. Application HMAC verification uses constant-time comparison. SQL stores a signing-key digest, never the key. Public read credentials cannot record clicks; a separate backend capability records only after verification. A server-derived source hash produces a stable daily page nonce, so reloads cannot mint unlimited distinct countable tokens. Index-backed daily caps and 30-day retention bound ingestion. These remain unverified observations, susceptible to distributed abuse; orders/commissions come only from merchant reports.
