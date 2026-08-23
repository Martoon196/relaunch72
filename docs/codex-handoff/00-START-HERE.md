# 00 — START HERE (Relaunch72 audit handoff)

> Prepared for an external coding agent performing a full CRM + architecture audit.
> **Documentation only** — no code, deps, or config were changed to produce this pack
> (one exception, called out below: `npm ci` was run to restore already-locked deps so
> the test suite could execute; no versions changed).
> Every non-obvious claim in this pack cites `path:line`. Secret *values* are never included — only variable **names**.

---

## Repository

| Field | Value |
|---|---|
| Name | `relaunch72` (GitHub: `Martoon196/relaunch72`) |
| Absolute path | `/home/user/relaunch72` |
| Current branch | `claude/relaunch72-architecture-1fi7qd` |
| Current commit | `b1f601d833b36b804ba37661341f9d48a4cf4e89` — *"portal: billing screen … (own-portal slice 7, D-066)"* (2026-07-28) |
| Remote | `https://github.com/Martoon196/relaunch72` |
| Working tree | **Clean** — `git status --porcelain` is empty (verified before this pack; the pack adds only `docs/codex-handoff/**`, uncommitted). |
| Uncommitted work | None other than this handoff folder. Nothing has been committed or pushed. |

The full commit-by-commit design rationale lives in `docs/decisions.md` (decisions **D-001 … D-066**). The two most useful orientation docs already in-repo: `docs/platform-architecture.md` and `docs/roadmap.md`.

---

## Technology stack (exact)

Monorepo via **npm workspaces** (`package.json:6-8`), single workspace `orchestrator`.

| Layer | Choice | Version source |
|---|---|---|
| Runtime | Node.js **v22.22.2** (declared `engines.node >=20`, `package.json:22-24`; Render pins `NODE_VERSION=22`, `render.yaml`) | measured |
| Package manager | npm **10.9.7** | measured |
| Language | TypeScript, declared `^5.7.0` (`orchestrator/package.json`), **5.9.3** resolved in `package-lock.json` | measured |
| Module system | **ESM** — `"type": "module"`, `tsconfig` `module/moduleResolution: NodeNext` (`orchestrator/tsconfig.json`) |
| TS strictness | `strict: true`, `noUncheckedIndexedAccess: true` (`orchestrator/tsconfig.json:6-7`) |
| Run/loader | **tsx** `^4.19` — TypeScript executed directly, no build step |
| HTTP server | **node:http only** — no Express/Fastify (`orchestrator/src/server/index.ts:168`, `createApp` in `src/server/app.ts:74`) |
| Test runner | **node:test** via `node --import tsx --test test/*.test.ts` (`orchestrator/package.json`) |
| Payments | `stripe` `^22.3.0` |
| LLM | `@anthropic-ai/sdk` `^0.110.0` (`src/llm/client.ts:1`) |
| JSON schema | `ajv` `^8.17.1` (`src/stages/runner.ts:10,18`) |
| Env loading | `dotenv` `^16.4.5` (`src/config.ts`, imported for side-effect by `src/server/config.ts:9`) |
| Proxy | `https-proxy-agent` `^9.1.0` |
| Browser (PDF/screens) | `playwright-core` `^1.61.1` |

