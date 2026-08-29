# Property Predator — current execution plan

**Authoritative execution snapshot:** 29 August 2026

**Growth HQ baseline:** `codex/relaunch72-platform-foundation`, forward-only through migration `0057`
**Purpose:** one truthful sequence from the current foundation to an operational Property Predator marketing and conversion system.

This document supersedes older roadmap prose for **current status, priority and sequencing**. Older handoffs, provider notes, security designs and deployment runbooks remain useful evidence, but their status labels must not be read as the present plan.

## North-star outcome

One system should take an attributable lead from first signal to sale and onboarding while the team can see, approve and operate every step:

`source → content/campaign → engagement → conversation → appointment → offer → sale → onboarding`

Growth HQ owns the people, attribution, consent, content, approvals, conversations, journeys, evidence and reporting. External services are replaceable transport rails.

## Foundation already completed

- The production Blueprint composes Growth HQ plus isolated email, owned-social, WhatsApp and Twilio SMS workers/webhooks; deployment remains a separate release action.
- Shared Property Predator login, workspace isolation, role boundaries and security controls are established.
- CRM, Journey Board, automatic journey evidence, lead scoring and Lead 360 foundations exist.
- Brand Brain, owned-specialist reuse, company-content adapter, immutable content versions, approvals and Campaign Wizard foundations exist.
- Content calendar, asset review, Affiliate Compliance Centre, conversion-inbox model and outbound-operation foundations exist.
- CSV migration and authenticated migration-centre foundations exist; production customer data has not been imported.
- OpenAI-backed company and affiliate generation rails are configured behind budgets, provenance and brand controls.
- Mailgun EU is configured. The owned internal seed remains capped at **1 message per run and 3 per month**; the permission-bound customer-email rail is capped at **10 per day and 50 per month**.
- Owned X, Meta WhatsApp and Twilio UK SMS command/worker/webhook foundations are composed with isolated identities, durable calling fences, receipts and Conversion Inbox visibility. Provider accounts and owned-test evidence are still required before any effect.
- The operational Conversion Inbox now has unified channel/source truth, assignment, internal notes, reply drafting and approval, consent/opt-out visibility, Lead 360 and affiliate linkage, admin-call tasks, outcomes and next actions. Facebook/Instagram DM live transport is the explicit remaining inbox adapter gap.
- A founder-only engage emergency pause now blocks every composed live worker at the durable `calling` transition. There is no release command in the application.
- Emergency stops, idempotency, suppression, consent, audit and provider-operation boundaries are built into the effectful rails.

These are foundations, not proof of a complete operating loop. The next ten strikes supply that proof.

### Prepared Campaign Machine candidate — not deployed

- The branch now contains a Property Predator-only reusable sequence library surface and forward migration `0051`.
- The model keeps campaign identity, immutable versions, prewritten steps, Brand Brain provenance, owned-specialist handoffs, LAPS entry/target milestones, automation entry/stop evidence, exact human review and reporting identity separate.
- The first fixture is a six-step owned-office Lead-to-Activation nurture: four proposed emails plus two mandatory admin tasks. It contains no customer recipient, provider account, send command or live effect.
- Activation remains blocked until the exact audience, offer/message, activation-window, consent/suppression and approved-version evidence is supplied at runtime.

## Main-site takeover lane — Codex owns this too

Claude is no longer an execution dependency. Existing Claude branches are preserved as source material; they are not treated as trusted, merged or deployed merely because they exist.

This lane runs alongside the ten Growth HQ strikes:

1. Inventory every main-site worktree and remote branch; identify exact base commits, overlapping changes and unfinished work.
2. Reconcile identity, affiliate attribution, content/asset APIs, AI-generation controls, valuation/payment work and security changes into one reviewed main-site candidate.
3. Keep one account identity across the main site and Growth HQ; retain affiliate/source facts through SSO and future imports.
4. Expose only narrow, authenticated company-content and account-export contracts—never browser sessions, raw secrets, unrestricted database access or customer-private material.
5. Test the combined main-site candidate independently, then deploy it only under an explicit production release authority.

Main-site completion is not allowed to stall the first Growth HQ campaign proof unless a shared identity or content contract genuinely blocks it.

## The remaining eleven strikes

### 1. Prove one complete owned-seed campaign

Use the real Brand Brain and Campaign Wizard to create, review, approve and schedule one Property Predator campaign. Send one capped email only to `office@propertypredator.com`, ingest its signed Mailgun receipt and show the resulting evidence in the calendar, inbox and Lead 360.

**Done when:** one immutable campaign/version can be traced end to end; suppression and emergency-stop tests pass; no customer is contacted.

