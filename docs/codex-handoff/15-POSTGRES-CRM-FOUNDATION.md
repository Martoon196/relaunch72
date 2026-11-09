# 15 — POSTGRES + CRM FOUNDATION

**Status:** implementation design; nothing in this document is implemented yet.
**Inspected:** 2026-08-23, including the payment/auth/truth hardening currently present in the working tree.
**Scope:** the production data spine for Relaunch72 as a multi-workspace, white-label CRM + social + webinar platform.
**Rule used throughout:** every statement about the current product is tied to repository evidence; everything under **Proposed** is a design decision, not a claim about existing code.

---

## 1. Decision in one page

Relaunch72 should move to one managed PostgreSQL database as the authoritative store for identity, workspaces, CRM, billing projections, pipeline metadata, durable jobs, provider connections, idempotency receipts and the audit trail. Large/raw artifacts should not be stored as local paths forever: PostgreSQL stores their ownership, provenance, status and content hash; object storage stores the bytes.

The first database release should **not** try to ship every GoHighLevel feature. It should establish the invariants that every later feature depends on:

1. A global `user` can explicitly belong to one or more isolated `workspaces` through `workspace_memberships`.
2. Every customer-owned row carries `workspace_id`; cross-workspace relations use composite foreign keys so a record from workspace A cannot be attached to workspace B.
3. PostgreSQL Row Level Security (RLS) is enabled and forced on every workspace-owned table. The application sets request identity and workspace context inside a transaction.
4. Orders and subscriptions bind to a workspace by immutable IDs, never by an email join.
5. Verified provider events are claimed with unique constraints; replay protection is a transaction, not a separate `has()` check.
6. No payment grants value unless it matches a server-created checkout intent and exact provider Session/commercial facts.
7. Intake acceptance, paid-entitlement consumption, workspace creation and job enqueue happen atomically.
8. A database-backed job queue replaces detached child processes and manual/calendar-only ticks.
9. External effects use a transactional outbox and idempotency keys. Workers are at-least-once; handlers must be effect-idempotent.
10. CRM stage belongs to an `opportunity`, not a `contact`; contacts may have multiple opportunities and multiple contact points.
11. Consent is an append-only evidence record. Suppression is enforced before every message/publish job.
12. `mock` versus `live`, `draft` versus `approved`, and `scheduled` versus `published` are stored states, not wording inferred by the UI.

The existing TypeScript boundaries make this feasible without throwing away the valuable parts. `CrmStore`, `AccountStore`, `OrderStore`, `SubscriptionStore`, the manager `ActionRunner`, and the mock/live provider interfaces are already seams. The main refactor is to make all persistence asynchronous and transaction-aware, then move filesystem calls behind an artifact abstraction.

---

## 2. Current state — repository evidence

This section describes what exists **now**. It is not the target model.

| Area | Current implementation | Consequence for the database move |
|---|---|---|
| CRM persistence | `JsonCrmStore` serializes a single in-memory `State` containing tenants, contacts, activities and integer counters to one JSON file (`orchestrator/src/crm/store.ts:29-38,120-128`). | No concurrency control, constraints, migrations or durable tenant isolation. The store interface is already asynchronous, which is a useful adapter seam. |
| Workspace | `Tenant = { id, name, runDir?, createdAt }` (`orchestrator/src/crm/types.ts:16-22`). | Current `Tenant` maps to the proposed `workspace`, not to a user or commercial organisation. |
| Login | One `Account` contains one email and one `tenantId` (`orchestrator/src/portal/accounts.ts:21-29`). `findByTenant` assumes one account mapping (`orchestrator/src/portal/accounts.ts:139-140`). | One user cannot belong to multiple workspaces; there is no membership or role model. |
| Password/setup safety | Current working tree uses versioned salted scrypt, migrates old SHA-256 hashes after successful login, and supports hashed one-use setup tokens (`orchestrator/src/portal/accounts.ts:69-94,143-221`). Token claims and login throttling are process-local (`orchestrator/src/portal/accounts.ts:98-99`; `orchestrator/src/portal/session.ts:18-61`). | Preserve these hashes during import; do not force-reset every existing account. Database conditional token consumption and a shared limiter must replace the single-instance guards before horizontal scaling. |
| Portal session | The current cookie is HMAC context/audience separated and strictly validates its payload, but that payload still carries the tenant ID directly (`orchestrator/src/portal/session.ts:80-109`); routes use that ID as the data scope (`orchestrator/src/portal/router.ts:98,152-205`). | The hardening prevents cross-token/confused-payload use, but a self-contained signed ID still cannot re-check membership/revocation on each request. Replace it with a server-side user session plus an explicitly selected workspace. |
| Tenant filtering | `tenantView` filters contacts and activities by `tenantId`, but `moveContact(contactId, stage)` looks up a globally supplied contact ID and has no caller tenant argument (`orchestrator/src/crm/store.ts:90-98,107-116`). | Future CRUD endpoints could mutate another tenant's row if they call this shape. PostgreSQL RLS and workspace-qualified repository methods must make that impossible. |
| CRM depth | Contact carries the single fixed pipeline stage; the only stages are `lead/contacted/qualified/won/lost` (`orchestrator/src/crm/types.ts:13-14,24-32`). | Introduce pipelines, stages and opportunities. Migration can create one default opportunity per legacy contact to preserve the current board. |
| Activity | Activities are typed (`contact_created`, `stage_changed`, `message_sent`, `rail_run`, `note`) and workspace-owned (`orchestrator/src/crm/types.ts:9-11,34-42`). | Preserve the timeline as an immutable projection, but do not confuse it with a durable job/event log. |
| Lead capture | When explicitly enabled, `/api/subscribe` validates an email and calls Brevo directly; `/api/intake` gates and builds; neither creates a CRM contact (`orchestrator/src/server/app.ts:268-339`). Subscribe has no durable consent/idempotency record or shared abuse throttle. Contacts are otherwise seeded during the explicitly enabled demo path (`orchestrator/src/portal/provision.ts:126-149`). | New capture commands must create/dedupe a contact, consent evidence and attribution touch in one transaction. Public capture also needs a shared/edge rate limit; retries need command idempotency. |
| Orders | JSONL append log keyed by Stripe checkout session, with `paid_awaiting_intake/building/nudge_returned` (`orchestrator/src/server/orders.ts:10-29,49-75`). | Replace read-then-update with an atomic conditional transition. `session_id` becomes a unique external key. |
| Current intake hardening | A valid intake now requires server-side acknowledgement, a paid order and the private sandbox gate, strips transport metadata, claims before side effects, derives permitted build scope from that order and treats the Stripe session as the duplicate key (`orchestrator/src/server/app.ts:283-339`; `orchestrator/src/intake/canonical.ts:1-18`; `orchestrator/src/server/entitlements.ts:1-71`). | This closes the simple public-build, missing-consent and caller-selected-scope holes in one process. It is not a multi-instance compare-and-set because the file store has no conditional update primitive. The database transaction is the permanent fix. |
| Stripe replay hardening | Current working tree journals Stripe event IDs in another JSONL store and checks `has()` before processing (`orchestrator/src/server/app.ts:220-265`; `orchestrator/src/server/orders.ts:31-47,92-116`). | Correct direction, but `has()` then `record()` can race across processes. `INSERT ... ON CONFLICT DO NOTHING` must be the claim. |
| Order projection hardening | The webhook now records an order only when the Session is absent and otherwise enriches null receipt fields without resetting status/product scope (`orchestrator/src/server/app.ts:233-250`). | This closes the distinct-event state regression in one process. The file `find/record/update` sequence is still not an atomic cross-process unique/CAS; PostgreSQL keeps Session uniqueness and separates financial from fulfilment state. |
| Subscription ownership | Subscription records are indexed by email (`orchestrator/src/server/subscriptions.ts:28-51,163-170`); portal billing resolves tenant → account email → newest subscription (`orchestrator/src/portal/billing.ts:44-66`). | Email is mutable and not an entitlement key. Add `workspace_id`, `billing_customer_id` and unique Stripe IDs. |
| Subscription checkout identity | Besides the authenticated portal action, sandbox-gated public `POST /api/subscription` accepts caller-supplied plan/email and starts Checkout when the shared readiness gate is open (`orchestrator/src/server/app.ts:210-217`; authenticated path at `orchestrator/src/portal/router.ts:178-188`). | A recurring platform checkout must be bound to an authenticated workspace or a signed, single-use commercial invitation. Caller email alone must not create entitlement. |
| Subscription event order | Webhook mapping receives application processing time (`orchestrator/src/server/app.ts:252-255`) and `mergeSub` always lets the later-processed patch replace status (`orchestrator/src/server/subscriptions.ts:150-160`). The current `StripeEvent` shape carries optional ID/type/data but not the provider event's `created` time (`orchestrator/src/server/stripe.ts:19-23`). | A delayed older webhook can regress the projection. Store provider event time/ID and apply state transitions only when the event is not older than the projection (or reconcile from Stripe). |
| Platform versus merchant billing | The current catalog and checkout code sell Relaunch72's own one-off offers and recurring platform plans (`orchestrator/src/server/catalog.ts:15-45`; `orchestrator/src/server/stripe.ts:45-101`). | This is **platform billing**, not a client's payment processor. Future invoices/order forms/client payments need a separate workspace-owned merchant ledger and connected-account model; never overload Relaunch72's own `orders`/`subscriptions`. |
| Checkout provenance | Checkout creation has no durable local intent row (`orchestrator/src/server/stripe.ts:35-55,65-89`). `orderFromEvent` accepts any paid payment-mode session in the shared Stripe account whose metadata names a valid tier; it records amount/currency but does not compare session, price, amount or currency with a server-originated expectation (`orchestrator/src/server/stripe.ts:113-132`). | Valid metadata is not proof that this application created the purchase. Persist an intent first and require exact intent/session/mode/livemode/price/amount/currency agreement before creating an order or subscription entitlement. Unrelated Stripe products must never launch a build. |
| Intake claim | Stripe redirects with the Session ID in the success URL (`orchestrator/src/server/stripe.ts:47-52`). Beyond the shared private-sandbox code, intake treats posted `_stripe_session` as the order-specific locator/claim credential and consumes the order (`orchestrator/src/server/app.ts:283-315`). | Before public launch, a leaked/referrer-copied Session ID must not let another browser consume the purchaser's one build. Session ID is an identifier, not order-specific authorisation. Require an authenticated purchaser or a separate one-use high-entropy intake claim grant bound to the checkout intent/order. |
| Subscription provenance | The event mapper accepts subscription lifecycle objects by subscription ID, retains an unrecognised price as the plan value and considers `active`/`trialing` sufficient to unlock the platform (`orchestrator/src/server/subscriptions.ts:25-42,69-91,117-145`). Portal ownership is then resolved by account email (`orchestrator/src/portal/billing.ts:44-66`). | An unrelated subscription in the same Stripe account must not become a Relaunch72 entitlement. Establish the provider subscription ID through the exact server-created Checkout intent/session, require an allowed price/plan, and bind it to organisation/workspace IDs before lifecycle events can update access. |
| Background builds | Intake plus a scoped `.job.json` sidecar are written to disk and `npx tsx ...` is spawned detached (`orchestrator/src/server/index.ts:38-70`). The HTTP order's `run_dir` is actually the intake JSON path returned by `createKick`, not the pipeline output directory (`orchestrator/src/server/app.ts:322-339`). | The sidecar improves auditability but is not a claimed/leased/retryable queue. A deploy, host sleep, spawn error or worker crash can leave an order in `building` with no owner or recovery path. Do not import `orders.run_dir` as an artifact directory; replace the detached process with a durable job. |
| Post-commit side effects | Customer Brevo sync is launched without awaiting after a webhook receipt is recorded (`orchestrator/src/server/app.ts:258-263`). Accepted portal intake invokes another non-awaited callback (`orchestrator/src/server/app.ts:332-337`), and the callback provisions/logs failure in process (`orchestrator/src/server/index.ts:207-213`). | A crash or provider outage can lose marketing sync, account provisioning or setup-email delivery with no replayable intent. Insert durable outbox work in the same transaction as the triggering state; make each handler idempotent and recoverable. |
| Fulfilment readiness | Portal setup delivery is correctly disabled in production without Postmark and a portal base URL, but those facts only decide whether `onIntakeAccepted` exists (`orchestrator/src/server/index.ts:148-164,207-215`). The one-off build blocker is composed separately (`orchestrator/src/server/index.ts:217-218`), and a portal-entitled intake still returns `building` when the callback is absent (`orchestrator/src/server/app.ts:332-339`). | Readiness must be capability-aware: Core/Pro cannot accept live money unless their portal/setup-delivery path can durably enqueue, while a non-portal Autopsy need not require it. Provision status/failure belongs in the order/run read model, not logs. |
| Split fulfilment runs | For a portal product, intake starts the detached CLI and separately fires portal provisioning (`orchestrator/src/server/app.ts:322-337`; `orchestrator/src/server/index.ts:207-213`). Portal provisioning calls `generateBrandBrain`, which hard-codes `MockClient` (`orchestrator/src/portal/provision.ts:77-90`; `orchestrator/src/portal/run.ts:41-55`). The paid CLI and portal artifacts have no shared run ID. | Create one canonical `pipeline_run` from the paid order. Portal/admin/delivery read that run's versioned artifacts; any deliberate mock preview is a separate explicitly labelled run, never the customer's paid fulfilment record. |
| Product/build scope | The verified order maps through immutable code-owned entitlements (`autopsy → S1/no portal`; Core/Pro → S9/portal), and `createKick` writes a `.job.json` sidecar with that scope (`orchestrator/src/server/entitlements.ts:8-71`; `orchestrator/src/server/index.ts:38-70`). | Preserve this fail-closed mapping as versioned product/entitlement data on the order and durable job. Browser/intake fields must never select scope. |
| Live-money readiness | Shared readiness helpers block live Stripe keys until the PostgreSQL durable-job foundation is active; one-off checkout additionally requires build readiness, recurring plans remain preview-only unless explicitly enabled, and public test checkout is sandbox-code gated (`orchestrator/src/server/readiness.ts:10-39`; public routes at `orchestrator/src/server/app.ts:149-150,198-217`; portal wiring at `orchestrator/src/server/index.ts:166-172`). | Keep the fail-closed rule in a shared checkout command/service during the database refactor so every future route and white-label surface inherits it. |
| Portal billing URLs | Subscription success/cancel and billing-portal return URLs are built from the funnel `publicBaseUrl` (`orchestrator/src/server/stripe.ts:79-97`), while setup delivery separately recognises `PORTAL_BASE_URL` as the service that mounts `/portal` (`orchestrator/src/server/index.ts:148-159`). | Return targets must be derived server-side from the verified platform/organisation domain registry and the correct portal route. Store a return-origin key on the intent; never trust a caller URL or assume the funnel origin serves the portal. |
| Order state vocabulary | `nudge_returned` is declared in `OrderStatus`, but no source path writes it; it appears only in a negative-path test (`orchestrator/src/server/orders.ts:10`; `orchestrator/test/server.test.ts:402`). | Define independent financial/fulfilment transitions in SQL/domain code. Do not carry a status into either new state machine merely because it existed in a TypeScript union. |
| Pipeline output | A run directory holds `manifest.json`, raw attempts and stage JSON; manifest is rewritten after stage progress (`orchestrator/src/runs/manifest.ts:12-48`; `orchestrator/src/stages/runner.ts:65-181`). | Keep the manifest semantics, but persist run/stage/attempt metadata transactionally and put raw/output files behind `ArtifactStore`. |
| Portal artifacts | Dashboard reads `s3.json`, `cc.json`, `keyword-report.json`, `ad.json` and `s8.json` directly from `Tenant.runDir` (`orchestrator/src/portal/data.ts:28-68`). | Local paths cannot support horizontally scaled web/worker processes. Dashboard must query artifact metadata/read models. |
| Manager cadence | Due work is derived only from date rules; there is no last-run memory (`orchestrator/src/manager/schedule.ts:1-36`). CLI loads a JSON roster or demo constants (`orchestrator/src/manager/cli.ts:42-61`). | Store schedules and execution windows. A unique `(schedule, window)` key prevents duplicate ticks. |
| Manager execution | `runTick` loops in-process and converts thrown errors to entries (`orchestrator/src/manager/engine.ts:62-75`). Portal's Run button executes generation during the request (`orchestrator/src/portal/router.ts:197-204`; `orchestrator/src/portal/run.ts:63-101`). | API requests should enqueue and return a run/job ID. Workers own long-running work, leases, retry and recovery. |
| Live social connection | `AyrsharedPublisher` accepts one API key and optional profile key from environment (`orchestrator/src/social/ayrshare.ts:35-56`). Account linking is delegated to the provider's hosted flow and no workspace connection model exists (`orchestrator/src/social/ayrshare.ts:84-88`). | Provider credentials and account mappings must be workspace-scoped. No secret/profile key should be global when serving multiple workspaces. |
| Social result model | The adapter already distinguishes `scheduled/published/failed` and carries provider ID/cost (`orchestrator/src/social/types.ts:30-55`). | Persist this useful truth model instead of reconstructing it from activity copy. |
| Ads safety | Ads interface only creates `paused_draft` or `failed` and states that campaigns must not auto-spend (`orchestrator/src/ads/types.ts:1-44`). | Make approval and paused state database invariants before a provider job can be dispatched. |
| Consent | The browser review UI disables Send without one intake/privacy confirmation and the server now independently requires it (`orchestrator/src/intake/form.ts:482-501`; `orchestrator/src/server/app.ts:287-297`). | Preserve this as an enforced intake/privacy acknowledgement, but record policy text/version/time. It is not communication-channel marketing consent; build separate append-only consent events and suppressions. |
| Existing-account provisioning | The current hardening resolves an existing email to its persisted account/tenant rather than returning a newly computed tenant ID (`orchestrator/src/portal/provision.ts:59-74`). | Preserve that correction. PostgreSQL generalises it to global user + explicit organisation/workspace memberships and returns persisted IDs; it never recomputes ownership from a submitted business name. |
| Admin | One shared admin password gates all runs; sign-off actor is the hard-coded string `Martin Howard` (`orchestrator/src/server/admin/router.ts:47-75,90-107`). | Migrate admin to normal users/platform roles and record the actual user ID on sign-off/audit rows. |
| Hosting | Render config starts one free web service and notes local data/build loss without a disk (`render.yaml:11-21,62-73`). | Production needs `DATABASE_URL`, a web process and at least one worker. Object storage removes dependence on shared disks. |

