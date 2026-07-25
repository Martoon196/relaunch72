# Platform architecture — the AI-native marketing platform (+ CRM)

**Vision.** A white-label, multi-tenant marketing platform. Each client logs in,
connects their accounts, and their marketing runs on autopilot from a stored
*brand brain* — content, socials, ads, keyword intel, and email/SMS/WhatsApp —
all pre-filled with strategy and gated by the no-invention QA. Recurring
subscription. This is the Phase D north star (decisions D-051): one-off pack →
recurring AI marketing manager.

The honest name for what we're describing: **an AI-native GoHighLevel.**

---

## 1. What we already have (the moat) vs what the platform needs (the plumbing)

**Moat — built, mock-first:** deep intake → S1–S10 strategy → **brand brain**
(S2 dream-buyer + S3 message/voice) → content clusters (Soro) → socials / keyword
/ ads rails → the no-invention QA that runs on every output. This is the
differentiator, and it's done.

**Plumbing — not built:** multi-tenant *client* login (we have *admin* auth
only, Phase A), per-client account connections, a CRM (contacts / pipelines /
activity timeline), multi-channel messaging (email / SMS / WhatsApp), an
orchestrator to run the rails on a schedule, dashboards, and subscription billing
with client rebilling.

The plumbing is commodity. The moat is ours. That split drives the key decision.

---

## 2. THE decision: build the plumbing, or build on GoHighLevel

The user's description — white-label login, CRM, email/SMS/WhatsApp, funnels,
automation, resell to clients with markup — **is GoHighLevel, feature for
feature.** GHL already exists and is a unicorn. So:

- **Option A — Build our own platform + CRM from scratch.** Full control, our IP,
  no per-seat platform fee. But it's *months-to-years* rebuilding commodity
  plumbing (contacts DB, pipelines, SMS/WhatsApp sending, deliverability, mobile
  apps, billing) — a year spent *not* on our differentiator.
- **Option B — Build ON GoHighLevel (SaaS Pro, ~$497/mo).** GHL's *SaaS mode*
  gives us the entire platform layer today: white-label portal + custom domain,
  auto multi-tenant sub-account creation, CRM, **email/SMS/WhatsApp built in**,
  funnels, calendars, client **rebilling with markup**, even white-label mobile
  apps. We plug **our AI engine** (brand brain → Soro / socials / ads / keyword)
  into each sub-account via GHL's API + webhooks, and sell it as *Relaunch72* —
  GHL invisible underneath. Fastest path to "clients log in and get a platform,"
  by months.
- **Option C — Hybrid (recommended).** GHL as the CRM/messaging/portal backbone
  **now** to get to market; our own thin AI-orchestration layer + brand brain on
  top; migrate pieces to our own stack later *only if* a specific need justifies
  it.

**Recommendation: C (start on GHL).** Our moat is the AI strategy + no-invention
content — **not** the CRM plumbing GHL spent years and millions perfecting.
Building our own CRM first spends a year rebuilding a commodity and delays the
only part that's actually differentiated. GHL's SaaS mode exists precisely to let
us white-label, resell and rebill; $497/mo is trivial against per-client revenue.
It also **de-risks**: we validate the platform business on rented rails before
investing in our own.

**Crucially, nothing we've built is wasted.** The AI engine (pipeline, Soro,
socials, keyword, ads, brand brain, QA) is exactly what plugs *into* the platform
layer, whichever we choose. This decision is **only** about the plumbing, never
the AI. It's the "own the assembly [AI], rent the rails [platform]" doctrine
(D-055) applied one level up.

**Trade-offs of C to hold honestly:** dependency on GHL + their margin; less
control of the platform UI; GHL lock-in; their API's limits. Worth it to reach
paying customers a year sooner and prove the model.

---

## 3. Messaging rails (email / SMS / WhatsApp)

If we go GHL (Option C), **these come built in** — GHL includes email, SMS and
WhatsApp natively, billed through their wallet with rebilling. Nothing to build.

If/when we build our own (later, Option A pieces), the rails follow our
mock-first adapter pattern (a `MessagingRail` interface + mock + live adapter):