### 2. Make the Conversion Inbox operational

Turn the existing inbox foundation into the team's daily workspace: real email threads, ownership, assignment, reply drafts, approval, follow-up tasks, suppression state, delivery state and clear failure recovery.

**Done when:** an operator can receive the owned-seed reply, assign it, approve a response and close or schedule the next action without leaving Growth HQ.

**Build status:** backend and route workflows are complete through email, WhatsApp, social-DM projections and SMS. Remaining proof is the owned-seed round trip and production migration/readiness evidence—not another inbox implementation.

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

### 7. Connect Twilio UK SMS

Bind the existing Twilio rail to one Property Predator-owned UK sender and one founder-owned UK recipient. Rehearse STOP, START, signed inbound, status receipts, segment caps and unknown-outcome quarantine before any customer audience.

**Done when:** one explicitly approved owned-recipient SMS round trip is visible in the Conversion Inbox and Lead 360, opt-out immediately suppresses later enqueue, and the durable pause/cap fences are evidenced.

### 8. Operationalise Predator Briefing webinars

Choose the final embedded webinar rail, then connect registration, room creation, reminders, attendance, no-shows, replay and follow-up journeys. Attendance—not a manual card move—must be the advancement evidence.

**Done when:** an internal rehearsal moves test participants through registration, attendance/no-show and replay follow-up with signed evidence.

### 9. Activate the highest-value automation recipes

Ship a small, controlled recipe library before a general workflow builder:

- new lead → admin-call task;
- appointment booked / attended / no-show → correct follow-up;
- content consumed → scoring and journey evaluation;
- offer viewed → priority call task;
- sale evidenced → onboarding;
- stalled lead → review queue, never silent spam.

**Done when:** each recipe has explicit entry evidence, stop conditions, ownership, idempotency and an operator-visible reason for every action or block.

### 10. Import existing people and affiliate attribution

Use the controlled export/preview/reconcile/commit flow to import the existing Property Predator accounts, leads and affiliates. Preserve original source, affiliate/referral identifiers, consent evidence and raw-source audit hashes; deduplicate before commit.

**Done when:** dry-run totals reconcile to the authoritative export, exceptions are reviewed, rollback evidence exists and the committed people appear correctly in CRM, Journey Board and Lead 360.

### 11. Finish the operating and reporting layer

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
| SMS | Twilio UK command, worker, webhook, receipts and Inbox projection composed | Owned Twilio account/sender, restricted key, Messaging Service, UK regulatory bundle, signed webhook secret and one founder-owned UK recipient with consent |
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

## Master activation sheet — exact smallest next inputs

| Rail | Build position | Exact remaining external/owned proof |
|---|---|---|
| Customer email | Mailgun EU configured; 10/day and 50/month customer caps; signed receipt path composed | No new Mailgun account. Supply the exact `office@propertypredator.com` person/endpoint, current consent and suppression-clear evidence, approved message/version hash, operator/connection IDs and one signed owned-mailbox receipt proof. |
| Meta WhatsApp | Command, one-at-a-time worker, challenge/webhook and Inbox receipt path composed | Verified Meta Business, App ID, WABA ID, phone-number ID, worker-only encrypted access-token binding, webhook-only app secret/verify token, one founder-owned UK recipient, and one approved **parameter-free** Property Predator test template. |
| Owned X social | Ayrshare worker, cap fence and receipt projection composed | Ayrshare API key, exact linked Property Predator-owned X profile, X OAuth1 key/secret, profile-binding evidence, and one approved link-free test post/hash. |
| Twilio UK SMS | Command, one-at-a-time worker, signed inbound/status webhook and Inbox receipt path composed | Twilio Account SID, restricted API key SID/secret, Messaging Service SID, approved UK regulatory bundle, owned UK sender, webhook auth token, and one founder-owned UK recipient plus approved message/consent/suppression evidence. |
| Facebook/Instagram DMs | Unified Inbox projection exists; live adapter is intentionally reported `not-composed` | Owned Page and Instagram professional account, Meta app review/permissions and signed webhook subscription **after** the dedicated live inbound/reply adapter is built. |
| Database proof | Static contracts through `0057` pass | A guarded disposable Neon `TEST_DATABASE_URL` plus the explicit reset acknowledgement. Production must never be used for this proof. |

## Immediate move

Run `npm run pilot:preflight` for the five-rail redacted readiness report, then
`npm run pilot:rehearse-targets` for the exact founder-owned target pack. The
first authorised effect remains one owned email proof; WhatsApp, owned X and SMS
can follow one rail at a time without further foundation work. Continue the
main-site branch inventory in parallel only where it does not delay activation.
