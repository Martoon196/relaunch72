# Independent media audit repair status

PR #108 remains a draft. The branch is not approved for integration or live release. Review current code and CI; earlier green runs at 52173b7 do not validate these repairs.

| Finding | Repair / remaining proof |
| --- | --- |
| 1. Renderer memory | Sequential per-clip encoding + concat demuxer, Linux child address-space/CPU limits, RSS watchdog, input codec/resolution whitelist. Synthetic moving 180-second 1080p stress completed under 1.5 GiB with 193,524 KiB combined sampled peak RSS (see committed evidence). **Real camera-footage proof remains missing.** |
| 2. Worker | Default-off supervised offline loop, token lease heartbeat, fenced retries (three attempts), SQL queue and stored-output caps. Requires genuine PG tests and operator service supervision before enabling. |
| 3. Zernio | The old fake social job fixture with `session_replication_role=replica` was removed. **Canonical planner → multi-day scheduled video → actual calling trigger is not proved and the fresh-attestation adapter is not implemented.** The 15-minute canonical freshness rule remains; do not extend it or mount this path. |
| 4. Signup/billing | Removed standalone signup, its provisioning grant draft and UI, and separate Stripe checkout/webhook/receipt rail. Canonical paid-order and billing integration belongs to Claude. |
| 5. Deletion | Added owner tombstones, source-derived local-output takedown, bounded worker payload erasure and automatic staging/media/click retention. External provider and backup erasure still require canonical integration/operations. |
| 6. Owner screens | Replaced typed evidence hashes with document selection, removed displayed hashes and micro-USD labels, mandatory burned-in #ad, removed redundant video authorize action in favour of canonical approval. Private evidence checks remain preparatory. |
| 7. Range/status | No full-file rehash on range or status; immutable inode checks and short part receipts. Full integrity checks remain at assembly/probe/render boundaries. |
| 8. Docs/drafts | All three docs rewritten around actual unmounted modules. Superseded resumable draft/store/UI removed. No production migration numbers assigned or changed. |
| 9. Click beacon | Stable server-source/page/day nonce, constant-time application HMAC validation, dedicated backend record capability, cap index, 30-day retention; signing secret removed from SQL. Distributed scripted traffic remains possible; label counts unverified. |

## Required follow-up evidence

1. Run actual multi-minute 1080p camera footage under the stated memory limit. The available stress fixture is synthetic; do not relabel it real footage. The existing harness accepts `RL72_MEDIA_MEMORY_SOURCE` for a private local source.
2. Implement just-in-time canonical source revalidation, preserving 15-minute attestations and all exact version/brand/media checks. Prove planner-created jobs scheduled days ahead can reach calling with all FK/check/triggers enabled, and stale/withdrawn/erased media cannot. No fake job insertion, disabled triggers or replication-role bypass is acceptable evidence.
3. Independently review new maintenance privileges, bounded erasure retries, failure recovery, source-hash trust boundary and retention policy before mounting any component.

No live provider accounts, messages, charges, setup emails, migrations or deployment effects form part of this repair run.
