# Calendar social rail: safe resume checkpoint (superseded)

Checkpoint recorded on 2026-09-01 before the workstation was shut down.

> **Superseded after the 2026-09-01 resume and independent release review.**
> This file preserves the exact pre-shutdown history below; it is no longer an
> instruction to repeat the old three-blocker repair sequence.

## Current launch truth (2026-09-02)

The active launch candidate is **Zernio for Instagram and LinkedIn**, not
Ayrshare:

- the Growth HQ calendar publishes/reconciles through the Zernio posting rail;
- supported DMs, comment posts and comment threads enter the Zernio social
  inbox; and
- approved Instagram and LinkedIn comment replies use the same immutable
  draft → approval → decision → claim → settle evidence chain.

Migration `0080` remains the hardened calendar invariant layer. Migration
`0085` adds exact Zernio publish bindings and the Zernio-qualified
enqueue/lease/receipt path; `0086` adds exact LinkedIn comment replies without
weakening the existing Instagram ledger; `0087` replaces the owned-social row
in live-channel truth with Zernio-qualified connection, binding, cap, pause and
receipt evidence; and `0088` supplies the atomic connected-account-to-calendar
command. Migration `0089` then makes the central social-DM readiness row use
the same exact Zernio connection/account, approval, delivery, receipt and pause
evidence without retaining provider identifiers, message text or PII.

Approved PNG, JPEG and WebP media now crosses a dedicated signed public gateway.
Each 15-minute URL is bound to the workspace, job, exact storage key, SHA-256,
MIME type and expiry; the Growth HQ service reads and verifies the source bytes,
while the Zernio worker receives only the signing key and never the private
company-content bearer. Tampered, expired or mismatched requests fail with the
same generic not-found response. Video remains deliberately unsupported and
fails closed.

The controlled proof caps are **1 publication per UTC day and 3 per UTC month,
per exact Zernio account and network**. Enqueue and effect-time begin enforce
them, and the live-channel truth reports the same grain. Outbound calendar,
DM and comment-reply effects require provider effects ON and the emergency
pause OFF; inbox reads remain independently available. Partial activation
tuples fail closed.

Ayrshare remains in the repository only as dormant historical/replacement-
provider code. The detailed Ayrshare checkpoint below is intentionally retained
for provenance and recovery knowledge, but it is not authority to configure,
activate or describe the current launch.

## Historical Ayrshare post-resume resolution

- The storage-key allowlist now accepts the real
  `/api/internal/company-content/assets/.../file` shape while still rejecting
  traversal, double-slash, query-string and overlength inputs.
- Media resolution now finishes before the durable `calling` transition, so a
  local resolution failure cannot be recorded as an ambiguous provider call.
- The worker claims only its configured network set. Its legacy v1
  claim/load/begin privileges are explicitly revoked, and startup readiness
  proves that denial before accepting the v2 boundary.
- Migration `0080` now binds the exact planning target and owned-account digest,
  coordinates cancel/reschedule with provider begin, and uses the current exact
  `0040` revalidation proof and proof-media as effect-time freshness authority.
- The current line-ending-normalised migration checksum is
  `b76caf3a0cd48aa5de894a94662559df25f0c60de44e05ca97649082a91fb670`.
- Independent review found no remaining P0/P1 blocker to committing, pushing or
  deploying the release **dark**, with provider effects OFF and the emergency
  pause ON.

At this historical Ayrshare checkpoint, the sole remaining code blocker to
enabling Instagram/LinkedIn Ayrshare provider effects was provider-fetchable
media delivery. The company-content file route was an authenticated internal-
service endpoint, so Ayrshare could not supply its bearer and client headers.
That finding remains useful replacement-provider history; it is not the current
Zernio launch diagnosis.

## Historical durable state

- Branch: `codex/relaunch72-platform-foundation`
- Feature commit: `8ec572c4cc6c0ede5ae418fd65f65f63f212e55c`
- Commit title: `feat: connect calendar to Instagram and LinkedIn`
- The feature commit is local and was one commit ahead of the remote when this checkpoint began.
- Focused regression: 141/141 passing.
- Typecheck: passing.
- Current migration file after branch integration: `0080_instagram_linkedin_calendar_live_rail.sql`
- Pre-shutdown migration checksum for the historical, pre-hardening bytes: `167503ea35b96f1c0d46b48c26ca498af376ca46dfe282357dafe524b0a6f4b8`
- X is intentionally deferred. This slice targets Instagram and LinkedIn only.

## Historical production state at the checkpoint

- The then-named social migration `0066` (now `0080`) was **not** applied.
- Commit 8ec572c was **not** pushed or deployed.
- No production data was changed.
- No provider effect, social post, email, message, payment, or customer action occurred.
- The pending GitHub device-login process was cancelled before shutdown.
- The exact Neon production target remains project `round-morning-64548835`, branch `br-calm-surf-b22211ng`, database `neondb`.
- The main Property Predator service is out of scope and must not be altered.

## Historical release-review blockers at this checkpoint

1. **P0 — Property Predator media paths fail the then-named social migration `0066` (now `0080`) storage-key check.** The existing content adapter stores paths beginning `/api/internal/company-content/assets/...`, while the new job-media constraint requires an alphanumeric first character. Instagram requires media, so a real Instagram calendar enqueue would fail.
2. **P1 — local media-resolution failures are misclassified as ambiguous provider calls.** The worker marks a job as `calling` before resolving local media. A missing origin or invalid local media path can therefore become `outcome_unknown` even though Ayrshare was never contacted.
3. **P1 conditional — the claimant is network-blind.** A preserved runnable X job can be claimed by the Instagram/LinkedIn worker and rejected only after leasing, delaying or stranding work.

All three findings above were closed by the post-resume diff described in the
resolution section. They remain here only as an audit trail of why commit
`8ec572c` itself was not the reviewed release candidate.

## Historical dormant-Ayrshare resume sequence

1. Start in this repository and read this checkpoint first.
2. Confirm the branch and clean working tree.
3. Fix the three release-review findings and add focused regression coverage.
4. Complete the independent migration/worker review.
5. Run focused tests, full typecheck, and the disposable-database regression.
6. Commit the fixes locally.
7. Re-establish GitHub authentication and push the Codex branch.
8. Verify the remote exact commit before touching production.
9. At that checkpoint, verify the production ledger was exactly 65/65 and hold the then-named social migration `0066` for review. This historical step is not authority to skip the later reviewed `0066`–`0080` chain.
10. Deploy only the reviewed fixed commit to the existing Growth HQ services with provider effects OFF and emergency pauses ON.
11. Run health, readiness, authentication, calendar, responsive-browser, and worker checks.
12. Link only the exact owned Instagram and LinkedIn Ayrshare profiles, then request or confirm the precise controlled-proof scope before any public post. **Dormant historical step only; do not use for the current Zernio launch.**

This was the safe restart point used for the completed review. Current Zernio
activation instructions live in `docs/property-predator-owned-social-activation.md`;
do not use this historical Ayrshare sequence as authority to enable provider
effects.
