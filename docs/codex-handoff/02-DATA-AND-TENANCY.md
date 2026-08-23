# 02 — DATA & TENANCY

**There is no database.** All persistence is flat files (JSON documents + JSONL append logs) written by swappable store classes. The "schema" is a set of TypeScript interfaces; raw definitions are in `database-schema.txt`.

---

## Every current "table" / model

| Model | Where persisted | Definition | Ownership field |
|---|---|---|---|
| **Tenant** (the workspace) | `portal-crm.json` (whole `State` blob) | `src/crm/types.ts:16-22` | `id` (self) |
| **Contact** | `portal-crm.json` | `src/crm/types.ts:24-32` | `tenantId` (`:26`) |
| **Activity** (timeline entry) | `portal-crm.json` | `src/crm/types.ts:34-42` | `tenantId` (`:36`) |
| **Account** (login) | `portal-accounts.json` | `src/portal/accounts.ts:11-15` | `tenantId` (`:13`) — 1:1 with Tenant |
| **Order** (one-off purchase) | `orders.jsonl` (append; last-per-`session_id`) | `src/server/orders.ts:12-23` | `session_id` (Stripe) + `email`; **no tenantId** |
| **Subscription** (recurring) | `subscriptions.jsonl` (append; last-per-`subscription_id`) | `src/server/subscriptions.ts:26-35` | `subscription_id` + `email`; **no tenantId** |
| **Pipeline run artifacts** (brand brain, deliverables) | per-run dir under `RUNS_DIR` / tenant `runDir` (`s1.json`…`s10`, `cc.json`, `ad.json`, `keyword-report.json`, `bundle.json`, `signoff.json`) | filesystem, written by `src/stages/runner.ts:162-164` | directory path stored on `Tenant.runDir` (`crm/types.ts:19-20`) |
| **Catalog** (products/prices) | **not persisted** — code constants | `src/server/catalog.ts:16-21` (one-off `CATALOG`), `:33-37` (recurring `PLANS`) | n/a |

The in-memory `State` (tenants + contacts + activities + sequence counters) is a single object serialized to one JSON file (`src/crm/store.ts:29-39`, persisted `:126-128`).

---

## Question-by-question

### What represents a client workspace?
A **`Tenant`** (`src/crm/types.ts:16-22`): `{ id, name, runDir?, createdAt }`. Its `runDir` points at the brand-brain/deliverables directory. There is no richer "workspace" object (no plan, no owner list, no settings) — anything workspace-level is either on the Tenant, or joined at read time from other stores by email.

### How is every customer-owned record scoped?
- **Contacts and Activities** carry `tenantId` and are filtered by it in `tenantView` (`src/crm/store.ts:110`,`:113-114`).
- **Accounts** carry `tenantId` (single value) — the login → tenant mapping.
- **Orders and Subscriptions are NOT scoped by tenant** — they key on Stripe ids + email. The join back to a tenant is indirect: subscription `email` → `Account.email` → `Account.tenantId` (`src/portal/billing.ts:53-66`, using `accounts.findByTenant` at `src/portal/provision.ts` wiring). This email-join is the only link and is a soft spot for the audit (email mismatch = orphaned billing).

### Can users belong to multiple workspaces?
**No.** An `Account` has exactly one `tenantId` (`src/portal/accounts.ts:13`), and `create` upserts by email replacing the mapping (`accounts.ts:52-59`). There is no user↔workspace join table, no membership/invite concept, no "switch workspace". One email = one tenant.

### What roles and permissions exist?
**Effectively two hard-coded principals, no role model:**
- **Admin** — one shared password (`ADMIN_PASSWORD`), full access to `/admin` (all runs, all orders, sign-off). No per-user admin accounts; sign-off is hard-coded to `'Martin Howard'` (`src/server/admin/router.ts:102-103`).
- **Tenant (client)** — authenticated by the portal cookie; can see only their own dashboard/billing and trigger their own run. No roles within a tenant (no owner/member/viewer), no permission flags on `Account` or `Tenant`.

### Where is tenant isolation enforced?
**Application layer only**, at two points:
1. The portal cookie is HMAC-signed and carries `tid`; a request's tenant is whatever `verifyTenant` returns (`src/portal/session.ts:28-45`), used directly as the scope key in `handlePortal` (`src/portal/router.ts:64`, then `deps.dashboard(tenantId)` `:86`).
2. `MemoryCrmStore.tenantView` filters contacts/activities by `tenantId` (`src/crm/store.ts:110-114`).

Note: `getTenant`/`addContact`/`moveContact` operate by **global id without a tenant check** (`store.ts:65-67`,`:90-98`) — `moveContact(contactId, stage)` does not verify the contact belongs to the caller's tenant. Today no portal route exposes those to a client (contacts are seeded/ingested server-side), but any future "edit contact" route must add an explicit ownership check. **There is no test proving tenant A cannot read/mutate tenant B's data** (see `07-TEST-MAP.md`).

### Are there database-level policies, or only application checks?
**Only application checks.** No database exists, so there is no RLS / row policy / constraint layer. Isolation, uniqueness, and referential integrity are entirely code-enforced (and partially unenforced — e.g. no uniqueness on contact email, no FK from Order→Tenant).

### How are migrations handled?
**They aren't.** There is no migration tool, no schema versioning, and no migration files (none tracked; grep for migrate/prisma/knex/drizzle: none). Store classes read a JSON/JSONL file if present and otherwise start empty (`src/crm/store.ts:123`, `src/portal/accounts.ts:34-36`, `src/server/orders.ts:33-35`). Any shape change to a persisted interface is a silent, unversioned change — old files are `JSON.parse`d directly with no validation or upgrade step. **This is a primary audit concern for moving to a real DB.**

### How are contacts deduplicated?
**They are not.** `addContact` always creates a new record with a fresh `c-<seq>` id and pushes it (`src/crm/store.ts:73-88`); there is no lookup by email/phone, no merge, no uniqueness constraint. Two identical contacts will coexist.

### What CRM entities currently exist?
`Tenant`, `Contact`, `Activity`, and derived `TenantView` (contacts + pipeline stage counts + sorted activity) — that is the entire CRM (`src/crm/types.ts`). See `03-CRM-AND-EVENTS.md`.

### What is missing for conversations, messages, tasks, appointments, consent, attribution and revenue?
All absent as data models. Concretely:
- **Conversations / messages:** no `Conversation`/`Message` entity. `ActivityKind` includes `'message_sent'` (`crm/types.ts:11`) and `Channel` includes `sms|whatsapp|email` (`:9`), but nothing writes a message body, direction (in/out), thread, or status. No inbox.
- **Tasks / next actions:** no task entity, no assignee, no due date.
- **Appointments:** no calendar/appointment entity, no availability, no booking.
- **Consent / suppression:** no consent flag, opt-in/opt-out, or suppression list on Contact. (Marketing sync to Brevo exists but stores no consent state locally.)
- **Attribution (source/UTM):** Contact has no `source`, `utm_*`, `referrer`, or `campaign` fields. Orders carry `tier`/`bump` only.
- **Revenue / won-value:** pipeline stages are **counts only**; no amount on a Contact/stage, no `Opportunity` with a value, no won/lost value roll-up. Order `amount_total` exists (`orders.ts:19`) but is not linked to a tenant or the CRM.

---

## Raw schema
See **`database-schema.txt`** for the verbatim interface definitions (CRM model, store State, Account, Order, Subscription, Catalog) with file:line origins.