### Important current-data ambiguity

There are two kinds of run directory today:

- Portal provisioning creates `DATA_DIR/portal-runs/<tenantId>` and stores that path on the tenant (`orchestrator/src/portal/provision.ts:73-86`).
- The detached CLI creates a separate timestamped run under `RELAUNCH72_RUNS_DIR` (`orchestrator/src/runs/manifest.ts:12-31`). Its manifest source is only the intake filename without the extension (`orchestrator/src/cli.ts:56-69,107-110`).

The import must not assume these are the same run. It may link a CLI run to an order only when the manifest source exactly matches the basename of that order's stored intake file; ambiguous matches go to a migration-anomaly report.

---

## 3. Proposed tenancy model

### Terms

| Term | Meaning | Why it exists |
|---|---|---|
| `platform` | Relaunch72 itself. | Owns system administration and product configuration; it is not a customer workspace. |
| `organization` | The commercial/white-label account. A direct customer may own one workspace; an agency/reseller may own many. | Gives us a clean home for billing ownership, custom domain/branding and reseller administration without weakening workspace isolation. |
| `workspace` | One operational business/sub-account whose contacts, opportunities, social accounts, campaigns, webinars and AI artifacts are isolated. | This is the direct replacement for today's `Tenant`. |
| `user` | A global human identity identified by verified email. | One person can work in multiple workspaces without duplicate credentials. |
| `membership` | An explicit active grant from user to organisation or workspace with a role. | Authorization is based on grants, not email or a tenant ID embedded in a cookie. |

An organisation hierarchy must **not** create implicit read access in the first release. When an agency owner needs a client workspace, create an explicit `workspace_membership` linked to the exact source organisation membership. The RLS access helper requires both grants to remain active; revoking the organisation membership therefore invalidates derived workspace access immediately, after which a cleanup command marks the derived rows revoked. This costs a few rows and prevents a transitive-policy bug from exposing every client in an agency.

### Reusable-core boundary

Reuse this kernel—migrations, workspace/auth/RLS, CRM commands, jobs/outbox, artifacts and provider adapters—as packages, but deploy a separate database per top-level product initially. Organisation branding handles Relaunch72's customer/agency white labels; it should not silently turn unrelated owned products into tenants of one data plane. If a later commercial decision genuinely needs one control plane, add `platform_applications` above organisations and include its ID in domain/catalog namespaces before importing another product. Do not retrofit a vague `brand_id` onto rows without defining the cross-product operator and data-access rules.

### Roles

- Platform: `platform_admin`, `support`, `auditor`.
- Organisation: `owner`, `admin`, `billing`.
- Workspace: `owner`, `admin`, `marketer`, `sales`, `viewer`.

RLS answers “may this principal touch this workspace?” Fine-grained actions such as billing, publishing, deletion and connection management remain application permissions checked before the transaction. Do not encode a rapidly changing product-permission matrix in dozens of RLS policies.

### Session change

Replace the signed `{ tid, exp }` portal cookie with an opaque 256-bit random session token. Store only its SHA-256 hash in `user_sessions` with `user_id`, expiry, revocation and selected `workspace_id`. Every request:

1. begins a transaction and passes the presented token's hash to a narrowly granted `SECURITY DEFINER` auth function that returns only the safe session identity (runtime roles have no raw session-table read);
2. confirms the user and membership are still active;
3. creates a request context containing `user_id`, `workspace_id`, roles and request ID;
4. installs that context in the same transaction using `set_config(..., true)` before any workspace query.

This allows immediate revocation and workspace switching. State-changing browser requests also need CSRF protection; `SameSite=Lax` alone is not the full authorization model.

---

## 4. Non-negotiable database invariants

These are database rules, not conventions in controller code.

