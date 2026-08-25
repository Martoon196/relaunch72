# 24 — PROPERTY PREDATOR GROWTH FOUNDATION

**Measured:** 2026-08-25 on the local Codex branch.

**Status:** the Property Predator profile, Conversion Journey domain, outbound
eligibility boundary and signed shadow source bridge are implemented as a
foundation. This is not yet a connected marketing machine or a customer-ready
journey product.

**Verification:** TypeScript type-checking and the complete ordinary test suite
pass. Exact final counts, plus the fresh disposable-Neon proof, are recorded
below under **Verification evidence**.

**External effects:** the new bridge is disabled by default and receipt-only.
No message, email, WhatsApp, SMS, Messenger reply, Instagram action, social
post, webinar action, customer contact, charge, purchase, deployment or
production-database write is performed by this slice.

## Verification evidence

The final local proof for this slice was:

- `npm run typecheck`: passed;
- ordinary non-destructive suite: **683 tests — 678 passed, 0 failed, 5 live
  database tests deliberately skipped** behind the explicit integration gate;
- fresh guarded reset/migration of the explicitly disposable
  `TEST_DATABASE_URL`: passed through migrations `0001`–`0015`; and
- explicit sequential disposable-Neon suite: **5/5 passed**, covering identity
  and CRM isolation, one-use provisioning, paid-checkout provenance, conversion
  publishing/consent/payment authority, and the receipt-only external-event
  role boundary.

These results are test-environment evidence, not a production deployment or a
claim that the missing provider integrations below already work.

## What now exists

### A profile-aware Property Predator Growth HQ

`src/portal/product-profile.ts` defines Property Predator as a product profile
on the reusable Relaunch72 engine rather than a second hard-coded application.
Selecting `PORTAL_PRODUCT_PROFILE=property_predator_growth` supplies its own
name, mark, colour tokens, sign-in story, navigation labels, journey summaries
and truthful rail-readiness copy. The existing Relaunch72 profile remains the
default.

The Property Predator profile intentionally exposes only **Today** and
**Leads** in its current navigation. The premium Growth HQ home in
`src/portal/growth-home.ts` is composed with the existing portal and CRM
boundary; in PostgreSQL portal mode it renders the canonical saved workspace
snapshot. It calculates:

- lead/prospect count;
- open opportunity count;
- open pipeline value, explicitly labelled as potential value rather than
  collected revenue;
- overdue saved tasks; and
- an attention queue of saved tasks followed by opportunities without a next
  task.

Those are CRM facts, not invented performance analytics. Empty states say when
nothing urgent is recorded. Planned content, publishing, inbox, webinar and
automation rails are visible as build context but have no action controls while
unconnected.

### Two different conversion journeys

`src/conversion-pg/property-predator-blueprints.ts` keeps the two real sales
motions separate:

| Blueprint | Milestones | Current evidence mapping |
|---|---|---|
| `property-predator-self-serve` | Lead → Activated → Priced → Sale | Account creation can establish Lead; completed product analysis can establish Activated; Sale requires collected payment. Priced is deliberately unmapped until an authoritative pricing/checkout fact exists. |
| `property-predator-agency-laps` | Lead → Appointment → Presentation → Sale | Account creation can establish Lead; Sale requires collected payment. Appointment and Presentation remain deliberately unmapped until authoritative calendar and attendance facts exist. |

This prevents the product-led **Activated/Priced** path from being mislabeled as
Daniel Priestley's literal **Lead/Appointment/Presentation/Sale** path. The two
blueprints can share infrastructure without pretending they mean the same
thing.

### Versioned, publishable conversion definitions

Migration `0014_conversion_journeys.sql` adds workspace-owned tables for score
models and versions, journey containers and versions, ordered milestones,
triggers, enrollments, consent and suppression evidence, commerce facts,
milestone facts and score snapshots. The tables use same-workspace foreign keys
and forced row-level security.

`src/conversion-pg/definition.ts` produces strict canonical definitions and
SHA-256 content digests. `src/conversion-pg/commands.ts` and `repository.ts`
publish one score-model/journey blueprint atomically. The publishing boundary:

- requires an authenticated workspace manager;
- creates immutable numbered definition versions;
- verifies the canonical digest on replay and rejects a different definition
  reusing the same version number;
- activates versions monotonically rather than reopening published content as
  a draft;
- pins each enrollment to its exact journey and score-model version; and
- requires an active journey version to contain exactly one completion
  milestone.

There is no customer-facing journey manager/editor yet. The internal
command/service and storage boundary can install audited blueprints in code and
tests; it is not yet wired to a CLI, server route, admin action or drag-and-drop
automation builder.

### Sale means verified collected money

The database makes **Sale** a protected semantic, not a label a salesperson or
browser can apply casually:

- commerce triggers accept only `payment_collected`;
- conversion commerce facts can be appended only by the webhook capability;
- a Sale milestone fact must be linked by foreign key to the same enrollment,
  contact and `payment_collected` commerce fact;
- manual milestone facts cannot use the Sale semantic; and
- a webhook cannot move an enrollment to Sale until that commerce-backed
  milestone fact exists.

The accepted Property Predator wire event `commerce.purchase.completed` is not
yet projected into these conversion facts. The rule above describes the target
authority boundary, not a claim that Property Predator purchases currently
advance a journey.

