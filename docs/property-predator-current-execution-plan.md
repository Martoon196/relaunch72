# Property Predator — current execution plan

**Authoritative execution snapshot:** 2 September 2026

**Growth HQ baseline:** `codex/relaunch72-platform-foundation`. Local checkpoint `c794bd6` extends the migration ledger through `0093`; the last independently observed GitHub tip was `80ee590`. The new local checkpoint widens the existing Zernio engagement rail to multiple explicitly configured Facebook Pages: Facebook Page DMs and Facebook Page comment threads now use the same live social inbox, immutable draft, approval, exact-account and one-shot reply boundary as Instagram and LinkedIn. Focused verification is 95/95 and typecheck is clean. It is **built locally, not deployed**, and `0093` has not been applied to production. Personal Facebook profiles remain unavailable because the official Facebook/Zernio API supports Pages, not personal-profile automation. This plan does not itself authorise a cold message, unsolicited comment or customer communication.

**Purpose:** one truthful sequence from the current foundation to an operational Property Predator marketing and conversion system.

This document supersedes older roadmap prose for **current status, priority and sequencing**. Older handoffs, provider notes, security designs and deployment runbooks remain useful evidence, but their status labels must not be read as the present plan.

## North-star outcome

One system should take an attributable lead from first signal to sale and onboarding while the team can see, approve and operate every step:

`source → content/campaign → engagement → conversation → appointment → offer → sale → onboarding`

Growth HQ owns the people, attribution, consent, content, approvals, conversations, journeys, evidence and reporting. External services are replaceable transport rails.

## Foundation already completed

- The production Blueprint composes Growth HQ plus isolated email, owned-social, WhatsApp and Twilio SMS workers/webhooks. The last verified production release remains live; the reviewed `0080`–`0089` suffix is the current forward-only candidate and customer communication effects remain separately permission-bound.
- Shared Property Predator login, workspace isolation, role boundaries and security controls are established.
- CRM, Journey Board, automatic journey evidence, lead scoring and Lead 360 foundations exist.
- Brand Brain, owned-specialist reuse, company-content adapter, immutable content versions, approvals and Campaign Wizard foundations exist.
- Content calendar, asset review, Affiliate Compliance Centre, conversion-inbox model and outbound-operation foundations exist.
- CSV migration and authenticated migration-centre foundations exist; production customer data has not been imported.
- OpenAI-backed company and affiliate generation rails are configured behind budgets, provenance and brand controls.
- Mailgun EU is configured. The owned internal seed remains capped at **1 message per run and 3 per month**; the permission-bound customer-email rail is capped at **10 per day and 50 per month**.
- Instagram and LinkedIn now share the Zernio calendar worker with exact owned-account binding, immutable approved-media evidence, a short-lived signed public-media gateway, durable calling fences, reconciliation and receipts. The gateway is bound to the workspace, job, storage key, digest, MIME type and expiry; the worker never receives the private company-content bearer. Ayrshare remains dormant replacement-provider code; X is deliberately deferred. Exact owned-account linking and controlled proof are still required before this candidate is called live.
- The operational Conversion Inbox now has unified channel/source truth, assignment, internal notes, reply drafting and approval, consent/opt-out visibility, Lead 360 and affiliate linkage, admin-call tasks, outcomes and next actions. The Zernio live inbox now reads Facebook Page and Instagram DMs plus Facebook Page, Instagram and LinkedIn organisation comments across explicit account lists. Every reply uses the existing account-bound immutable draft, approval and one-shot provider boundary. Signed central-inbox ingestion remains Instagram/LinkedIn until the Facebook event-contract extension is separately proved.
- The global provider-effects switch and emergency pause fence every Zernio send before its one-shot durable claim. Reads may remain available during a pause; writes remain blocked unless the exact runtime tuple, account binding, approval and effect gates all agree. There is no release command in the application.
- Emergency stops, idempotency, suppression, consent, audit and provider-operation boundaries are built into the effectful rails.

### Effect-free production activation-prep checkpoint — 29 August 2026

