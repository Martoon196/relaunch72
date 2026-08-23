# 04 — MANAGER & RAILS

## How "Run this week" and the AI manager actually work

There are **two** entry points, both thin:

### A) Portal "Run this week" button
`POST /portal/run` → `deps.runTick(tenantId)` → `runTickReal(store, tenantId)` (`src/portal/router.ts:127-133`, `src/portal/run.ts:59`). `runTickReal` regenerates this period's content/keyword/ads **for one tenant** from its `runDir`, records activities, and falls back to a *simulated* run if the tenant has no brand brain (`src/portal/run.ts:57-59+`). It runs **synchronously inside the HTTP request** and uses the **mock LLM** (`MockClient`) — so it's £0 and fast, but it is not real generation and not backgrounded.

### B) Manager CLI tick
`npm run manager -- --date <YYYY-MM-DD> [--rails] [--ghl] [--mock]` (`src/manager/cli.ts`). Flow:
1. `dueActions(tenants, date)` — for each tenant × cadence rule, is it due? (`src/manager/schedule.ts:27-37`).
2. `runTick(tenants, date, runner)` iterates due actions through an injected `ActionRunner` (`src/manager/engine.ts:62-76`).
3. Runner is one of: `mockRunner` (log-only, `engine.ts:17`), `ghlRunner` (push seam only, `:40`), or `railRunner` (actually generate each rail + push to GHL, `src/manager/rail-runner.ts:92`).

**Cadence is purely calendar-derived** (`isCadenceDue`, `schedule.ts:13-24`): `daily`=every day, `weekly`=Mondays (`getUTCDay()===1`), `monthly`=1st. This is deliberate so a tick needs no persisted last-run state — but it also means the manager has no memory of what it already did.

### The orchestration guarantees — measured against your checklist

| Concern | State | Evidence |
|---|---|---|
| **Scheduler** | **ABSENT.** No cron, no timer, no queue. The tick only runs when a human invokes the CLI (or the portal button fires one tenant). `render.yaml` defines a single web service, **no cron job / worker**. | `src/manager/cli.ts`, `render.yaml` |
| **Durable job storage** | **ABSENT.** No job/queue table. Tick results are printed to stdout (`cli.ts:80-85`) and, via `ingestTick`, appended as CRM activities. No job records, no status, no re-drive. | `src/manager/engine.ts:56-76`, `src/crm/ingest.ts` |
| **Retries** | **PARTIAL.** A failing action is caught and recorded as `status:'failed'` — **no retry** (`engine.ts:69-73`). The only retry anywhere is (a) the Anthropic SDK `maxRetries:4` on 429/5xx (`src/llm/client.ts:43`) and (b) the pipeline's one schema/QA retry per stage (`src/stages/runner.ts:92-172`). Rail/publish failures do not retry. |
| **Idempotency** | **ABSENT for ticks.** Re-running the same date re-does everything (calendar-only cadence, no last-run marker). Provisioning is idempotent per email (`src/portal/provision.ts:57-59`) and catalog/plan creation is idempotent by Stripe `lookup_key` (`src/server/catalog.ts`), but **ticks and publishes are not**. |
| **Concurrency locking** | **ABSENT.** No locks/leases/mutex. Two overlapping ticks (or two portal Run clicks) would run concurrently with no guard; JSON stores do read-modify-write with no locking (`src/crm/store.ts:126-128`). |
| **Failure recovery** | **ABSENT.** No dead-letter, alerting, or resume. Fire-and-forget hooks log to `console.warn` only (`src/server/app.ts:174`, `src/server/index.ts:157`). |
| **Monitoring** | **ABSENT.** No metrics, health of jobs, or dashboards for the manager. Only `/health` for the web process. |
| **Audit trail** | **PARTIAL.** CRM activities (`rail_run`) are the closest thing (`src/crm/ingest.ts`), plus per-run manifest files (`src/runs/manifest.ts`) and raw stage outputs saved per attempt (`src/stages/runner.ts:104`). No immutable, tamper-evident audit log. |
| **Human approval** | **PARTIAL / one place only.** The 72h **pack** has a human sign-off gate in `/admin` (`src/server/admin/router.ts:90-115`, `src/signoff/signoff.ts`). Ongoing manager rail output does **not** route through approval before "publishing" (today it only pushes to a mock GHL). |
| **Advert-spend protection** | **REAL (by construction).** The ads rail only ever creates **PAUSED** drafts and never un-pauses/spends: mock returns `paused_draft` (`src/ads/mock.ts`), Meta live creates `status=PAUSED` campaigns only and the header comment states "Nothing here ever un-pauses or spends" (`src/ads/meta.ts:11`, `:4-6`). There is no budget/spend API call anywhere. |

**Bottom line:** the manager is a **deterministic planner + dispatcher**, not a production job system. Everything about durability, scheduling, retries, idempotency, locking, and recovery is still to be built.

---

## Per-rail breakdown

Common pattern per rail: a TypeScript **interface**, a **mock** adapter (used in tests + £0 runs), a **live** adapter (key-guarded, **not exercised by tests**). Each live adapter's own header says to verify against current provider docs before a live run.

