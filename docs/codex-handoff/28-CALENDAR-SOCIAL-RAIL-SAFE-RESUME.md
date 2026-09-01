# Calendar social rail: safe resume checkpoint

Checkpoint recorded on 2026-09-01 before the workstation was shut down.

## Durable state

- Branch: `codex/relaunch72-platform-foundation`
- Feature commit: `8ec572c4cc6c0ede5ae418fd65f65f63f212e55c`
- Commit title: `feat: connect calendar to Instagram and LinkedIn`
- The feature commit is local and was one commit ahead of the remote when this checkpoint began.
- Focused regression: 141/141 passing.
- Typecheck: passing.
- Migration file: `0066_instagram_linkedin_calendar_live_rail.sql`
- Migration checksum: `167503ea35b96f1c0d46b48c26ca498af376ca46dfe282357dafe524b0a6f4b8`
- X is intentionally deferred. This slice targets Instagram and LinkedIn only.

## Production state

- Migration 0066 was **not** applied.
- Commit 8ec572c was **not** pushed or deployed.
- No production data was changed.
- No provider effect, social post, email, message, payment, or customer action occurred.
- The pending GitHub device-login process was cancelled before shutdown.
- The exact Neon production target remains project `round-morning-64548835`, branch `br-calm-surf-b22211ng`, database `neondb`.
- The main Property Predator service is out of scope and must not be altered.

## Release review blockers: do not deploy 8ec572c as-is

1. **P0 — Property Predator media paths fail migration 0066's storage-key check.** The existing content adapter stores paths beginning `/api/internal/company-content/assets/...`, while the new job-media constraint requires an alphanumeric first character. Instagram requires media, so a real Instagram calendar enqueue would fail.
2. **P1 — local media-resolution failures are misclassified as ambiguous provider calls.** The worker marks a job as `calling` before resolving local media. A missing origin or invalid local media path can therefore become `outcome_unknown` even though Ayrshare was never contacted.
3. **P1 conditional — the claimant is network-blind.** A preserved runnable X job can be claimed by the Instagram/LinkedIn worker and rejected only after leasing, delaying or stranding work.

The shutdown interrupted the rest of the read-only migration audit, so the next run must complete that review after fixing these findings.

## Exact resume sequence

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

This is a safe restart point. Begin with correctness fixes, not production activation.