- **SMS + WhatsApp — Twilio.** The dominant comms API (SMS ~$0.011–0.013/msg
  effective, numbers ~$1.15/mo; WhatsApp ~$0.005/msg + Meta's template fee).
  Sub-accounts give per-client isolation. Note: *Twilio itself isn't
  white-label* — but that's a non-issue, because **we white-label at our portal
  layer; Twilio is invisible plumbing** the client never sees. Cheaper SMS
  alternatives if volume bites: Telnyx, Plivo, Bird, Sinch.
- **Email — we already have Brevo (marketing) + Postmark (transactional) wired.**
  For strict multi-tenant isolation, **SendGrid sub-users** (Twilio-owned, so one
  vendor could cover SMS + WhatsApp + email) are purpose-built for it. The
  autoresponder *logic* (sequences, triggers) is our orchestrator; the *send* is
  the rail.

So the "white-label email autoresponder / WhatsApp / text" the founder asked for
is: **GHL natively (fast path), or Twilio + SendGrid/Brevo behind our own
orchestrator (owned path).**

---

## 4. Architecture components (either path)

- **Brand brain** — the stored intake → S2/S3 per client. *We have this.* The
  portal surfaces it and lets the client edit; every rail reads from it.
- **Account connections** — "connect your Instagram / ad account / site / phone
  number." OAuth via each rail (Ayrshare, Meta, Twilio) or GHL's native connectors.
- **Orchestrator** — the "manager": run each client's rails on a cadence (weekly
  content, daily socials, monthly ad refresh, triggered messages). This is the
  new core we build regardless of A/B/C — it drives the rails per tenant.
- **CRM core** — contacts / leads, pipeline stages, activity timeline across all
  channels. *GHL gives this; building it is the bulk of Option A.*
- **Dashboards + LLM-visibility tracking** (mirrors BabyLoveGrowth's tracker).
- **Subscription billing + rebilling** — Stripe is wired for one-off; this needs
  subscriptions + usage passthrough. *GHL SaaS mode does rebilling natively.*

---

## 5. MVP slice (get the first paying platform customer fast)

Don't build the whole CRM before a login exists. Thinnest vertical slice:

1. GHL SaaS Pro account, white-labelled as Relaunch72 (portal + custom domain).
2. One sub-account per client, auto-created on subscribe.
3. Brand brain: run our intake → S1–S10 → push the pack + a Soro cluster into the
   sub-account via GHL's API.
4. One live rail end-to-end (socials via Ayrshare, or ads paused-drafts).
5. Recurring billing via GHL rebilling (or Stripe subs).

Onboard the first few clients on that, learn, then deepen. Each additional rail
(keyword, ads, messaging sequences, dashboards) is a self-contained add-on.

---

## 6. Cost shape (to price the recurring tier)

- Platform: GHL SaaS Pro ~$497/mo flat (not per-client) — covers portal, CRM,
  messaging, rebilling.
- Per-client rails: Ayrshare ~$20/mo entry, DataForSEO pennies/query, ads API
  free (client's spend), LLM near-free. Messaging usage passed through / rebilled.
- Sell at $97–$497/client/mo (GHL-market rates); breakeven ~2–3 clients.

---

## 7. Sequencing

The engine is ready. The platform is the scale play. Smart order: **prove the
offer with the first paid one-off pack → stand up the GHL-backed MVP slice →
onboard a handful of recurring clients → deepen the rails and dashboards.** Don't
build the full owned CRM until GHL's ceiling actually blocks us — it probably
won't for a long time.

---

## Update (26 Jul) — founder input reshapes the fork, and the Orchestrator is built

**GHL is clunky.** Founder has used it and finds the UX cluttered — and that's the
product, not a version (it's a decade-old everything-app). The distinction I
under-weighted: **whether clients see GHL's UI.** So the fork is now:

- ~~Clients live in GHL's white-label UI~~ — ruled out; they'd inherit the clunk.
- **GHL headless** — its API as an invisible backend (messaging, CRM data,
  rebilling); clients log into *our* clean portal. Keeps the plumbing win, kills
  the clunk. Dependency remains.
- **Own portal + thin CRM + atomic rails** (Twilio / SendGrid / Stripe) — most
  control, cleanest UX, no GHL. We build only the focused slice we need (contacts,
  pipeline, timeline, messaging, the AI rails, billing) — not the whole GHL
  kitchen sink. Positions us as **the anti-GHL: clean, AI-first.** Most upfront
  build; best long-term fit given the UX bar.

Recommendation shifts toward **headless-GHL (fast) or own-portal (clean)** — both
put clients in *our* UI. Still a founder call; logged P0.

**The Orchestrator is built (mock-first).** `orchestrator/src/manager/` — the
per-tenant "manager": given the client roster and a date, it computes which rails
are due (daily / weekly / monthly cadence) and dispatches them through an injected
runner (mock today, live rail-wiring next). `npm run manager -- --date <d> --mock`.
This is the piece that's true on **every** platform path, so it was safe to build
now — it turns the five capability CLIs into a scheduled, multi-tenant service.
