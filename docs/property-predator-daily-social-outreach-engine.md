# Property Predator Daily Social Outreach Engine

**Decision date:** 2 September 2026

**Status:** approved product direction; implementation follows the current Zernio calendar/inbox launch candidate

**Source concept:** founder discussion prompted by Daniel Priestley's practice of treating a fixed daily number of relevant outreaches as a non-negotiable operating input.

## The operating idea

Growth HQ should make disciplined outreach a visible daily system instead of an
occasional burst of messages.

The system gives each operator a configurable daily target, builds the next-best
prospect queue, prepares a relevant first-touch brief, records the real action,
captures every response, and moves genuine engagement into Conversion Inbox,
Lead 360 and the appropriate LAPS journey.

The quota measures completed, evidence-backed outreach attempts. It is not a
licence for indiscriminate bulk messaging, and it does not replace platform or
recipient permission rules.

## What Growth HQ automates

1. Selects eligible prospects from approved, traceable sources without scraping
   a social network.
2. Prioritises them by audience fit, current campaign, relationship context,
   recency, previous outcomes and operator capacity.
3. Creates a daily operator queue with a configurable target per channel and
   segment.
4. Produces a short research brief and a Property Predator first-touch draft
   from the Brand Brain, approved offer/message versions and the target LAPS
   action.
5. Classifies each item as `manual_first_touch`, `zernio_reply_eligible`,
   `comment_to_dm_eligible`, `other_channel_review` or `blocked`.
6. Prevents duplicates, too-soon retries, conflicting ownership, suppressed
   people, missing source evidence and attempts above the configured operating
   or provider cap.
7. Records the actual attempt, operator, exact immutable draft/version, channel,
   source, timestamp and outcome.
8. Ingests supported DMs, comments, mentions and replies through Zernio into the
   Conversion Inbox.
9. Creates the next action automatically: reply review, admin call, follow-up,
   nurture, close, suppress or re-qualify.
10. Promotes a person into LAPS only from real evidence. A cold attempt is an
    activity; a genuine identified response or captured account/contact can
    become a Lead.

The intended operator experience is highly automated: the machine finds the
next eligible opportunity, reads the permitted context, chooses an approved
message family, bends only its controlled fields, prepares the action and
records the result. A human approval remains a fast final boundary for cold or
third-party engagement unless the exact platform/provider capability expressly
permits the automated action and a later policy approves that class.

## Prospect-source adapters

The engine does not depend on one social provider. It consumes candidates from
versioned, replaceable source adapters:

1. people who comment, mention, follow up or DM the owned Property Predator
   accounts through Zernio;
2. a founder-approved creator/business watchlist with exact profile or post
   identifiers;
3. the existing CRM, affiliates, referrals, events and imported legacy leads;
4. first-party landing pages, lead forms, webinars and product engagement;
5. permissioned business directories, CSV/API imports and a later approved B2B
   data provider; and
6. manually added targets with a recorded source and research note.

AI can rank and research the records those adapters legitimately supply. It does
not create a lawful data source by crawling a platform that withholds one.

## Controlled message families

Cold and early-stage messages should be stored as immutable, approved families,
not a single repeated script and not unrestricted AI prose. Each family defines:

- intended audience, LAPS/CVJ stage and purpose;
- one core proposition and next action;
- allowed context fields, such as a real post topic, role, company or observed
  problem;
- optional hook/question modules and bounded tone variants;
- claims/proof that may be used and phrases that may never be invented;
- channel length and formatting limits;
- cooling-off, follow-up and stopping rules; and
- approval sampling rules and performance evidence.

The AI selects and adapts within that envelope. The stored version/hash proves
what it actually proposed or sent.

## Creator Watch and Authority Commenter

The outreach cockpit includes a founder-approved watchlist for relevant creators
and businesses. Initial examples supplied by the founder are **Rob Moore** and
**Samuel Leeds**; exact platform identities must be confirmed before a watcher
is activated.

For each new supported post, the engine should:

1. ingest the post only through an official provider/API event or an
   operator-supplied URL/identifier;
2. decide whether Property Predator has something useful to add, including the
   valid option `no_comment`;
3. ground the draft in a concrete point from the actual post;
4. choose one purpose: add useful evidence, extend the idea, ask a sharp
   question, offer a relevant counterpoint or open a genuine conversation;
5. reject generic praise, copied phrasing, fake personal experience, invented
   familiarity and immediate sales pitches;
6. create a short Property Predator-voiced version for review;
7. enforce per-creator and per-channel frequency/cooldown limits; and
8. post only through an officially supported account/action, then retain the
   provider receipt and ingest any response into Conversion Inbox.

The target is **human-quality relevance**, not concealing that software assisted
the operator. Phase one is watch → draft → one-tap approve/post. Autonomous
commenting on third-party posts remains unavailable unless the exact official
capability, account permission and operating policy are all proven. Replies on
owned posts can use the existing approval-gated Zernio path.

