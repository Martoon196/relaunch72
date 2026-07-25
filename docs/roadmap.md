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
Verdict: not a competitor — a capability we absorb. (Sibling tools noted: daily-indexing, content-strategy,
GEO Visibility Audit — same suite; screenshots pending to complete the teardown.)
