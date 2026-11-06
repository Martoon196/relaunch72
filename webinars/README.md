# Growth HQ Webinars

Live, on-demand and evergreen webinars for every brand, from one Cloudflare deployment. The webinars are white-label, embed on any site, and are locked to each brand's API keys. Growth HQ stays the system of record: every webinar action is sent to it as a signed webhook.

```
Browser ── embed.js / <ghq-webinar> ──► API Worker (Hono) ──► D1 (all data, brand-scoped)
   │                                        │  ├─► SessionRoom Durable Object (one per session: chat, Q&A, polls, CTAs)
   │                                        │  ├─► Queues → signed webhooks → Growth HQ
   │                                        │  └─► R2 (handouts)
   └── <video> ◄── signed 1h token ── Cloudflare Stream (live input / uploads / recordings)
```

## Layout

| Path | What |
| --- | --- |
| `src/worker.ts` | Worker entry: HTTP, Queue consumer, cron, Durable Object export |
| `src/routes/public.ts` | Publishable-key API used by the embed (list, register, join, playback, heartbeats, WebSocket, host console) |
| `src/routes/admin.ts` | Secret-key admin API for Growth HQ (`/v1/admin/*`) |
| `src/routes/pages.ts` | Hosted pages, iframe fallback, host console page, Stream webhook |
| `src/room/session-room.ts` | `SessionRoom` Durable Object (hibernatable WebSockets) |
| `src/lib/` | Auth/keys, tokens and crypto, brand config, slot engine, room state machine, events and webhooks, Stream, Turnstile |
| `src/cron.ts` | Every-minute jobs: evergreen lifecycle, finalisation (left/no-show), recording fallback, webhook sweeper, retention |
| `migrations/` | D1 schema |
| `embed/` | Lit web components → `public/v1/embed.js` (loader), `embed-app.js`, `chunks/` (lazy hls.js) |
| `test/` | `node:test` suite on a `node:sqlite` D1 stand-in with fake Stream/Queue/DO |
| `scripts/dev-seed.mjs` | Seeds a local dev instance with a brand, keys and one webinar of each type |

## Run it locally

```bash
npm install                                   # from the repo root
cd webinars
cp .dev.vars.example .dev.vars                # DEV_MODE=1: sample video, Turnstile bypass
npx wrangler d1 migrations apply webinars --local
npm run dev                                   # builds the embed, serves on http://localhost:8787
npm run seed                                  # demo brand + keys + one webinar of each type; prints pk, host-console link
npm run demo -- pk_live_…                     # a throwaway brand site on http://localhost:8788 embedding the widget
```

The demo site has pages for the live, evergreen and on-demand webinars, a list view and a dark-theme page. It deliberately ships hostile global CSS (`button{background:hotpink!important}`) so you can see Shadow DOM isolation holding. Open the printed host-console link in a second tab to run the room.

Checks: `npm test` (31 tests) and `npm run typecheck` (worker, embed and tests). The embed is built by esbuild into `public/v1/` (loader ≈ 0.3 KB, app ≈ 96 KB minified, hls.js in a lazy chunk only non-Safari browsers fetch).

## Deploy (first time)

```bash
cd webinars
npx wrangler d1 create webinars --location weur                    # EU; put database_id in wrangler.toml
npx wrangler queues create ghq-webinar-webhooks
npx wrangler queues create ghq-webinar-webhooks-dlq
npx wrangler r2 bucket create ghq-webinar-files --jurisdiction eu
npx wrangler d1 migrations apply webinars --remote

# Secrets
npx wrangler secret put TOKEN_SECRET            # long random string
npx wrangler secret put DATA_KEY                # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_STREAM_API_TOKEN     # Stream:Edit
npx wrangler secret put STREAM_SIGNING_KEY_ID   # from POST /accounts/:id/stream/keys
npx wrangler secret put STREAM_SIGNING_JWK      #   "jwk" field of the same response
npx wrangler secret put STREAM_WEBHOOK_SECRET   # from PUT /accounts/:id/stream/webhook (notificationUrl = https://api.webinars.growthhq.app/hooks/stream)
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put BOOTSTRAP_TOKEN         # one-off; delete after bootstrapping

# Set STREAM_CUSTOMER_CODE and TURNSTILE_SITE_KEY in wrangler.toml [vars], then:
npm run deploy

curl -X POST https://api.webinars.growthhq.app/v1/admin/bootstrap -H "x-bootstrap-token: $BOOTSTRAP_TOKEN"
#   → account-level sk_live_… and sk_test_… (shown once). Then: wrangler secret delete BOOTSTRAP_TOKEN
```