## Channel execution rules

### LinkedIn

- Growth HQ may prepare and assign a personalised first-touch task.
- The operator performs any cold connection request or personal DM in LinkedIn.
- Growth HQ must not scrape LinkedIn or drive the website through an unofficial
  bot. LinkedIn's current User Agreement expressly prohibits unauthorised bots
  that send messages, comment or otherwise automate engagement.
- Zernio may ingest and reply to supported comments on the connected Property
  Predator organisation account through the official provider surface.
- A recorded manual first touch can still start the cadence clock and attribution
  trail; automation resumes when an official supported inbound/reply context
  exists.

### Instagram

- Zernio ingests supported inbound DMs and comments and carries approved replies.
- A person-initiated comment, keyword or story reply may enter a separately
  approved comment-to-DM automation when the connected-account capability and
  current platform window allow it.
- A cold profile selected by an operator remains a manual-first-touch task unless
  the official provider capability returns an exact eligible route.
- The system never treats a public profile or public contact detail as consent.

### Email, telephone, WhatsApp and later channels

An operator may choose another channel only after the existing permission,
suppression, identity, policy and provider gates return an eligible decision for
that exact person, purpose and message class. The outreach cockpit does not
weaken those rails.

## Daily cockpit

The operator view should answer five questions immediately:

1. **What is my target today?** Completed / target, split by channel and segment.
2. **Who is next?** One prioritised card with reason, source and suggested action.
3. **Can the system act?** Clear badge for manual, Zernio-eligible or blocked.
4. **What happened?** Attempted, replied, positive, referred, booked, declined,
   no response, invalid target or suppressed.
5. **What happens next?** Due time, owner, draft, approval and journey consequence.

Manager reporting separates controllable inputs from outcomes:

- prospects reviewed;
- valid outreach attempts;
- response rate and positive-response rate;
- conversations created;
- LAPS Leads and Appointments created;
- calls/tasks completed;
- time-to-first-response and time-to-human-handoff;
- duplicates, blocks, suppressions and account/provider failures;
- results by operator, audience, campaign, source, angle and channel.

## Core records

Reuse the existing contacts, source identities, attribution facts, activities,
tasks, conversations, messages, immutable content versions, approvals, provider
operations and journey evidence. Add only the missing outreach control records:

- versioned outreach programmes and daily-target rules;
- prospect memberships with source/provenance and audience-fit evidence;
- immutable cadence versions and steps;
- daily queue allocations and ownership leases;
- outreach-attempt receipts, including manual evidence;
- cooldown/no-response state and explicit stopping reasons;
- channel eligibility decisions with an expiry;
- outcome-to-task and outcome-to-LAPS projection receipts.

Raw scraped profile dumps, browser cookies, social passwords and unbounded free
text are not part of this model.

## First implementation slice

1. Add the outreach records and fail-closed database commands.
2. Ship a branded **Daily Outreach** route using fictional/test prospects.
3. Let the founder configure a daily target instead of hard-coding somebody
   else's number.
4. Generate an operator queue and three-way eligibility decision: manual,
   Zernio-supported or blocked.
5. Support manual-attempt completion with immutable draft/version evidence.
6. Reconcile Zernio inbound comments/DM replies into the same outreach thread.
7. Create the next task and LAPS evidence idempotently.
8. Add manager input/outcome reporting and stop-condition visibility.
9. Add the Creator Watch/Authority Commenter with a test watchlist, supported
   post-ingestion seam, relevance/no-comment decision and one-tap approval.
10. Attack-test duplicate attempts, stale eligibility, cross-workspace access,
   suppression, quota races and provider ambiguity on the disposable database.
11. Keep live cold-audience effects off until a solicitor-approved route and an
    exact owned-account acceptance proof exist.

## Acceptance gate

With test data, an operator can open the Daily Outreach cockpit, see a target and
prioritised queue, complete a permitted manual attempt, receive a simulated or
owned-account Zernio response, see the conversation in Conversion Inbox and Lead
360, and get the correct next task/LAPS update. A duplicate, suppressed, stale,
cross-workspace or unsupported automated attempt must fail closed with a useful
reason.

## Current external constraints

- LinkedIn User Agreement and automation guidance:
  <https://www.linkedin.com/legal/user-agreement> and
  <https://www.linkedin.com/help/linkedin/answer/a1340567>
- ICO business-to-business/direct-message guidance:
  <https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/>
- Zernio inbox and platform capability matrix:
  <https://docs.zernio.com/platforms>
- Zernio comment-to-DM automation:
  <https://docs.zernio.com/comment-automations/create-comment-automation>

These sources constrain execution mechanics; they do not replace solicitor
review of the exact Property Predator audience, wording, purpose and lawful route.
