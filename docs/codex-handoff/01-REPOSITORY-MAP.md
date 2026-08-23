# 01 — REPOSITORY MAP

Concise tree (source + tests + deploy; excludes `.git`, `node_modules`, caches, generated `runs/`, and gitignored secrets `.env*`). Full tracked list: `repo-tree.txt`.

```
relaunch72/
├── package.json                 # npm workspaces root; scripts proxy into orchestrator
├── package-lock.json            # tracked lockfile (npm ci restores exact versions)
├── render.yaml                  # Render Blueprint (deploy)
├── .env.example                 # env var documentation (placeholders only)
├── docs/
│   ├── decisions.md             # D-001..D-066 design log (authoritative history)
│   ├── platform-architecture.md # own-portal vs GHL decision + build order
│   ├── roadmap.md               # north star + phases
│   ├── deploy-render.md         # deployment runbook
│   ├── content-engine.md, paid-ads-rail.md, socials-manager-spike.md, email-setup.md
│   └── codex-handoff/           # THIS PACK
├── site/  admin/                # static funnel + static admin assets (HTML; not the node server)
├── prompts/                     # versioned LLM prompt files (own IP), read by the pipeline
└── orchestrator/                # THE APP (npm workspace @relaunch72/orchestrator)
    ├── tsconfig.json
    ├── fixtures/                # sample intakes (trades/coach/ecom) used by tests + demo
    ├── test/                    # 32 *.test.ts files (node:test) — see 07-TEST-MAP.md
    └── src/
        ├── types.ts             # Intake + shared pipeline types
        ├── config.ts            # .env load + model/cost config (root config)
        ├── paths.ts             # RUNS_DIR / FIXTURES_DIR
        ├── cli.ts               # pipeline CLI (S0→S10 over one intake)
        ├── intake/              # intake spec, S0 gate, form generation
        ├── stages/              # generic stage runner, stage defs, schemas, S10 assembly
        ├── qa/                  # no-invention / evidence QA (checks.ts, banned.ts)
        ├── llm/                 # LlmClient: AnthropicClient (live) + MockClient + json extract
        ├── content/  social/  keyword/  ads/   # the four capability rails (each: types+mock+live+stage/cli)
        ├── ghl/                 # GoHighLevel adapter (mock + live) — dormant, see notes
        ├── manager/             # per-tenant orchestrator (schedule, engine, rail-runner, cli)
        ├── crm/                 # thin CRM core (types, store, ingest)
        ├── portal/              # client portal (session, accounts, data, views, router, run, provision, billing, emails)
        ├── server/              # node:http server, Stripe, catalog, orders, subscriptions, config
        │   └── admin/           # /admin control room (session, store, views, router)
        ├── email/               # brevo.ts (marketing) + postmark.ts (transactional)
        ├── signoff/  deliver/  docs/  runs/  util/   # sign-off, pack delivery, doc render, manifest, text utils
```

---

## Ownership map — who owns what (with citations)

### Authentication
Two **separate** cookie-based auth systems; both HMAC-signed, no user-auth framework, no OAuth.
- **Admin auth** (single shared password): `src/server/admin/session.ts` — `passwordOk` (`:14`), `signSession`/`verifySession` (`:22`,`:29`), cookie `r72_admin` (`:10`). Gate: `src/server/admin/router.ts:55,71`. Password from `ADMIN_PASSWORD` (`src/server/config.ts:63`); empty ⇒ `/admin` disabled (`admin/router.ts:48`).
- **Client-portal auth** (per-tenant): `src/portal/session.ts` — `signTenant`/`verifyTenant` carry `tid`+`exp` (`:21`,`:28`), cookie `r72_portal` (`:9`), `passwordOk` constant-time (`:13`). Credentials verified against the account store: `src/portal/accounts.ts` `verify` (`:62-69`, SHA-256 + `timingSafeEqual`). **Passwords are unsalted SHA-256** (`accounts.ts:25-27`) — flag for audit.
- Both HMAC secrets come from `SESSION_SECRET` (falls back to the Stripe webhook secret; `src/server/config.ts:78-79`).

### Multitenancy / workspaces
- A **workspace = a `Tenant`** (`src/crm/types.ts:16-22`). There is **no separate "workspace"/"organization" entity** and **no user↔workspace join** — one account maps to exactly one tenant (`src/portal/accounts.ts:11-15`, field `tenantId: string`).
- Tenant id is derived deterministically from the signup email: `tenantIdFor` = `t-<slug(name)>-<sha256(email)[0:6]>` (`src/portal/provision.ts:41-42`).
- Isolation is **application-level only**: the signed cookie carries `tid`; every read goes through `store.tenantView(tenantId)` which filters by `tenantId` (`src/crm/store.ts:107-117`). Details + gaps: `02-DATA-AND-TENANCY.md`.

### Client portal
`src/portal/` — routing/auth gate `router.ts` (`handlePortal:66`), server-rendered HTML `views.ts` (`loginPage`, `dashboardPage`, `billingPage`), dashboard assembly `data.ts` (`makeDashboard:61`), live run `run.ts`, provisioning + DI wiring `provision.ts` (`buildPortalDeps:103`). Mounted into the server at `src/server/app.ts:92-96` (before the JSON API), boot wiring `src/server/index.ts:139-167`.

### Intake
- Field spec + validation rules: `src/intake/spec.ts` (`INTAKE_FIELDS`, `FIELD_BY_ID`). Form generation: `src/intake/form.ts`, `build-form.ts`.
- **S0 gate** (no-LLM validation: required fields, min-words, placeholder-echo): `src/intake/s0.ts` (`runS0:136-193`). HTTP entry `POST /api/intake` at `src/server/app.ts:164-177`.

