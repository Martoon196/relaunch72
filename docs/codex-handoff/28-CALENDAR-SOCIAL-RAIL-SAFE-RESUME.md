# Calendar social rail: safe resume checkpoint (superseded)

Checkpoint recorded on 2026-09-01 before the workstation was shut down.

> **Superseded after the 2026-09-01 resume and independent release review.**
> This file preserves the exact pre-shutdown history below; it is no longer an
> instruction to repeat the old three-blocker repair sequence.

## Post-resume resolution

- The storage-key allowlist now accepts the real
  `/api/internal/company-content/assets/.../file` shape while still rejecting
  traversal, double-slash, query-string and overlength inputs.
- Media resolution now finishes before the durable `calling` transition, so a
  local resolution failure cannot be recorded as an ambiguous provider call.
- The worker claims only its configured network set. Its legacy v1
  claim/load/begin privileges are explicitly revoked, and startup readiness
  proves that denial before accepting the v2 boundary.
- Migration `0066` now binds the exact planning target and owned-account digest,
  coordinates cancel/reschedule with provider begin, and uses the current exact
  `0040` revalidation proof and proof-media as effect-time freshness authority.
- The current line-ending-normalised migration checksum is
  `b76caf3a0cd48aa5de894a94662559df25f0c60de44e05ca97649082a91fb670`.
- Independent review found no remaining P0/P1 blocker to committing, pushing or
  deploying the release **dark**, with provider effects OFF and the emergency
  pause ON.

The sole remaining code blocker to enabling Instagram/LinkedIn provider effects
is provider-fetchable media delivery. The current company-content file route is
an authenticated internal-service endpoint; Ayrshare cannot supply its bearer
and client headers. Before activation, the media resolver must return a
credential-free, short-lived signed URL bound to the exact immutable asset and
the release must prove a provider-style unauthenticated fetch returns the exact
MIME type and blob digest while expired or tampered URLs fail closed.

## Durable state

- Branch: `codex/relaunch72-platform-foundation`
- Feature commit: `8ec572c4cc6c0ede5ae418fd65f65f63f212e55c`
- Commit title: `feat: connect calendar to Instagram and LinkedIn`
- The feature commit is local and was one commit ahead of the remote when this checkpoint began.
- Focused regression: 141/141 passing.
- Typecheck: passing.
- Migration file: `0066_instagram_linkedin_calendar_live_rail.sql`
- Checkpoint migration checksum: `167503ea35b96f1c0d46b48c26ca498af376ca46dfe282357dafe524b0a6f4b8`
- X is intentionally deferred. This slice targets Instagram and LinkedIn only.

## Production state

- Migration 0066 was **not** applied.
- Commit 8ec572c was **not** pushed or deployed.
- No production data was changed.
- No provider effect, social post, email, message, payment, or customer action occurred.
- The pending GitHub device-login process was cancelled before shutdown.
- The exact Neon production target remains project `round-morning-64548835`, branch `br-calm-surf-b22211ng`, database `neondb`.
- The main Property Predator service is out of scope and must not be altered.

## Historical release-review blockers at this checkpoint

1. **P0 — Property Predator media paths fail migration 0066's storage-key check.** The existing content adapter stores paths beginning `/api/internal/company-content/assets/...`, while the new job-media constraint requires an alphanumeric first character. Instagram requires media, so a real Instagram calendar enqueue would fail.
2. **P1 — local media-resolution failures are misclassified as ambiguous provider calls.** The worker marks a job as `calling` before resolving local media. A missing origin or invalid local media path can therefore become `outcome_unknown` even though Ayrshare was never contacted.
3. **P1 conditional — the claimant is network-blind.** A preserved runnable X job can be claimed by the Instagram/LinkedIn worker and rejected only after leasing, delaying or stranding work.

All three findings above were closed by the post-resume diff described in the
resolution section. They remain here only as an audit trail of why commit
`8ec572c` itself was not the reviewed release candidate.

## Historical resume sequence

1. Start in this repository and read this checkpoint first.
2. Confirm the branch and clean working tree.
3. Fix the three release-review findings and add focused regression coverage.
4. Complete the independent migration/worker review.
5. Run focused tests, full typecheck, and the disposable-database regression.
6. Commit the fixes locally.
7. Re-establish GitHub authentication and push the Codex branch.
8. Verify the remote exact commit before touching production.
9. Verify the production migration ledger is exactly 65/65; apply 0066 atomically only if the expected state matches.
10. Deploy only the reviewed fixed commit to the existing Growth HQ services with provider effects OFF and emergency pauses ON.
11. Run health, readiness, authentication, calendar, responsive-browser, and worker checks.
12. Link only the exact owned Instagram and LinkedIn Ayrshare profiles, then request or confirm the precise controlled-proof scope before any public post.

This was the safe restart point used for the completed review. Current activation
instructions live in `docs/property-predator-owned-social-activation.md`; do not
use this historical sequence as authority to enable provider effects.
