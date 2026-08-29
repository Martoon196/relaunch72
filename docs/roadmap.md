# Relaunch72 — Product Roadmap

**North star:** evolve from a **one-off done-for-you pack** (pay once → 9 deliverables in 72h)
into a **recurring AI marketing platform** where a customer logs in, an AI manages their
marketing continuously, and everything lives inside Relaunch72 (cancel = lose it).
One-off gets them in the door; recurring is the business.

---

## Where we are now (live / built)

- **Funnel live** on relaunch72.com: landing → Generic Test scorecard → $97 autopsy → checkout → 45-Q intake → upgrade.
- **Payments** (Stripe test): checkout → webhook → order recorded → auto-kicks the build. ✅ proven end-to-end.
- **Pipeline** (S0–S10): one paid intake → nine deliverables, no-invention QA, human sign-off gate. Running live on Render.
- **Email** wired: Postmark (transactional) + Brevo (marketing lead/customer sync).
- **Admin control room** (Phase A part 1): /admin — see builds + orders, read the pack, approve/send-back.

Immediate: land the **first fully-approved paid pack** (one S3 pass away), then delivery.

---

## Phases

### Phase A — Foundation + Admin *(in progress)*
The control room + the auth/data foundation everything reuses.
- ✅ /admin: runs + orders, pack viewer, sign-off. Persistent disk for runs.
- Next: "trigger delivery" from admin; the real DB (Postgres) + auth when accounts arrive.

### Phase B — Customer portal
Buyer accounts. The login area.
- Log in; **resume a half-finished intake** across devices (not just localStorage).
- **View / download their reports**; see the pack in the browser.
- **Buy repeat assessments** at a returning-customer price ("re-run after you've grown").

### Phase C — Affiliate scheme
- Affiliate logins, referral links + tracking, commissions.
- All surfaced in the founder admin.

### Phase D — Recurring "AI Social Manager" *(the north star)*
Turn the one-off into a subscription. Each customer:
- has a **stored brand profile** (≈ their intake) + voice guide (S3) held in their login area;
- an AI **generates their content on a schedule** (weekly/monthly) from that profile;
- a **dashboard** shows their content + real metrics (scores, response rates);
- optionally, we **auto-post** for them.
It's **theirs to use, never to keep** — the engine + data stay in Relaunch72. Recurring revenue + retention moat.

**Feasibility (the "would the AI go wild?" question): no.** It's multi-tenant — the same model is
called *per customer*, loading only that customer's file each time, with no memory between calls. Two
customers can't bleed into each other. It's exactly what the pipeline already does (one run = one
customer), just stored and re-run on a timer. The AI-management core ≈ the existing pipeline on a
schedule; the **biggest new piece is real metrics** — connecting each customer's Instagram/social via
the Meta Graph API (or self-report) — plus optional auto-posting.

### Activation-critical Growth HQ channel rails *(current)*

The shared Conversion Inbox and consent model cover email, WhatsApp, SMS and
social conversations. A channel is not launch-ready merely because its type,
fixture or inbox filter exists. Each live rail needs a permission-bound command,
isolated worker, authenticated receipt path, calling fence, caps and one
founder-owned acceptance target.

- ✅ Customer email — Mailgun EU foundation, worker and signed receipt path built;
  provider account/domain evidence and an owned test recipient remain required.
- ✅ WhatsApp — direct Meta Cloud foundation, worker and raw signed webhook path
  built; app/WABA/phone/template evidence and an owned test number remain required.
- ✅ Owned social — Ayrshare/X foundation and isolated worker built; exact owned
  profile evidence, credentials and one approved test post remain required.