1. **All operational customer data contains `workspace_id uuid NOT NULL`.** Organisation branding/membership is deliberately organisation-scoped; global identity/product configuration is global. The remaining exceptions are narrowly restricted pre-workspace acquisition/billing rows (for example a just-received Stripe event or paid order waiting for intake). Those rows become workspace-bound atomically at provisioning and are not exposed through tenant RLS beforehand.
2. **All workspace relationships are same-workspace relationships.** Every tenant table has `UNIQUE (workspace_id, id)` and child tables reference `(workspace_id, parent_id)`. Globally unique UUIDs alone are not enough: a programming error must not link workspace A's message to workspace B's contact.
3. **RLS is `ENABLE`d and `FORCE`d.** A migration test fails if a registered workspace table lacks either flag.
4. **Runtime roles do not own tables and never have `BYPASSRLS`.** Separate migration ownership from web, worker and webhook roles.
5. **Email and phone are normalised once.** Use `citext` for user/email equality and application-normalised E.164 phone values. Preserve original display values separately.
6. **Money uses integer minor units plus ISO currency.** No floating-point revenue columns.
7. **External IDs are unique in their actual provider namespace.** Examples: globally scoped event IDs use `UNIQUE(provider, external_event_id)`; account-scoped IDs include `provider_connection_id`/external account scope. Never assume an ID is global when a provider only promises per-account uniqueness.
8. **Consent evidence is append-only.** Corrections add a new event; they do not rewrite history. Effective consent is a view/projection of the latest applicable event plus suppressions.
9. **Activity/audit events are append-only.** The user-facing summary may be a projection, but actor, correlation and source payload are retained.
10. **Mock/live is explicit.** Pipeline runs, artifacts, provider operations and metrics carry `execution_mode CHECK (execution_mode IN ('mock','live'))`.
11. **Publishing is stateful.** A live publish job can only be created for an approved item, and provider success is the only thing that sets `published_at`.
12. **Paid entitlement consumption is conditional.** One SQL update/transaction requires `financial_status = 'paid' AND fulfilment_status = 'awaiting_intake'`, records consumption and moves fulfilment to `build_queued`; a second caller gets the existing intake/run.
13. **Webhook receipt claim and projection update share a transaction.** There is no `has()`/`record()` race.
14. **Jobs are at-least-once, effects are idempotent.** A job can run again after a lease expires. Each handler owns a stable effect key.
15. **Large/private bytes are not local-path state.** Artifacts have a storage key/URI, hash, size and workspace owner; local filesystem is only a development adapter.
16. **Soft deletion is the default for business records.** Legal erasure is a separate, audited workflow that removes or anonymises dependent data deliberately.
17. **Provider ordering is explicit.** Billing/message/publish projections retain provider event time and last event ID; a late older event cannot silently move state backwards.
18. **Only one conflicting execution owns an aggregate at a time.** Manual clicks, schedules and retries share a unique run/effect key or advisory/row lock; two portal clicks cannot overwrite the same artifact set concurrently.
19. **Tenant work is never “global by accident.”** A tenant job/outbox/provider event requires `workspace_id`. The few pre-workspace/system job types use an explicit database CHECK/allowlist and a restricted handler; a missing workspace cannot turn an ordinary customer payload into platform-wide work.
20. **Payment provenance is local and exact.** A verified provider signature proves Stripe sent an event; it does not prove the Session belongs to Relaunch72's catalogue. Entitlement requires a server-created intent plus exact Session and expected commercial facts.
21. **Interactive edits detect stale state.** Mutable user-edited aggregates carry `row_version`; commands update with the expected version and return a conflict instead of silently overwriting a newer browser/automation edit.
22. **Workspace assignees are workspace members.** Owner/assignee FKs use `(workspace_id,user_id) → workspace_memberships`; assignment commands require that membership to be active. Historical ownership can remain attributable after later revocation.
23. **Provider Session IDs are identifiers, not bearer authority.** Consuming paid intake also requires the authenticated purchasing principal or a separate hashed, expiring, one-use order claim grant.

For append-only tables, runtime roles receive `SELECT`/`INSERT` but no `UPDATE`/`DELETE`; “correction” commands insert superseding events. A narrowly authorised, audited legal-erasure function may redact/delete subject data according to retention policy. Append-only must not become an excuse to make unlawful personal data immortal.

---

## 5. Proposed schema — foundation release

Use PostgreSQL UUID primary keys (`gen_random_uuid()`), `timestamptz`, `jsonb`, `citext`, explicit `CHECK` constraints and partial unique indexes. Keep external provider IDs as text. Use snake_case in SQL and map to the current camelCase TypeScript domain types in repositories.

### 5.1 Identity, white label and workspaces

| Table | Required columns and constraints |
|---|---|
| `organizations` | `id`, `name`, `slug`, `kind direct_customer\|agency`, `status`, `created_at`, `updated_at`; unique lower-case slug. |
| `organization_branding` | `organization_id PK`, product name, organisation-scoped logo storage reference/hash, colours and support email. No CRM data belongs here. |
| `organization_domains` | `id`, organisation, optional workspace constrained to that organisation, lower-case hostname unique globally, purpose `portal\|funnel\|forms\|tracking`, status pending\|verified\|disabled, verification challenge/time, primary flag and timestamps. Only verified domains route traffic or become checkout return origins. |
| `workspaces` | `id`, `organization_id`, `legacy_tenant_key`, `name`, `slug`, `status active\|suspended\|archived`, `timezone`, `locale`, `currency`, settings JSON, timestamps; unique `(organization_id, slug)` and unique non-null legacy key. |
| `users` | `id`, `email citext UNIQUE`, `password_hash`, `email_verified_at`, `status pending\|active\|suspended`, timestamps. Do not put `workspace_id` here. |
| `organization_memberships` | organisation/user composite key, role, status, granted/revoked metadata. |
| `workspace_memberships` | workspace/user composite key, role, status `invited\|active\|suspended\|revoked`, optional source `(organization_id,user_id)` membership, timestamps. Composite FKs require that source user match and that the organisation own the workspace. `active` grants access only while any source organisation membership is also active. This is the authorization source. |
| `membership_invitations` | `id`, invited email, user when resolved, organisation/workspace and intended roles, source order/inviter, status pending\|accepted\|expired\|revoked, expiry/accepted timestamps. Acceptance activates the exact invited organisation/workspace memberships in one transaction. Receipt email alone never changes an existing active grant. |
| `identity_action_tokens` | `id`, user, purpose `account_setup\|membership_claim\|password_reset`, token SHA-256 hash unique, optional membership invitation, expiry, consumed/revoked timestamps and request metadata. Conditional `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` makes use single-shot across instances; raw tokens never persist. |
| `user_sessions` | `id`, `token_hash UNIQUE`, `user_id`, selected workspace, expiry/revocation/last-seen, IP/user-agent hashes and CSRF material. Session deletion/revocation takes effect immediately. |
| `platform_memberships` | user/role, status. Replaces the shared `ADMIN_PASSWORD`. |

### 5.2 Billing and paid intake

These are the **Relaunch72 platform commercial ledger**: what a customer paid Relaunch72 for and which product capabilities that purchase grants. They are deliberately separate from the workspace-owned merchant/payment tables proposed in section 6. This avoids mixing a client's buyers and funds with Relaunch72's own Stripe customers, revenue and subscriptions.

| Table | Required columns and constraints |
|---|---|
| `checkout_intents` | `id`, origin `server\|legacy_import`, kind `one_off\|subscription`, nullable organisation/workspace/invitation, internal product/plan key and immutable entitlement version, expected provider price ID/amount minor/currency/mode/livemode, server-resolved return-origin key/route, purchaser email, request idempotency key unique, provider idempotency key unique, nullable Stripe session ID unique, status `created\|session_created\|completed\|expired\|cancelled`, expiry and timestamps. Live server-origin rows require every expectation; nullable unknowns are allowed only on quarantined historical imports. This row is mandatory before a new webhook can grant anything. |
| `order_claim_grants` | checkout intent/order, token SHA-256 hash unique, purpose `intake`, delivery channel `browser\|email`, expiry, consumed/revoked timestamps, consumed intake ID and request metadata. Raw browser grants use a secure first-party mechanism and never logs/URLs; fallback receipt-email links are one-use. A conditional consume occurs in the paid-intake transaction. |
| `billing_customers` | `id`, nullable `organization_id`/default `workspace_id` while pre-provision, provider, external customer ID, purchaser email, timestamps; unique provider/external ID. Once provisioned it binds to the commercial organisation; workspace entitlement resolution still uses immutable workspace IDs, never email. |
| `orders` | `id`, nullable `organization_id`/`workspace_id`, `billing_customer_id`, Stripe checkout session/payment-intent IDs, tier, bump, immutable entitlement snapshot/version, amount minor, currency, `financial_status` (`paid\|partially_refunded\|refunded\|dispute_open\|dispute_won\|dispute_lost`) and independent `fulfilment_status` (`awaiting_intake\|build_queued\|fulfilling\|fulfilled\|failed\|cancelled`), paid/consumed timestamps; unique Stripe session/payment intent. A CHECK enforces post-intake fulfilment states have organisation/workspace and `consumed_at`. Intake rejection/nudge state belongs on `intake_submissions`, not the commercial order. A fulfilled order can truthfully become refunded without erasing that it was delivered. |
| `subscriptions` | `id`, `organization_id NOT NULL`, optional directly scoped workspace, billing customer, provider subscription ID, price ID, internal plan key, status, period dates, cancellation fields, last provider event ID/time and provider-updated timestamp; unique provider/subscription ID. Workspace capabilities are materialised in `workspace_entitlements`; no email ownership lookup. |
| `stripe_events` | Stripe event ID PK, origin `live_payload\|legacy_receipt`, type, provider-created time, livemode, API version, payload JSON, metadata, received/processed timestamps, status `received\|deferred\|processed\|ignored\|rejected`, retry time/reason and error. Live rows require payload; null is allowed only for explicitly marked legacy receipt imports. Insert is the replay claim. A transient processing failure rolls back the receipt/projection transaction so Stripe can retry; an out-of-order event awaiting its locally proven checkout link is durably deferred; only terminal unsupported/invalid events commit as ignored/rejected. Restrict payload access to webhook/support roles. |
| `intake_submissions` | `id`, nullable `workspace_id` for a rejected pre-provision attempt, `order_id`, submitted payload JSON, S0 result JSON, status accepted\|rejected\|building\|complete\|failed, privacy acknowledgement fields, submitted/accepted timestamps. A partial unique index allows only one non-rejected/accepted intake per order while preserving corrected rejected attempts. Strip transport-only `_stripe_session` from the canonical payload. |
| `workspace_entitlements` | workspace, capability key, source subscription/order/manual, limits JSON, active interval. This is the stable runtime feature gate and is distinct from the immutable `BuildEntitlement` snapshot on a one-off order; UI code should not infer capability from Stripe status directly. |
| `usage_ledger` | append-only workspace/capability/quantity/unit/cost, source operation/attempt and time. A unique `(source_type,source_id,meter_key)` prevents a retried job/provider webhook charging usage twice. Supports metered email, SMS, AI and video without rewriting CRM entities. |

Subscription Checkout must require an authenticated workspace or signed, single-use invitation, then stamp immutable `workspace_id`, `organization_id` and `plan_key` in server-generated Stripe metadata. The webhook validates and links those IDs to an existing billing customer/workspace. Email remains useful customer data but is never the join that unlocks a workspace.

Fulfilment transitions are explicit domain commands backed by conditional SQL: `awaiting_intake → build_queued → fulfilling → fulfilled`; `fulfilling → failed`; and an authorised retry may move `failed → build_queued` while creating a new run revision. Only verified payment events change the separate financial state. Repeated Checkout-completed events may fill null provider facts but do not touch fulfilment. Do not implement either projection as “last webhook write wins.”

### 5.3 Minimum real CRM