- The guarded disposable Neon database was reset and migrated cleanly through
  `0059`. The real customer-email attack proof passed, and the WhatsApp and
  owned-social readiness probes executed as their exact table-blind login roles.
- The Frankfurt production Neon ledger was validated as a contiguous,
  checksum-matching prefix through `0046`, then the exact forward suffix
  `0047`–`0059` was applied under the migration advisory lock. Production is
  now **59/59** with no reset, rewrite or customer-data import.
- Fresh credentials were provisioned only for
  `r72_customer_email_command`, `r72_customer_email_worker_command` and
  `r72_customer_email_webhook_command`. Each identity authenticated and proved
  its exact function allowlist, table blindness and denial of elevated roles.
- The exact Growth HQ and `property-predator-customer-email-live` Render
  services now contain their permission-bound database URLs plus the existing
  Mailgun EU sender/workspace/connection bindings. Before save, the live-mode,
  provider-effect, delivery, receipt and emergency-pause controls were proved
  as `disabled`, `false`, `false`, `false` and `true` respectively.
- The exact reviewed release graph was published at `c9f35ca`. Its first Growth
  HQ deployment started the 0059-aware application but correctly remained
  unready: production evidence exposed owner-default `PUBLIC EXECUTE` on eight
  owned-social functions, which caused the table-blind portal abuse boundary to
  fail closed. The separate Mailgun inbound probe also attempted a relation-name
  lookup despite its role correctly lacking `app` schema usage.
- Forward migration `0060` now reasserts the eight exact owned-social function
  ACLs, and the Mailgun inbound probe uses the already-established catalog-OID
  blindness pattern. On disposable Neon branch
  `br-withered-resonance-b2u4pzab`, the ledger reached **60/60**, the PUBLIC
  execute count was zero, the exact abuse identity returned ready, and the
  Mailgun identity, table-blindness and existing binding all returned ready.
  The same ACL-only migration was then applied to the Frankfurt production
  branch under the guarded migration authority. Production is now **60/60**;
  the PUBLIC execute count is zero and the exact abuse and Mailgun identities
  both return ready.
- The permission-bound customer-email worker deployed successfully at
  `c9f35ca` and reports `mode=disabled`, exact worker-role/schema/installation/
  function readiness, provider credentials not loaded, adapter not instantiated,
  zero readiness network calls, provider effects OFF, delivery OFF, emergency
  pause ON, dispatch loop not started, and caps of 10/day and 50/month. The
  Growth HQ web deployment at `05ba177` exposed one stale test inventory that
  stopped at migration 0059. Commit `14970cc` added the already-reviewed 0060
  filename and checksum to that inventory; its focused test and typecheck passed,
  Render's complete build gate passed, and the release promoted successfully.
  Public `/health` and `/ready` both return HTTP 200, `/ready` reports no blockers,
  the PostgreSQL portal is ready, and both signed Mailgun ingress paths are ready.
  `/portal` redirects to the production login and `/portal/login` returns HTTP 200.
- A post-deploy read-only production query returned exactly **0 customer-email
  authorities, 0 jobs, 0 leases and 0 receipts** with 60 migrations applied.
  A stale clipboard value surfaced the old `neondb_owner` connection credential
  during operator verification; it was never written to a service and the role
  password was immediately rotated in Neon, invalidating that credential.
- No provider call, customer write, email, SMS, WhatsApp message or social
  publication occurred. Provider effects and delivery remain OFF and emergency
  pause remains ON.

These are foundations, not proof of a complete operating loop. The next ten strikes supply that proof.

### Founder identity event bridge proof — 30 August 2026

- Growth HQ migrations `0061`–`0063` are applied in EU production, `/ready`
  reports no blockers, and the Conversion Inbox now serves its authoritative
  empty state instead of failing closed.
- The dedicated signed Property Predator receiver and least-privilege database
  identities are live at `32a6366`. The isolated Property Predator dispatcher
  is live at `52cffa8` on the approved 0.5 CPU / 512 MB Render worker.
