# 27 — PROPERTY PREDATOR LIVE JOURNEY BOARD AND CONTENT REUSE

**Measured:** 2026-08-25 on `codex/relaunch72-platform-foundation`.

**Status:** Growth HQ now has an operational people board at
`/portal/journeys/board`, backed by the durable PostgreSQL CRM and conversion
read models. The existing Affiliate Stash content machine is explicitly marked
for reuse and linked from Today. No production deployment, customer read,
message, post, payment, provider connection or purchase occurred.

## What shipped

The Journeys navigation now opens **Live journeys**. The existing definition
screen remains available as **Journey rules**. These are intentionally separate:

- **Live board** is the operator's CRM workflow. Saved opportunities appear in
  the default pipeline's lanes and can be moved by an authorised workspace
  member.
- **Journey rules** show the immutable route definitions and exact event or
  commerce evidence that can advance them.
- **Lead 360** remains the evidence case file. Selecting a person on the board
  opens it in an accessible same-origin drawer, with the ordinary full-page
  link as the no-JavaScript fallback.

Each card shows the saved person and company, score and published band, source
and typed affiliate attribution, primary route and milestone with honest
`AUTO` or `RECORDED` provenance, latest recorded signal, offer state, next
saved task or evidence-led recommendation, and other recent Property Predator
routes. Unscored and not-yet-enrolled CRM people remain visible; the read model
does not hide them or invent evidence.

The layout is a dense horizontal board on desktop, a single selected lane on
mobile, and a normal server-rendered list without JavaScript. It includes
shareable search, journey and score-band filters, 44-pixel controls, dedicated
drag handles, pointer and keyboard movement, reduced-motion handling and forced
colour support.

## The critical truth boundary

Dragging a card changes **only** `app.opportunities.stage_id` through the
existing `moveOpportunityStage` command. The command retains:

- session-bound CSRF verification;
- a server-created idempotency key;
- optimistic row-version checking;
- workspace membership and write-role checks;
- default-pipeline validation; and
- the existing append-only CRM activity trail.

A drag does not create a consumption fact, enrol a contact, advance a journey,
alter a lead score, verify payment, send a message or publish a post. Only
reviewed event or commerce provenance is labelled `AUTO`; a user-recorded fact
is labelled `RECORDED`. The board displays a Sale evidence badge only when the
sale milestone joins to the exact canonical `payment_collected` commerce fact.
Semantic wording or a human move to Won can never produce that badge.

This avoids the common CRM error where a salesperson dragging an opportunity
to “Won” silently becomes proof that the customer paid. Growth HQ keeps the
human workflow and the customer evidence visible together without merging
their truth.

## PostgreSQL read boundary

`JourneyBoardReadService` loads one repeatable-read, read-only, RLS-scoped
snapshot. It reads the selected workspace, default pipeline and stages, saved
opportunities and contacts, the deterministic primary Property Predator
enrolment, current milestone, latest score and reasons, latest evidence,
content and offer summaries, next open task and typed canonical or imported
attribution.

The boundary is limited to 100 stages and 75 loaded cards per lane. It returns
the saved total for every lane, validates every identifier, enum, timestamp,
score, progress value and workspace relationship, and rejects duplicate cards.
If a lane exceeds the bound, the UI persistently says how many cards are loaded
and that filters search only that loaded subset; zero loaded matches are never
presented as proof that no saved match exists. It never selects private raw
legacy attribution payloads or provider envelopes.

The disposable Neon integration creates an imported Property Predator lead
with legacy affiliate evidence and lets the import boundary materialise its
board card automatically. It then executes the production board query as the
ordinary `r72_web` owner and viewer roles, proves cross-workspace isolation,
moves the card through the real `r72_crm_command` boundary and rereads the
incremented row version through `r72_web`. The pre-enrolment person remains
visible and their affiliate code, referral code and source record survive
without exposing the private raw object.

## Existing leads reach the board

Forward-only migration `0020` closes the cutover gap between preserving a
legacy contact and making that person operational. It backfills already
imported contacts and, during future commits, adopts an existing opportunity in
the active default pipeline or creates exactly one zero-value opportunity in
its first open stage. New cards use the workspace's saved currency.

