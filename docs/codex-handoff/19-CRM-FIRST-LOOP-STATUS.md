# 19 — CRM FIRST LOOP STATUS

**Measured:** 2026-08-24 on the local Codex branch.  
**External effects:** none. No deployment, push, provider activation, purchase,
message, social post, webinar or live database was created.

---

## Outcome

The first durable CRM slice now exists as a complete application boundary:

1. create a contact, opportunity and optional first task;
2. read contacts, a default opportunity pipeline, tasks and recent CRM activity;
3. move an opportunity with optimistic concurrency;
4. complete a task with optimistic concurrency;
5. record history/activity and a transactional outbox event in the same database
   transaction;
6. replay a completed browser command without applying it twice.

The UI is server-rendered and responsive. It has explicit empty, validation,
conflict, unavailable and read-only states. There is no drag-and-drop theatre:
stage moves are labelled forms, and every mutation says that no external message
or provider action is triggered.

## Security and data boundaries

- Migration `0003_crm_first_loop.sql` adds contacts, contact points, pipelines,
  stages, opportunities, stage history, tasks, activity, command receipts and an
  append-only pending outbox.
- Every workspace-bearing table has forced row-level security and same-workspace
  foreign keys.
- Issued migrations `0001` and `0002` remain byte/checksum-immutable.
- `r72_web` can read visible CRM records but cannot mutate CRM tables.
- `r72_crm_command` is a separate `LOGIN NOINHERIT` identity and the only
  user-facing runtime role with CRM mutation grants. It cannot assume an owner
  or security-definer role, and ordinary runtime roles cannot assume it.
- Viewers receive no mutation controls; active membership and write permission
  are checked again by RLS for every statement.
- Browser mutations use a session-bound CSRF token, canonical command key,
  command receipt and row version where relevant.
- Success notices in query strings are session-signed; a bare or forged
  `?created` flag cannot claim that a lead was saved.
- Archived/deleted contact destinations fail as typed conflicts rather than
  creating an opportunity whose contact disappears from the normal read model.
- Browser wall times are resolved in the workspace IANA timezone; DST gaps and
  ambiguous clock folds fail validation instead of silently shifting a task.
- Mutation preflight uses one lightweight workspace/permission/defaults query;
  it does not load every contact, opportunity, task and timeline row before a
  save.

## What is not runtime-live yet

The currently deployed/legacy portal authenticates against JSON account files
and issues a signed tenant cookie. The local branch now also supports opaque
database sessions and a fail-closed PostgreSQL portal composition, but only
behind the explicit off-by-default `PORTAL_POSTGRES_ENABLED` gate. In that mode,
legacy signed cookies are rejected and every CRM transaction revalidates the
hashed session against its UUID user/workspace membership.

Those two modes remain intentionally **not interchangeable**. PostgreSQL mode
currently works only for a correctly migrated, pre-provisioned identity graph;
automatic onboarding and one-time setup are locked because their canonical
database commands do not exist yet. The gate must therefore stay off for
customer traffic. Read
[20-POSTGRES-PORTAL-CUTOVER-SLICE.md](./20-POSTGRES-PORTAL-CUTOVER-SLICE.md)
for the exact current boundary.

## Required cutover before a pilot

1. Provision canonical organization, workspace, user and membership rows for
   each accepted account, and atomically seed its default sales pipeline and
   stages. Migration `0003` seeds workspaces that already exist; future
   workspace creation does not yet have that canonical provisioning command.
2. Complete the new opaque database-session seam with atomic setup-token
   consumption and first-session issuance. Runtime sessions now store only token
   hashes and revoke normally, but PostgreSQL account setup is intentionally not
   implemented.
3. Keep the new verified `r72_web`, `r72_identity_command` and
   `r72_crm_command` pool composition off until all remaining gates pass. Exact
   migration readiness and no-fallback behavior are implemented.
4. Import/reconcile legacy JSON contacts with an explicit report; do not silently
   merge on display name.
5. Run `npm run test:db:integration` against an explicitly disposable PostgreSQL
   database and retain the result. The ordinary suite honestly skips this test
   when `TEST_DATABASE_URL` is absent.
6. Perform a browser acceptance pass for owner, sales and viewer roles before
   enabling the CRM capability in a customer workspace.
7. Add page-specific cursor pagination before a workspace has meaningful data
   volume. The pilot snapshot is intentionally simple and caps its timeline,
   but contacts, opportunities and tasks are not yet paginated.

## Provider boundary and cost consequence

The transactional outbox is pending-only in this slice. It proves where future
social, WhatsApp, webinar, email and automation adapters connect, but there is no
dispatcher and no provider effect is implied.

That is deliberate: the core CRM can be piloted without buying Mixpost,
Brand24, 360dialog, Temporal Cloud or an embedded automation licence. Current
scenario costs and purchase gates are in
[18-LAUNCH-COST-MODEL.md](./18-LAUNCH-COST-MODEL.md); provider evidence and
replaceability are in
[17-WHITE-LABEL-PROVIDER-MATRIX.md](./17-WHITE-LABEL-PROVIDER-MATRIX.md).

## Verification boundary

The TypeScript suite covers the schema contracts, migration immutability, RLS
intent, isolated command-pool configuration, command transactions, read-model
validation, server-rendered UX, router/CSRF/notice behavior, timezone handling,
read-only membership and the create → move → complete service boundary.

It is not evidence that PostgreSQL itself accepted the migration on this machine:
there is no local PostgreSQL/Docker runtime and no disposable
`TEST_DATABASE_URL`. That one integration test remains an explicit, visible skip
until the required test database is supplied. The final ordinary branch run
reports **511 passing tests, zero failures and one truthful skip**; TypeScript
typechecking also passes.