| Table | Required columns and constraints |
|---|---|
| `companies` | `id`, `workspace_id`, name, domain, phone/address fields, owner, source, custom fields JSON, timestamps and `deleted_at`; same-workspace unique/foreign-key pattern. |
| `contacts` | `id`, `workspace_id`, display/first/last name, optional same-workspace company ID, owner user, lifecycle status, source, custom fields JSON, `row_version`, timestamps, `deleted_at`; unique `(workspace_id,id)`. Do not keep pipeline stage here. |
| `contact_points` | workspace/contact composite FK, type `email\|phone\|whatsapp\|social`, original value, normalised value, primary/verified flags, dedupe state `normal\|shared\|quarantined` and `deleted_at`. Partial unique `(workspace_id,type,normalised_value)` for non-deleted `normal` points is the first dedupe rule; explicitly shared addresses such as `info@...` and ambiguous legacy collisions are not auto-merge keys. |
| `pipelines` | workspace, name, key, default flag, timestamps; unique workspace/key and one default pipeline per workspace. |
| `pipeline_stages` | workspace/pipeline composite FK, key, name, position, semantic `open\|won\|lost`; unique pipeline/key and pipeline/position. |
| `opportunities` | workspace, optional contact/company composite FKs with `CHECK (contact_id IS NOT NULL OR company_id IS NOT NULL)`, pipeline/stage composite FKs, name, amount minor, currency, probability, owner, expected/closed timestamps, status, loss reason, `row_version`, timestamps. `(workspace_id,pipeline_id,stage_id)` references a stage in that exact pipeline. A contact/company can have many. |
| `opportunity_stage_history` | append-only workspace/opportunity, from/to stage, actor, changed_at, correlation ID. |
| `activities` | append-only workspace, actor type/id, contact/opportunity/job/message links, typed kind/channel, summary, structured payload, occurred_at, correlation/causation/request IDs. This preserves today's timeline and makes it trustworthy. |
| `tasks` | workspace, title/body, status, priority, due time, assignee, contact/opportunity links, completed metadata. |
| `consent_events` | append-only workspace/contact/contact-point, purpose, channel, state granted\|denied\|withdrawn, lawful basis, source, policy version/text hash, capture time, evidence JSON. |
| `suppressions` | workspace, channel, normalised destination, scope/purpose, reason/source, active interval. Sending always checks this table even when a consent projection says granted. |
| `attribution_touchpoints` | workspace/contact, session/campaign IDs, source/medium/campaign/content/term, referrer, landing URL, first/last timestamps, raw JSON. Orders/opportunities may point at first/last touch IDs. |
| `merge_candidates` | workspace, subject contact, candidate contact, matching reasons/strength, status open\|merged\|dismissed, resolver/timestamps; unique open pair. Ambiguous identity never becomes an invisible automatic merge. |

`contacts.custom_fields jsonb` is acceptable for the first database cut because it avoids blocking on a custom-field UI. Before external API customers can define schemas, add `custom_field_definitions` and validate values through the domain service.

### 5.4 Relaunch72 evidence engine

| Table | Required columns and constraints |
|---|---|
| `pipeline_runs` | workspace, intake, order, kind `relaunch72_pack\|content_cluster\|manager_action`, execution mode, requested `through`, status, source, `concurrency_key`, current stage, token/cost totals, started/finished times, error, legacy run key. A partial unique active concurrency key prevents two clicks/jobs overwriting the same logical output set. |
| `pipeline_stage_runs` | workspace/run composite FK, stage key, `revision_no`, status, prompt file/version/hash, model, cost, output artifact ID, flags JSON, started/finished; unique `(run_id, stage_key,revision_no)`. A send-back creates a new revision rather than overwriting the signed-off evidence. |
| `pipeline_attempts` | workspace/stage run, attempt number, model stop reason, token counts, duration, schema errors, status, raw-output artifact; unique `(stage_run_id,attempt_no)`. |
| `qa_issues` | workspace, run/stage/attempt, check key, message, fatal, resolution state, resolver/notes/timestamps. Do not hide fatal no-invention evidence in a manifest blob only. |
| `artifacts` | workspace, run/stage, kind, execution mode, lifecycle `draft\|parked\|awaiting_approval\|approved\|scheduled\|published\|superseded`, storage status `pending\|ready\|failed\|deleted`, storage provider/key unique, media type, byte size, SHA-256, optional JSON preview, provenance JSON, timestamps. Normal reads expose only `ready`; publication requires ready + approved. |
| `signoffs` | workspace/run or artifact, decision, actual user actor, acknowledged flags, send-back instructions, timestamp. Immutable decisions; a new decision supersedes rather than edits. |

Keep the current `RunManifest` export as a compatibility/read format, but derive it from these rows. It should no longer be the only durable source of run state.

### 5.5 Durable operations

| Table | Required columns and constraints |
|---|---|
| `jobs` | workspace required for tenant job types, queue, type, version, encrypted/JSON payload, status queued\|running\|retry_wait\|succeeded\|dead_letter\|cancelled, global `idempotency_key UNIQUE`, optional `concurrency_key` with a partial unique index over active states, priority, run time, attempt/max attempts, lease owner/until/version, last error, correlation/causation IDs, timestamps. A CHECK permits null workspace only for an explicit small system-job allowlist. |
| `job_attempts` | job, attempt number, worker, started/finished, outcome, error class/message, heartbeat and metrics; unique job/attempt. |
| `schedules` | workspace, action/recipe, cadence or cron, timezone, next due, enabled, payload version and timestamps. Unique execution-window job keys make ticks idempotent. |
| `outbox_events` | optional workspace, aggregate type/id, event type/version, payload (encrypted if sensitive), idempotency key unique and created timestamp. This immutable fact is created in the same transaction as the state change it represents. |
| `outbox_deliveries` | event, destination/handler key, status `pending\|running\|retry_wait\|delivered\|dead_letter`, attempts/max attempts, available time, lease owner/until/version, delivered time and last error; unique event/destination. Each consumer retries independently, so a successful CRM projection is not repeated merely because email delivery failed. |
| `command_receipts` | scope + caller id + idempotency key unique, request hash, state running\|complete\|failed, response code/body, expiry. Prevents duplicate create/publish commands and rejects reuse with a different body. |
| `provider_webhook_events` | provider + explicit provider-account scope + external event ID unique, optional workspace/connection until resolved, payload, received/processed status and error. Same claim pattern as Stripe for social, messaging, calendar and webinar providers; the signed endpoint/account mapping, not a posted workspace ID, resolves tenancy. |
| `provider_auth_flows` | workspace, requesting user, provider, hashed OAuth state, encrypted PKCE verifier/return target, expiry and consumed time; unique state hash. Callback consumption is conditional and single-use, so an OAuth response cannot be attached to another workspace. |
| `provider_connections` | workspace, provider, capability, external account/profile ID, status, scopes, encrypted credential or secret-manager reference, expiry/refresh metadata; unique workspace/provider/external account. Never expose secret material in normal repository returns. |
| `provider_operations` | workspace, provider connection, operation type, global idempotency key unique, local aggregate, status prepared\|sent\|confirmed\|ambiguous\|failed, request hash, external ID, sanitised response/error and timestamps. This is the effect/reconciliation record. |
| `external_resource_links` | workspace, provider connection, local entity type/id, external resource ID/type, metadata; unique provider connection/resource. Reconciliation uses this after crashes. |
| `audit_log` | append-only actor, workspace, action, target, before/after or change summary, request/correlation ID, IP/user-agent hashes and time. Restricted RLS/read permission. |
| `migration_batches` / `migration_anomalies` | global operator-only import checksum/status/counts plus per-source unresolved records. These make the one-time flat-file cutover repeatable and reviewable. |

### 5.6 Index and query baseline

Every customer-list index starts with `workspace_id`; use keyset pagination, not deep offsets. Minimum hot-path indexes are:

- active memberships by `(workspace_id,user_id)` and reverse `(user_id,status,workspace_id)`;
- contacts by `(workspace_id,updated_at DESC,id)` plus the partial normalised contact-point uniqueness described above;
- opportunity board by `(workspace_id,pipeline_id,stage_id,updated_at DESC,id)`;
- timeline by `(workspace_id,contact_id,occurred_at DESC,id)` and tasks by `(workspace_id,assignee_user_id,status,due_at)`;
- runnable jobs partial on `(priority DESC,run_at,created_at)` for queued/retry states, expired-running recovery on `(lease_until)` where status is running, and active concurrency/idempotency uniques;
- pending outbox deliveries on `(status,available_at)` and schedules on `(enabled,next_due_at)`;
- provider events/operations on their scoped external/idempotency uniques.

Do not add a blanket GIN index to every JSONB column. Promote repeatedly queried custom fields to validated definitions/projections and index the actual access pattern. Use `EXPLAIN (ANALYZE, BUFFERS)` with representative multi-workspace volumes before adding reporting indexes; operational write paths and analytics exports should not compete blindly.

---

## 6. Expansion schema for the “social machine + webinar” product

These tables belong after the foundation cutover; they should use the same workspace/RLS/job invariants rather than a second mini-platform.

### Tenant commerce and payments

This is the GHL-style payments surface for a workspace's own customers. It is a separate domain from section 5.2 even when both happen to use Stripe:

- `merchant_accounts`: workspace, provider, external connected-account ID, status, country/currency, capability/charges/payout flags and reconciliation cursor; unique provider/external account and normally one active account per workspace/provider.
- `merchant_customers`: workspace, optional contact/company, provider customer ID and billing fields; unique workspace/provider/customer. This row must never point at a platform `billing_customer`.
- `commerce_products` / `commerce_prices`: workspace-owned catalogue, price/currency/tax/recurrence and immutable price versions.
- `customer_invoices` / `customer_invoice_lines`: workspace/customer/contact, totals, tax, due/status/provider IDs and line snapshots. Historical lines do not change when a catalogue price changes.
- `payment_transactions`: append-oriented charge/payment/refund/dispute facts with workspace, merchant account, invoice/order, provider IDs, amount/currency/status and provider-created time. Provider IDs are unique within an account; refunds/disputes reference the original payment.
- `checkout_links`: workspace, immutable offer/version, expiry/usage limit, attribution source and status. Public tokens are high-entropy and stored hashed where lookup permits.

Use a connected-account product such as Stripe Connect when Relaunch72 must facilitate client payments; keep provider onboarding/status as `provider_connection`/`merchant_account` state. Relaunch72 should not store card details. Merchant webhooks enter through the same unique `provider_webhook_events` claim, then update the tenant ledger monotonically and emit outbox events for receipts, CRM activity and automation enrollment.

### Forms and acquisition surfaces

- `forms` / `form_versions`: workspace-owned definition plus immutable published schema, consent copy/version, destination pipeline and automation recipe.
- `form_submissions`: workspace/form version, idempotency key, raw encrypted/redacted payload, contact/opportunity/attribution links, validation status and submitted time.
- `funnels` / `page_versions`: routing/domain/path and immutable published content/version metadata. The rendered page bytes can remain in object storage/CDN; PostgreSQL owns publication truth and provenance.
- `tracking_sessions` / `tracking_events`: pseudonymous first-party session, page/form/campaign event, consent state and UTM/referrer metadata with a retention policy.

A public form resolves workspace from a verified host/form token, stores the submission and runs the same `capture-contact` command; it never trusts a posted `workspace_id`. A full visual page builder is not a foundation dependency—the schema supports one later without making the CRM wait for it.

### Conversations and communications

- `communication_endpoints`: workspace/provider connection, channel, verified sender domain/address/number, external ID, compliance/status and default-purpose flags. A send job requires an active endpoint; credentials remain on the connection.
- `inboxes`: one workspace-owned email/SMS/WhatsApp/social inbox and its provider connection.
- `conversations`: workspace, inbox, contact, channel, assignment, unread/status/last-message fields.
- `messages`: workspace/conversation/contact, inbound/outbound, sender/recipient, body, structured content, provider ID, state `draft/queued/sent/delivered/read/failed`, timestamps and consent decision ID.
- `message_deliveries`: provider attempts, cost, status events and errors. Provider webhooks update this idempotently.
- `message_templates` and `sequences`: versioned approved content; enrolling creates jobs, not `setTimeout` calls.

