# Property Predator follow-up emails

PP-FOLLOWUP-001 lets the Property Predator workspace (`d975ff66-336a-46c2-b36b-d7095a11af97`, campaign `pp-owner-followup`) send the **email** steps of its follow-up flows through Postmark, the same way Martin Howard Property's sequences already send. Text and WhatsApp steps, and the reply/booked/purchased stop rules, stay unconnected: a flow that uses them cannot be started.

## Owner workflow (`/portal/follow-ups` on hq.propertypredator.com)

1. Build the flow and its emails in the existing editor, then **Publish flow**. Publishing approves the exact message and flow versions. It starts nobody and sends nothing.
2. On the published flow's page, **Start a person** lists the CRM contacts who have agreed to marketing emails (see "Who can be emailed"). The list shows up to 200 people; **Find a person by name or email** searches all of them on the server. Choose one and **Start this person**. The database checks permission, approval and that this person is not already in this version or an older open version.
3. The first email is due when the person is started (or after a leading wait). Each later wait starts when Postmark accepted the previous email. Every claim and every send re-checks permission, suppression, approval of the exact versions and that the starting owner is still an owner/admin.
4. **People in this flow** shows each person as Running, Paused, Waiting for you, Finished, Stopped or Couldn't send. Pause, resume or stop one person, or pause/resume/stop everyone in the flow. The list shows the newest 100 people of the flow on screen; the same search box reaches the rest. Stop always works, including when sending is off.

The page never shows setting names to the owner. When sending is not ready it says "Email sending isn't set up yet." and lists the missing settings inside a closed **For your developer** block. A form sent from an out-of-date page (back button, second tab) answers "This page was out of date. Please try again." with a link back to a fresh copy of the flow.

**Resume restarts the clock.** When a paused or waiting person is resumed and their next email has not been claimed yet, its due time moves to now, so its retry window starts again. A person held for longer than the flow's `expiryHours` is really resumed instead of failing as expired on the next sweep. An email that was already claimed and whose window has since passed cannot be resumed: the page says so and offers only Stop.

## Who can be emailed

Two consent purposes count as permission for Property Predator marketing email, both on channel `email` and both bound to the exact address (endpoint identity hash):

- `property_predator_marketing`: the product's own opt-in and opt-out. Registration, account preferences and the product's unsubscribe arrive as `privacy.consent.updated` events and are projected onto the CRM contact point by migration 0018.
- `marketing`: permission the owner records on the lead (Lead 360 permission panel).

The rule (`app_private.pp_followup_endpoint_allowed`, checked when a person is started, at every claim and again immediately before the hand-off to Postmark):

1. no active email suppression that is purpose-free or for either purpose;
2. **any opt-out wins**: the latest consent event of neither purpose is `denied` or `withdrawn`;
3. the latest consent event of at least one of the two purposes is `granted`.

So a real product opt-in is enough on its own, an owner-recorded `marketing` grant is enough on its own, and a person who opted out in the product is never started, claimed or sent to even if an older `marketing` grant exists (and the other way round). `partner_marketing` is a different permission and is never read. The mutable `contact_points.consent_status` column is never consulted.

