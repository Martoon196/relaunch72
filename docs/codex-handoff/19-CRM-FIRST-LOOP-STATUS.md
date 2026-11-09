# 19 — CRM FIRST LOOP STATUS

**Measured:** 2026-08-24 on the local Codex branch.  
**External effects:** only the explicitly disposable Neon test database was
migrated and reset. No production database or customer data, deployment, push,
provider activation, purchase, message, social post or webinar was touched.

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
- `0001` was amended before its first successful managed-PostgreSQL application
  so its role bootstrap works without true superuser authority; `0002` remained
  unchanged. The proven `0001`–`0011` ledger is now the immutable baseline.
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
now includes canonical organization/workspace/owner provisioning, default Sales
pipeline creation, one-time setup consumption and first opaque-session issuance.
Those paths passed the disposable Neon proof, but the customer gate remains off
until the delivery/provider and operational gates below are complete. Read
[21-NATIVE-CUSTOMER-ONBOARDING.md](./21-NATIVE-CUSTOMER-ONBOARDING.md) and
[22-DURABLE-SETUP-DELIVERY.md](./22-DURABLE-SETUP-DELIVERY.md) for the exact
current boundary.

## Remaining cutover before a pilot

Canonical provisioning, atomic setup/session issuance and the destructive
disposable-Neon proof are complete. No legacy import is required because the
founder confirmed there is no legacy customer data.

1. Keep the verified PostgreSQL pool composition off until all remaining gates
   pass; exact migration readiness and no-fallback behavior are implemented.
2. Implement and test the transactional setup-email dispatcher without logging
   recipient addresses, decrypted setup URLs, raw setup tokens or raw leases.
3. Make paid-checkout provenance and the fulfilment claim database-native before
   any public purchase can trigger onboarding.
4. Redact the initial `?token=` query at every edge, proxy and application-log
   layer, and complete restore, alerting, key-rotation and distributed abuse-
   control runbooks.
5. Perform a real-browser acceptance pass for owner, sales and viewer roles.
6. Add page-specific cursor pagination before a workspace has meaningful data
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

The TypeScript suite covers the schema contracts, migration checksums, RLS
intent, isolated command-pool configuration, command transactions, read-model
validation, server-rendered UX, router/CSRF/notice behavior, timezone handling,
read-only membership and the create → move → complete service boundary.

The dedicated destructive command passed **2 tests, 0 failures and 0 skips**
against a disposable direct Neon database. It proved real PostgreSQL migration,
RLS, same-workspace foreign keys, append-only facts, immediate revocation,
atomic provisioning, setup reservation/consumption and first-session issuance.
The final sequential complete suite, including both real-Neon tests, reports
**577 passing tests, 0 failures and 0 skips**. TypeScript typechecking also
passes.