Every outbound handler must re-check current suppression/consent immediately before calling the provider. Consent may have changed after the message was queued.

### Social/content/ads

- `social_accounts`: workspace/provider connection, network, external account/page ID, display handle, status and capability/scopes snapshot; unique connection/network/external account.
- `content_items`: canonical draft with channel-neutral copy/media, source pipeline run and approval state.
- `social_posts`: schedule/timezone and content item.
- `social_post_targets`: one row per connected social account; state and provider post ID are per target, because one network may fail while another succeeds.
- `publishing_attempts`: request/effect idempotency key, provider response, cost and exact status history.
- `ad_campaigns`, `ad_sets`, `ad_creatives` and `ad_provider_drafts`: internal approved creative separated from provider mapping.
- `approval_requests` / `approval_decisions`: required before live social publishing and always required before an ad draft can be activated. Relaunch72 should continue creating ads paused; activation is a separate privileged command.
- `performance_metrics`: dated, provider-sourced facts with metric name/value/unit/source. Mock estimates remain a different execution mode and cannot roll into live KPI views.

The existing `SocialPublisher` and `AdsPublisher` interfaces remain adapter boundaries, but instances must be constructed from a workspace's `provider_connection`, not global `AYRSHARE_PROFILE_KEY` or Meta environment variables.

OAuth connection starts bind provider + requesting user + workspace in `provider_auth_flows`. The callback claims the state hash once, verifies the still-active membership and writes the encrypted connection. Token refresh takes a row/advisory lock and uses a credential version so two workers cannot overwrite a newly rotated refresh token with an older one.

### Calendar, appointments and webinars

- `calendars`: workspace, owner/team, timezone, booking rules and provider mapping.
- `appointments`: workspace, calendar, contact/opportunity, start/end, timezone, status, meeting URL/provider and attribution.
- `appointment_attendees`: contact/user/external attendee and RSVP state.
- `webinars`: workspace-owned event definition, title/description, host, provider mode `external_url\|embedded\|native`, optional provider connection/external ID, registration rules and status. Vendor names remain adapter data, not schema enums.
- `webinar_sessions`: occurrence start/end, provider room/webinar ID and join URLs.
- `webinar_registrations`: session/contact, consent evidence, source/UTM, registered/cancelled timestamps and unique session/contact.
- `webinar_attendance`: join/leave/duration and provider event ID.

Registration commands should create/dedupe the contact, record attribution and consent, register the attendee, and enqueue provider sync in one transaction. Provider attendance webhooks use `provider_webhook_events` uniqueness and can trigger a follow-up task or sequence through the outbox.

### Native automation recipes

- `automation_definitions`: workspace, recipe key/name, enabled state.
- `automation_versions`: immutable trigger/condition/action JSON, published timestamp and actor.
- `automation_enrollments`: definition/version plus contact/opportunity, triggering outbox event, state and correlation/causation depth; unique version/trigger-event/subject prevents replay enrollment.
- `automation_step_runs`: enrollment/versioned step key, scheduled time, job ID, attempt/state/output/error; unique enrollment/step key.

Start with controlled recipes (“new lead → task + email”, “webinar no-show → follow-up”, “opportunity stage changed → notify”) rather than exposing a general workflow canvas. The runtime is the same durable `jobs`/`outbox_events` system; a later visual editor only authors versioned recipes. Preserve correlation/causation and cap recursion depth so an action that emits its own trigger cannot create an infinite automation loop.

---

## 7. Row Level Security and authorization

### Database roles

- `r72_owner`: owns schemas/tables and migration-time objects; used only by migrations, not as a web/worker function owner.
- `r72_security_definer`: `NOLOGIN`, non-table-owner, no BYPASSRLS; owns only audited auth/membership helper functions and has narrowly scoped underlying grants/policies.
- `r72_web`: runtime web role, no BYPASSRLS and not a table owner.
- `r72_public`: no raw table read/write; execute-only access to narrowly defined public form/checkout commands that resolve workspace/offer from server-published tokens or verified hosts, never request body IDs.
- `r72_worker`: runtime worker role, no BYPASSRLS; each job installs its workspace context.
- `r72_webhook`: may insert/handle restricted global provider-event rows and then install a resolved workspace context.
- `r72_readonly`: support/reporting role with explicit views, not raw broad table grants.

### Request context

Do not use session-scoped `SET` on a pooled connection. Every repository operation occurs inside a transaction and uses transaction-local configuration:

```sql
select set_config('app.user_id',      $1, true);
select set_config('app.workspace_id', $2, true);
select set_config('app.actor_kind',   $3, true);
select set_config('app.request_id',   $4, true);
```

Helper functions live in a private schema and return `NULL` safely when a value is absent:

```sql
create function app_private.current_workspace_id()
returns uuid language sql stable
as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

create function app_private.current_user_id()
returns uuid language sql stable
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
```

Membership/auth helpers that use `SECURITY DEFINER` must set a fixed `search_path`, avoid dynamic SQL, be owned by the non-login `r72_security_definer` role, and expose only the minimum boolean/safe identity result. That role gets explicit RLS policies/grants only on the membership/session rows each function needs; it neither owns tables nor has `BYPASSRLS`. Revoke public execution and grant each function only to the relevant runtime role. The migration owner should transfer function ownership to this role rather than becoming an everyday runtime capability.

Session bootstrap is the deliberate pre-context exception: `app_private.resolve_session(token_hash)` validates expiry/revocation and returns only `session_id`, `user_id` and selected `workspace_id`. Login uses similarly narrow auth functions/repository calls for password verification and session creation. Neither path grants `r72_web` generic `SELECT` over all users or sessions.

### Standard tenant policy

Every registered workspace table receives both isolation and membership checks:

```sql
alter table contacts enable row level security;
alter table contacts force row level security;

create policy contacts_workspace_select on contacts
for select to r72_web
using (
  workspace_id = app_private.current_workspace_id()
  and app_private.has_active_workspace_membership(
    app_private.current_user_id(), workspace_id
  )
);

create policy contacts_workspace_write on contacts
for all to r72_web
using (
  workspace_id = app_private.current_workspace_id()
  and app_private.can_write_workspace(
    app_private.current_user_id(), workspace_id
  )
)
with check (
  workspace_id = app_private.current_workspace_id()
  and app_private.can_write_workspace(
    app_private.current_user_id(), workspace_id
  )
);
```

The worker policy uses the same equality to `current_workspace_id()` without a human membership check. The job claim occurs outside workspace RLS through a tightly granted queue function; after claiming, the worker starts a new transaction scoped to the returned job's workspace.

Workspace repositories take a trusted `RequestContext`/`WorkerContext` and entity IDs; they do not accept a second caller-supplied workspace ID that can disagree with the installed RLS context. Platform/organisation reporting repositories are separate interfaces, so a future admin feature cannot accidentally reuse a tenant CRUD method with broader credentials.

Organisation-owned tables need parallel organisation-membership policies; global `users` expose only the current user's safe profile fields. Pre-workspace billing/event rows have no tenant-portal policy at all and are accessible only to the narrow webhook/command roles until atomically linked to a workspace. Do not weaken workspace RLS just to make those acquisition rows fit.

Anonymous acquisition is another execute-only boundary, not a fake member. `r72_public` can call a fixed `submit_published_form(form_token, payload, idempotency_key)` or `create_public_checkout(offer_token, ...)` function/service contract, but cannot select contacts, enumerate forms or set arbitrary workspace context. The function resolves a published token/verified host to its workspace or server-catalogue offer, validates the payload and writes through the same domain command. Relaunch72's own scorecard leads should land in an explicit internal marketing workspace, not in global unowned contact rows.

An agency overview does not justify a multi-workspace raw-table policy. Keep drill-down requests in one selected workspace. Build organisation-scoped aggregate read models (for example lead/opportunity/job counts by explicitly granted workspace) and protect those with organisation membership plus the user's active workspace grants. A dedicated safe function/view may return those summaries; it never turns organisation ownership into implicit access to every contact or message.

### Composite ownership example

```sql
alter table contacts
  add constraint contacts_workspace_id_id_uq unique (workspace_id, id);

alter table opportunities
  add constraint opportunities_contact_same_workspace_fk
  foreign key (workspace_id, contact_id)
  references contacts (workspace_id, id);
```

Repeat this pattern for opportunity → stage, message → conversation/contact, appointment → contact, artifact → run and every other workspace-owned relationship.

### RLS test gate

CI must open two real database transactions as two users in two workspaces and prove:

- A can read/write A and B can read/write B.
- A receives no B rows even if it supplies B's UUID.
- A cannot insert an A-owned child referencing B's parent UUID.
- revoked membership invalidates an existing browser session's next request.
- a worker scoped to A cannot touch B.
- every table in `app_private.workspace_table_registry` has `relrowsecurity` and `relforcerowsecurity` true.

Mocks cannot prove these properties; these are PostgreSQL integration tests.

---

## 8. Durable jobs, outbox and idempotency

### Why all three are required

- A **job** says internal work must happen and supports scheduling, leases and retry.
- An **outbox event** says a committed business change must be delivered to another handler/provider.
- An **idempotency receipt** says the same external command/event must not create a second logical effect.

One table cannot safely replace all three concerns without losing either business traceability or retry semantics.

An outbox event is immutable; one or more `outbox_deliveries` rows carry mutable delivery state. Dispatchers claim deliveries with the same `FOR UPDATE SKIP LOCKED` + expiring-lease pattern as jobs. They mark a delivery complete only after the internal handler commits or the external effect is confirmed. A process crash leaves a reclaimable lease, while a permanently failing destination becomes an explicit dead letter without blocking the other destinations for that event.

### Job claim

Workers claim with one transaction and `FOR UPDATE SKIP LOCKED`:

```sql
with candidate as (
  select id
  from jobs
  where attempt < max_attempts
    and (
      (status in ('queued', 'retry_wait') and run_at <= now())
      or (status = 'running' and lease_until < now())
    )
  order by priority desc, run_at, created_at
  for update skip locked
  limit 1
)
update jobs j
set status = 'running',
    attempt = attempt + 1,
    lease_owner = $1,
    lease_until = now() + interval '2 minutes',
    lease_version = lease_version + 1,
    started_at = coalesce(started_at, now()),
    updated_at = now()
from candidate
where j.id = candidate.id
returning j.*;
```

The claim transaction also inserts the matching `job_attempts` row. Long LLM/video/provider jobs heartbeat their lease. A worker crash leaves `running` with an expired lease, which the query deliberately reclaims. Transient errors use capped exponential backoff with jitter; permanent validation/authorization errors dead-letter immediately. A small reaper marks expired jobs that have exhausted `max_attempts` as dead-letter rather than leaving them stuck. A dead-letter job stays visible and replayable by an authorised operator; it is never silently dropped.

`lease_version` is a fencing token. Heartbeat and finalisation update only `WHERE id = $job_id AND lease_owner = $worker_id AND lease_version = $claimed_version AND status = 'running'`. A worker that wakes after losing its lease cannot mark the newer attempt successful. It must stop before any further provider effect; stable provider-operation idempotency remains necessary because lease fencing alone cannot undo a call already sent.

### Stable idempotency keys

Examples:

- `stripe:event:evt_...`
- `intake:order:<order_uuid>`
- `provision:workspace:<workspace_uuid>`
- `pipeline:<run_uuid>:stage:S3:attempt:1`
- `cadence:<schedule_uuid>:2026-08-24`
- `social:<post_target_uuid>:publish:v1`
- `webinar:<registration_uuid>:provider-sync:v1`
- `email:<message_uuid>:send:v1`

