# 12 · Operator API for Claude — release notes

Date: 10 Nov 2026. Owner: Martin Howard. Decision records: `docs/decisions.md` D-079, D-080.
Full description: `docs/operator-api.md`.

The first operator API (commit 52ea7dc) was excluded from the webinar release after review found
authorization-code replay across instances and refresh tokens that were neither bound to their
client nor rotated. This branch rebuilds it on the released trunk (11a1045) with durable OAuth
state (migration 0148), adds follow-up sequence and owner email drafting tools, and prepares
recovery builds for both repositories.

Relaunch72 branch `claude/gifted-lamport-i4bdio`; recovery `claude/recovery-147-admits-0148`.
Group HQ branch `claude/gifted-lamport-i4bdio` (Alembic 0017, same design); recovery
`claude/recovery-main-admits-0017`.

Release order (owner approval required for each production step):
1. Relaunch72: merge to trunk, fast-forward the production branch, deploy with 0148 pending;
   `/ready` green. Apply 0148 with the migrator; `/ready` green; restart.
2. Group HQ: merging to `main` auto-deploys and runs `alembic upgrade head` (0017).
3. Set the operator settings (names in `docs/operator-api.md`), writes off. Owner adds the two
   claude.ai connectors and presses Allow once each; read tools verified; then decide on writes.