Brand custom domains (for example `webinars.propinvest.co.uk`): add the hostname as a **Cloudflare for SaaS custom hostname** on the `growthhq.app` zone. Then set `settings.domains.hosted_hostname` on the brand. The Worker routes on the `Host` header.

## A new brand in under 30 minutes, with no code

All of this is admin API calls, so the Growth HQ UI can wrap it:

```bash
SK=sk_live_…   # account key
API=https://api.webinars.growthhq.app/v1/admin

# 1. Brand (look, copy, compliance, CRM mapping all live in settings)
curl -X POST $API/brands -H "authorization: Bearer $SK" -H 'content-type: application/json' -d '{
  "name": "Prop Invest UK", "slug": "prop-invest-uk",
  "theme": { "colors": { "primary": "#0b2545", "accent": "#C8A04B" }, "font_family": "Inter, sans-serif",
             "font_url": "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap", "button_style": "pill" },
  "settings": {
    "domains": { "allowed_origins": ["https://www.propinvest.co.uk", "https://*.propinvest.co.uk"] },
    "registration": { "consent_text": "…", "consent_version": "2026-11", "privacy_url": "https://…" },
    "compliance": { "risk_warning": "Capital at risk…", "recording_notice": "This session is recorded." },
    "crm": { "pipeline_id": "…", "stage_id": "…", "tag_prefix": "webinar" },
    "defaults": { "timezone": "Europe/London", "qa_moderation": true, "replay_expiry_days": 7 }
  }}'

# 2. Keys: a publishable key for the sites, a secret key for Growth HQ
curl -X POST $API/api-keys -H "authorization: Bearer $SK" -d '{"type":"pk","brand_id":"brd_…"}'
curl -X POST $API/api-keys -H "authorization: Bearer $SK" -d '{"type":"sk","brand_id":"brd_…","scopes":["*"]}'

# 3. Webhooks to Growth HQ (secret shown once)
curl -X POST $API/webhook-endpoints -H "authorization: Bearer $BRAND_SK" -d '{"url":"https://…/webinar-events","events":["*"]}'

# 4. A live webinar: create → live input (RTMPS/SRT for OBS or StreamYard, WHIP) → session → CTA → publish
curl -X POST $API/webinars -H "authorization: Bearer $BRAND_SK" -d '{"type":"live","title":"Q4 Investor Briefing","duration_s":3600}'
curl -X POST $API/webinars/web_…/live-input -H "authorization: Bearer $BRAND_SK"
curl -X POST $API/sessions -H "authorization: Bearer $BRAND_SK" -d '{"webinar_id":"web_…","starts_at":"2026-11-12T19:00:00Z"}'
curl -X PATCH $API/webinars/web_… -H "authorization: Bearer $BRAND_SK" -d '{"status":"published"}'
#   → response includes embed.snippet, embed.iframe and embed.hosted_url
```

On the day: `POST /sessions/:id/start {"test":true}` opens a private preview. Then `POST /sessions/:id/start` opens the room, and `POST /sessions/:id/end` ends it and promotes the recording. `POST /sessions/:id/host-token {"role":"host"|"moderator"}` returns a console link.

## Embedding

```html
<script src="https://cdn.webinars.growthhq.app/v1/embed.js" data-key="pk_live_…" defer></script>
<ghq-webinar webinar="q4-investor-briefing" view="register"></ghq-webinar>
```

| Attribute | Values |
| --- | --- |
| `view` | `register` · `room` · `replay` · `list` · `countdown` |
| `theme` | `light` (default) · `dark` · `auto` |
| `accent` | Any CSS colour; overrides the brand accent |
| `layout`, `filter` | For `list`: `card`/`list`, `upcoming`/`on_demand` |
| `href` | For `list`/`countdown`: link template such as `/webinars/{slug}`. Default: open inline (list) or the hosted page (countdown) |

- Everything renders in Shadow DOM, so host CSS can't reach it. This was checked against a page with `button{background:hotpink!important}`.
- Magic links come back to the registering page with `?ghq_token=…&ghq_view=room`. The component switches to the room and strips the token from the URL.
- Events for the site's own pixels: `ghq:registered`, `ghq:joined` and `ghq:cta-click` fire on the element and bubble.
- Iframe fallback for builders that block scripts: `https://webinars.growthhq.app/frame/<pk>/<webinar-slug>/<view>`. It posts `{type:'ghq:resize', height}` and relays the `ghq:*` events to the parent.

## Webhooks to Growth HQ

Each event is POSTed as JSON with these headers:

- `GHQ-Event: registrant.created`
- `GHQ-Delivery: dlv_…` (de-duplicate on this)
- `GHQ-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`

Reject a signature older than 5 minutes. Reference verifier: `verifyWebhookSignature` in `src/lib/webhooks.ts`.