Keys are global strings that include the workspace-owned aggregate ID. A unique index means two web instances cannot enqueue the same logical job.

### External-effect ambiguity

No database can make an arbitrary HTTP provider call and a local SQL commit one atomic operation. Use this pattern:

1. Insert/claim a `provider_operation`/outbox row with stable idempotency key.
2. Send that key to providers that support idempotency.
3. Store the provider resource/message ID and response.
4. If the worker crashes after the call but before final commit, reconcile by idempotency key or provider ID/status endpoint before calling again.
5. If a provider supports neither, mark an ambiguous result for reconciliation rather than blindly duplicate-publishing/spending.

For ads, a successful operation only creates a paused draft. No retry path may activate spend.

### Scheduler

Store schedules (`workspace_id`, action, cadence/cron, timezone, next due, enabled). One scheduler process takes a PostgreSQL advisory lock, finds due rows, and inserts jobs using a unique execution-window key. The uniqueness constraint—not the leader lock—is the correctness guarantee. This replaces calendar-only `dueActions` and allows missed work to catch up after downtime.

### Pipeline execution

The first durable version can run one `pipeline.execute` job that resumes from persisted `pipeline_stage_runs`, committing after every stage. Then split expensive stages into child jobs if needed. Before each LLM call, create a `pipeline_attempt` in `running`; after the call, save the raw artifact, QA result and stage transition. A crash may duplicate an LLM cost when the provider offers no idempotency, but it cannot silently mark an unknown attempt as passed. Unknown attempts become visible for retry/review.

---

## 9. Atomic command flows

### Checkout creation

1. Require one authorised acquisition context: an authenticated workspace/organisation, a signed single-use commercial invitation, or—for public one-off offers only—a server-published offer token/route. Anonymous callers cannot start recurring workspace subscriptions. Validate the selection against the server catalogue and an entitlement-specific readiness gate. For example, a portal product requires durable setup-delivery capability while an Autopsy does not.
2. In one transaction, claim the caller's command idempotency key, insert `checkout_intents` with the exact product, entitlement version, expected Stripe price, amount, currency, mode/livemode and server-resolved verified return origin/route, and store the hash of a separate intake claim grant for one-off purchases. Commit before calling Stripe; return/deliver the raw grant only through the approved secure browser/email channel.
3. Create the Stripe Session using a stable provider idempotency key and server-only metadata containing the opaque checkout-intent ID/schema version. Caller input never supplies that metadata.
4. In a second short transaction, bind the returned Session ID to the intent. If the process crashed after Stripe created it, retry the same provider request/idempotency key and converge on the same Session before returning its URL.
5. Expire abandoned intents with a scheduled job. An intent is not an order, subscription or entitlement merely because a Session URL exists.

Metadata is a locator, not authority. The later webhook must find this persisted intent **and** match the exact bound Session ID and expected commercial facts.

### Stripe webhook

1. Verify signature over raw body before parsing business fields (current code already does this in `server/app.ts:220-227`).
2. If the signed payload lacks line-item/price detail required for commercial validation, retrieve/expand the Session from Stripe **before** opening the database transaction. A provider-read failure returns non-2xx; no network call occurs while locks are held.
3. Begin transaction as webhook role and `INSERT stripe_events ... ON CONFLICT DO NOTHING RETURNING id`.
4. If no row returned, load the existing result and acknowledge a processed/ignored/rejected replay. A deferred event may be re-enqueued; the synchronous path never commits a half-projected `received` row. A transient/internal failure rolls the entire transaction back and returns non-2xx so Stripe retries.
5. Validate the event. Commit unsupported types as `ignored` and terminal malformed/unrecognised-origin events as `rejected` with an alert.
6. For Checkout completion, lock the server-created `checkout_intent` and require exact intent ID, Session ID, mode, livemode, price, amount and currency. Only then create the order, or bind the new provider subscription ID to the intended organisation/workspace. If a legitimate out-of-order subscription event arrives before its Checkout link, mark it `deferred` and enqueue a bounded retry/reconciliation job; do not grant entitlement from plan/email metadata alone.
7. Update order financial/subscription/billing-customer projections only if provider-created time is not older than the projection's last accepted event. Equal-time conflicting or otherwise uncertain ordering triggers provider reconciliation rather than an arbitrary event-ID comparison. `ON CONFLICT (stripe_session_id)` may fill missing payment facts but never changes an existing order's fulfilment state.
8. Insert outbox event/delivery rows for customer sync, entitlement recalculation or notifications; mark the Stripe event processed and commit.
9. Return 2xx only after commit. External Brevo/Postmark calls happen from the outbox, not in the webhook request.

This removes the current multi-process race between `webhookReceipts.has()` and `.record()`.

### Paid intake → workspace → build

After S0 validation (a rejected attempt may be recorded without consuming the order), accept the valid intake in one transaction:

1. claim a `command_receipt` for caller/grant + idempotency key + canonical request hash; the same completed request returns its stored response and key reuse with a different body is rejected;
2. resolve by Stripe Session ID, lock the order/grant, then require the authenticated purchaser or conditionally consume the separate `order_claim_grant`;
3. if the order/grant was already consumed by this completed command, return its existing workspace/intake/run IDs; otherwise reject reuse;
4. require financial state `paid`, fulfilment state `awaiting_intake` and a provider receipt email; treat that address as a delivery destination until the later claim/setup link proves control;
5. validate S0 and privacy acknowledgement;
6. resolve the immutable product-entitlement snapshot. Every accepted order gets an internal workspace for data/artifact isolation, but only an entitlement with `portal_access` provisions a portal identity;
7. create organisation + workspace (or attach to the explicitly selected existing organisation);
8. for a portal entitlement, create/find the global user by the Stripe receipt email, treating it as a delivery destination—not proof that this browser owns an existing user;
9. insert explicit **invited** organisation-owner and workspace-owner memberships plus one `identity_action_token` claim/setup grant; activate the invitation bundle only after the recipient proves control through the emailed link, or immediately when an already-authenticated matching user initiated the purchase;
10. insert the accepted intake, bind the order/grant's workspace/intake/consumed fields and conditionally move fulfilment to `build_queued`;
11. create a `pipeline_run` and unique `pipeline.execute` job limited by the entitlement's `through` stage;
12. create the appropriate encrypted outbox event (portal setup for portal products; fulfilment/delivery notification for a non-portal product such as Autopsy);
13. complete the command receipt, commit and return stable IDs.

Generation and email occur after commit. A failed worker is retryable; a second browser submission cannot create a second workspace or build because the accepted-intake partial unique index, locked order transition and job idempotency key converge on the existing result.

Setup-link raw tokens must not be logged. If a token must survive an email retry in the outbox, encrypt the sensitive payload at application level and redact/delete it after successful send; the account/setup-grant table stores only the token hash and expiry. Completing the link verifies the email (when applicable) and atomically activates the invited membership. A paid checkout email alone must never attach an active workspace to an unrelated existing account.

### Contact capture

In one transaction:

1. normalize email/phone;
2. insert `contact_point`, using the workspace/type/normalised unique index to find an existing contact;
3. create or update the contact according to an explicit merge policy;
4. append consent/privacy evidence and attribution touch;
5. optionally create an opportunity in the default pipeline;
6. append activity and outbox events;
7. commit.

Never silently merge two established contacts just because a weak field such as display name matches. Put ambiguous matches in `merge_candidates` for human resolution.

### Stage move

The command accepts workspace/opportunity IDs and the UI's expected `row_version`, locks the opportunity, rejects stale state, validates that the target stage belongs to the same pipeline/workspace, increments the version, appends stage history/activity and emits `opportunity.stage_changed` in one transaction. This is the database-safe replacement for the current global `moveContact(contactId, stage)`.

### Publish social

The command checks the actor's publish permission, approved content version, connected account, current entitlement and schedule. It creates one `social_post_target` plus unique publish job per provider target. The worker re-checks suppression/policy and approval, calls the provider, persists the provider ID/status, then appends truthful activity. “Published” is never inferred merely because an artifact exists.

---

## 10. Artifact and object-storage boundary

Add an interface before moving bytes:

```ts
export interface ArtifactStore {
  putJson(scope: ArtifactScope, value: unknown): Promise<StoredArtifact>;
  putText(scope: ArtifactScope, value: string, contentType: string): Promise<StoredArtifact>;
  putBytes(scope: ArtifactScope, value: Uint8Array, contentType: string): Promise<StoredArtifact>;
  getJson<T>(ref: ArtifactRef): Promise<T>;
  getBytes(ref: ArtifactRef): Promise<Uint8Array>;
  exists(ref: ArtifactRef): Promise<boolean>;
}
```

Implement:

- `FsArtifactStore` for deterministic tests/local development.
- `ObjectArtifactStore` for production S3-compatible storage.
- `ArtifactRepository` for the PostgreSQL metadata row and RLS.
- `ArtifactService` to coordinate metadata reservation, byte upload/hash verification and finalisation without holding a database transaction across object storage.

The write protocol is: reserve a `pending` artifact and server-generated unique key in a short transaction; upload bytes outside the transaction; then conditionally finalise size/hash/status to `ready`. A retry reuses the artifact ID/key and verifies the same hash. A sweeper reconciles stale `pending` rows and unreferenced objects. Pipeline state may point to the artifact only in the finalisation transaction, so a database commit never claims bytes are ready when upload failed.

Refactor `runStage` to use the interface instead of `fs.writeFileSync` (`orchestrator/src/stages/runner.ts:103-105,160-165`), `writeManifest` to persist/derive database state (`orchestrator/src/runs/manifest.ts:34-48`), and portal/admin read models to stop opening local paths (`orchestrator/src/portal/data.ts:28-68`; `orchestrator/src/server/admin/store.ts:68-137`).

Suggested object key:

```text
workspaces/<workspace_uuid>/runs/<run_uuid>/stages/<stage_key>/<artifact_uuid>.<ext>
```

Never accept a client-supplied storage key. Generate it from authenticated server context. Private downloads use short-lived signed URLs after a membership check.

---

## 11. Migration from JSON/JSONL — no big bang

### Phase 0 — inventory and immutable backup

1. Put the current service into a short maintenance window for the final cutover; Stripe may receive a temporary non-2xx and retry.
2. Copy and hash `portal-crm.json`, `portal-accounts.json`, `orders.jsonl`, `subscriptions.jsonl`, `stripe-webhook-receipts.jsonl`, `DATA_DIR/intakes` (including `.job.json` entitlement sidecars), `DATA_DIR/portal-runs`, and `RELAUNCH72_RUNS_DIR`.
3. Store filename, size, SHA-256 and backup location in `migration_batches`.
4. Parse and validate every record before inserting anything. Malformed rows go to a report; they are not silently skipped.

### Phase 1 — add PostgreSQL without changing feature behaviour

- Add connection pool, migrations, transaction context, health checks and RLS integration tests.
- Add repository interfaces/implementations while retaining memory/file adapters for unit tests.
- Do not add new CRM UI yet.
- Use a feature flag such as `PERSISTENCE_DRIVER=file|postgres`; production refuses `file` after cutover.

Avoid a long dual-write period. A file append and PostgreSQL transaction cannot commit atomically, so dual-write creates two sources of truth. Use an idempotent import plus a short final write freeze and one authoritative cutover.

### Phase 2 — import identity and thin CRM

For each legacy tenant in `portal-crm.json`:

