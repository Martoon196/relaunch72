# 08 — HONEST GAP REPORT

> **Engineering update — 2026-08-24:** this report is an intentionally retained
> pre-foundation baseline. The database/RLS foundation and a first PostgreSQL CRM
> loop now exist locally, so the “not built” and test-count statements below are
> historical. The current, deliberately unsmoothed status—including the portal
> identity cutover that still blocks runtime activation—is in
> [19-CRM-FIRST-LOOP-STATUS.md](./19-CRM-FIRST-LOOP-STATUS.md).

The prior artifact ("Inside Relaunch72") is a **founder/marketing briefing**. This file reconciles it against the code. Nothing below contradicts that the engineering is genuinely well-structured and tested — the point is to separate *proven-in-production* from *works-on-mock* from *not-built*, so the audit starts from reality.

## Capability classification

### Implemented runtime surfaces (not approved for live money)
- **HTTP server + routing + CORS + `/health`** (`src/server/app.ts`, `index.ts`). Liveness stays up while readiness reports explicit blockers.
- **Stripe one-off checkout + signed webhook recording** — real Stripe client wired and handler-tested, but deployed use is a private, mock-only test sandbox. Live/unknown keys are hard-locked until PostgreSQL durable jobs and commercial provenance exist.
- **Recurring subscription scaffolding** — event projection and checkout builders exist, but checkout is preview-only, defaults disabled and remains commercially unsafe until workspace/price/customer binding and ordered event handling are implemented.
- **Admin control room** — password auth, list runs/orders, view pack, human sign-off (`src/server/admin/*`, `src/signoff/*`).
- **Client portal** — per-tenant auth, dashboard, billing screen (`src/portal/*`), tested via handler doubles.
- **Transactional email** — real Postmark HTTP client (`src/email/postmark.ts`); login email path wired (`src/portal/emails.ts`).
- **Persistence** — file stores work (`crm/store.ts`, `orders.ts`, `subscriptions.ts`, `portal/accounts.ts`). They are not transactional across processes; even a persistent disk does not make them live-money safe.

### Implemented but mocked (runs at £0; a live adapter exists but is UNPROVEN)
- **AI generation** — pipeline S1–S10 + brand brain run on `MockClient` by default; `AnthropicClient` is real but the portal/manager default to mock (`src/portal/run.ts`, `src/manager/rail-runner.ts:98`).
- **Content/Soro, keyword, social, ads generation** — full mock adapters + QA; live adapters exist but are never exercised (`src/{content,keyword,social,ads}/*`).
- **Manager tick / rail-runner** — computes and dispatches; £0 mock end to end (`src/manager/*`).
- **GHL push** — mock + live adapter, dormant by decision (`src/ghl/*`).

### Partially implemented
- **Billing lifecycle** — state captured; no dunning, no cancel-consequence, no proration, no usage limits (`06-BILLING-AND-PROVISIONING.md`).
- **Human approval** — the 72h pack only; ongoing rail output has no approval gate (`05`, `04`).
- **Audit trail** — CRM activities + run manifests; not an immutable event log (`04`).
- **Lead capture** — `/api/subscribe` + `/api/intake` exist but **do not create CRM contacts** (`03`); unauthenticated Brevo capture now defaults disabled pending consent/double-opt-in and abuse controls.
- **Data durability** — works locally; resets on redeploy without a Render disk (`render.yaml`).

### Interface / adapter present but UNPROVEN live
- **Every live provider rail** (Anthropic, DataForSEO, Ayrshare, Meta, GHL): interface + live code, **zero live/integration tests**, each header says "verify before the live run"; Meta is additionally **incomplete** (paused campaign only, no ad sets/creatives) (`04-MANAGER-AND-RAILS.md`).

### Not built
- **SMS / WhatsApp rail** (type exists, no adapter).
- **Account connections / OAuth** (no connect flow, no token refresh, no provider webhooks).
- **Scheduler / durable jobs / retries / idempotency / concurrency locking / recovery / monitoring** for the manager.
- **CRM: opportunities/deals, tasks, appointments, conversations/messages, consent/suppression, source/UTM attribution, revenue roll-up, contact dedup, contact CRUD API.**
- **Cancellation / export / data-deletion / GDPR erasure.**
- **Multi-workspace membership, roles/permissions** (one account = one tenant; admin is a shared password).
- **Real analytics / performance metrics** (dashboard KPIs are mock/literal).
- **Database + migrations** (flat files, no migration tooling).