### Brand brain
- Definition: the stored intake → S1–S10 strategy per tenant, held in the tenant's **run dir** (`src/crm/types.ts:19-20`, `Tenant.runDir`).
- Generated by `generateBrandBrain(intake, dir)` = runs `STAGE_ORDER` S1–S9 (+ content cluster, keyword, ad) into the run dir (`src/portal/run.ts:37-55`; stage order `src/stages/defs.ts:43`).
- Surfaced to the client from `s3.json` + artifact JSONs by `src/portal/data.ts:32-59`.

### No-invention / evidence QA
- `src/qa/checks.ts` (2,161 lines) — per-stage checks; core helpers `inventedNumbers` (`:135`), `quoteTracesTo` (`:61`), `findVerbatimSpan` (`:69`), `haystack` (`:39`). Banned-phrase/lexicon layer `src/qa/banned.ts`.
- **FATAL (park immediately, no retry)** checks: `s4.risk_reversal_promises_outcome` (`:747-749`), `s6.proof_word_unsupported` (`:1138-1140`), `cc.number_invented` (`:1888-1890`), `cc.quote_fabricated` (`:1903-1905`), `social.number_invented` (`:2034`), `social.quote_fabricated` (`:2052`), `ad.number_invented` (`:2115`), `ad.quote_fabricated` (`:2126`).
- Enforcement lives in the stage runner: fatal issue ⇒ park with no retry (`src/stages/runner.ts:150-156`). Full detail: `05-AI-EVIDENCE-SYSTEM.md`.

### Content / Soro engine
- `src/content/stage.ts` (`CONTENT_CLUSTER_STAGE`), `src/content/cli.ts`. Schema `src/stages/schemas.ts` (`CONTENT_CLUSTER_SCHEMA`). QA `qaContentCluster` (`src/qa/checks.ts:1863`). Mock generation `src/llm/mock.ts` (`mockContentCluster`). Prompt `prompts/content-cluster.md`.

### Manager orchestration
- `src/manager/` — cadence rules → due actions `schedule.ts` (`isCadenceDue:13`, `dueActions:27`), tick engine `engine.ts` (`runTick:62`, `mockRunner:17`, `ghlRunner:40`), the real per-tenant rail executor `rail-runner.ts` (`railRunner:92`, `runRail:41`), CLI `cli.ts`. Types `types.ts`. Full detail: `04-MANAGER-AND-RAILS.md`.

### CRM — contacts
- Model `src/crm/types.ts` (`Contact:24-32`). Store ops `src/crm/store.ts` — `addContact:73-88` (**assigns `c-<seq>` ids; no dedup**), `moveContact:90-98`.

### Pipelines (sales pipeline / stages)
- `PIPELINE_STAGES = ['lead','contacted','qualified','won','lost']` (`src/crm/types.ts:13-14`). Stage counts computed in `tenantView` (`src/crm/store.ts:111-112`). **No opportunity/deal entity and no monetary value on a stage** — see `03-CRM-AND-EVENTS.md`.

### Activity timeline
- Model `Activity` (`src/crm/types.ts:34-42`). Writes: `addActivity` (`src/crm/store.ts:100-105`); auto-written on contact create (`store.ts:85`) and stage change (`store.ts:95`). Manager runs bridged in via `src/crm/ingest.ts` (`ingestTick:20`). Portal-run entries `src/portal/run.ts`. **These are typed business events, but the seeded demo timeline is written manually** — see `03-CRM-AND-EVENTS.md`.

### Billing
- Stripe wrapper `src/server/stripe.ts` (`createCheckoutSession:31`, `createSubscriptionCheckout` ~`:60`, `createBillingPortalUrl`, `orderFromEvent`, `verifyEvent`). Recurring model + store + event mapping `src/server/subscriptions.ts`. Catalog (products/prices, code-defined) `src/server/catalog.ts`. One-off orders `src/server/orders.ts`. Routes `src/server/app.ts:111,119,126`. Portal billing UI `src/portal/billing.ts` + `views.ts` `billingPage`. Full detail: `06-BILLING-AND-PROVISIONING.md`.

### Admin
- `src/server/admin/` — `router.ts` (`handleAdmin:47`), `store.ts` (`listRuns`, `getRunDetail`, `readDeliverable`, `listOrders`), `views.ts`, `session.ts`. Sign-off writes `signoff.json` reusing `src/signoff/signoff.ts`.

### Provider adapters (the "rails")
Each rail = interface + mock + live, same pattern:
- **LLM:** `src/llm/client.ts` (`LlmClient` interface `:27`, `AnthropicClient` live `:32`), `src/llm/mock.ts` (`MockClient`).
- **Keyword:** `src/keyword/types.ts` (`KeywordProvider`), `mock.ts` (`MockKeywordProvider`), `dataforseo.ts` (live).
- **Social:** `src/social/types.ts` (`SocialPublisher`), `mock.ts` (`MockPublisher`), `ayrshare.ts` (live).
- **Ads:** `src/ads/types.ts` (`AdsPublisher`), `mock.ts` (`MockAdsPublisher`), `meta.ts` (live).
- **GHL (dormant):** `src/ghl/types.ts` (`GhlClient`), `mock.ts`, `live.ts` (`GhlLiveClient`).
- **Email:** `src/email/postmark.ts` (transactional), `src/email/brevo.ts` (marketing).
Detail + env vars + gaps per rail: `04-MANAGER-AND-RAILS.md`.

### Tests
`orchestrator/test/*.test.ts` — 32 files, 316 tests (`npm test`). Map: `07-TEST-MAP.md`.

### Deployment
`render.yaml` (Blueprint), `docs/deploy-render.md` (runbook), entry `src/server/index.ts` (`main:102`, listen `:168`).