- A recoverable Property Predator production Neon checkpoint was created as
  `pre-conversion-data-plane-20260830` (`br-quiet-hat-abumklct`) before the
  additive conversion outbox/export schema and immutable-event trigger were
  applied. Production verification returned 5 required tables, 5 indexes, 1
  immutable trigger, sequence high-water 0 and 0 queued events before proof.
- Only founder account `7fba8186-9fa5-4c87-9511-263d887b07ca` was reconciled.
  Event `5786bc2a-0e03-584d-a989-a218b1c74ddc` delivered once with no error or
  retry. An exact rerun returned `replayed` for the same event; the source still
  held exactly 1 row and 1 delivery attempt.
- Growth HQ persisted exactly 1 signed receipt, 1 Growth projection and 1
  Journey projection. Lead 360 shows the founder's real account-created evidence
  and evaluation time, and the Journey Board links the same contact and Lead
  stage. Conversion Inbox correctly remains empty because account creation is
  not a message thread.
- No email, SMS, WhatsApp message or social publication occurred, and no other
  Property Predator account was reconciled.

### Release-candidate `80ee590` disposable-PostgreSQL proof — 2 September 2026

Branch `codex/relaunch72-platform-foundation`, local `HEAD` and the GitHub tip are
all at exact commit `80ee590f794032d4440acbf83394fa7cfd707e56`. The worktree is
clean and its remote-tracking reference matches. Nothing was amended, rebased,
force-pushed or reset.

Re-verified locally on this candidate:

- `npm run typecheck` — clean.
- `npm test` — 2,931 tests, **2,893 passing, 0 failing**, 38 skipped. The figure
  previously reported as 2,892 passing was one short; 2,893 is the measured count.
- Browser acceptance — 6/6 desktop, tablet and mobile, carried forward from the
  candidate's own verification and deliberately not re-run, as no UI code changed.

**The 38 opt-in PostgreSQL integration and attack tests still have not run.** They
are *not* blocked by a missing `TEST_DATABASE_URL`: the approved disposable Neon
database was available and was used. They are blocked because migration `0090`
cannot apply. Two independent defects were found, both invisible to typecheck and
to the 2,893 non-database tests:

1. **Blanket function revoke — fixed in this block.** `0090` ran
   `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private` under
   `SET LOCAL ROLE r72_owner`. That form requires ownership or grant option on
   every function in the schema, and `app_private` holds 211 functions owned by 28
   other definer roles. `r72_owner` is a member of 26 of them but **not** of
   `r72_owned_social_definer` (created in `0052`) or `r72_zernio_social_definer`
   (created in `0074`), which own 39 functions between them, so the statement
   aborted with `42501`. `0090` is the first migration since `0056` to use the
   blanket form, which is why a latent gap dating to `0052` and `0074` only
   surfaced now. The revoke is now scoped to functions the executing role can act
   for. The three daily-outreach roles are created by this migration, so no
   unrelated definer-owned function could ever hold a grant to them. Verified:
   `0090` now proceeds past that statement.

2. **Neon platform role membership versus `0090`'s own assertion — OPEN.** `0090`
   asserts that `r72_owner` is the sole inbound member of the daily-outreach roles.
   On Neon that invariant is unachievable. When `neondb_owner` creates a role, the
   platform grants that role back to `neondb_owner` with `grantor = cloud_admin`,
   `admin_option = true` and `set_option = false`. The migration's strip loop
   cannot remove it, because a `REVOKE` issued by a non-grantor is a warning rather
   than an error, and an explicit `REVOKE ... GRANTED BY cloud_admin` fails with
   `42501 permission denied to revoke privileges granted by role "cloud_admin"`.
   The migration therefore aborts at its own guard with
   `Daily Outreach role has unsafe inbound membership: r72_daily_outreach_definer<-neondb_owner`.

Defect 2 is a security-model decision and has deliberately **not** been patched.
Resolving it means either relaxing `0090`'s invariant to tolerate the
platform-owner grant — noting `set_option = false`, so `neondb_owner` cannot
`SET ROLE` into the identity, though it does hold `ADMIN` — or changing how the
daily-outreach roles are provisioned so that the platform grant never applies.
**If production runs on Neon, migration `0090` will fail there in exactly the same
way.** Migration application is transactional, so an attempt would roll back
cleanly rather than corrupt the ledger, but the deployment would not succeed.