**Unsubscribe** (the signed link in every email, or the mailbox's one-click unsubscribe) appends a `suppressed` event for **both** purposes and stops every open run for that address at once. Every other Property Predator marketing path (the 0022/0023 delivery queue, the founder email pilot, customer email) matches suppressions on `purpose IS NULL OR purpose = <its purpose>`, so the `property_predator_marketing` row stops those too. The suppression is deliberately not purpose-free: that would also block transactional email. The insert policy for the feature's definer role allows exactly these two purposes and nothing else.

## Outcomes of a send

An attempt is spent when the dispatch proof is written (`pp_followup_prepare`), which is the last step before the Postmark call. A claim spends nothing, so a worker that dies after claiming never uses up the five-attempt budget.

| What happened | Recorded as | Effect |
| --- | --- | --- |
| Postmark answered `ErrorCode 0` with a `MessageID` | `accepted` | Step marked sent with the message id; the run moves on. |
| Postmark refused this message (HTTP 4xx such as 422, or an explicit non-zero `ErrorCode`), or rendering failed before the call | `rejected` | Definite non-send. The attempt stays spent; next try after 5 minutes per attempt; five attempts then `delivery_failed`. |
| Postmark refused the sender, not the message (401/403 bad server token, 429 rate limit, error codes 10/400/401/405/412/413), or the lease was about to run out | `deferred` | Definite non-send. The attempt is handed back; next try in 5 minutes. When Postmark refused the sender, the sweep also stops and a warning is logged. One bad token does not hold or fail anyone. |
| The address can never be sent to (not a valid address, or Postmark error 406 inactive recipient) | `undeliverable` | Step and run fail at once (`delivery_failed`). |
| Timeout, network error, HTTP 5xx or 408, unreadable answer, or the settlement itself was lost | unknown | The run waits for the owner (**outcome unknown**). Nothing is retried silently. |

The lease-time and recipient checks run **before** the proof, so they never produce an unknown outcome. Apostrophes are valid in addresses (`o'brien@example.com`).

For an unknown outcome the page says: "We're not sure this email went out. Check Postmark for this person first. Send it again? They might get it twice." Sending again needs the owner to tick that they checked. If Postmark's answer arrives late (after the lease ran out) and the lease has not been replaced, the result is still recorded and the hold is lifted automatically.

## Stop rules

| Event | Effect |
| --- | --- |
| Recipient unsubscribes | Suppression for both purposes; every open run for the address stops at once. |
| Permission withdrawn or denied on either purpose, any matching email suppression (bounce, complaint, manual), address changed or contact archived/deleted | The next sweep stops the run (`unsubscribed`) before anything is due. |
| A newer version of the flow or of one of its emails | Open runs of the old version wait for the owner (`newer_sequence` / `content_changed`). Stop them and start the new published version. |
| Retry window (`expiryHours` in the flow) passes for a due step | The run fails as `delivery_expired`; later steps are never sent. Resume restarts the window for a step that was not claimed yet. |
| Five spent attempts | The run fails as `delivery_failed`. |

Bounces are not ingested automatically from Postmark yet. Postmark itself suppresses hard-bounced and spam-complaint addresses on the stream; the next send to one is refused with error 406 and the run fails.

## Configuration (PP web service)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PP_MARKETING_MODE` | `off` | `off`: nothing is claimed or sent; runs wait and their steps can expire. `test`: only `PP_MARKETING_TEST_TO` receive anything (checked at claim and again at send). `live`: every started person. |
| `PP_POSTMARK_SERVER_TOKEN` | — | Server token of the PP Postmark server (secret). |
| `PP_MARKETING_FROM` | — | Sender address on the verified propertypredator.com domain. |
| `PP_MARKETING_FROM_NAME` | `Property Predator` | Display name; also fills `{{LABEL}}` and the email heading. |
| `PP_MARKETING_REPLY_TO` | the sender | Reply-to address. |
| `PP_POSTMARK_BROADCAST_STREAM` | `broadcast` | Postmark broadcast message stream id. |
| `PP_MARKETING_TEST_TO` | — | Comma-separated 1–20 addresses; required in `test` mode. |
| `PP_MARKETING_LINK` | `https://propertypredator.com/` | Fills `{{LINK}}` (https only). |

**Test mode never queues real people for live.** A person who is not on the test list can be added in test mode, but is held (`test_mode`, shown as "Waiting for you") and cannot be resumed while testing. Switching to `live` sends them nothing by itself: the owner presses Resume for them, or Resume everyone, when ready. People started in live mode simply wait if the mode is later set back to test.

The unsubscribe link is `PORTAL_BASE_URL/email/follow-up/unsubscribe?p=<contact point>&t=<HMAC>`, signed with `SESSION_SECRET`. A GET only shows a confirmation; a POST (including RFC 8058 one-click) records the suppression. Rotating `SESSION_SECRET` invalidates links in already-sent emails; people can still reply to be removed by hand.

A mode other than `off` with a missing or invalid setting is logged once at start-up (`pp.followup.readiness`, setting names only) and sends nothing; it never takes the portal down and the flow page shows it as not set up, never as test or live. People can be started or resumed only when the mode is `test` or `live` and every setting is valid.

Postmark setup: add and verify the propertypredator.com sender domain (DKIM TXT record and the custom Return-Path CNAME), create or use a **Broadcast** message stream on the PP server (its id goes in `PP_POSTMARK_BROADCAST_STREAM`), and check the stream's unsubscribe setting: the app adds its own signed unsubscribe link and `List-Unsubscribe`/`List-Unsubscribe-Post` headers, as MHP does.

## Operator (Claude) tools

`followups_overview` returns counts, the email mode and each run's progress for Property Predator, never a recipient's name or address: the contact picker is dropped and `email`/`displayName` are stripped from every run.

## Implementation

Migration 0152 is additive. It adds `app_private.pp_followup_runs`, `pp_followup_sends`, `pp_followup_dispatch_proofs` (immutable once settled) and `pp_followup_commands`, all pinned to the PP workspace by CHECK constraint and RLS, owned by the NOLOGIN `r72_pp_followup_definer`. No MHP table, function or policy is changed and no trigger is added to a shared table; newer versions are detected lazily at claim time. Its checksum is pinned in `orchestrator/src/db/pp-followup-schema.ts`.

Functions: `pp_followup_snapshot(session, flow, search)` (r72_web); `pp_followup_command(…, test_emails)`, `pp_followup_claim`, `pp_followup_prepare`, `pp_followup_settle(send, lease, outcome, reference)`, `pp_followup_unknown`, `pp_followup_unsubscribe` and `pp_followup_hold_runs` (r72_identity_command). The dispatcher runs every minute inside the PP web process (`startPpFollowupDispatcher`), next to MHP's, and uses leases, so several instances are safe.

Rollout: deploy with `PP_MARKETING_MODE` unset (off), apply 0152, set the Postmark variables, switch to `test` with your own address as `PP_MARKETING_TEST_TO`, start yourself as a CRM contact with recorded marketing permission, confirm delivery and the unsubscribe link, then switch to `live`. Recovery: set the mode back to `off` (dispatch stops at the next sweep); `SELECT app_private.pp_followup_hold_runs()` as r72_identity_command holds every open run for an explicit owner resume.