### Explicit, explainable scoring inputs

`src/conversion-pg/scoreable-sources.ts` is a positive registry: adding an event
to a wire catalogue does not make it scoreable automatically. The V1 registry
allows only account creation, completed product analysis and the authoritative
`payment_collected` commerce fact. The shipped Property Predator score rules
currently award points only for account creation and completed analysis; fit
and intent remain unallocated until evidence-backed sources exist.

Consent, permission and suppression events are not score inputs. Lead score
snapshots retain the pinned model version, component scores, explanations,
applied rules, source identity and source-payload digest so a score can be
audited instead of appearing as an unexplained AI opinion.

### Endpoint-bound consent and suppression evidence

Migration `0014` records consent and suppression as append-only events. Each
event is bound to a SHA-256 identity of the exact contact endpoint that existed
when the evidence was recorded. Runtime CRM commands can no longer silently
retarget that contact-point UUID to a different address or number.

`src/consent-pg/eligibility.ts` evaluates the current endpoint against immutable
evidence in a read-only repeatable-read transaction. An active global or
purpose-specific suppression wins over consent. With no valid evidence the
answer is unknown, not allowed. The old mutable `contact_points.consent_status`
field remains only as a compatibility hint and is deliberately not trusted for
outbound eligibility.

This is an eligibility decision service, not a sender. No channel adapter is
allowed or invoked by it.

### A strict, signed Property Predator source contract

`src/integrations/external-events/contracts.ts` defines a bounded V1 catalogue:

- account created;
- marketing consent updated;
- affiliate referral attributed;
- product analysis completed;
- purchase completed;
- purchase refunded; and
- subscription cancelled.

The parser rejects unknown fields and non-canonical identifiers, timestamps,
references, amounts and currencies. The payload cannot choose a workspace;
trusted server configuration binds each HMAC key to one workspace.

`signature.ts` authenticates the exact raw request bytes with
`HMAC-SHA256(secret, timestamp + "." + rawBody)`, a dedicated key ID, constant-
time digest comparison, a five-minute delivery window and a 32 KiB body limit.
The HTTP route is the exact POST endpoint
`/api/external-events/v1/property-predator`. It is absent by default, fails
closed when enabled with incomplete configuration, and in production requires
an encrypted socket or an exact configured proxy address before trusting
`X-Forwarded-Proto`.

### Receipt-only means receipt-only

The current boundary is intentionally:

```text
Property Predator sender (not built here)
  → strict V1 contract + raw-body HMAC
  → disabled-by-default HTTP route
  → private idempotent shadow receipt
  ╳ no CRM/contact projection
  ╳ no journey enrollment, milestone or score projection
  ╳ no consent projection or outbox event
  ╳ no message, post or webinar effect
```

Migration `0015_external_event_shadow_bridge.sql` stores authenticated events in
`app_private.external_event_shadow_receipts` for observation and replay safety.
The exact raw bytes are hashed but not retained; the already-validated canonical
event is journalled. Replaying the same event ID with the same bytes returns a
safe replay result, while reusing the ID with different bytes is a conflict.
There is no update or delete path.

Database access is split into a dedicated `r72_external_event_command` LOGIN
identity and a `r72_external_event_definer` NOLOGIN owner. Startup readiness
requires the command identity to have only private-schema usage plus execution
of the narrow SECURITY DEFINER recorder and request-context functions. It must
have no direct table privileges, no application-schema access and no unexpected
private-function execution. This is deliberately separate from the broader
webhook identity.

The bridge therefore proves authentication, schema compatibility, workspace
binding, idempotency and least privilege before any source event is allowed to
change operational state.

## What is still missing

This foundation must not be described as a GHL/Hootsuite replacement yet:

1. **No Property Predator sender exists here.** The Property Predator
   application does not yet emit these signed events to Growth HQ.
2. **No receipt projector exists.** Shadow receipts do not create or update CRM
   contacts, attribute affiliates, append consent evidence, enroll a contact,
   achieve a milestone, calculate a score or convert a purchase into a
   commerce-backed Sale.
3. **No effect-producing provider connections exist for this product slice.**
   There is no customer OAuth/token lifecycle, shared inbox, email/SMS/WhatsApp
   conversation runtime, Messenger/Instagram reply runtime, social publisher,
   social listening runtime, webinar runtime or connected automation runner.
4. **No customer-facing Journey Manager exists.** Publishing is currently an
   internal command/service boundary exercised in code and tests; users cannot
   build, simulate, approve, pause or inspect journey executions in the portal.
5. **No autonomous reply system exists.** Consent eligibility and auditable
   scoring are safety prerequisites, not permission to contact anybody.
6. **No production activation has occurred.** The bridge remains disabled by
   default and this work authorises no deployment or provider effect.

## Product boundary

Property Predator is the first reusable vertical profile on the Relaunch72
engine. The shared pieces—CRM snapshot, capabilities, Conversion Journeys,
permission evidence and source-ingress pattern—are designed to support future
profiles without collapsing their domain language.

**Ordris remains parked.** Asset management stays in Ordris and any connection
or port belongs after acquisition/conversion, not inside this foundation. No
Ordris integration or data movement is implemented or implied here.