Status of this candidate: **built and pushed; not deployed; production migrations
`0090`-`0092` not applied; the disposable-PostgreSQL proof blocked by defect 2.**
No production database, customer record or provider effect was touched.

The exact activation sequence is held in
`docs/property-predator-0090-0092-production-cutover-checklist.md`, which must not
begin until defect 2 is resolved and the 38 tests pass.

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

## The remaining twelve strikes

### 1. Prove one complete owned-seed campaign

Use the real Brand Brain and Campaign Wizard to create, review, approve and schedule one Property Predator campaign. Send one capped email only to `office@propertypredator.com`, ingest its signed Mailgun receipt and show the resulting evidence in the calendar, inbox and Lead 360.

**Done when:** one immutable campaign/version can be traced end to end; suppression and emergency-stop tests pass; no customer is contacted.

### 2. Make the Conversion Inbox operational

Turn the existing inbox foundation into the team's daily workspace: real email threads, ownership, assignment, reply drafts, approval, follow-up tasks, suppression state, delivery state and clear failure recovery.

**Done when:** an operator can receive the owned-seed reply, assign it, approve a response and close or schedule the next action without leaving Growth HQ.

**Build status:** backend and route workflows are complete through email, WhatsApp, social-DM projections and SMS. Remaining proof is the owned-seed round trip and production migration/readiness evidence—not another inbox implementation.

### 3. Connect the owned Facebook Pages, Instagram and LinkedIn organisations

Use the current Zernio seam. Connect each Property Predator-owned Facebook Page, Instagram professional account and LinkedIn organisation with a separate explicit workspace, network and account binding. Multiple Page/account IDs are supported by the inbox configuration. Retain the earlier Ayrshare implementation as dormant replacement-provider code only; it is not the current execution route. Do not represent a personal Facebook profile as connectable.

**Done when:** Growth HQ validates every selected owned account, proves a read/reply against one owned test conversation, then prepares one approved test post and reconciles its provider result without exposing credentials or enabling any other account.

### 4. Deliver the Hootsuite-quality Facebook Page + Instagram + LinkedIn surface

Operationalise Facebook Pages, Instagram and LinkedIn organisations through Zernio: channel previews, crop/aspect checks, calendar scheduling, approval, partial failures, correction/retry, delivery receipts and useful analytics. The current calendar worker remains Instagram/LinkedIn until a forward migration makes account selection multi-account and Facebook-qualified. TikTok and X remain later additions.

**Done when:** one campaign can become channel-correct approved variants, publish through controlled rails and report truthful per-channel outcomes.

### 5. Connect WhatsApp

Connect an owned Property Predator number to the native Growth HQ inbox. Implement approved templates, consent evidence, conversation-window rules, replies, assignment, suppression, signed webhooks and delivery receipts.

**Done when:** an owned-number/owned-recipient pilot completes both directions and every message is visible, attributable and stoppable in Growth HQ.

### 6. Prove Facebook Page and Instagram DMs/comments live

The live-read and approval-gated reply foundation now covers Facebook Page and Instagram DMs plus Facebook Page, Instagram and LinkedIn organisation comments. Validate callback state, reconcile each provider-owned account, extend the signed webhook projection to Facebook events, then prove one owned Page and one Instagram professional account. Bring signed messages, comments and mentions into the Conversion Inbox; let AI propose replies while a human remains the approval boundary.

**Done when:** signed inbound events deduplicate correctly and one approved owned-account reply reconciles to its original conversation.

### 7. Build the Daily Outreach + Authority Comment Engine

Turn the founder's fixed-daily-outreach discipline into an operator cockpit: configurable daily targets, approved prospect-source adapters, prioritised queues, controlled message families, Brand Brain personalisation, manual-versus-Zernio eligibility, attempt receipts, cooldowns, response handling, next tasks, attribution and LAPS advancement. Add a founder-approved creator watchlist and context-grounded Authority Commenter that can monitor supported new posts, deliberately choose `no_comment`, draft useful replies and send through a one-tap approval path. Do not scrape LinkedIn, disguise bot activity or automate unsupported cold DMs/comments. Use Zernio only for official supported conversations, comments and replies.