The payload is `{ id, type, created_at, mode, brand, webinar, session, registrant, data, crm }`. `crm` is the Growth HQ action this event maps to under the brand's CRM settings: `action`, `tags_add`, `tags_remove`, `lead_score_delta`, `pipeline_id`/`stage_id`, `sequence`/`stop_sequence` and `custom_field`. A Growth HQ workflow can apply it directly.

`registrant.created` carries `magic_link`, `hosted_link`, `ics_url`, `google_calendar_url`, `outlook_calendar_url`, the consent record, `reminders_min` and the session times. That is everything the confirmation and reminder sequence needs.

Retries back off exponentially over about 24 hours: 30s, 1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 8h. After that a delivery is marked `dead`. List dead deliveries with `GET /webhook-endpoints/:id/deliveries?status=dead` and replay one with `POST /webhook-deliveries/:id/retry`. A cron sweeper re-queues anything the queue lost.

## API summary

**Public** (`x-ghq-key: pk_…`, origin-locked): `GET /v1/brand` · `GET /v1/webinars?view=upcoming|on_demand` · `GET /v1/webinars/:slug` · `POST /v1/webinars/:slug/registrations` · `POST /v1/join` · `POST /v1/playback` · `POST /v1/events` · `WS /v1/sessions/:id/live` · `POST /v1/host/console` · `POST /v1/host/end` · `GET /v1/handouts/:webinar/:file` · `GET /v1/calendar/:token.ics`

**Admin** (`Authorization: Bearer sk_…`, under `/v1/admin`): CRUD for `/brands`, `/webinars`, `/sessions`, `/slot-rules`, `/ctas`, `/polls`, `/api-keys` and `/webhook-endpoints`, plus:

- Webinars: `POST /webinars/:id/live-input`, `/video`, `/video/sync`, `/duplicate`; `PUT /webinars/:id/handouts/:name`; `GET /webinars/:id/slots`
- Sessions: `POST /sessions/:id/start`, `/end`, `/push-cta`, `/push-poll`, `/announce`, `/host-token`, `/preview-playback`; `GET /sessions/:id/messages`
- Moderation: `PATCH /messages/:id`
- Reporting: `GET /registrants`, `/attendance` and `/analytics` (add `?format=csv` to `/registrants` or `/attendance` for a CSV export); `GET /events`; `GET /audit-log`
- Registrants: `PATCH /registrants/:id`
- Keys and webhooks: `POST /api-keys/:id/rotate`, `POST /webhook-endpoints/:id/rotate-secret`, `POST /webhook-deliveries/:id/retry`
- GDPR: `DELETE /contacts/:email`

An account-level key (brand_id NULL) passes `?brand_id=` or a `GHQ-Brand` header. A brand key is pinned to its brand. Test keys (`*_test_*`) only ever see test-mode rows and only send to test-mode webhook endpoints.

## Where this differs from the spec, and why

- **Admin routes live under `/v1/admin/*`.** Under the spec's paths, `GET /webinars` would be both a public and an admin route.
- **Webhook secrets are stored AES-GCM encrypted (`secret_enc`) plus a hash.** HMAC signing needs the secret itself, so a hash alone (`secret_hash`) can't sign anything.
- **Extra columns:** `mode` on tenant tables (test/live isolation), `agenda_json`/`handouts_json` on webinars, `pending` message status (moderated questions), and `test_mode`/`finalized_at` on sessions.
- **`attendee.left` is emitted once per attendee** when a live or evergreen session is finalised, with final watch time and percent. For on-demand viewing it is emitted after 10 minutes idle. Per-heartbeat leave events would score engaged viewers more than once in the CRM.
- **The retention curve** uses each attendee's furthest playhead (live: watch time), not per-minute samples.
- **Fresh registrations get the magic token in the browser** so "Join now" works for just-in-time slots. Re-registering an existing email never returns it; a new link is emailed instead.

## Not built yet

- **The admin wizard and analytics screens inside Growth HQ.** The API they call is complete.
- **Browser "Go live" publisher (WHIP).** The live input returns a WHIP URL, but there is no in-browser camera/screen publisher page yet. That is Phase 4 in the spec.
- **Automatic Cloudflare for SaaS custom-hostname creation.** Host-based routing works; adding the hostname is a dashboard or API step for now.
- **Verification against real Cloudflare Stream.** The live input, direct upload, RS256 signed playback and webhook code follow Stream's documented API, but have only run against fakes. Run a real smoke test on a Stream account before the pilot.
- **Load testing.** Room fan-out has not been load-tested at all; the tests use a handful of sockets. Load-test a room at the target audience size before relying on it.
