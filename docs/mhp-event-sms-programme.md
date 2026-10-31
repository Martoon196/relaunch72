# MHP webinar texts (009B source build)

Status: **source-complete candidate, not ratified, not integrated, not live.**
Built on `cd8aa8f47b21ebe88b329de4bcc2814f1faf74e1` without access to the ratified
`009B-SQL-DESIGN.md` (SHA `30486ff7…cbc7c`). Every place this build had to decide
something that document may decide differently is listed under *Assumptions*.
Astra must reconcile this against the ratified design before integration.

## What it does

1. **Public opt-in (registrant).** `https://app.martinhowardproperty.co.uk/webinar/texts`
   asks for the email they registered with, a UK mobile, and a separate, unticked
   consent box with its own versioned wording (`mhp.event-sms/v1`). If the email
   has a webinar signup for the configured campaign, the SMS worker texts a
   six-digit code to that mobile. Entering the code proves possession. Nothing is
   written to the CRM at this stage. Every request is stored and answered the
   same way: an unknown, unsubscribed or clashing request becomes a never-texted
   "decoy" row, so repeats, wrong-code answers and rate limits look identical.
   One signal cannot be removed: someone who enters their own mobile learns an
   email is registered when a code arrives. Decoys are deleted after 24 hours and
   every other unverified row after 30 days (never one claimed in the current
   month), in small batches on later public requests. If the page goes unused,
   rows wait until it is next used or the prospect is erased.
2. **Owner review = send (founder).** `/hq/marketing/event-texts` shows the exact
   current batch: every verified opt-in for the campaign, each with a status
   (ready, needs import, phone shared, opted out, already sent this text, and so
   on), the chosen saved SMS text, the segment cost and the remaining daily and
   monthly allowance. The owner ticks one agreement and sends. That single owner
   action, in the owner's live session:
   - captures the ready set once, under the rail's own per-connection lock, and
     refuses unless that exact set hashes to what the owner reviewed (anyone who
     verified since waits for the next review); the loop sends to that captured
     set and nothing else;
   - materialises each recipient's verified phone point and their own consent
     event (recorded as `actor_kind=system`, source `mhp.event-sms.public-optin`,
     occurred at their verification time, never as the owner's consent);
   - creates each exact message, approval request and owner approval decision,
     the per-recipient compliance chain and a 4-minute authority, exactly as the
     ratified R11 owner send does;
   - enqueues through the unchanged `authorize_and_enqueue_sms_live_job`.
   The existing live worker then delivers with all of its existing re-checks.
3. **Verification codes (worker).** The existing SMS worker, in its live mode,
   optionally sends pending opt-in codes behind `MHP_EVENT_SMS_CODES_ENABLED=true`,
   still subject to its provider-effect and emergency-pause switches, and only
   when no owner text is queued. Codes count inside the same 10-a-day and
   50-a-month allowance as every other text on the number but are limited to a
   reserved 3 a day and 15 a month, so the owner always keeps at least 7 a day
   and 35 a month; 3 per phone and per person a day. A code is never sent to a
   number with a STOP on any contact point, including deleted or quarantined
   ones, and only with at least 5 minutes of its 15-minute life left. The worker
   refuses to start codes without `MHP_EVENT_SMS_TWILIO_ADVANCED_OPT_OUT_CONFIRMED=true`
   and a poll interval of 15000 ms or less.

## The delayed-worker finding (needs Astra)

The recorded 009B summary says a *delayed worker derives truthful fresh event
authority*. On the unchanged rail this cannot be done truthfully:

- every enqueue needs a compliance permission-use receipt whose
  `decision_expires_at <= evaluated_at + 5 minutes` (0032 CHECK);
- `begin_sms_live_call` requires that receipt's `recorded_by_user_id` and
  `recorded_request_id` to equal the authority's operator, an active owner/admin.

So any send needs an owner decision recorded within minutes of the enqueue. A
worker could only meet that by writing a fresh decision in the owner's name while
the owner is absent, which 009B forbids. This build therefore makes the owner's
one exact-batch review the send. Scheduling a reviewed batch for later needs a
rail change (a worker-operator authority kind, or a longer-lived owner permission
type) and is left for Astra's decision. No such change is made here.

## Hard limits that remain

- 10 segments per UTC day and 50 per month on the MHP connection, codes
  included. A batch that does not fit the remaining allowance is refused, not
  split. With 3 codes a day, at most three new people can confirm a mobile each
  day. These are the founder's caps; raising them is a founder decision.
- The ratified 0130 owner self-test enqueues through the unchanged 0056 check,
  which counts jobs only, so on a day with codes it could exceed 10 by at most 3.
  That owner test has already been used and needs its own new approval.
- Email ownership is not proven by the phone step; possession of the phone is.
  Someone could attach their own number to another person's registration; they
  would receive that person's webinar texts and the number would be added to
  that contact. A registrant with two verified numbers is held for the owner,
  the review page says email ownership is unproven, and the fix is a signed
  link from the registration email (a content decision for the founder).
- A STOP sent in reply to a *code* text, before the first event text, cannot be
  recorded: the unchanged inbound webhook needs an existing contact point. Before
  switching codes on, confirm Twilio Advanced Opt-Out is enabled on the MHP
  Messaging Service so the provider itself blocks that number.
- Owner texts carry a 4-minute authority. The worker sends one text per poll, so
  `PROPERTY_PREDATOR_SMS_LIVE_POLL_MS` must stay at 15000 or below for a full
  10-person batch to go out inside it.
- The external martinhowardproperty.co.uk site is not in this repo. Linking to
  the opt-in page from it, or from an email, is the founder's content decision.
  The active email programme is not touched.
- WhatsApp: nothing.

## Accepted risks recorded by the independent review

- The ratified 0130 owner self-test can push a day to at most 13 segments when codes ran that day.
- A STOP replied to a code text relies on Twilio Advanced Opt-Out, attested by the operator.
- Email ownership is unproven; an attacker can attach their own number to someone else's registration.
- One person with their own registration and phone can use up the 3-a-day and 15-a-month code budget,
  locking genuine registrants out of codes (never out of the owner's allowance).
- The 15-second poll limit is enforced only while codes are switched on.

## Assumptions to reconcile with the ratified design

1. Public functions run as `r72_identity_command`, like signup capture.
2. Opt-ins bind to the latest webinar signup for the email in the campaign,
   using the same chronological anchor as `mhp_webinar_lead_candidates`.
3. A recipient must already be imported into the CRM by the existing owner
   import; review never creates contacts.
4. One phone per registrant per campaign (their latest verified one); a phone
   verified by two registrants is excluded for both.
5. The same saved text version is never sent twice to the same opt-in.
6. The message must contain `STOP`.
7. Consent wording and version `mhp.event-sms/v1` are drafts for the founder.

## Switches (all off by default)

| Variable | Service | Effect |
|---|---|---|
| `MHP_EVENT_SMS_ENABLED=true` | web | Mounts the public page and the owner page |
| `MHP_EVENT_SMS_CODES_ENABLED=true` | SMS worker | Lets the live worker text verification codes |
| `MHP_EVENT_SMS_TWILIO_ADVANCED_OPT_OUT_CONFIRMED=true` | SMS worker | Operator attests Twilio Advanced Opt-Out is on for the MHP Messaging Service; required for codes |
| `PROPERTY_PREDATOR_SMS_LIVE_POLL_MS` | SMS worker | Must be 15000 or less when codes are on |

Both also need the existing MHP SMS pilot settings and migration 0131.