**Done when:** with test data, one operator can complete a daily queue, every item explains whether it is manual, Zernio-supported or blocked, an approved creator-watch comment can be reviewed/post-staged with exact source context, a real/simulated response lands in Conversion Inbox and Lead 360, and duplicate, stale, suppressed or unsupported attempts fail closed. The detailed contract is in `docs/property-predator-daily-social-outreach-engine.md`.

### 8. Connect Twilio UK SMS

Bind the existing Twilio rail to one Property Predator-owned UK sender and one founder-owned UK recipient. Rehearse STOP, START, signed inbound, status receipts, segment caps and unknown-outcome quarantine before any customer audience.

**Done when:** one explicitly approved owned-recipient SMS round trip is visible in the Conversion Inbox and Lead 360, opt-out immediately suppresses later enqueue, and the durable pause/cap fences are evidenced.

### 9. Operationalise Predator Briefing webinars

Choose the final embedded webinar rail, then connect registration, room creation, reminders, attendance, no-shows, replay and follow-up journeys. Attendance—not a manual card move—must be the advancement evidence.

**Done when:** an internal rehearsal moves test participants through registration, attendance/no-show and replay follow-up with signed evidence.

### 10. Activate the highest-value automation recipes

Ship a small, controlled recipe library before a general workflow builder:

- new lead → admin-call task;
- appointment booked / attended / no-show → correct follow-up;
- content consumed → scoring and journey evaluation;
- offer viewed → priority call task;
- sale evidenced → onboarding;
- stalled lead → review queue, never silent spam.

**Done when:** each recipe has explicit entry evidence, stop conditions, ownership, idempotency and an operator-visible reason for every action or block.

### 11. Import existing people and affiliate attribution

Use the controlled export/preview/reconcile/commit flow to import the existing Property Predator accounts, leads and affiliates. Preserve original source, affiliate/referral identifiers, consent evidence and raw-source audit hashes; deduplicate before commit.

**Done when:** dry-run totals reconcile to the authoritative export, exceptions are reviewed, rollback evidence exists and the committed people appear correctly in CRM, Journey Board and Lead 360.

### 12. Finish the operating and reporting layer

Make “every lead gets called” an accountable operating system: queues, SLA clocks, call scripts, outcomes, next actions, manager exceptions, campaign/source attribution, funnel conversion, provider cost and failure reporting.

**Done when:** the team can run the day from Growth HQ and management can explain where every active lead came from, what happened, what happens next and what it cost.

## Provider and account dependencies

| Capability | Current position | External dependency before live proof |
|---|---|---|
| AI copy and imagery | Configured behind Brand Brain, budgets and approvals | Maintain funded restricted OpenAI project/key and approved company assets; no consumer GPT session is an application API |
| Email | Mailgun EU owned-seed rail ready and tightly capped | Strike 1 needs no new account; customer delivery later needs approved audience, consent/suppression evidence and a separately reviewed cap increase |
| Public social | Migration `0080` plus the provider-qualified Zernio calendar suffix, signed approved-media gateway and the shared Instagram/LinkedIn Zernio worker are the current candidate | Restricted Zernio API key; exact connected Instagram and LinkedIn account IDs; shared media-signing key in web/worker secret managers; connection/account bindings; one owned test post per network |
| WhatsApp | Effects-off Meta contract exists | Verified Meta Business, WABA, owned number, app/permissions, approved templates, webhook and opt-in evidence |
| Facebook/Instagram DMs | Zernio connection, signed account-webhook, inbox reads, DMs, comment threads and approval-gated Instagram/LinkedIn replies are composed behind the global effect/pause gates | Exact callback-state validation, signed connected-event plus account reconciliation, owned Page + Instagram professional account, restricted credential and one owned-account proof |
| SMS | Twilio UK command, worker, webhook, receipts, Inbox projection and founder-only bind/revoke/readiness-gated staging composed | Owned Twilio account/sender, restricted key, Messaging Service, UK regulatory bundle, signed webhook secret and one founder-owned UK recipient with consent |
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
- The customer-email `10/day` and `50/month` limits are temporary founder-pilot
  controls, not commercial throughput limits. After the first signed
  send/receipt/reply/opt-out rehearsal and its observation window, graduate or
  remove those aggregate caps in a forward migration while retaining
  per-recipient consent, suppression, idempotency, outcome-unknown quarantine
  and operator pause controls.