1. create an organisation and workspace;
2. store old `Tenant.id` in `workspaces.legacy_tenant_key`;
3. preserve name/created time and retain `runDir` only in a legacy import table until artifact migration;
4. import each account as a global user and explicit owner membership;
5. preserve versioned scrypt/legacy hashes exactly so current verification/migration logic remains valid; move an unexpired pending setup-token hash/expiry into `identity_action_tokens` rather than leaving it on the user row;
6. import contacts and contact points; do not infer a company merely because a legacy display name contains “Ltd”—create company links only from unambiguous structured data or later review. If multiple legacy contacts in one workspace share a normalised point, preserve all contacts, mark the conflicting imported points shared/quarantined and create `merge_candidates`; do not let the new unique index silently choose a winner;
7. create one default pipeline with the five legacy stage keys;
8. create one opportunity per contact at its legacy stage;
9. import activities with their legacy ID in metadata and original timestamp.

Do not reuse the old deterministic `t-<slug>-<email hash>` as the database primary key. Use UUID and retain the old value as a unique legacy key/path mapping.

### Phase 3 — import billing and receipts

- Collapse `orders.jsonl` to the last record per `session_id`, then insert with unique Stripe session ID.
- Map legacy `paid_awaiting_intake` to financial `paid` + fulfilment `awaiting_intake`. Map `building` to financial `paid` + fulfilment `fulfilling` unless an exactly correlated completed manifest proves `fulfilled`; unresolved/orphaned builds remain visible for recovery. The declared-but-unwritten `nudge_returned` value becomes an anomaly/intake-rejection note rather than a new commercial state.
- Create a completed `legacy_import` checkout-intent record for each imported order/subscription, bound to its known Session when available. Retain amount/currency/tier facts exactly; leave unknown historical price/livemode fields null and flag them. These synthetic rows preserve provenance of imported state but cannot authorise a new purchase or a different Session.
- Do not invent a known raw intake grant for an imported awaiting-intake order. Issue a fresh one-use receipt-email claim through an audited recovery command; already-building/fulfilled imports need no claim.
- Import an exact matching `.job.json` as the order's entitlement snapshot when present; otherwise derive only from the validated legacy tier/bump map and record the derivation/version.
- Collapse `subscriptions.jsonl` to the last merged record per `subscription_id`.
- Link an order/subscription to a workspace only when there is exactly one exact, case-insensitive imported account-email match. Record everything else in `migration_anomalies`; do not guess.
- Import receipt-only Stripe event rows with `payload = NULL`, status processed and `metadata.legacy_receipt = true`.
- Do **not** interpret `Order.run_dir` as a pipeline run path; current `createKick` stores the intake path there.

### Phase 4 — cut billing/intake/jobs to PostgreSQL

- Switch every one-off/subscription checkout surface to the shared persisted-intent command before accepting new payments.
- Deploy async PostgreSQL order/subscription/event repositories.
- Switch webhook replay claim to the unique `stripe_events` insert.
- Switch intake to the atomic command and enqueue `pipeline.execute`.
- Start a separate worker service and stop spawning detached CLI children.
- Reconcile order counts/statuses and replay any provider events received during maintenance.

### Phase 5 — migrate runs/artifacts

- Import portal run directories by exact tenant `runDir` mapping.
- Import CLI run manifests and stage/attempt/QA metadata.
- Link CLI runs to orders only by exact unique source/intake basename correlation; report ambiguity.
- Upload bytes to object storage, verify SHA-256, then mark artifact migrated.
- Run the portal/admin from database read models before making legacy directories read-only.

### Phase 6 — expand the CRM, then channels

1. Opportunities and tasks UI/API.
2. Contact capture + consent + attribution.
3. Conversations/messages and booking.
4. Social connected accounts, approval and durable publishing.
5. Webinar registration/attendance.
6. Automation recipes over the same domain events/jobs.

### Reconciliation gates

The cutover fails closed unless all of these match or have an explicit anomaly:

- tenant/workspace count;
- account/user + membership count;
- contact, opportunity and activity count per workspace;
- latest order per Stripe session and latest subscription per Stripe subscription;
- receipt event ID set;
- run/stage/attempt/artifact counts and hashes;
- cross-tenant RLS suite;
- one paid-intake replay concurrency test;
- one webhook replay concurrency test;
- worker crash/lease-reclaim test.

Retain immutable legacy backups for the agreed retention period. Do not delete source files as part of the importer.

---

## 12. Operational production baseline

- Run PostgreSQL in an EU region near the UK/Relaunch72 application, with encrypted transport, storage encryption, automated backups and point-in-time recovery. Provider choice is deliberately separate from this schema.
- Use separate credentials for migrations, web, worker and webhook roles. Rotate them without rebuilding customer data. Runtime credentials never own objects.
- Run migrations as an explicit release step under an advisory lock. Web/worker startup checks the expected schema version and refuses writes when behind; it does not race to migrate from every replica.
- Keep migrations expand/contract: add nullable/new structures, deploy compatible code, backfill, validate constraints, then remove old structures in a later release. Never combine a destructive contraction with the first code that stops using a column.
- Configure pool limits from the database connection budget across **all** web and worker replicas. Tag connections with `application_name`; set statement, lock and idle-in-transaction timeouts.
- The transaction helper retries PostgreSQL serialization failures/deadlocks only for commands with a stable idempotency key, using a small bounded jitter. It never retries an external provider call inside the transaction callback.
- Never hold a database transaction open across an LLM, email, social, Stripe, webinar or object-storage network call. Commit durable intent, make the call, then finalise/reconcile in a new transaction.
- Keep `/health` as process liveness and add `/ready` for database reachability, required migration version and worker/outbox backlog safety. Load balancers should remove an unready instance without repeatedly restarting a healthy-but-dependent process.
- Emit structured metrics for pool saturation, slow queries, transaction retries, RLS denials, queued/running/dead-letter jobs, oldest outbox age, webhook failures and provider reconciliation ambiguity. Correlation IDs connect HTTP → command → event → job → provider operation.
- Never log SQL parameter values wholesale. Emails, phone numbers, intake answers, tokens and provider payloads are sensitive; log IDs, hashes and classified errors.
- Apply shared edge/Redis/database-backed abuse limits to public subscribe, form, login, setup and checkout endpoints. Process-local maps are a useful single-instance stopgap, not a horizontal-control plane. Rate limiting supplements—not replaces—command idempotency and database uniqueness.
- Take an immutable pre-cutover backup, verify automated backup retention, and perform a restore drill before live money is unlocked. A backup that has never been restored is not a proven recovery plan.
- Object storage remains private, versioned where practical and lifecycle-managed. Database backup plus missing artifacts is not a complete Relaunch72 recovery.

---

## 13. Exact code seams to introduce next

### New files/directories

```text
orchestrator/src/db/
  config.ts                    # role-specific DB URLs, pool sizing, SSL, fail-closed prod rules
  pool.ts                      # pg Pool; no domain logic
  transaction.ts               # withTransaction + set_config request/worker context
  migrate.ts                   # advisory lock, ordered SQL migrations, SHA-256 checksums
  rls.ts                       # RequestContext/WorkerContext helpers
  migrations/
    0001_extensions_roles.sql
    0002_identity_workspaces.sql
    0003_billing_intake.sql
    0004_crm_core.sql
    0005_jobs_outbox_providers.sql
    0006_pipeline_artifacts.sql
    0007_rls_registry_audit.sql
  repositories/
    postgres-account-store.ts
    postgres-crm-store.ts
    postgres-checkout-intent-repository.ts
    postgres-order-store.ts
    postgres-subscription-store.ts
    postgres-run-repository.ts
    postgres-job-repository.ts
    postgres-outbox-repository.ts
    postgres-provider-connection-repository.ts

orchestrator/src/auth/
  sessions.ts                  # opaque session creation/lookup/revocation
  authorization.ts             # role→permission checks

orchestrator/src/providers/
  credential-vault.ts          # envelope encryption/key-versioned secret access
  oauth-flow.ts                # single-use state/PKCE → workspace connection
  registry.ts                  # capability→adapter factory; no global tenant profile

orchestrator/src/commands/
  create-checkout-intent.ts     # local intent → idempotent provider Session binding
  accept-paid-intake.ts        # atomic order/workspace/intake/run/job command
  capture-contact.ts
  move-opportunity.ts
  request-social-publish.ts

orchestrator/src/jobs/
  types.ts                     # versioned job payload discriminated union
  worker.ts                    # claim, heartbeat, retry, dead-letter
  scheduler.ts                 # schedules → unique execution-window jobs
  handlers/
    pipeline-execute.ts
    setup-email-send.ts
    manager-action.ts
    outbox-dispatch.ts

orchestrator/src/artifacts/
  store.ts                     # ArtifactStore contract
  service.ts                   # reserve → upload/verify → finalise/reconcile
  filesystem.ts               # tests/local compatibility
  object-storage.ts            # production implementation

orchestrator/src/migration/
  import-flat-files.ts         # idempotent batch import, no source deletion
  reconcile-flat-files.ts      # counts/hashes/anomaly report

orchestrator/test/db/
  database-helper.ts           # isolated test schema/database lifecycle
  rls.integration.test.ts
  webhook-idempotency.integration.test.ts
  intake-concurrency.integration.test.ts
  jobs.integration.test.ts
  import.integration.test.ts
```

Use `pg` as the small runtime dependency and keep repositories explicit. SQL migrations are first-class because RLS, functions, partial indexes and composite foreign keys are important product behaviour, not ORM detail. The migration runner should take a PostgreSQL advisory lock, record filename + SHA-256 in `schema_migrations`, run each new migration transactionally and refuse a changed checksum.

Every migration that creates a workspace table also enables/forces RLS, adds its policies and registers it **in that same migration**; tenant tables are never exposed while waiting for `0007`. The final `0007_rls_registry_audit.sql` adds the catalogue assertion/CI guard and fails when any registered table lacks `relrowsecurity` or `relforcerowsecurity`.

Migration order is dependency order: **0001** extensions, roles, private schemas and migration ledger → **0002** organisations/workspaces/users/memberships/invitations/sessions → **0003** checkout intents, order claims, platform billing, intake, entitlements and Stripe events → **0004** contacts/companies/pipelines/opportunities/tasks/consent/attribution → **0005** jobs, attempts, schedules, outbox deliveries, provider auth/connections/operations and audit → **0006** pipeline runs/stages/attempts/QA/artifacts/sign-off → **0007** RLS registry assertion, final grants and policy-coverage audit.

Atomic command repositories receive the same `DbTransaction`/`PoolClient` explicitly; they never acquire a fresh pool connection mid-command. `withTransaction(context, fn)` installs RLS settings, constructs transaction-bound repositories and owns commit/rollback. This is what makes “order + workspace + intake + job + outbox” one transaction rather than five individually successful writes.

### Existing files and required changes

