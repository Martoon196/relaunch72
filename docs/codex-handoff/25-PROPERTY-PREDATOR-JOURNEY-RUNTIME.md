# 25 — PROPERTY PREDATOR JOURNEY RUNTIME

**Measured:** 2026-08-25 on `codex/relaunch72-platform-foundation`.

**Status:** The Property Predator bridge is now a conversion runtime, not only
an evidence journal. An accepted first-party event can automatically enrol the
right journey, advance immutable milestones, produce an explainable score,
record consent or commerce evidence, and append matching outbox facts. It still
cannot send a message, publish content, contact a lead or call a provider.

## Exact v2 conversion topology

The workspace installer publishes the v2 blueprints below. Runtime readiness
requires their v2 slugs, milestone/trigger topology and one immutable score hash
pinned by both journeys.

| Route | Automatic milestones | Authoritative trigger |
|---|---|---|
| Self-serve | Lead | `identity.account.created` |
| Self-serve | Activated | `product.analysis.completed` |
| Self-serve | Priced | `offer.presented` |
| Self-serve | Sale | collected payment from `commerce.purchase.completed` |
| Agency LAPS | Lead + Appointment | first `sales.appointment.booked` |
| Agency LAPS | Presentation | `sales.presentation.completed` |
| Agency LAPS | Sale | collected payment from `commerce.purchase.completed` |

Account creation starts only the self-serve route. Self-serve can also begin at
the first later authoritative trigger it receives—Analysis creates an enrolment
at Activated and Offer creates one at Priced—without inventing missing earlier
milestone facts. An authoritative appointment starts the agency route and
establishes Lead and Appointment together from the same source event; this
avoids putting every account into both funnels. Presentation is accepted only
when the same agency enrolment already holds an Appointment fact with the same
appointment reference and the presentation does not predate it. Commerce never
creates an enrolment. A purchase can complete one existing route: the runtime
prefers an active agency enrolment that has reached Appointment or Presentation,
otherwise it uses an active self-serve enrolment.

Milestone facts are append-only and the enrolment's current milestone moves
forwards only. Sale remains payment-backed: it cannot be completed from an
ordinary event or manual label. A refund is attached to the same enrolment as
the original payment by contact, product and Checkout session. A subscription
cancellation is attached to the original subscription payment using its stored
subscription ID. Neither may predate its payment; cumulative refunds cannot
exceed the original collected amount. Neither refund nor cancellation rewinds a
conversion milestone or silently creates another enrolment. A later trigger
cannot reopen or silently replace a completed, withdrawn or disqualified route.
That route receives no new enrolment, milestone or score; the event is wholly
zero-output only when no other route is active. Its contact-scoped evidence may
still refresh the score of another active route.

One person may legitimately have both routes. Lead 360 and Growth HQ preserve
that distinction rather than flattening the person into one ambiguous funnel.
Lead 360 keeps every rail visible and chooses one explicitly labelled primary
route for the headline score and next move: highest-scoring active route, then
latest active evidence and stable route order; when none is active, the most
recent terminal route is primary.

## Exact v2 scoring

Scoring is evidence-led and version-pinned. Each rule can contribute at most
once per enrolment, no matter how many matching source events exist:

| Component | Evidence | Points |
|---|---|---:|
| Engagement | account created | 5 |
| Engagement | analysis completed | 15 |
| Engagement | content asset completed | 15 |
| Intent | offer presented | 10 |
| Intent | appointment booked | 10 |
| Intent | presentation completed | 10 |
| Intent | collected payment | 5 |

The component ceilings are Fit 30, Engagement 35 and Intent 35. Fit deliberately
has no rule yet because no reviewed authoritative fit source exists; it therefore
contributes zero rather than invented points. Bands are Quiet 0–21, Warm 22–44,
Hot 45–69 and Burning 70–100. Consent, suppression and channel permission stay
outside the score: a high score never becomes permission to contact somebody.

The database derives these values from the validated immutable score-model JSON;
the projector does not hide a second hard-coded points table.

Event evidence is contact-scoped and cumulative across active routes. When a
later event starts Agency LAPS, its first score can include earlier canonical
subject events, by source occurrence time, that already passed journey
projection; those facts are not discarded just because the agency enrolment is
newer. Collected-payment evidence is deliberately limited to the one route
receiving the payment. Every score
snapshot keeps the source event, source hash, component breakdown, reasons,
effective time and evaluated time. Scores for the same person can therefore
differ between routes without being flattened into one opaque contact-level
number.

Delivery order cannot regress the displayed score. When an older source event
arrives after newer evidence, the projector evaluates a fresh snapshot through
the enrollment's current source-time watermark and stamps it at that watermark.
The late event remains the immutable causation, but the newest evaluated
snapshot still contains every applicable rule already known through the latest
source time.

## Runtime and replay architecture

The composed ingress path is:

1. The signed Property Predator route validates the bounded v1 wire envelope.
2. `r72_external_event_command` records the canonical payload and SHA-256 in
   the private shadow ledger. It has no CRM, conversion or growth-table access.
3. The existing Growth projector derives contact, source identity, content,
   offer and attribution evidence for the event types it owns.
