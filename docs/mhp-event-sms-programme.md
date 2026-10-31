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
   written to the CRM at this stage, and the page never says whether an email is
   registered.
2. **Owner review = send (founder).** `/hq/marketing/event-texts` shows the exact
   current batch: every verified opt-in for the campaign, each with a status
   (ready, needs import, phone shared, opted out, already sent this text, and so
   on), the chosen saved SMS text, the segment cost and the remaining daily and
   monthly allowance. The owner ticks one agreement and sends. That single owner
   action, in the owner's live session:
   - re-derives the ready set and refuses if it no longer hashes to what the owner
     reviewed (anyone who verified since must wait for the next review);
   - materialises each recipient's verified phone point and their own consent
     event (recorded as `actor_kind=system`, source `mhp.event-sms.public-optin`,
     occurred at their verification time, never as the owner's consent);
   - creates each exact message, approval request and owner approval decision,
     the per-recipient compliance chain and a 4-minute authority, exactly as the
     ratified R11 owner send does;
   - enqueues through the unchanged `authorize_and_enqueue_sms_live_job`.
   The existing live worker then delivers with all of its existing re-checks.
3. **Verification codes (worker).** The existing SMS worker, in its live mode,
   optionally claims pending opt-in codes behind `MHP_EVENT_SMS_CODES_ENABLED=true`,
   still subject to its provider-effect and emergency-pause switches. Codes are
   capped at 20 per UTC day in SQL, 3 per phone and 5 per source per 24 hours.

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

- 10 segments per UTC day and 50 per month on the MHP connection. A batch that
  does not fit today's remaining allowance is refused, not split.
- Email ownership is not proven by the phone step; possession of the phone is.
  The review page shows this, and texts only reach the phone owner who consented.
- A STOP sent in reply to a *code* text before the first event text is not
  linked to a contact (no point exists yet). Twilio's own opt-out still blocks
  later sends to that number at the provider.
- The external martinhowardproperty.co.uk site is not in this repo. Linking to
  the opt-in page from it, or from an email, is the founder's content decision.
  The active email programme is not touched.
- WhatsApp: nothing.

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

Both also need the existing MHP SMS pilot settings and migration 0131.
