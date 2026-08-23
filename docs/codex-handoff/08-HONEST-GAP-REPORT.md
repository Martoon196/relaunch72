# 08 — HONEST GAP REPORT

The prior artifact ("Inside Relaunch72") is a **founder/marketing briefing**. This file reconciles it against the code. Nothing below contradicts that the engineering is genuinely well-structured and tested — the point is to separate *proven-in-production* from *works-on-mock* from *not-built*, so the audit starts from reality.

## Capability classification

### Production-live (real code path, runs in prod, real external effect, tested)
- **HTTP server + routing + CORS + `/health`** (`src/server/app.ts`, `index.ts`). Deploys green unconfigured.
- **Stripe checkout (one-off + subscription) + signed webhook recording** — real Stripe client wired (`src/server/stripe.ts`, `subscriptions.ts`); logic tested against a fake. Real charging needs live keys (test-mode by default).
- **Admin control room** — password auth, list runs/orders, view pack, human sign-off (`src/server/admin/*`, `src/signoff/*`).
- **Client portal** — per-tenant auth, dashboard, billing screen (`src/portal/*`), tested via handler doubles.
- **Transactional email** — real Postmark HTTP client (`src/email/postmark.ts`); login email path wired (`src/portal/emails.ts`).
- **Persistence** — file stores work (`crm/store.ts`, `orders.ts`, `subscriptions.ts`, `portal/accounts.ts`). *Caveat: not durable on the current Render free plan (no disk).*

### Implemented but mocked (runs at £0; a live adapter exists but is UNPROVEN)
- **AI generation** — pipeline S1–S10 + brand brain run on `MockClient` by default; `AnthropicClient` is real but the portal/manager default to mock (`src/portal/run.ts`, `src/manager/rail-runner.ts:98`).
- **Content/Soro, keyword, social, ads generation** — full mock adapters + QA; live adapters exist but are never exercised (`src/{content,keyword,social,ads}/*`).
- **Manager tick / rail-runner** — computes and dispatches; £0 mock end to end (`src/manager/*`).
- **GHL push** — mock + live adapter, dormant by decision (`src/ghl/*`).

### Partially implemented
- **Billing lifecycle** — state captured; no dunning, no cancel-consequence, no proration, no usage limits (`06-BILLING-AND-PROVISIONING.md`).
- **Human approval** — the 72h pack only; ongoing rail output has no approval gate (`05`, `04`).
- **Audit trail** — CRM activities + run manifests; not an immutable event log (`04`).
- **Lead capture** — `/api/subscribe` + `/api/intake` exist but **do not create CRM contacts** (`03`).
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
**True for the mocked loop, not for real-world effects.** Intake → provision → brand-brain generation → login email → portal dashboard → subscribe is wired and proven (DI tests + a manual curl smoke). But every external effect in that loop is mock or test-mode (mock LLM, no live publish, test Stripe). So "end-to-end" = the *control flow* is complete; the *value delivery to real channels* is not yet exercised.

### "£0 to run"
**True and verified.** Mock adapters + in-memory/file stores + no paid API calls; the suite runs and the server boots with no keys. Two honest caveats: (a) £0 == mock == not real output; (b) hosting itself isn't free in a real deployment (Render), and £0 durability needs a paid disk.

### "One key switches any rail live"
**Structurally supported, not proven.** The mock/live interface split is real, so swapping requires no interface change. But **no live rail is tested or verified against its API**, Meta is incomplete, and the portal/manager hard-code the mock LLM in places — so flipping a key today does **not** yield a verified working live rail without further work. This is an architectural intention with real scaffolding, not a proven capability (`04`).

### "Manager that never sleeps"
**Not true as stated.** There is **no scheduler** — the manager runs only when a human invokes the CLI (`npm run manager …`) or clicks the portal Run button. It has no cron/worker/queue and no persisted last-run memory (calendar-only cadence). Accurate framing: "a manager you can run on demand," not one that runs itself (`04`).

### "Nothing invented, ever"
**True for generated deliverable copy; not a global guarantee.** The no-invention QA robustly blocks invented numbers and fabricated quotes in pipeline/rail **content** (fatal park, no retry — tested, `05`). It does **not** govern: the **dashboard's own KPIs** (hard-coded `posts=30`/`ads=2` and mock keyword volumes in `src/portal/views.ts`/`run.ts`), any **future AI CRM replies** (not routed through the QA), or the **truthfulness of client-supplied statements** (trusted verbatim). "Ever" overreaches; "no invented numbers or quotes in generated deliverables" is exact.

### "316 tests, all green"
**Verified true** (measured: 316 pass, after `npm ci`). But it is a count, not coverage: **no test crosses a real HTTP socket, no cross-tenant isolation test, no webhook idempotency/replay test** (`07`). Strong on evidence/QA and pure logic; thin on integration, isolation, and lifecycle.

---

## What is proven vs unproven — one-line summary
- **Proven:** the architecture, the no-invention QA on content, the pipeline mechanics, the payment/subscription *state capture*, the portal auth + provisioning control-flow — all at £0 on mocks, with 316 green unit/handler tests.
- **Unproven:** every live external integration (LLM in prod, keyword/social/ads/GHL, real charging), durability under load/redeploys, tenant isolation under attack, webhook idempotency, and the entire "send/publish/measure/converse" half of a marketing platform (much of which is not built at all).

## Suggested audit priorities (derived)
1. Tenant isolation model + a real DB with row-level scoping and migrations (replaces flat files).
2. Webhook idempotency + provisioning/payment coupling (email-join fragility).
3. A real job system for the manager (schedule, durable jobs, retries, locking, recovery).
4. Prove one live rail end-to-end behind a key, with an integration test; finish Meta.
5. Build the missing CRM spine (deals, tasks, appointments, conversations, consent, attribution, revenue) — the bulk of "CRM audit" scope.
6. Extend no-invention coverage to any AI that talks to customers (CRM replies) and to dashboard metrics.