- **NEXT: UK SMS through Twilio Messaging.** Reuse the existing Conversion Inbox,
  consent, suppression and Lead 360 models. Build exact least-privilege command,
  one-at-a-time worker and signed inbound/status webhook identities; preserve raw
  callback authentication and replay conflict evidence; enforce current consent at
  enqueue and immediately before the provider call; process STOP/START without
  weakening manual suppression; add initial daily/monthly segment caps and
  outcome-unknown quarantine; expose readiness, cap usage, blockers and bounded
  receipts to Live Channels; prove the complete lifecycle only against a nominated
  founder-owned UK test number.

No provider credential, production deployment, customer message or live effect is
authorised by this roadmap entry. Activation still requires the exact account,
sending identity, regulatory evidence, owned target and founder-approved message.

---

## Backlog (captured ideas, not yet scheduled)

- **Scored-checklist scorecard** — upgrade the Generic Test to a gamified, weighted tick-box audit
  with an instant number + "weakest area + one fix" (pattern seen in the Reel Audit tool). Better lead magnet.
- **Questions-as-lead-magnet variant** — give a mid-length free diagnostic, paywall the deep report at the end.
- **Niche audits** — the same scorecard engine, re-skinned per vertical (e.g. a Reel Audit) as separate campaign entry points.
- **Webinar funnel** — a free live masterclass as an alternative to the $97 tripwire (needs registration/reminders/replay).

---

## Sequencing principle

Finish the machine that's almost printing before starting the next one. Order:
**land the first paid pack → Phase B portal → Phase C affiliates → Phase D recurring manager.**
Phase D is a *short hop* once the portal exists — not a from-scratch build. Don't build ahead of revenue.

## Hard boundary (IP)

Any "social media manager" / marketing playbook we build is **our own IP**, written from scratch and
inspired-by-concepts only. Licensed third-party material (e.g. DigitalMarketer) never enters the code,
the product, or git. Same rigour, our IP — it protects the business legally.

---

## Positioning — own the stack, the 72-Day Package (crystallised)

**Stance: take over, not take part.** No partnerships with tools we don't control. Every adjacent
AI marketing tool (content engines, ad engines, SEO/indexing/traffic tools like digitalwomble) is
something we out-build and absorb into the ecosystem. We already own the hard part — the conversion
engine + a no-invention quality bar competitors don't have. Extend outward from there: our own
content engine, our own ad-creative + campaign engine, our own traffic play — all in-house, all AI,
all inside the customer's Relaunch72 login area.

**The model — 72 hours in, every 72 days forever:**
- **72 hours** = the door-opener (one-off pack, fast). Becomes the trial.
- **The 72-Day Package** = the business. ~5 cycles/year, each a mini-relaunch driven by the customer's
  live metrics: refreshed message/offer, new content batch (social/email/website), ads. Recurring
  revenue + a cadence that IS the brand — "every 72 days" can't be copied without copying us.
- **Moat:** it all lives in the login area; leaving = their marketing rots again in 72 days. One
  customer gets message + copy + content + traffic + ads, rebuilt every cycle by our AI, forever.

This reframes **Phase D** (recurring AI manager) as **the 72-Day Package**, and adds an ecosystem arm:
our own content + ads + traffic engines (compete with / absorb the digitalwomble-type tools), built
in-house on our own IP. Sequence unchanged: land the first paid pack → portal → the 72-Day Package.

---

## Competitive intel + steals — Digital Womble "Traffic Quality Optimiser"

**What it is:** AI bulk SEO-metadata tool. Free page audit → rewrites titles/meta for search intent →
ships a CMS-import-ready file (WP/Shopify/Webflow/Ghost/Magento/…). £97/≤1,000 pages, tiered up,
agency-targeted ("run across every client site"), one-off, explicitly no subscription.

**Steals (worth building):**
- **Import-ready CMS delivery** — their real innovation. Deliver our website/content as import files
  per CMS ("optimised Monday, live Tuesday"), not just docs. Upgrades the whole pack's delivery UX.
