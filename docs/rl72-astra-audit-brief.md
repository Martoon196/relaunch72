# Independent media audit repair status

PR #108 remains a draft for Claude’s independent review and integration. Both previously open proof gates now have executable tests and local evidence. Exact-head CI status is recorded in the PR. No media routes, production migrations or external effects were activated.

| Finding | Repair / remaining proof |
| --- | --- |
| 1. Renderer memory | Sequential encoding/demuxer concat and limits retained. Continuous three-minute live-action HD footage, letterboxed to 1920×1080 without upscaling or looping, passed the 1.5 GiB combined RSS watchdog. Actual decoded frame count: 4,320. Source provenance, preparation and measurements are committed; CI repeats the benchmark. |
| 2. Worker | Default-off supervised offline loop, token lease heartbeat, fenced retries (three attempts), SQL queue and stored-output caps. Requires genuine PG tests and operator service supervision before enabling. |
| 3. Zernio | Implemented native caption/video pair, native source adapter into canonical planning tables, existing connected-account enqueue and scoped JIT proof. Disposable PG clock advances three days; old planning attestations expire, fresh proof lasts exactly 15 minutes, real canonical begin-call reaches the enabled BEFORE UPDATE trigger. Withdrawal, expiry, erasure and cross-workspace cases are tested. No fake job inserts, disabled constraints, modified canonical functions or provider calls. |
| 4. Signup/billing | Removed standalone signup, its provisioning grant draft and UI, and separate Stripe checkout/webhook/receipt rail. Canonical paid-order and billing integration belongs to Claude. |
| 5. Deletion | Added owner tombstones, source-derived local-output takedown, bounded worker payload erasure and automatic staging/media/click retention. External provider and backup erasure still require canonical integration/operations. |
| 6. Owner screens | Replaced typed evidence hashes with document selection, removed displayed hashes and micro-USD labels, mandatory burned-in #ad, removed redundant video authorize action in favour of canonical approval. Private evidence checks remain preparatory. |
| 7. Range/status | No full-file rehash on range or status; immutable inode checks and short part receipts. Full integrity checks remain at assembly/probe/render boundaries. |
| 8. Docs/drafts | All three docs rewritten around actual unmounted modules. Superseded resumable draft/store/UI removed. No production migration numbers assigned or changed. |
| 9. Click beacon | Stable server-source/page/day nonce, constant-time application HMAC validation, dedicated backend record capability, cap index, 30-day retention; signing secret removed from SQL. Distributed scripted traffic remains possible; label counts unverified. |

## Evidence and remaining integration work

- `docs/rl72-media-audit-evidence/live-action-1080p-memory.json`: normal Node JIT benchmark, source hashes, decoded frames and exact limits.
- `docs/rl72-media-audit-evidence/live-action-strict-address-space-memory.json`: additional strict 1.5 GiB address-space run with Node JIT disabled; distinct from normal worker-mode evidence.
- `docs/rl72-media-audit-evidence/native-calendar-clock-proof.json`: local genuine-role PostgreSQL journey receipt.
- `orchestrator/test/tools/media-real-footage-memory.sh`: repeatable live-action benchmark. Film footage is a private technical fixture, never an affiliate advertisement or published asset.
- `orchestrator/test/db/creative-media-native-calendar-pg.integration.test.ts`: actual planner → enqueue → elapsed-clock → JIT → lease → calling test, with call-check receipt produced by the real trigger.
- The workflow’s `native-calendar-clock` job repeats the clock journey and real-footage benchmark independently of ordinary regressions.

Claude still consolidates/applies draft SQL, mounts the prepared routes/adapters, configures durable storage and real accounts, reviews the change and performs live end-to-end verification. Native calendar support matches the existing canonical Instagram/LinkedIn rail. Account inventory/webhook data in integration tests are explicit provider fixtures, not live OAuth proof.

No production deployment, provider publication, signup email or charge was performed.