## Verification economy and master-rehearsal rule

The team must spend verification effort in proportion to changed risk. Repeating
the same broad audit after every narrow edit is not progress.

### Live-by-default operating rule

Routine application deployments and forward schema repairs preserve the current
provider settings; they must not automatically darken a healthy rail, disable
delivery or re-engage an emergency pause. OFF or paused posture is required only
for a concrete critical condition such as an unknown recipient, missing consent
or suppression evidence, an unbounded queue, an unproved destructive migration,
or a provider/receipt fence that cannot fail closed.

Once a rail has its exact founder-owned target, current consent and suppression
evidence, reviewed content, hard caps, least-privilege credentials and focused
provider/receipt proof, the next action is the explicitly authorised live owned
test. Do not insert another zero-effect or darkness rehearsal unless it answers a
new, stated risk. The final Sol Ultra master rehearsal remains the release-wide
verification pass and must not be recreated piecemeal after every narrow change.

### During each strike

- Run the smallest focused tests that prove the changed behaviour, its failure
  boundary and any directly affected contract, plus typecheck when TypeScript is
  touched.
- Add a disposable-database proof when a migration or database authority changes
  and a guarded disposable URL is available. Never substitute production.
- Run browser, responsive or accessibility checks only when the affected user
  journey or presentation changed.
- Mark the strike done when its scoped acceptance criteria pass, no known P0/P1
  defect remains and the exact evidence is recorded. Do not reopen it merely to
  repeat unchanged checks.

### Milestone regression triggers

Run a full regression only when one of these occurs:

- a shared authentication, authorisation, database, runtime-composition or
  security boundary changes;
- a forward-migration/provider-composition batch is completed;
- branches are integrated for a release candidate;
- production deployment or the first separately authorised provider effect is
  imminent; or
- focused evidence reveals credible cross-system risk.

Otherwise use the last green full-suite result as the baseline and test only the
new risk. Auditing, ratification and adversarial-review passes must have a stated
question and must stop once that question is answered.

### Final Sol Ultra master rehearsal

Before production activation, run one dedicated master-rehearsal task using the
latest available **Sol model at Ultra reasoning**. It must review the combined
release candidate once, not recreate every earlier strike. The rehearsal covers:

1. the complete branch diff and dependency/supply-chain evidence;
2. a clean guarded disposable-Neon reset, migrations and cross-role attack proof;
3. full typecheck and regression suite;
4. critical desktop/tablet/mobile browser journeys and accessibility;
5. authentication, role, secret-isolation, cap, suppression, pause, idempotency,
   receipt and outcome-unknown boundaries;
6. one zero-effect or explicitly authorised owned-test rehearsal per provider
   rail; and
7. the final exact deployment, provider-account and rollback checklist.

Any live email, WhatsApp, SMS or social publication still requires its own exact
effect approval. A successful master rehearsal proves release readiness; it does
not itself authorise deployment, migration or provider effects.

## Documentation truth and maintenance

- `docs/roadmap.md` describes an older Relaunch72 product sequence and is **historical for this Property Predator execution**.
- Early `docs/codex-handoff/*` status reports are measured snapshots, not the current backlog.
- Provider decision documents may contain earlier prices, preferred vendors or effects-off states. Reconfirm current commercial terms and account eligibility immediately before purchase or activation.
- Deployment and security documents remain runbooks where their commands and controls still match the checked-in code; they do not override this plan's priority order.
- Update this file at the end of every strike with the exact commit, environment/effect state, evidence and next blocker. Do not create another competing roadmap.