| File | Change |
|---|---|
| `orchestrator/src/crm/types.ts` | Introduce `Workspace`, `Opportunity`, pipeline/stage and richer activity types. Keep a temporary `Tenant = Workspace` compatibility alias. Remove `stage` from the canonical Contact after the compatibility read model is in place. |
| `orchestrator/src/crm/store.ts` | Keep memory adapter for fast unit tests. Move PostgreSQL implementation to `db/repositories`; change unsafe `moveContact(contactId, stage)` to a workspace-scoped opportunity command. Do not make the DB store inherit from the in-memory store. |
| `orchestrator/src/portal/accounts.ts` | Keep password/hash functions; move persistence behind PostgreSQL `AccountStore`. Database uniqueness/token conditional update replaces `setupClaims`. Split global user from workspace membership. |
| `orchestrator/src/portal/session.ts` | Replace tenant-bearing cookie with opaque server session. Keep cookie helpers, add revocation and CSRF. |
| `orchestrator/src/portal/router.ts` | Resolve user/session/membership, construct request context, and enqueue `/portal/run` instead of executing generation. Never accept workspace ownership from a form body. |
| `orchestrator/src/portal/provision.ts` | Accept repository interfaces rather than concrete `JsonCrmStore`; provisioning becomes the atomic paid-intake command plus worker jobs. `buildPortalDeps` selects PostgreSQL in production. |
| `orchestrator/src/portal/data.ts` | Replace file reads with one workspace-scoped dashboard query/read model. Artifact previews come from `ArtifactRepository`. |
| `orchestrator/src/portal/billing.ts` | Make `SubscriptionStore` fully async and query by workspace ID, not email. |
| `orchestrator/src/portal/run.ts` | Preserve pure generation helpers initially, but call them from a job handler with `ArtifactStore`; route-level `runTickReal` becomes enqueue/status. |
| `orchestrator/src/server/orders.ts` | Make methods async; add atomic `claimPaidForIntake(sessionId)` or move that logic into `accept-paid-intake` transaction. File adapter remains test/migration compatibility only. |
| `orchestrator/src/server/stripe.ts` | Extend the verified event shape with provider `created`, livemode/API version and safe Session retrieval/line-item validation. Checkout creation receives only the server-built intent snapshot/idempotency key; metadata locates the intent but never grants entitlement by itself. |
| `orchestrator/src/server/subscriptions.ts` | Keep event mapping pure; add provider event ID/created time, reject stale projection updates, and make persistence async and organisation/workspace/billing-customer keyed. Preserve merge tests and add out-of-order delivery tests. |
| `orchestrator/src/server/readiness.ts` | Preserve this shared fail-closed checkout gate. Replace the placeholder “PostgreSQL foundation active” condition with a real database schema/worker readiness capability used by both API and portal checkout commands. |
| `orchestrator/src/server/app.ts` | Await repositories; replace receipt `has/record` with transactional event insert and monotonic order projection; call shared command services rather than orchestrating file writes and fire-and-forget callbacks. Checkout readiness lives in that shared service so public and portal routes cannot diverge. |
| `orchestrator/src/server/index.ts` | Composition root creates DB pool/repositories and health/readiness checks. Delete detached `createKick` after worker cutover. Start web only; worker gets a separate entry point/script. |
| `orchestrator/src/server/admin/store.ts` | Replace filesystem scans with async platform-admin read repositories. |
| `orchestrator/src/server/admin/router.ts` | Authenticate a real platform user and write their user ID to sign-off; remove hard-coded actor. |
| `orchestrator/src/runs/manifest.ts` | Generate a compatibility manifest from persisted run records; filesystem output becomes an artifact adapter concern. |
| `orchestrator/src/stages/runner.ts` | Inject `ArtifactStore`/attempt repository. Persist attempt-before-call and result/QA-after-call. Keep all existing QA logic intact. |
| `orchestrator/src/manager/types.ts` | Replace duplicate manager `Tenant` with workspace + stored schedules; version job payloads. |
| `orchestrator/src/manager/schedule.ts` | Keep pure cadence helpers for calculating windows; database scheduler owns `next_due_at` and unique execution. |
| `orchestrator/src/manager/engine.ts` | Turn due actions into durable jobs; no sequential all-tenant loop in one process. Keep `ActionRunner` as handler seam. |
| `orchestrator/src/manager/rail-runner.ts` | Load artifacts and provider connection by workspace; persist operation result/external IDs. Remove direct `runDir` dependency after artifact cutover. |
| `orchestrator/src/social/ayrshare.ts` | Constructor receives a decrypted, workspace-scoped credential/profile object. Never read a multi-tenant profile key globally. |
| `render.yaml` | Add managed PostgreSQL `DATABASE_URL`; web service plus worker service; production `PERSISTENCE_DRIVER=postgres`; readiness should fail if DB/migrations are unavailable. Local persistent disk becomes optional artifact-migration compatibility, not authoritative state. |
| `.env.example` | Add web `DATABASE_URL` plus role-specific worker/webhook/public/migrator connection secret references, `PERSISTENCE_DRIVER`, worker/lease settings, object-storage configuration and application encryption key reference. No real secret values. |
| `package.json` | Add `db:migrate`, `db:import`, `db:reconcile`, `worker`, and DB integration-test scripts. |

### Interface compatibility warning

`CrmStore` and `AccountStore` are already Promise-based, but `OrderStore`, `SubscriptionStore` and `WebhookReceiptStore` are synchronous (`server/orders.ts:25-47`; `server/subscriptions.ts:45-51`). A real PostgreSQL adapter cannot honestly implement those synchronous contracts. Change the interfaces and await all call sites before introducing the adapter; do not hide asynchronous writes behind fire-and-forget methods.

---

## 14. Recommended implementation sequence

### PR/commit 1 — database runtime and isolation proof

- Add `pg`, role-specific config/pool, `withTransaction`, the advisory-lock/checksum migration runner and `db:migrate` script.
- Execute `0001_extensions_roles.sql`, then `0002_identity_workspaces.sql`; the latter creates identity/workspace/membership/session/invitation tables **with their RLS/policies**.
- Add the real PostgreSQL test helper plus two-workspace membership, revocation, same-workspace FK and session-bootstrap integration tests.
- No feature cutover yet.

**Exit gate:** two-workspace RLS suite passes against PostgreSQL; production refuses a missing/old schema.

### PR/commit 2 — PostgreSQL adapters for current portal CRM/auth

- PostgreSQL AccountStore/CrmStore.
- Importer for `portal-accounts.json` and `portal-crm.json`.
- Opaque sessions + membership check.
- Portal dashboard from DB; memory/file adapters remain in unit tests.

**Exit gate:** legacy demo fixture imports; portal behaviour matches current tests; cross-workspace mutation fails in DB.

### PR/commit 3 — billing, webhook and paid-intake transaction

- Async order/subscription repositories.
- Persisted checkout-intent command shared by public and portal routes; exact commercial webhook validation.
- `stripe_events` unique claim.
- Workspace-bound billing metadata and entitlements.
- Atomic `acceptPaidIntake` command and concurrency tests.
- Transactional setup-email/pipeline outbox entries.

**Exit gate:** 20 concurrent submissions for one paid session create exactly one workspace, membership, intake and pipeline job; replayed Stripe event creates one projection/outbox set; an unrelated paid Stripe Session/subscription cannot create either.

### PR/commit 4 — worker and durable pipeline

- Jobs/outbox, worker lease/retry/dead-letter, scheduler.
- Replace detached `npx tsx` and request-bound “Run this week”.
- Pipeline/stage/attempt/QA metadata.

**Exit gate:** killing a worker mid-job leads to lease reclaim; a completed effect is not duplicated; failed work is visible/replayable.

### PR/commit 5 — artifact abstraction/object storage

- Inject `ArtifactStore` into pipeline/portal/admin.
- Import and hash current run directories.
- Database-driven read models.

**Exit gate:** two independent web/worker instances can read the same run with no shared filesystem.

### PR/commit 6 — first sellable CRM loop

- Contact capture/dedupe, default pipeline, opportunities, tasks, consent and attribution.
- CRUD API/UI with workspace-scoped commands.
- Revenue view from opportunities + billing.

**Exit gate:** a real lead can enter, be attributed/consented, become an opportunity, move stage, receive a task and show revenue without any demo seed.

### Then — social, communications and webinar slices

Ship each as an end-to-end vertical slice: connection → durable command → provider webhook/reconciliation → truthful status → activity/audit → usage. Do not add a dashboard card before its underlying state is real.

---

## 15. Tests that define “production foundation complete”

1. RLS read/write/link isolation across two workspaces and roles.
2. Public role cannot select tenant rows or choose a posted workspace ID; a valid published form/offer token reaches only its configured workspace/offer.
3. Revoked membership blocks the next request even with an old cookie.
4. Account setup token is single-use under concurrent database transactions.
5. Stripe event replay/concurrency produces one event projection and one outbox effect; two distinct event IDs for one Checkout Session cannot reset a claimed/building order. A paid Session/subscription not bound to a server-created matching intent grants no order, workspace or entitlement.
6. Paid intake concurrency creates one logical build/workspace; possession of the provider Session ID without the authenticated purchaser/order claim grant cannot consume it.
7. Subscription entitlement resolves only by workspace/customer metadata, never email.
8. Contact normalisation/dedupe is workspace-local; identical email may exist in different workspaces.
9. Cross-workspace composite foreign keys reject links even under worker mistakes.
10. Opportunity stage change produces one history row, activity and outbox event in one transaction.
11. Job lease reclaim, retry backoff, max-attempt dead letter and manual replay; a stale worker with an old fencing token cannot heartbeat or finalise the reclaimed job.
12. Scheduler duplicate ticks produce one job per schedule/window.
13. Outbox dispatch crash/retry does not duplicate a provider resource where idempotency/reconciliation is available; one failed destination does not repeat or block another delivered destination.
14. Consent withdrawn after queueing prevents send at execution time.
15. Mock artifact cannot enter a live publish job; unapproved content cannot publish; ads remain paused.
16. Artifact SHA-256/size match after object-storage upload and download; crash after reservation or upload is reconciled, and no non-ready artifact is rendered/published.
17. Flat-file importer is idempotent and reports—not guesses—ambiguous email/run links.
18. Database unavailable/behind migrations fails readiness and refuses production writes.
19. Existing no-invention/QA suite remains green. The database move must not weaken the strongest part of the repository.

---

## 16. What not to do

- Do not bolt PostgreSQL only underneath `JsonCrmStore` while leaving orders, subscriptions, jobs and artifacts as independent files. The dangerous gaps are between those stores.
- Do not use email as a foreign key or billing entitlement key.
- Do not put `workspace_id` in a signed cookie and treat the signature as ongoing authorization.
- Do not rely only on application filters; enable and force RLS.
- Do not use a privileged table-owning/BYPASSRLS role for normal web queries.
- Do not add tenant columns without same-workspace composite foreign keys.
- Do not implement a PostgreSQL adapter behind synchronous store methods.
- Do not run generation, publishing or email as fire-and-forget work in an HTTP request.
- Do not claim exactly-once delivery. Use at-least-once jobs plus idempotent/reconcilable effects.
- Do not store provider access/refresh tokens as ordinary plaintext columns or log them.
- Do not store videos/PDFs/raw attempts as unbounded bytea blobs in PostgreSQL.
- Do not run a long, non-atomic dual-write between files and the database.
- Do not infer “scheduled”, “published”, “sent”, “live” or KPI performance from artifact presence.
- Do not expose a general workflow canvas until the event/job runtime and permissions are proven with controlled recipes.
- Do not delete the legacy files during migration; cut over, reconcile, retain, then dispose under an explicit retention decision.

---

## 17. Final recommendation

The next code should be **PR 1: database runtime + identity/workspace memberships + RLS integration tests**, followed by the current portal/auth adapter cutover in PR 2 and then **PR 3's transactional billing/intake/job spine**. Those pieces turn Relaunch72 from a single-process portal with good generation logic into a safe platform kernel.

The existing evidence/QA engine should remain the product differentiator. PostgreSQL is not a rewrite of that engine; it is the durable control plane around it. Once workspace ownership, jobs, outbox, consent and truthful provider states are real, CRM, social, webinars and reusable white-label modules become incremental tables/handlers/adapters rather than separate products glued together by email and local folders.