- **SEO-metadata layer on S6** — add search-intent titles + meta descriptions (classified buy/compare/
  learn) to the website deliverable. We already generate the page copy from the real message/ICP, so we
  deliver "rank AND convert" for real — the half they only claim.
- **Agency ICP** — target agencies relaunching multiple client brands (their angle: run across every site).

**Their weaknesses = our openings:** metadata-only (found, not converting — we own convert); one-off,
no recurring (SEO decays → fits the 72-day cycle they're missing); one tile of the stack (we're the board).
Verdict: not a competitor — a capability we absorb.

**The full Digital Womble suite (from the "Complete Your Stack" section):** Proactive Daily Indexing
(LIVE, **£29/mo — their only recurring product**), Traffic Quality Optimiser (metadata, coming soon),
Content Strategy (below), GEO Visibility Audit. Same "own the stack" instinct as us, built from the
SEO/content side. Their recurring hook is a small-ticket sticky utility (indexing); everything else is
one-off. That's the seam: they have no strategy layer and no relaunch cadence — the two things we lead with.

---

## Competitive intel + steals — Digital Womble "Topical Authority Content Strategy"

**What it is:** one topic in → **13 interlinked articles out** (1 pillar + 12 supporting). It decomposes
the topic into **fan-out queries** (the real sub-questions people/AI search behind it), verifies demand
against **live Google Ads data** (real volume/CPC/competition, not LLM guesses), and writes one article
per query — all interlinked to the pillar. Goal: **own the topic in Google AND get cited by ChatGPT/
Perplexity/AI Overviews (GEO).** Free = 2 full articles + full 13-plan visible before paying (no card);
paid = £98 (£48 tripwire); **Multi-Brand workspaces = the upsell** (multi-tenant, per-Brand memory/voice).

**Steals (worth building):**
- **Fan-out query → content-cluster engine.** The mechanic to own: from a topic, derive the real
  sub-questions, verify demand, build 1 pillar + 12 interlinked supporting articles. Slots straight into
  the **72-Day Package as the content stage** — we already have message/ICP/voice (S2/S3), so we can pick
  the *right* topics from strategy first, then cluster (they optimise a topic you hand them; we derive it).
- **GEO / get-cited-by-AI as an explicit deliverable.** Per-article snippet-ready answer block, TL;DR +
  3 takeaways, FAQ schema, H2 structure — formatted to win featured snippets AND ChatGPT/Perplexity
  citations. Add a "citation-ready" formatting layer to our website/content output (S6).
- **No-invention as a front-of-house *selling point*.** Their headline is literally our rule: "verified
  against a live source, or omitted rather than invented… most AI content is confidently wrong; this is
  the opposite." We treat it as internal rigour — we should market it the same way. It's a differentiator
  competitors with generic AI can't claim.
- **Every article links to one money page.** Their brief has a "target page + focus keyword" field so the
  whole cluster funnels authority/clicks to a single conversion page. Bake this discipline into our
  content deliverable: choose the money page, link the cluster to it.
- **Progressive/streaming delivery.** "Start reading the pillar while the other 12 generate." For us:
  surface each deliverable in admin/portal as it passes QA, not all-or-nothing at S10 — better UX inside
  the 72h window.
- **26 CMS export formats** — reinforces the Traffic Quality lesson: import-ready delivery per CMS is a
  real edge. Bump its priority.
- **Dogfood our own engine for our own acquisition (their smartest move).** Their footer is a large
  programmatic-SEO footprint — per-CMS ("Content Strategy for WordPress/Shopify/Webflow/…") and per-persona
  ("For CRO Agencies / CMOs / Product Managers / Growth Consultants") pages. They rank their content tool
  *using their content tool*. Our equivalent: relaunch our **own** funnel with our own relaunch engine —
  per-vertical Relaunch72 landing pages generated by the pipeline. Meta-proof: the product sells itself
  by being run on itself. (Own-IP, no fabricated proof — nothing changes the hard rules.)
