# Handoff: Growth HQ Webinars module (`webinars/`)

You are picking up a new, self-contained workspace in the `relaunch72` monorepo: a white-label webinar platform on Cloudflare. It was built in one session from the spec "Growth HQ Webinars — Build Spec (6 Nov 2026)". Everything described here is committed and pushed on branch **`claude/gifted-lamport-i4bdio`** (two commits: `5073c08` backend, `a8002a5` embed design pass). Nothing is deployed to Cloudflare yet.

Read `webinars/README.md` first. It has the architecture diagram, deploy steps, the brand-onboarding walkthrough, the embed attributes, the webhook contract, the API summary, the spec deviations and the not-built list. The decision-log entry is `docs/decisions.md` → **D-067**.

## What it is

Live, on-demand and evergreen webinars for all 8 brands from one deployment. Embeds on any site with one script tag, locked to a brand's publishable key and allowed origins. Growth HQ stays the system of record: every action becomes an HMAC-signed webhook.

Stack: **Hono** API Worker (TypeScript) + **D1** (all data, every row brand-scoped, live/test mode isolated) + one **Durable Object** per session (`SessionRoom`, hibernatable WebSockets) + **Cloudflare Stream** (live inputs, direct uploads, RS256 signed playback) + **Queues** (webhook delivery with ~24h exponential retry and a dead-letter log) + **R2** (handouts) + a one-minute **cron**. The embed is a **Lit** web component in Shadow DOM, built by esbuild into `webinars/public/v1/`.

It is a separate workspace because it runs on Cloudflare, not the Node/Render server the rest of the repo uses. It shares nothing with `orchestrator/` except the monorepo root `package.json` (npm workspaces).

## Where everything is

```
webinars/
  wrangler.toml              bindings, routes, cron, queue consumer, rate limits (database_id etc. are REPLACE_ME)
  migrations/0001_init.sql   the D1 schema — read this to understand the data model
  src/worker.ts              entry: HTTP app, queue consumer, scheduled, DO export
  src/app.ts                 Hono app factory, middleware: publishable() (pk + origin lock), secret(scope), rate limits, errors
  src/routes/public.ts       pk-key API the embed calls: brand, list, detail, register, join, playback, events, WS, host console
  src/routes/admin.ts        sk-key API for Growth HQ under /v1/admin: brands, webinars, sessions, slot rules, CTAs, polls,
                             moderation, registrants/attendance/analytics (+CSV), GDPR erasure, keys, webhooks, bootstrap
  src/routes/pages.ts        hosted pages (/w/:brand/:webinar + custom hostnames), iframe fallback (/frame/…), host console
                             page (/frame/console), inbound Stream webhook (/hooks/stream)
  src/room/session-room.ts   SessionRoom Durable Object: chat, moderated Q&A, polls, CTA push, viewer count, bans,
                             one-device limit, batched flush to D1 via alarm, GDPR purge
  src/lib/auth.ts            key generation/lookup/scopes, origin matching, session + host tokens, magic tokens
  src/lib/config.ts          brand theme/settings defaults, deep-merge with webinar overrides, publicConfig()
  src/lib/domain.ts          row types, room state machine (computeRoomState), session start/end, recording promotion,
                             finalisation (attendee.left / no_show), magic links, .ics + calendar links
  src/lib/events.ts          emitEvent(): writes the events row, builds the full webhook payload incl. the per-brand `crm` hint
  src/lib/webhooks.ts        delivery attempt, signing, retry schedule, queue consumer; verifyWebhookSignature() for receivers
  src/lib/slots.ts           evergreen slot engine (fixed / interval / just_in_time), timezone + DST safe, no deps
  src/lib/stream.ts          Stream API client + signed playback (WHEP + HLS URLs); verifyStreamWebhook()
  src/lib/crypto.ts          SHA-256, HMAC, compact signed tokens, AES-GCM (webhook secrets at rest), RS256 JWT
  src/cron.ts                evergreen lifecycle, forgotten live sessions, finalisation, recording fallback, stale on-demand
                             viewers, webhook sweeper, daily retention
  src/services.ts            Stream/Turnstile/clock behind an interface; DEV_MODE=1 swaps in fakes for wrangler dev
  embed/src/                 Lit components: app.ts (<ghq-webinar> shell), views.ts (register/list/countdown), room.ts,
                             player.ts (WHEP → HLS fallback, evergreen no-seek), host-console.ts, styles.ts (design tokens),
                             icons.ts (inline SVG), api.ts, format.ts, types.ts, loader.ts (the 300-byte embed.js)
  embed/build.mjs            esbuild → public/v1/{embed.js, embed-app.js, chunks/}  (build output is gitignored)
  public/_headers            CORS + cache headers for the embed assets (needed: cross-origin ES module import)
  test/helpers.ts            test harness: D1 stand-in on node:sqlite, fake Queue / DO namespace / Stream / Turnstile, clock
  test/*.test.ts             31 tests: slots, security primitives, live flow, evergreen + on-demand, room (DO), tenancy
  scripts/dev-seed.mjs       seeds a local instance (account keys, demo brand, keys, one webinar of each type)
  scripts/dev-site.mjs       throwaway brand site on :8788 embedding the local Worker (with hostile host CSS)
  .dev.vars.example          copy to .dev.vars for wrangler dev (gitignored)
```

