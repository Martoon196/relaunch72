# 24 — PROPERTY PREDATOR GROWTH HQ FOUNDATION

**Measured:** 2026-08-25 on `codex/relaunch72-platform-foundation`.

**Status:** Property Predator now has a branded, usable Growth HQ slice on the
shared Relaunch72 platform: two distinct conversion journeys, a deduplicated
attention list, evidence-backed engagement reporting, Lead 360 and a secure
disposable-Neon-tested projection boundary. It is still deliberately
effect-free: no provider is connected and nothing can contact a lead.

The automatic enrolment, milestone, scoring, consent and commerce runtime that
now follows this foundation is documented in
`25-PROPERTY-PREDATOR-JOURNEY-RUNTIME.md`.

## What now exists

### Property Predator product experience

The `property_predator_growth` product profile uses the owned Property Predator
identity rather than generic SaaS styling: the PP mark and wordmark, dark ink
palette, warm metallic accents, editorial display type and sharper conversion
language. The ordinary Relaunch72 profile remains the default and reusable
platform behaviour is not hard-coded to one brand.

The Growth HQ home shows saved CRM and engagement facts rather than invented
analytics. It includes:

- lead/prospect count, open opportunities, potential pipeline value and overdue
  tasks;
- separate self-serve **Lead → Activated → Priced → Sale** and agency
  **Lead → Appointment → Presentation → Sale** funnels;
- distinct people at each funnel stage, while explicitly allowing a person to
  participate in both routes;
- one deduplicated row per person in the hot-lead list;
- exact content, offer, reply and commerce evidence totals; and
- a next-move recommendation that checks suppression and channel permission
  before any outreach is suggested.

Empty and unconnected states are truthful. Email, WhatsApp, social, webinar,
listening and automation rails have no fake success state or live action while
their providers are absent.

### Lead 360

`/portal/crm/contacts/:contact-id` now opens a focused Lead 360 record. It brings
together, for one saved contact:

- contact details, CRM state, opportunities and tasks;
- content progress and completion evidence;
- offer presentation and response history;
- recorded consent and suppression evidence;
- an auditable next-move recommendation; and
- bounded query results so a very active contact cannot make the page grow
  without limit.

The permission decision is evaluated before the outreach recommendation. The
page says evidence was **recorded**; it does not upgrade ordinary observations
into falsely “verified” claims.

### Exact growth-evidence storage

Migration `0016_property_predator_growth_evidence.sql` adds workspace-isolated,
forced-RLS records for source identities, content consumption, offer
presentations/responses, attribution and private projection receipts. Evidence
keeps exact provenance and the human-readable offer label used at the time.

The Growth evidence projector owns bounded versions of:

- `content.consumption.progressed`;
- `content.consumption.completed`;
- `offer.presented`; and
- `offer.responded`.

Unknown fields and malformed identifiers, timestamps, amounts or source facts
remain rejected.

### Secure source projector

Migration `0017_property_predator_growth_projector.sql` and the PostgreSQL
projector add the narrow bridge from an authenticated shadow receipt to CRM and
growth evidence.

The webhook-facing database role cannot read or write the growth tables. It can
only request projection by event ID. A `SECURITY DEFINER` function reopens the
canonical stored event, revalidates its event type and derives the operational
facts server-side. The caller cannot supply a different contact, workspace,
offer, content item or response during projection.

Identity events resolve or create a contact from a normal active email endpoint
and refuse quarantined/shared-address shortcuts. Dependent events require an
existing source identity. Offer responses resolve their saved presentation.
Projection receipts make retries idempotent.

This projector is now composed behind the signed route with the separate
journey projector. Each stage owns an independent receipt, so an exact retry can
finish a partially interrupted projection without duplicating completed facts.
The complete runtime boundary is described in handoff 25.

## Verification evidence

The completed local proof for this slice is:

- TypeScript type-check: passed;
- complete ordinary non-destructive suite: **723 tests — 717 passed, 0 failed,
  6 explicitly guarded live-database tests skipped**;
- guarded reset of the explicitly disposable `TEST_DATABASE_URL`: passed;
- all forward migrations through `0017`: passed;
- explicit sequential disposable-Neon integration suite: **6/6 passed**;
- the real PostgreSQL Growth HQ read-model query, including RLS context, ran
  successfully against disposable Neon; and
- desktop and mobile browser acceptance: no horizontal overflow, broken
  images or browser-console errors on Growth HQ or Lead 360.

These are local and disposable-test-environment results. They are not a
production deployment or evidence that an external provider has been
connected.

Those figures are the verified baseline for the Growth foundation through
`0017`; they must not be presented as the final test count for the later `0018`
runtime. Handoff 25 defines the additional verification boundary.

## What is deliberately still missing

1. **Property Predator event sender.** The source application does not yet emit
   these signed events to Growth HQ.
2. **Journey Manager and setup UX.** The exact v2 definitions and automatic
   runtime exist, but manager-facing installation and editing screens do not.
3. **Workflow execution.** Durable outbox intent exists, but no workflow or
   provider consumer acts on it.
4. **Provider connections.** No email, WhatsApp, SMS, shared inbox, social
   publishing/listening or webinar account is connected.
5. **Autonomous replies.** Recommendations are visible, but no AI or workflow
   can send on its own.
6. **Production activation.** Nothing has been deployed and no production
   database has been read or written.

## Provider decision and product boundary

The provider discovery is not being restarted. The existing costed shortlist
and integration sequence in `17-WHITE-LABEL-PROVIDER-MATRIX.md` and
`18-LAUNCH-COST-MODEL.md` remain the working decisions. Providers stay behind
capability adapters so the Growth HQ domain does not become coupled to one
vendor.

Property Predator is the first vertical profile on the shared engine. The CRM,
evidence, permission, journey and integration boundaries are reusable for later
products. **Ordris remains parked**; its asset-management capability can be
connected after the acquisition and conversion machine is established.