### AI / LLM
- Interface: `LlmClient` (`src/llm/client.ts:27-30`). Mock: `MockClient` (`src/llm/mock.ts`). Live: `AnthropicClient` (`src/llm/client.ts:32-78`), streams via SDK, `maxRetries:4`.
- Env: `ANTHROPIC_API_KEY` **or** `ANTHROPIC_AUTH_TOKEN` (guarded `client.ts:37-41`); model default `RELAUNCH72_MODEL_DEFAULT` (`src/config.ts`).
- OAuth/webhooks/refresh: n/a. **Gaps:** portal/manager default to mock; live path proven only by the SDK, not by an integration test.

### Keyword — DataForSEO
- Interface: `KeywordProvider` (`src/keyword/types.ts`). Mock: `MockKeywordProvider` (`src/keyword/mock.ts`, deterministic FNV hash). Live: `src/keyword/dataforseo.ts` (Basic-auth POST to `/v3/keywords_data/google_ads/search_volume/live`).
- Env: `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `DATAFORSEO_LOCATION_CODE`, `DATAFORSEO_LANGUAGE_CODE`.
- OAuth/webhooks/refresh: none (Basic auth). **Gaps:** not tested against the live API; header warns "verify before the live run" (`dataforseo.ts:6-9`).

### Social — Ayrshare
- Interface: `SocialPublisher` (`src/social/types.ts`). Mock: `MockPublisher` (`src/social/mock.ts`). Live: `src/social/ayrshare.ts` (REST wrapper). Schedule builder `src/social/schedule.ts`.
- Env: `AYRSHARE_API_KEY`, `AYRSHARE_PROFILE_KEY` (per-customer profile). 
- OAuth: **not in our code** — Ayrshare brokers the per-network connections behind a profile key; there is no OAuth flow, connect screen, or token-refresh here. Webhooks/status-sync: none. **Gaps:** no connect UI, no post-status polling in code, not tested live (`ayrshare.ts:7-10`).

### Ads — Meta Marketing API
- Interface: `AdsPublisher` (`src/ads/types.ts`). Mock: `MockAdsPublisher` (`src/ads/mock.ts`, paused draft). Live: `src/ads/meta.ts`.
- Env: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID` (guarded `meta.ts:31-36`).
- OAuth/refresh/webhooks: **none** — uses a static access token; no OAuth login, no token refresh, no lead/status webhooks. **Gaps:** creates only a PAUSED **campaign** — ad sets / creatives / ads are explicitly "the next step (needs a Page id, pixel, budget + our own app review)" (`meta.ts:8-11`); not tested live.

### Email
- **Transactional — Postmark:** `PostmarkLike` + `makePostmark` (`src/email/postmark.ts:41-124`, real node:https client). Env: `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM`, `EMAIL_REPLY_TO`. Used for the login email (`src/portal/emails.ts` → `src/server/index.ts:118-121`) and pack delivery.
- **Marketing — Brevo:** `src/email/brevo.ts`, wired as `onLead`/`onCustomer` hooks. Env: `BREVO_API_KEY`, `BREVO_LIST_LEADS`, `BREVO_LIST_CUSTOMERS` (`src/server/index.ts` `makeMarketing`).
- OAuth/webhooks/refresh: none (API keys). Inbound email/webhooks: none. **Gap:** email is send-only; no delivery/bounce webhooks, no reply capture.

### SMS / WhatsApp
- **NOT BUILT.** `Channel` type lists `sms`/`whatsapp` (`src/crm/types.ts:9`) but there is **no adapter, interface, or provider code** (grep for twilio/sms/whatsapp/sendgrid: none). This is the biggest rail gap versus the "entire marketing department" claim.

### GoHighLevel (dormant)
- Interface `GhlClient` (`src/ghl/types.ts`), Mock `src/ghl/mock.ts`, Live `GhlLiveClient` (`src/ghl/live.ts`, API v2). Env: `GHL_API_TOKEN`, `GHL_AGENCY_ID`, `GHL_BLOG_ID`.
- Kept as optional scaffolding after the decision to build our own portal (D-060). The manager can push to GHL via `ghlRunner`/`railRunner`, but this is not part of the own-portal product path. **Gaps:** not tested live; content push needs `GHL_BLOG_ID` or it returns a clear no-push (`ghl/live.ts:8-11`).

---

## Is "one key switches it live" proven in code, or an intention?

**It is an architectural pattern that is real in structure but UNPROVEN end-to-end.**

- **Real:** each rail has a live adapter behind the same interface as its mock, selected by presence of an env key (e.g. `railRunner` picks `MockClient` vs `AnthropicClient` on `opts.mock`, `src/manager/rail-runner.ts:98`; the server builds live email/marketing only when the token exists, `src/server/index.ts`). So *swapping* mock→live requires no interface change — that much is proven by the code shape and the mock tests.
- **Unproven:** **no live adapter is covered by any test or has been run against the real API in this repo.** Every live adapter header explicitly says "NOT exercised in tests or mock runs … verify against current docs before the live run" (`ayrshare.ts:7-10`, `dataforseo.ts:6-9`, `meta.ts:4-5`, `ghl/live.ts:6-7`). The Meta rail is additionally **incomplete** (campaign-only, no ad sets/creatives). And the portal/manager default to mock, so turning a key on also requires wiring the live client into those call sites (`src/portal/run.ts` currently hard-codes `MockClient`).

So: "one key flips the *interface*" is true; "one key flips a *working, verified live rail*" is **not yet true** for any rail except, arguably, transactional email (Postmark client is a real HTTP client, though still not integration-tested here).
