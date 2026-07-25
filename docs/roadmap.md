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
