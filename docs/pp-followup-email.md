# Property Predator follow-up emails

PP-FOLLOWUP-001 lets the Property Predator workspace (`d975ff66-336a-46c2-b36b-d7095a11af97`, campaign `pp-owner-followup`) send the **email** steps of its follow-up flows through Postmark, the same way Martin Howard Property's sequences already send. Text and WhatsApp steps, and the reply/booked/purchased stop rules, stay unconnected: a flow that uses them cannot be started.

## Owner workflow (`/portal/follow-ups` on hq.propertypredator.com)

1. Build the flow and its emails in the existing editor, then **Publish flow**. Publishing approves the exact message and flow versions. It enrols nobody and sends nothing.
2. On the published flow's page, **Start a person** lists up to 200 CRM contacts whose email address has a current granted permission with channel `email` and purpose `marketing` (recorded on the lead's Lead 360 permission panel) and no active suppression. Choose one and **Start this person**. The database checks permission, approval and that this person is not already in this version or an older open version.
3. The first email is due at enrolment (or after a leading wait). Each later wait starts when Postmark accepted the previous email. Every claim and every send re-checks permission, suppression, approval of the exact versions and that the starting owner is still an owner/admin.
4. **People and progress** shows each run. Pause, resume, stop or cancel one person, or pause/resume/cancel all open runs of the flow. Stop and cancel always work, including when delivery is off.

Nothing is ever marked sent unless Postmark answered with `ErrorCode 0` and a `MessageID`, which is stored with the step. Any failure after the dispatch proof was written (timeout, lost response, lost settlement) holds the run as **outcome unknown**. Check Postmark's activity first; **Retry this unknown attempt** needs the owner to tick that they checked that exact attempt and accept a possible duplicate.

## Stop rules

| Event | Effect |
| --- | --- |
| Recipient clicks the unsubscribe link (or the mailbox's one-click unsubscribe) | Appends an `email`/`marketing` suppression for that exact address and stops every open run for it at once. |
| Permission withdrawn or denied, any email suppression (bounce, complaint, manual), address changed or contact archived/deleted | The next sweep stops the run (`unsubscribed`) before anything is due. |
| A newer version of the flow or of one of its emails | Open runs of the old version are held (`newer_sequence` / `content_changed`). Cancel them and start the new published version. |
| Retry window (`expiryHours` in the flow) passes for a due step | The run fails as `delivery_expired`; later steps are never sent. |
| Five not-accepted attempts | The run fails as `delivery_failed`. |

Bounces are not ingested automatically from Postmark yet. Postmark itself suppresses hard-bounced and spam-complaint addresses on the stream; to stop a run for a bounce, record a suppression on the lead (or stop the run).

## Configuration (PP web service)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PP_MARKETING_MODE` | `off` | `off`: nothing is claimed or sent; runs wait and their steps can expire. `test`: only `PP_MARKETING_TEST_TO` receive anything (checked at claim and again at send); other runs wait. `live`: every started person. |
| `PP_POSTMARK_SERVER_TOKEN` | — | Server token of the PP Postmark server (secret). |
| `PP_MARKETING_FROM` | — | Sender address on the verified propertypredator.com domain. |
| `PP_MARKETING_FROM_NAME` | `Property Predator` | Display name; also fills `{{LABEL}}` and the email heading. |
| `PP_MARKETING_REPLY_TO` | the sender | Reply-to address. |
| `PP_POSTMARK_BROADCAST_STREAM` | `broadcast` | Postmark broadcast message stream id. |
| `PP_MARKETING_TEST_TO` | — | Comma-separated 1–20 addresses; required in `test` mode. |
| `PP_MARKETING_LINK` | `https://propertypredator.com/` | Fills `{{LINK}}` (https only). |

The unsubscribe link is `PORTAL_BASE_URL/email/follow-up/unsubscribe?p=<contact point>&t=<HMAC>`, signed with `SESSION_SECRET`. A GET only shows a confirmation; a POST (including RFC 8058 one-click) records the suppression. Rotating `SESSION_SECRET` invalidates links in already-sent emails; people can still reply to be removed by hand.

A mode other than `off` with a missing or invalid setting is logged once at start-up (`pp.followup.readiness`, setting names only) and sends nothing; it never takes the portal down. Email shows as connected on the flow page only when the mode is `test` or `live` and every setting is valid, and only then can people be started or resumed.

Postmark setup: add and verify the propertypredator.com sender domain (DKIM TXT record and the custom Return-Path CNAME), create or use a **Broadcast** message stream on the PP server (its id goes in `PP_POSTMARK_BROADCAST_STREAM`), and check the stream's unsubscribe setting: the app adds its own signed unsubscribe link and `List-Unsubscribe`/`List-Unsubscribe-Post` headers, as MHP does. An address Postmark suppresses itself (hard bounce, spam complaint, Postmark-managed unsubscribe) is rejected by Postmark; like MHP, the app does not classify provider errors, so that step is never marked sent and the run is held as outcome unknown until the owner stops it or records a suppression.

## Implementation

Migration 0152 is additive. It adds `app_private.pp_followup_runs`, `pp_followup_sends`, `pp_followup_dispatch_proofs` (immutable once settled) and `pp_followup_commands`, all pinned to the PP workspace by CHECK constraint and RLS, owned by the NOLOGIN `r72_pp_followup_definer`. No MHP table, function or policy is changed and no trigger is added to a shared table; newer versions are detected lazily at claim time. Permission is read only from `app.communication_consent_events` / `app.communication_suppression_events` bound to the endpoint identity hash captured at enrolment; the mutable `contact_points.consent_status` column is never consulted.

Functions: `pp_followup_snapshot` (r72_web), `pp_followup_command`, `pp_followup_claim`, `pp_followup_prepare`, `pp_followup_settle`, `pp_followup_unknown`, `pp_followup_unsubscribe` and `pp_followup_hold_runs` (r72_identity_command). The dispatcher runs every minute inside the PP web process (`startPpFollowupDispatcher`), next to MHP's, and uses leases, so several instances are safe.

Rollout: deploy with `PP_MARKETING_MODE` unset (off), apply 0152, set the Postmark variables, switch to `test` with your own address as `PP_MARKETING_TEST_TO`, start yourself as a CRM contact with recorded marketing permission, confirm delivery and the unsubscribe link, then switch to `live`. Recovery: set the mode back to `off` (dispatch stops at the next sweep); `SELECT app_private.pp_followup_hold_runs()` as r72_identity_command holds every open run for an explicit owner resume.