---

## Reconciling the briefing's specific claims

### "Seven platform layers" vs "nine layers"
The briefing's hero stat says **"7 platform layers live"**; its own "What we've built" section then lists **9** layer cards (AI engine, Soro, rails, manager, CRM, portal, self-serve loop, billing, funnel/admin). **The two numbers are inconsistent**, and neither is a rigorous count of *production-live* layers. Reality: ~9 named components exist in code; the subset that is genuinely production-live with real external effects (per the classification above) is smaller (server, payments-recording, admin, portal, transactional email). Treat "7"/"9" as loose marketing counts, not an architecture inventory.

### "An entire marketing department"
**Overstated.** What exists is a **strategy + content generator with a thin CRM**: it can *generate* content clusters, keyword reports and ad drafts (on mock by default), and hold contacts/pipeline/timeline. A marketing department also *sends* (no SMS/WhatsApp, email is send-only with no sequences), *publishes* (no proven live social/ads), *converses* (no messages/inbox), *books* (no appointments), and *measures* (no analytics). Those are absent. Fair description: "an AI marketing **content & strategy engine** with a thin CRM and a client portal."

### "End-to-end"
**True for a private mocked one-off loop, not for real-world effects.** Access-code-protected test checkout → signed webhook → paid entitlement → canonical intake → mock build is handler-tested. Portal provisioning is still a separate post-accept side effect, and recurring subscribe is deliberately preview-locked. So "end-to-end" means the safe test control flow exists; real charging and value delivery to live channels do not.

### "£0 to run"
**True for the private sandbox.** Its deployed test build mode is forced to mock and capped, so a public Stripe test card cannot spend Anthropic credits. Two honest caveats: (a) £0 == mock == not real output; (b) hosting and production-grade persistence are not free.

### "One key switches any rail live"
**Structurally supported, not proven.** The mock/live interface split is real, so swapping requires no interface change. But **no live rail is tested or verified against its API**, Meta is incomplete, and the portal/manager hard-code the mock LLM in places — so flipping a key today does **not** yield a verified working live rail without further work. This is an architectural intention with real scaffolding, not a proven capability (`04`).

### "Manager that never sleeps"
**Not true as stated.** There is **no scheduler** — the manager runs only when a human invokes the CLI (`npm run manager …`) or clicks the portal Run button. It has no cron/worker/queue and no persisted last-run memory (calendar-only cadence). Accurate framing: "a manager you can run on demand," not one that runs itself (`04`).

### "Nothing invented, ever"
**True for generated deliverable copy; not a global guarantee.** The no-invention QA robustly blocks invented numbers and fabricated quotes in pipeline/rail **content** (fatal park, no retry — tested, `05`). It does **not** govern: the dashboard's clearly labelled **mock/simulated metrics** derived from draft artifacts, any **future AI CRM replies** (not routed through the QA), or the **truthfulness of client-supplied statements** (trusted verbatim). "Ever" overreaches; "no invented numbers or quotes in generated deliverables" is exact.

### Test status
**Current measured state: 374 tests pass through the repository's normal `npm test` command**, plus TypeScript type-check and dependency audit. The suite now covers webhook replay/quarantine, entitlement reuse, strict tier scope, session audience separation, sandbox outbound-message locks, private access and truthful mock states. It is still a count, not production proof: no test crosses a real provider account, file claims are not multi-replica transactions, and the current thin CRM has no database/RLS isolation model.

---

## What is proven vs unproven — one-line summary
- **Proven:** the architecture, no-invention content QA, pipeline mechanics, private test-payment control flow, hardened file-backed portal auth and truthful mock surfaces — all on mocks/handler tests.
- **Unproven or intentionally locked:** every live external integration, real charging, commercial checkout provenance, multi-process durability/tenant isolation, durable fulfilment and the "send/publish/measure/converse" half of a marketing platform.

## Suggested audit priorities (derived)
1. Tenant isolation model + a real DB with row-level scoping and migrations (replaces flat files).
2. Webhook idempotency + provisioning/payment coupling (email-join fragility).
3. A real job system for the manager (schedule, durable jobs, retries, locking, recovery).
4. Prove one live rail end-to-end behind a key, with an integration test; finish Meta.
5. Build the missing CRM spine (deals, tasks, appointments, conversations, consent, attribution, revenue) — the bulk of "CRM audit" scope.
6. Extend no-invention coverage to any AI that talks to customers (CRM replies) and to dashboard metrics.