The operation is contact-idempotent and source-provenance-bound. A replay cannot
create a duplicate. If the workspace has no valid default pipeline or open
stage, it records a durable blocked outcome instead of inventing topology. The
import role can call only a manager-validated security-definer function; it has
no direct opportunity or materialisation-table access. No message, outbox,
activity, stage-history or provider side effect is emitted.

## Safe interactive preview

The local preview contains seven named test people distributed across New
signal, Qualified, Proposal and Won. It is explicit fixture data only. The
board's real forms move those in-memory test opportunities and retain row
versions. A clearly amber **Preview fixtures only** control can record one of
four test signals: completed briefing, booked appointment, offer/presentation
or collected test payment.

That control demonstrates the runtime boundary rather than bypassing it. For
example, moving Priya from New signal to Proposal changes only her team lane;
recording the separate test appointment automatically enrols her into Agency
LAPS, advances the automatic route to Appointment, recalculates the score and
updates Lead 360. Earlier preview milestones say `Time not recorded` unless the
fixture contains an exact timestamp. No real database, person or channel is
involved.

## Affiliate Stash: reuse, do not rebuild

A read-only audit found the existing machine in the Property Predator source
repository. Its user-facing route is
`https://propertypredator.com/affiliate`; its dashboard is
`frontend/affiliate.html`, and its current APIs are:

- `GET /api/affiliate/media` for prewritten swipe copy;
- `GET /api/affiliate/assets` for graphics metadata;
- `GET /api/affiliate/assets/{id}/file` for artwork; and
- `POST /api/affiliate/generate` for brand-trained generation.

The brand prompt loader is `backend/services/brand.py`; the current text sources
are `backend/data/brand_bible.md` and `backend/data/production_kit.md`. Growth
HQ's Today rail now says **Affiliate Stash content machine — Reuse existing**
and links to the existing dashboard. No second content generator was added.

It is not yet honest to call the systems integrated. The current generation
endpoint is affiliate-mode only: it requires an affiliate session, injects that
affiliate's referral link and adds the required `#ad` disclosure. Calling it
for company-owned publishing would impersonate an affiliate. The eventual
integration needs a narrow server-side adapter and explicit company-owned mode,
not copied prompts, API keys, database access or browser tokens.

Before automatic publishing, the source catalog also needs an approval state,
brand version, update time and stable content hash. Generated output needs
persistence and human review. The audited source contains conflicting font,
logo and panther-image instructions; some seed copy contains invented
first-person outcomes; and a separate image-pack folder contains legacy logos,
fabricated figures and unapproved slogans. Growth HQ must consume only items
approved in the live Affiliate Stash and must not bulk-import those folders.

## Verification

- Journey Board, adapter, router, import and materialisation focused tests:
  **56/56 passed**.
- Affiliate Stash reuse/profile focused tests: **9/9 passed**.
- Guarded disposable Neon reset and all migrations `0001`–`0020`: passed.
- Explicit disposable-Neon integration suite, including real runtime roles,
  legacy-board materialisation, affiliate preservation and read–move–reread:
  **9/9 passed**.
- TypeScript checking: passed.
- Full ordinary suite: **838 total — 829 passed, 9 explicitly gated
  live-database tests skipped, 0 failed**.
- Browser acceptance: board rendered; protected workflow move succeeded;
  automatic test appointment enrolled and advanced the selected person; Lead
  360 drawer loaded; mobile lane controls, filter retention and keyboard-contained
  drawer behaviour were rechecked in an isolated preview.

## Honest next boundaries

1. Add the Affiliate Stash metadata adapter only after a scoped service-token or
   SSO boundary and an explicit company-owned generation mode exist.
2. Add approval/version/hash metadata to its content catalog and reconcile the
   brand-source conflicts before any automatic publisher can consume it.
3. Connect authoritative live source exports only under the separate production
   data and cutover approval documented in handoff 26.
4. Continue with the shared inbox, outbound approval recipes, webinar event
   adapter and social provider adapter without allowing provider actions to
   become conversion evidence until their canonical receipts are verified.