## Run and check

```bash
npm install                       # repo root
cd webinars
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply webinars --local
npm run dev                       # http://localhost:8787 (builds the embed first)
npm run seed                      # prints pk/sk, an embed snippet, a host-console URL
npm run demo -- <pk_live_…>       # http://localhost:8788  (/, /evergreen, /on-demand, /list, /dark)

npm test                          # 31 tests, node:test, no network, no Cloudflare account needed
npm run typecheck                 # worker + embed + tests (three tsconfigs)
npx wrangler deploy --dry-run     # confirms the bundle builds
```

From the repo root: `npm run webinars:test`, `npm run webinars:typecheck`, `npm run webinars:dev`. The existing orchestrator suite (`npm test` at root, 316 tests) is unaffected.

## Things you need to know before changing code

- **Tenancy is enforced in the routes, not the DB.** Every admin handler resolves the row, then `assertBrand()` / `webinarFor()` checks it belongs to the key's brand and mode. Keep that pattern for any new route. Account-level keys have `brand_id NULL` and must pass `brand_id` / `GHQ-Brand`.
- **Live vs test mode** is a `mode` column on webinars, registrants, events, api_keys and webhook_endpoints. A `*_test_*` key must never see live rows. Tests cover this; don't break it.
- **Hono route ordering matters.** `app.use('/v1/webinars', mw)` matches that exact path only; each public route registers its own `publishable()` middleware. Admin routes are mounted at `/v1/admin` because the spec's paths would collide with public ones.
- **The DO is never reachable from the internet.** The Worker authenticates the socket and passes a trusted context in the `x-room-ctx` header. Status (`scheduled/preview/live/ended`) is seeded from D1 on every connect; D1 is the source of truth, the DO is a live cache that flushes messages to D1 from an alarm.
- **Webhook secrets are AES-GCM encrypted (`secret_enc`), not just hashed**, because signing needs the plaintext. `DATA_KEY` is the base64 32-byte key.
- **`attendee.left` is emitted once per attendee** at finalisation (live/evergreen) or after 10 min idle (on-demand). A repeat replay viewing emits another one flagged `data.repeat=true` with `crm.action=null` so the CRM doesn't re-score.
- **Playback never happens without a signed token.** `/join` mints a 4h session token; `/playback` refreshes a 1h Stream token. The embed refreshes 5 min before expiry.
- **Evergreen is labelled "Scheduled replay", never "live"**, and the player blocks seeking (`offset_s`, `seekable:false`). This is an FCA requirement for Prop Invest UK — don't soften it.
- **Fresh registrations return the magic token to the browser** (so just-in-time slots can be joined immediately). Re-registering an existing email never does; a new link is emailed instead.
- **Tests fake the whole Cloudflare surface** (`test/helpers.ts`). If you add a binding, add it to `createHarness()`. The D1 stand-in runs the real migration SQL on `node:sqlite`, so schema changes are exercised by the tests.
- `DEV_MODE=1` lives only in `.dev.vars`. Never put it in `wrangler.toml`.

## What has been verified, and what hasn't

Verified: the 31 tests (full live / evergreen / JIT / on-demand flows, tenancy and mode isolation, scopes and rotation, GDPR erasure incl. the DO cache, webhook signing/retry/dead-letter, room moderation/polls/bans/one-device), typecheck, wrangler dry-run, and a Playwright run against `wrangler dev` (real workerd + local D1/DO): register → waiting room → host goes live → chat → moderated question approved and answered from the host console → CTA and poll pushed and voted, across desktop, mobile, list, dark and on-demand pages, with zero browser errors.

**Not verified: anything against real Cloudflare.** Stream (live input creation, direct upload, RS256 signed playback, the recording webhook), Turnstile, Queues and the rate-limit binding have only run against fakes. The code follows the documented APIs, but the first deploy should be a smoke test, not a pilot.

## Not built yet (in rough priority order)

1. A smoke test against a real Cloudflare account (see "Deploy" in the README). Expect to adjust `src/lib/stream.ts` field names if Stream's responses differ.
2. The Growth HQ side: the admin wizard + analytics screens (the admin API they'd call is complete) and a webhook receiver (`verifyWebhookSignature` in `src/lib/webhooks.ts` is the reference implementation). Note the repo already has a thin CRM in `orchestrator/src/crm/`; whether that *is* Growth HQ is a product decision nobody has made yet.
3. In-browser "Go live" (WHIP publisher page). The live input already returns a WHIP URL.
4. Automated Cloudflare for SaaS custom-hostname creation (routing on `Host` already works).
5. A room load test at the target audience size (fan-out has only been exercised with a handful of sockets).

Open product questions from the spec are still open: Brevo vs Growth HQ sending, attendees on camera, paid tickets, FCA approval steps, default replay expiry, hosted pages in phase 1.