There is **no frontend framework**. The client portal and admin are **server-rendered HTML strings** (`src/portal/views.ts`, `src/server/admin/views.ts`). The public funnel is static HTML on GitHub Pages (outside this repo's server).

---

## Local setup & startup

```bash
# from repo root
npm ci                 # or: npm install  — REQUIRED on a fresh clone (see "Known broken" #1)
cp .env.example .env   # then fill in the values you need (all optional for mock runs)

# run the payments/portal server (the production entry point)
npm run serve          # → orchestrator/src/server/index.ts ; listens on PORT (default 4242)

# run the AI pipeline once over an intake JSON (mock LLM, £0)
npm run pipeline -- --input <intake.json> --mock

# the capability rails (all have a --mock mode, £0)
npm run content -- --help
npm run social  -- --help
npm run keyword -- --help
npm run ads     -- --help

# the per-tenant "manager" tick (see 04-MANAGER-AND-RAILS.md)
npm run manager -- --date 2026-08-03 --mock
npm run manager -- --date 2026-08-03 --rails --mock   # whole package, mock, £0
```

Server boots **even with no secrets**: with no `STRIPE_SECRET_KEY` it logs `UNCONFIGURED` and `/health` still returns 200; checkout/webhook return 503 until a key is set (`src/server/index.ts:107`, `src/server/app.ts:112,120,127`).

## Test commands

```bash
npm test        # → node --import tsx --test test/*.test.ts   (from orchestrator workspace)
npm run typecheck   # → tsc --noEmit
```

Current result: **316 tests, 316 pass, 0 fail** (full log: `test-output.txt`). Typecheck: clean. See `07-TEST-MAP.md` for the caveats (no test crosses a real HTTP socket; no cross-tenant or webhook-idempotency tests).

---

## Deployment

- **Platform:** Render (Blueprint in `render.yaml`). Service `relaunch72-payments`, `runtime: node`, region frankfurt, **plan `free`** (sleeps after 15 min idle).
- **Build:** `npm install` (repo root). **Start / production entry point:** `npm run serve` → **`orchestrator/src/server/index.ts`** (`main()` at `src/server/index.ts:102`, listen at `:168`). Health check: `/health`.
- **Static funnel** (landing / scorecard / autopsy / checkout / intake): separate, on **GitHub Pages at relaunch72.com** — plain HTML, not served by this repo's server (`docs/deploy-render.md:3-8`).
- **Guide:** `docs/deploy-render.md` (dashboard steps, DNS, Stripe webhook registration).

## Database provider

**None.** There is no SQL/NoSQL database. All state is **flat files**:
- Orders → JSONL append log `orders.jsonl` (`src/server/orders.ts:32-58`).
- Subscriptions → JSONL append log `subscriptions.jsonl` (`src/server/subscriptions.ts:180-206`).
- CRM (tenants/contacts/activity) → single JSON file `portal-crm.json` (`src/crm/store.ts:120-129`).
- Portal accounts → JSON file `portal-accounts.json` (`src/portal/accounts.ts:29-41`).
- Pipeline run artifacts → per-run directories under `RUNS_DIR` (`src/paths.ts:14`).

Root dir defaults to `<repo>/data` (`src/server/config.ts:64`) / `<repo>/runs` (`src/paths.ts:14`); on Render, point `DATA_DIR` at a mounted persistent disk (commented in `render.yaml`; without it, **files reset on every redeploy**). Full detail: `02-DATA-AND-TENANCY.md`.

## Where environment variables are documented

- **`.env.example`** (repo root, tracked) — the canonical list with inline comments. Contains **placeholders only, no secrets** (verified).
- `render.yaml` `envVars` — the production set (secrets marked `sync: false`, pasted in the Render dashboard).
- Machine-extracted name list: **`environment-variable-names.txt`** in this folder.

---

## Known broken / unfinished areas (start your audit here)

1. **Fresh clone can't run until deps are installed.** This container had **no `node_modules`**; `npm test` failed with `Cannot find package 'tsx'` until `npm ci` was run. Not a code bug, but the handoff environment needs `npm ci` first. A tracked `package-lock.json` exists, so `npm ci` restores exact versions.
2. **`npm ci` reports 1 high-severity vulnerability** (`npm audit`). Not investigated or fixed (out of scope: "do not update dependencies").
3. **Live provider adapters are unproven against real APIs.** Ayrshare, DataForSEO, Meta, GHL adapters are **not exercised by any test or mock run**; each file says "verify against current docs before the live run" (`src/social/ayrshare.ts:7-10`, `src/keyword/dataforseo.ts:6-9`, `src/ads/meta.ts:4-11`, `src/ghl/live.ts:5-11`).
4. **No SMS/WhatsApp rail exists.** `Channel` includes `'sms' | 'whatsapp'` (`src/crm/types.ts:9`) but there is **no Twilio/adapter code** anywhere (grep: none). Email adapters exist (Brevo, Postmark).
5. **No account-connection / OAuth flow.** No OAuth, no token refresh, no inbound provider webhooks (only Stripe). Live rails read static tokens from env. See `04-MANAGER-AND-RAILS.md`.
6. **The "manager" has no scheduler or durable jobs.** It's a CLI tick computed from the calendar (`src/manager/schedule.ts`); no cron, queue, retry, locking, or idempotency layer. See `04-MANAGER-AND-RAILS.md`.
7. **Portal "Run" uses the mock LLM by default** (`src/portal/run.ts` builds a `MockClient`); real generation needs the Anthropic key wired into that path.
8. **No cancellation / export / data-deletion logic.** `customer.subscription.deleted` updates status only; nothing de-provisions, exports, or removes generated assets (see `06-BILLING-AND-PROVISIONING.md`).
9. **Test blind spots:** no test crosses a real HTTP socket; no cross-tenant isolation test; no Stripe-webhook idempotency/replay test (see `07-TEST-MAP.md`).
10. **`render.yaml` uses the free plan with no persistent disk** — production data is not durable across redeploys unless a disk + `DATA_DIR` are added.

See `08-HONEST-GAP-REPORT.md` for the full production-live / mocked / interface-only / not-built classification and a reconciliation of the marketing briefing's claims.