## Master activation sheet — exact smallest next inputs

| Rail | Build position | Exact remaining external/owned proof |
|---|---|---|
| Customer email | Mailgun EU configured; production schema 65/65; Growth HQ web and the isolated customer-email worker live at `8b066e6`; provider credential loaded, signed receipts confirmed and dispatch active; temporary 10/day and 50/month founder-pilot caps | No new Mailgun account. Use only the founder-controlled `martin.howard1984@gmail.com` endpoint for the first proof, with the founder's written consent, suppression-clear evidence and the exact Lead 360 prepared/approved message. Complete one signed send/receipt/reply proof, observe it, then graduate or remove the aggregate pilot caps without weakening per-recipient controls. |
| Meta WhatsApp | Command, one-at-a-time worker, challenge/webhook and Inbox receipt path composed | Verified Meta Business, App ID, WABA ID, phone-number ID, worker-only encrypted access-token binding, webhook-only app secret/verify token, one founder-owned UK recipient, and one approved **parameter-free** Property Predator test template. |
| Facebook Page + Instagram + LinkedIn social | Zernio account linking is built for all three. The live social inbox now supports multiple explicit Facebook/Instagram DM accounts and Facebook/Instagram/LinkedIn organisation comment accounts with immutable approval-gated replies. Calendar publishing and signed central-inbox ingestion remain Instagram/LinkedIn on the deployed boundary until their Facebook-qualified forward migrations land. | Restricted Zernio API key; exact owned Facebook Page, Instagram professional and LinkedIn organisation account IDs; callback/ownership evidence; one founder-controlled test conversation/comment per selected account. For publishing, also bind the media-signing key and one approved owned test post per network. |
| X social — later build | Not active and intentionally absent from the current production manifest | Create/confirm the owned X account and developer/API funding, then add the selected provider's X-specific account binding, text/media contract, calendar placement, receipt proof and controlled owned-account acceptance as a separate strike. |
| Twilio UK SMS | Command, one-at-a-time worker, signed inbound/status webhook, Inbox receipt path and founder-only bind/revoke/readiness-gated staging workflow composed; migration `0061` is applied in production | Twilio Account SID, restricted API key SID/secret, Messaging Service SID, approved UK regulatory bundle, owned UK sender, webhook auth token, and one founder-owned UK recipient plus approved message/consent/suppression evidence. |
| Facebook/Instagram DMs | Multi-account Zernio live read and approval-gated reply are built for Facebook Pages and Instagram. Signed central-inbox projection is still Instagram-only for DMs. | Supply and prove the exact callback/account reconciliation, restricted Zernio credential, and one founder-controlled Page/Instagram conversation before calling the rail operational. |
| Founder event bridge | Dedicated HMAC receiver, two least-privilege Growth HQ database identities, isolated Property Predator dispatcher and additive immutable outbox are live; founder fresh/replay proof is 1 receipt, 1 Growth projection, 1 Journey projection and 1 delivery attempt | No remaining code or account input for account-created events. Add future event types only when a real founder workflow supplies the authoritative source fact. |
| Database proof | Production Growth HQ ledger is 65/65 and runtime-ready; migrations 0064-0065 passed a clean disposable-Neon apply and hostile-role proof before production. Property Predator conversion data-plane has a recoverable pre-migration checkpoint and its live immutable one-event proof passed. | Run the final clean disposable-Neon reset/attack sweep through the complete ledger during the Sol Ultra master rehearsal. Production must never be the disposable attack-proof target. |

## Planned multi-business social expansion

Property Predator is the first isolated production social workspace, not the
only business the platform will support. It is the proving ground and an
important lead engine for the wider portfolio; **Relaunch72** is the modular,
multi-company productisation layer.

The founder's current portfolio map to validate and provision after the Property
Predator pilot is proved is:

| Brand / channel | Current founder description | Intended platform relationship |
|---|---|---|
| **Property Predator** | Practice/proving ground and property-intelligence lead engine | First production workspace; may originate explicitly attributed opportunities for other portfolio brands |
| **InvestUK.co.uk** | Centrepiece property-development arm | Separate workspace and Brand Brain; receive explicit, attributable development-interest handoffs from Property Predator |
| **UK Property Intelligence** | WhatsApp channel | Separate channel identity/binding; may have its own audience, content permissions and conversation journeys |
| **Ordris.io** | Software brand/product | Separate workspace or product identity after its commercial and brand boundaries are confirmed |
| **HelpTheOrphans.co.uk** | Charitable fund | Strictly separate charitable brand, claims, legal basis, donor/supporter permissions and reporting |
| **Relaunch72** | Reusable platform | Packages the proven CRM, outreach, content, journey, inbox, provider and analytics modules for multiple companies |

Each business must retain its own connected-account mappings, credentials,
permissions, brand brain, approval trail, content calendar, inbox, analytics,
caps and provider receipts. Never reuse a Property Predator account, key,
approval or post against another portfolio business merely because the
same founder controls both. Adding a business is a deliberate provisioning and
native-account-consent action; this roadmap note does not authorise any present
connection, schedule or publication outside Property Predator.

Zernio remains the active provider while the Property Predator account set is
small enough for its current plan. Ayrshare is a later commercial/provider
switch, not an immediate dependency and not a one-off unlimited purchase: its
current Business offering is profile-priced, with one social account per network
inside each profile. Re-evaluate the two providers only when the exact portfolio
account count makes the price or capability difference material. Keep provider
adapters replaceable so changing transport does not fork the inbox, calendar,
approvals or analytics model.

The shared platform should provide a **Portfolio HQ** above those isolated
workspaces: reusable modules, founder-level roll-up reporting and explicit
cross-brand campaigns. A cross-brand campaign can promote or introduce another
portfolio brand, but must record the source brand, destination brand, campaign,
offer, audience decision and handoff outcome. Contacts, permissions and
suppression state are not silently copied between workspaces.

### Portfolio build list after the Property Predator proof

1. Create the versioned portfolio/brand registry and one-click workspace
   provisioning contract.
2. Load a separate Brand Brain, owned assets, product truth, legal bundle and
   provider bindings for each validated brand/channel.
3. Generalise the Daily Outreach Engine so quotas, prospect pools, copy,
   permissions, inboxes and results are workspace-specific.
4. Add explicit cross-brand campaign and lead-handoff records, including source
   attribution, destination acceptance, ownership and outcome reconciliation.
5. Add a founder Portfolio HQ showing leads, conversations, LAPS journeys,
   pipeline value, channel performance and provider costs without exposing one
   workspace's private operating data to another.
6. Prove Property Predator → InvestUK.co.uk as the first controlled cross-brand
   lead path using test data, then an explicitly approved owned/internal proof.
7. Package the proven modules, provisioning flow and tenant controls as the
   Relaunch72 multi-company/white-label product.

## Immediate move

Begin the customer experience with the founder as the sole production pilot:

1. Sign in through the real Growth HQ customer journey and confirm the exact
   production workspace and founder/operator identity.
2. Create or resolve the founder-controlled `martin.howard1984@gmail.com` person and
   endpoint, then record current consent and suppression-clear evidence.
3. Review and approve one exact customer-email version in the existing content
   workflow and retain its approval ID and message digest.
4. Re-run `npm run pilot:rehearse-targets` with only those owned identifiers;
   it must pass with ZERO EFFECTS before any service switch changes.
5. Under a separate explicit effect approval, send exactly one message to the
   owned mailbox, require the signed Mailgun receipt and owned reply to reconcile
   into Conversion Inbox and Lead 360, then review the customer experience and
   correct only observed issues.

Instagram and LinkedIn follow next through the calendar-bound owned-account
proof. WhatsApp and SMS then follow one rail at a time. X stays on the later-build
list until its account and API requirements exist. Facebook/Instagram DMs remain controlled until the composed Zernio
foundation has exact production callback/account reconciliation and one approved owned-account reply proof. The final Sol Ultra master rehearsal remains the release-wide
verification gate before any external customer cohort.