4. `r72_webhook` calls the journey projector with the immutable event ID only.
5. A separate `SECURITY DEFINER` role reopens and revalidates the stored payload,
   resolves its workspace and source identity, checks the active v2 route
   topology and pinned score definition, and derives enrolment, milestone,
   score, consent and commerce facts inside one database transaction.
6. Matching pending outbox facts are appended in that same transaction for
   enrolment started, milestone achieved, score updated, consent recorded and
   commerce fact recorded.

Growth and journey projection use separate private receipts because one source
event can legitimately feed both. Each receipt is an idempotency fence with the
canonical payload hash and bounded result counts. If a process stops after the
shadow receipt or one projector, an exact signed retry catches up the missing
stage. It does not duplicate completed facts. The HTTP result is `projected`;
`replayed` is true only when every applicable stage had already completed.
Runtime health follows the latest projection result rather than freezing green
at boot. A failure marks health degraded, while the mounted signed endpoint
remains callable for the exact repair retry; a later successful projection
restores ready state. There is not yet an autonomous receipt-draining worker.

Every dependent event must resolve the source identity already derived by the
Growth projector. The journey definer will not guess a contact from an email or
silently create a second identity when that prerequisite is missing.

All 13 reviewed Property Predator event types pass through the journey boundary:

- identity and consent;
- affiliate attribution and analysis;
- content progress and completion;
- offer presentation and response;
- appointment and presentation;
- purchase, refund and subscription cancellation.

When an accepted catalog event has no applicable journey output—for example
content progress or an offer response—it still receives a zero-output journey
receipt, so retry behaviour remains explicit and deterministic. A commerce event
that lacks its required existing enrolment or original payment instead fails
closed; it is not acknowledged as a successful no-op.

Consent projection binds the event to the saved contact endpoint and preserves
purpose, state, source and optional policy evidence. The existing endpoint digest
trigger captures the exact endpoint identity at the time of the fact. Consent
does not enrol a journey or change a score.

## Definition installation

`installPropertyPredatorConversionBlueprints(...)` publishes self-serve first
and Agency LAPS second through the existing manager-authorised
`ConversionCommandService.publishBlueprint(...)` boundary. It does not bypass
workspace membership, publication immutability or manager permission.

Publication is intentionally two transactions. If it is interrupted after the
first definition, that first definition remains valid and an exact rerun safely
finishes the pair. Journey projection stays closed until both exact active v2
routes and their shared score-model version are installed. This helper is an
explicit workspace setup action; the public event route does not create or edit
definitions.

## Database security boundary

Migration `0018_property_predator_journey_runtime.sql` adds the NOLOGIN,
NOINHERIT `r72_journey_projector_definer` role and its private projection
receipt. It also removes the temporary direct conversion-table capabilities
previously granted to `r72_webhook`. The webhook login remains table-blind and
this migration grants it only Journey readiness and the reviewed event-ID
Journey projector—not the internal outbox helper, receipt recorder or any table.
The separately reviewed Growth projector remains the other Property Predator
projection capability used by the composed bridge.

The definer has an explicit table, column and RLS capability map. It cannot
accept a workspace, contact, score, milestone, consent endpoint or amount from
the caller. The canonical accepted shadow payload is the only source of those
values. Runtime readiness proves the function owner, fixed search path, execute
grant and webhook table blindness; the projector independently refuses to run
unless the workspace has the exact v2 topology.

## Verification and honest boundaries

The completed working tree passed TypeScript checking and the ordinary suite:
756 tests discovered, 749 passed and 7 guarded database tests skipped exactly
as designed. The explicitly disposable `TEST_DATABASE_URL` was then reset from
zero and the serial live suite passed 7/7 after replaying all 18 migrations.
The journey proof finished with two completed enrollments, 8 milestone facts,
12 score snapshots, 13 journey receipts and 28 matching outbox facts, including
the t2-then-late-t1 score-watermark case. Browser acceptance confirmed Growth
HQ and Amelia Hart's Lead 360, two journey rails, exactly one labelled primary
route, no broken images and no horizontal overflow at the tested desktop
viewport. Ordinary tests do not silently connect to Neon.

This work proves database derivation and user-interface read models. It does
**not** prove a production Property Predator sender, live provider delivery,
workflow execution, inbox handling, social publishing/listening, webinar
delivery or production deployment.

## Honest remaining work

1. Make Property Predator emit the signed v1 events and operate key rotation,
   time-skew, dead-letter and replay procedures. Add an autonomous guarded
   receipt-draining/reconciliation worker so repair does not depend only on the
   sender's exact retry.
2. Add the manager-facing Journey Manager and workspace setup flow that invokes
   the blueprint installer and shows readiness without database access.
3. Build the workflow/outbox consumers, approval gates and stop conditions.
   Pending outbox rows are durable intent, not proof that anything was sent.
4. Add provider adapters for shared inbox/email, WhatsApp/SMS, social
   publishing and listening, and webinars. No provider account is connected.
5. Add an authoritative Fit signal before assigning any of the reserved 30
   points; do not infer fit from engagement.
6. Add operational reconciliation, alerting, retention, restore and production
   rollout evidence before customer traffic is enabled.
7. Keep Ordris parked. These conversion, evidence and permission boundaries are
   reusable later without coupling Property Predator to Ordris asset management.
