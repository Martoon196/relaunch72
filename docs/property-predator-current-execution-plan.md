# Property Predator — current execution plan

**Authoritative execution snapshot:** 28 August 2026

**Growth HQ baseline:** `5dc2e4cb029155433dfd66083b0580d9f635c1bc` on `codex/relaunch72-platform-foundation`
**Purpose:** one truthful sequence from the current foundation to an operational Property Predator marketing and conversion system.

This document supersedes older roadmap prose for **current status, priority and sequencing**. Older handoffs, provider notes, security designs and deployment runbooks remain useful evidence, but their status labels must not be read as the present plan.

## North-star outcome

One system should take an attributable lead from first signal to sale and onboarding while the team can see, approve and operate every step:

`source → content/campaign → engagement → conversation → appointment → offer → sale → onboarding`

Growth HQ owns the people, attribution, consent, content, approvals, conversations, journeys, evidence and reporting. External services are replaceable transport rails.

## Foundation already completed

- Production Growth HQ runs four services on the baseline above, with the production migration ledger advanced through `0046`.
- Shared Property Predator login, workspace isolation, role boundaries and security controls are established.
- CRM, Journey Board, automatic journey evidence, lead scoring and Lead 360 foundations exist.
- Brand Brain, owned-specialist reuse, company-content adapter, immutable content versions, approvals and Campaign Wizard foundations exist.
- Content calendar, asset review, Affiliate Compliance Centre, conversion-inbox model and outbound-operation foundations exist.
- CSV migration and authenticated migration-centre foundations exist; production customer data has not been imported.
- OpenAI-backed company and affiliate generation rails are configured behind budgets, provenance and brand controls.
- Mailgun EU sending and signed-event infrastructure is configured. The isolated worker is ready only for the owned internal seed, capped at **1 message per run and 3 per month**. At the baseline proof point there were zero queued, attempted or delivered messages.
- Public-social revalidation/test workers, safe social-account linking, Meta communications contracts and webinar inbound contracts exist, but live social, WhatsApp, DM and webinar effects remain dark.
- Emergency stops, idempotency, suppression, consent, audit and provider-operation boundaries are built into the effectful rails.

These are foundations, not proof of a complete operating loop. The next ten strikes supply that proof.

## Main-site takeover lane — Codex owns this too

Claude is no longer an execution dependency. Existing Claude branches are preserved as source material; they are not treated as trusted, merged or deployed merely because they exist.

This lane runs alongside the ten Growth HQ strikes:

1. Inventory every main-site worktree and remote branch; identify exact base commits, overlapping changes and unfinished work.
2. Reconcile identity, affiliate attribution, content/asset APIs, AI-generation controls, valuation/payment work and security changes into one reviewed main-site candidate.
3. Keep one account identity across the main site and Growth HQ; retain affiliate/source facts through SSO and future imports.
4. Expose only narrow, authenticated company-content and account-export contracts—never browser sessions, raw secrets, unrestricted database access or customer-private material.
5. Test the combined main-site candidate independently, then deploy it only under an explicit production release authority.

Main-site completion is not allowed to stall the first Growth HQ campaign proof unless a shared identity or content contract genuinely blocks it.

## The next ten strikes

### 1. Prove one complete owned-seed campaign

Use the real Brand Brain and Campaign Wizard to create, review, approve and schedule one Property Predator campaign. Send one capped email only to `office@propertypredator.com`, ingest its signed Mailgun receipt and show the resulting evidence in the calendar, inbox and Lead 360.

**Done when:** one immutable campaign/version can be traced end to end; suppression and emergency-stop tests pass; no customer is contacted.

### 2. Make the Conversion Inbox operational

Turn the existing inbox foundation into the team's daily workspace: real email threads, ownership, assignment, reply drafts, approval, follow-up tasks, suppression state, delivery state and clear failure recovery.

**Done when:** an operator can receive the owned-seed reply, assign it, approve a response and close or schedule the next action without leaving Growth HQ.

### 3. Connect one owned social profile

Select the quickest commercially sensible first transport—use the existing Ayrshare seam for speed or complete the lower-cost Zernio route if its live contract is ready. Connect one Property Predator-owned profile with explicit workspace/resource binding.

**Done when:** Growth HQ can validate the owned connection, prepare one approved test post and reconcile the provider result without exposing credentials or enabling any other profile.

### 4. Deliver the Hootsuite-quality public-social surface

Operationalise Facebook, Instagram and LinkedIn first: channel previews, crop/aspect checks, scheduling, calendar movement, approval, partial failures, correction/retry, delivery receipts and useful analytics. Add TikTok and X only after their account and API constraints are confirmed.

**Done when:** one campaign can become channel-correct approved variants, publish through controlled rails and report truthful per-channel outcomes.

### 5. Connect WhatsApp

Connect an owned Property Predator number to the native Growth HQ inbox. Implement approved templates, consent evidence, conversation-window rules, replies, assignment, suppression, signed webhooks and delivery receipts.

**Done when:** an owned-number/owned-recipient pilot completes both directions and every message is visible, attributable and stoppable in Growth HQ.