- **Cheap trust/liability moves:** B2B-only disclaimer ("acting in a business capacity"), ICO registration
  shown, "no advertising cookies, no tracking pixels." Low-cost additions to our compliance footer.

**Their weaknesses = our openings:** content-only (one of our nine deliverables — we absorb the whole
product as a stage); no strategy layer (they optimise a topic you guess at; we derive the right topics
from the intake); one-off, SEO decays (the 72-Day cadence is the fix they lack). Their growth dashboard
shows illustrative +245%/£56k numbers with no named customer — a soft spot we deliberately don't have
(no fabricated proof, ever; we win by earning the [PROOF SLOT]). Verdict: not a competitor — the
content-cluster + GEO engine becomes **a stage inside the 72-Day Package**, and their dogfood-your-own-
method acquisition play is the one idea worth adopting wholesale.

---

## Competitive intel + steals — Digital Womble "Daily Indexing" + the whole-suite read

Two more pages (Daily Indexing; Traffic Quality Optimiser now shipped & live) complete the teardown of
the full four-tool suite. Daily Indexing is the one to study closely — it's their **only recurring product**,
and recurring is our whole thesis.

**The single best idea on any of their pages — the honesty section ("What we can promise, and what we
cannot"):** they guarantee only what they *control* (daily submission to Google/Bing/IndexNow) and openly
**refuse to promise** what they can't (that Google actually indexes every page) — "anyone telling you they
can guarantee indexation is either confused or lying." This is **our no-invention DNA applied to marketing
claims**, and it builds *more* trust than a hypey guarantee. **Steal:** add an honest promise/limits block
to Relaunch72 — we promise a complete, verified, ready-to-run relaunch (message, offer, nine deliverables,
every number and quote traced to the customer's own words); we do **not** promise you go viral or hit a
revenue figure — anyone who does is selling smoke. Differentiates us from every hype competitor.

**Other steals:**
- **Honest social proof done right** — "47+ users now indexing daily. First customer already seeing
  results." They don't fabricate big numbers either. Confirms our hard rule is a *selling strength*, not a
  handicap — lean into "early, honest, verified" rather than faking traction.
- **The recurring shape (template for the 72-Day Package):** "runs daily, forever, emails you monthly";
  onboarding is "three steps, one of which is optional — there is no step four, nothing to install, nothing
  to log into." Set-and-forget cadence + a recurring report is exactly how the 72-Day Package should *feel*.
- **Frictionless one-off vs logged-in recurring — the right architectural split.** Their transactional
  tools have *no login* ("nothing to log into"); their content/recurring products have login + per-Brand
  memory. Mirrors our plan: keep the one-off pack low-friction, reserve accounts for the recurring package.
- **White-label reseller channel** — every page pushes "set it up for a client once, bill it monthly, it
  becomes margin" + explicit white-label ("run this service under your own brand with your own invoicing").
  A **stronger Phase C than referral-only affiliates**: agencies reselling Relaunch72 under their own brand.

**The whole suite, decoded:** 2 free diagnostics (GEO Visibility Audit, AI Visibility Checker — "are you
cited by ChatGPT/Perplexity/Gemini/Copilot?") feed 2 paid fixers (Content Strategy £48–98, Traffic Quality
£97 one-off); only Daily Indexing (£29/mo) recurs. Free-diagnostic→paid-fix is the same scorecard→autopsy
funnel we already run. **AI-citation (GEO) is the wind every one of their tools sails** — reinforces adding
a citation-ready formatting layer to our content/website deliverables, and a free "are you cited by AI?"
check as a possible second funnel entry (backlog — don't build ahead of the first paid pack).

**The seam, restated:** their business is **transactional + one small sticky utility**. It has no strategy
layer and no relaunch cadence. Both gaps are precisely what Relaunch72 leads with. Verdict unchanged across
all four tools: not competitors — capabilities and plays we absorb into the 72-Day Package.