### 6. Connect Facebook and Instagram DMs

Activate the existing Meta contracts for an owned Page and Instagram professional account. Bring messages, comments and mentions into the Conversion Inbox; let AI propose replies while a human remains the approval boundary.

**Done when:** signed inbound events deduplicate correctly and one approved owned-account reply reconciles to its original conversation.

### 7. Operationalise Predator Briefing webinars

Choose the final embedded webinar rail, then connect registration, room creation, reminders, attendance, no-shows, replay and follow-up journeys. Attendance—not a manual card move—must be the advancement evidence.

**Done when:** an internal rehearsal moves test participants through registration, attendance/no-show and replay follow-up with signed evidence.

### 8. Activate the highest-value automation recipes

Ship a small, controlled recipe library before a general workflow builder:

- new lead → admin-call task;
- appointment booked / attended / no-show → correct follow-up;
- content consumed → scoring and journey evaluation;
- offer viewed → priority call task;
- sale evidenced → onboarding;
- stalled lead → review queue, never silent spam.

**Done when:** each recipe has explicit entry evidence, stop conditions, ownership, idempotency and an operator-visible reason for every action or block.

### 9. Import existing people and affiliate attribution

Use the controlled export/preview/reconcile/commit flow to import the existing Property Predator accounts, leads and affiliates. Preserve original source, affiliate/referral identifiers, consent evidence and raw-source audit hashes; deduplicate before commit.

**Done when:** dry-run totals reconcile to the authoritative export, exceptions are reviewed, rollback evidence exists and the committed people appear correctly in CRM, Journey Board and Lead 360.

### 10. Finish the operating and reporting layer

Make “every lead gets called” an accountable operating system: queues, SLA clocks, call scripts, outcomes, next actions, manager exceptions, campaign/source attribution, funnel conversion, provider cost and failure reporting.

**Done when:** the team can run the day from Growth HQ and management can explain where every active lead came from, what happened, what happens next and what it cost.

## Provider and account dependencies

| Capability | Current position | External dependency before live proof |
|---|---|---|
| AI copy and imagery | Configured behind Brand Brain, budgets and approvals | Maintain funded restricted OpenAI project/key and approved company assets; no consumer GPT session is an application API |
| Email | Mailgun EU owned-seed rail ready and tightly capped | Strike 1 needs no new account; customer delivery later needs approved audience, consent/suppression evidence and a separately reviewed cap increase |
| Public social | Dark adapters, workers and account-linking seams exist | Choose first provider; obtain its key/profile binding and connect one owned Meta/LinkedIn profile |
| WhatsApp | Effects-off Meta contract exists | Verified Meta Business, WABA, owned number, app/permissions, approved templates, webhook and opt-in evidence |
| Facebook/Instagram DMs | Effects-off Meta contract exists | Owned Page + Instagram professional account, correct app review/permissions and signed webhook subscription |
| Webinar | Inbound/adapter foundation exists | Final provider choice (Whereby/Zoom or approved alternative), API credentials, webhook secret and allowed origins |
| Calendar | Internal calendar exists | Google/Microsoft connection is required only when external calendar synchronisation becomes part of the selected workflow |
| Paid ads | Draft/paused rail only | Owned ad account, reviewed credentials and a separate activation; Growth HQ must never unpause or create spend automatically |

Commercial signup, app review and account-verification lead times can run in parallel with product work. Provider choice must not leak provider concepts into the core CRM or content model.

## Effect boundaries during execution

- Strike 1 may use only the owned internal email seed and the existing hard caps until its evidence is reviewed.
- Every new live channel starts with one owned account and owned/internal recipients before any customer audience.
- AI may draft and recommend; it may not bypass content, claims, legal, consent or operator approval gates.
- A delivery request is not evidence of delivery; only authenticated provider receipts may advance provider-derived facts.
- A dragged CRM card is workflow state, not proof of content consumption, attendance, payment or sale.
- Production migrations remain forward-only. No production reset, destructive rewrite or silent customer import is part of this plan.
- Paid ads remain paused drafts; payments and spend activation are separate authorities.
- Emergency pauses, volume/spend caps, suppressions, consent and least-privilege credentials remain part of the product, not temporary launch scaffolding.

## Documentation truth and maintenance

- `docs/roadmap.md` describes an older Relaunch72 product sequence and is **historical for this Property Predator execution**.
- Early `docs/codex-handoff/*` status reports are measured snapshots, not the current backlog.
- Provider decision documents may contain earlier prices, preferred vendors or effects-off states. Reconfirm current commercial terms and account eligibility immediately before purchase or activation.
- Deployment and security documents remain runbooks where their commands and controls still match the checked-in code; they do not override this plan's priority order.
- Update this file at the end of every strike with the exact commit, environment/effect state, evidence and next blocker. Do not create another competing roadmap.

## Immediate move

Start **Strike 1** and the **main-site branch inventory** in parallel. Do not begin a second provider integration until the owned-seed campaign loop is evidenced end to end.
