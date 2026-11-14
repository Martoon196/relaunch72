# MHP sign-ups, webinar emails and the training centre

Package **MHP-GROWTH-001**. It replaces the Brevo forms and automations for martinhowardproperty.co.uk with Relaunch72, and adds the members' training centre at `https://app.martinhowardproperty.co.uk/app/learn`.

## What it adds

| Route | Who | What |
| --- | --- | --- |
| `POST /api/mhp/subscribe` | Public, from the static site | Takes the existing form fields (`FIRSTNAME`, `EMAIL`, `OPT_IN`, `LEVEL`, `CHEATSHEET`, `CHEATSHEET_MODULE`, `CHEATSHEET_LINK`, honeypot `email_address_check`). Origin must be the public site. Source rate limit uses the `auth.setup` policy (20 per 15 minutes per source). Redirects to `/thanks/?for=webinar|sheet|waitlist`. |
| `POST /api/mhp/story` | Public | The testimonial form. Rejects `£` in the number answer. Stored with status `received` for review; nothing is published automatically. Redirects to `/thanks/?for=story`. |
| `GET/POST /email/unsubscribe?p=&t=` | Signed link | HMAC of the prospect id with the session secret. GET shows a confirm button; POST (including RFC 8058 one-click) unsubscribes and cancels every unsent email. |
| `/app/learn`, `/app/learn/NN`, `/app/learn/NN/KK` | Signed-in members | Catalogue, module and lesson pages, task tick, complete and private notes. |
| `/hq/growth` | Programme admins | Counts only: sign-ups by form, level, sends, stories, learners. No addresses. |
| `/hq/course` | Programme admins | Upload the course bundle JSON. Replaces modules and lessons in one transaction; progress is kept. |

## Access to lessons

Decided in the database (`app_private.mhp_learning_tier`), not in the router:

- **full**: programme admins, or any live MHP `course`, `cohort` or `partnership` entitlement (including the read-only grace window).
- **desk**: any other live MHP entitlement (Deal Desk, Room). Opens Module 0 and Module 1 only.
- **none**: signed in without an entitlement. Sees titles, timings and tasks only, with a link to `/join/`.

Lesson text never leaves `mhp_course_content` unless the tier opens it. Progress writes are checked the same way.

## Why the lessons are not in this repository

This repository is public. Paid course text is loaded through `/hq/course` from a bundle file held privately by the owner, and lives only in `app_private.mhp_course_modules` / `mhp_course_lessons`.

## Emails

Templates are in `orchestrator/src/mhp/marketing-templates.ts`, ported from Brevo templates 16 and 19–23 with the Brevo tags resolved. Every footer carries the education disclaimer, no-income statement and partner disclosure.

| Sign-up | Emails |
| --- | --- |
| Cheat sheet | Delivery now (expires after 7 days if never sent). |
| Webinar | Confirmation now; 24 hours before; 1 hour before; replay 08:00 UK next morning; follow-up 08:00 UK the day after (marketing consent only). |
| Waitlist | Stored only. |

A reminder that misses its moment is cancelled rather than sent late. A fresh sign-up after an unsubscribe revives unsent emails; it never resends one already delivered.

Delivery is a one-minute lease/settle loop on the existing process: at-least-once, five attempts with backoff, then marked failed.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `MHP_MARKETING_MODE` | `off` | `off`: sign-ups are saved and emails wait. `test`: only `MHP_MARKETING_TEST_TO` receives anything. `live`: everyone. |
| `MHP_MARKETING_TEST_TO` | none | Comma-separated, required in test mode. |
| `MHP_MARKETING_FROM` | none | Required unless off, for example `martin@martinhowardproperty.co.uk` (domain verified in Postmark). |
| `MHP_MARKETING_REPLY_TO` | `martin@propinvestuk.co.uk` | |
| `MHP_POSTMARK_BROADCAST_STREAM` | `broadcast` | A Postmark **Broadcast** stream on the same server as `MHP_POSTMARK_SERVER_TOKEN`. Set its unsubscribe handling to your own links: each email carries `List-Unsubscribe` and a footer link. |
| `MHP_WEBINAR_STARTS_AT` | `2026-11-04T19:30:00Z` | UTC. November is GMT, so this is 19:30 UK. |
| `MHP_WEBINAR_CAMPAIGN` | `webinar-YYYY-MM-DD` | Change for each new webinar so reminders are keyed separately. |
| `MHP_POSTMARK_WEBHOOK_SECRET` | none | 24 to 200 characters, no spaces. The password Postmark sends with every bounce webhook. Until it is set the webhook stays closed; the catch-up read of Postmark still runs. |
| `EMAIL_BOUNCE_SOURCES` | none | Optional JSON array that adds another brand's Postmark server to the same handler (see below). MHP needs no entry. |
| `EMAIL_BOUNCE_HANDLING` | on | `off` (also `false`, `0`, `no` or `disabled`, in any letter case) switches the whole feature off: no webhook, no reads, nothing refused. |

## Bounces, spam reports and unsubscribes

Postmark's own lists are read at start-up (retried within minutes, with a warning in the log, if Postmark cannot be read), every hour and whenever the owner presses **Check with Postmark now**; its webhooks add to the picture as things happen. From migration 0153 every hard bounce, spam report and unsubscribe is also kept in our own database (`app_private.email_address_blocks`, one row per brand, email source, address and reason), written by the webhook and by every read of Postmark and read by every send guard; the list held in the running process is a cache in front of it. While the database still ends at 0152 the process list is used alone, exactly as before. The code is in `orchestrator/src/email-bounces/` (shared by every brand; `ledger.ts` is the database side) and `orchestrator/src/mhp/email-health.ts` (MHP's page and its lasting effect).

| What happened | What stops, for that exact address in that brand |
| --- | --- |
| The email came straight back (hard bounce) | Marketing and event emails (webinar and sign-up emails too). The address does not work. |
| They marked an email as spam | Marketing and event emails from the brand, a confirmation they ask for later included (owner rule, 12 November 2026). |
| They unsubscribed through Postmark's own link or list | Marketing email only. An event email they asked for (a booking or webinar confirmation, a reminder) still goes. A fresh sign-up after the unsubscribe lets marketing go again; so does Postmark telling us they re-subscribed. |
| Their mailbox refused email 3 times in 30 days | All marketing email, for as long as that stays true. Fewer than that is only counted. Held in the running process only. |

Sign-in links, receipts and purchase emails are never refused by this list (see below).

Nothing ever lifts a hard bounce or a spam report automatically: once it is in the database, reactivating the address in Postmark or signing up again does not let email go to it. Times are compared as event times, never by when a report arrived: a re-subscribe that overtakes a retried, older unsubscribe leaves a lifted marker, so the late unsubscribe does not block. A provider list row with no time keeps the time it was first seen.

**Signing in from these pages.** Opening `/hq/marketing` or `/hq/marketing/email-health` while signed out sends the owner to sign in with `?next=` set to that exact page, and a password sign-in returns there. Only those two exact paths are accepted (exact string match against a fixed list; the redirect target is the constant from the list, never the submitted text); anything else lands on the Desk, and an email sign-in link always lands on the Desk. Outside the marketing workspace the email health page explains why in one sentence and offers **Open marketing workspace**, which lands back on the email health page; the same button on the marketing screen still lands on the enquiry board.

**Undoing a wrong hard bounce (owner button).** On `/hq/marketing/email-health`, while the list is kept in the database, each hard-bounced address has a button **This address works now**. Press **Reactivate** for that address in Postmark first (this build does not call Postmark for it: the Postmark call to reactivate was not verified, so it is left to the owner). The button lifts the hard bounce in the database with who, when and a fixed reason ("Owner confirmed in Growth HQ that this address works now"), forgets the running process's copy and reloads the list. A later genuine bounce for the same address blocks it again: the same row is re-armed by a bounce whose own event time is after the lift (equal times never re-arm). Two accepted behaviours: re-arming clears the who/why on the block row itself, but every owner lift also writes a permanent, append-only row to `app_private.email_address_block_lifts` (address, who, why, when, how many CRM stops were released), so the trace of the undo stays; and a provider list row with no time never re-arms a lifted row (only a timed event can). A retried copy of the ORIGINAL bounce arriving after the lift does not stop the person again; a second press of the button repairs a PP CRM stop if one ever landed in between. A spam report also recorded for the address means nothing is released in the CRM. The person's contact-list stop is left alone, because the contact record does not say whether the bounce caused it; the page says so. For Property Predator the same database function also writes a purpose-free `released` email suppression event (`reason = owner_confirmed_working`, `source = pp.owner.email_health`, the owner as actor) on every PP email point with that address whose current stop is that hard bounce, so PP follow-ups may be sent to it again. A spam report has no owner button.

**Runbook: a spam report recorded by mistake** (manual, by someone with database owner access; record why in the change log first). Replace the address and brand:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL ROLE r72_owner;
-- 1. See exactly what is there (one row per email source).
SELECT id,source_key,reason,occurred_at,lifted_at FROM app_private.email_address_blocks
 WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND email='person@example.com' AND reason='spam_complaint';
-- 2. Spam reports cannot be lifted (a table rule). Remove the row instead; keep the output of step 1 as the record.
DELETE FROM app_private.email_address_blocks
 WHERE workspace_id='2789228d-55a6-4688-b1e8-2f70abca990b' AND email='person@example.com' AND reason='spam_complaint';
COMMIT;
```

Then make sure Postmark no longer lists that address as a spam complaint on any of the brand's streams (whether Postmark lets you remove a spam-complaint suppression was not verified when this was written; while it is listed, the next hourly read writes the row again), and, for Property Predator, append a purpose-free `released` email suppression event for that contact point by hand; the stop in the MHP contact list stays until the person signs up again.

One limit to know: when someone signs up for a webinar with the marketing box ticked, the confirmation itself is the marketing version, so for an address blocked from marketing it is refused; the reminders they asked for still go.

Only failures that say something about the address count towards the three: Postmark's `SoftBounce`, `DnsError` and `Unknown`. `Blocked` and `SpamNotification` mean the receiving provider refused the sender or the content, so they are not counted against the address (one bad day at a large mailbox provider would otherwise block everyone there for a month). A hard bounce that Postmark did not switch the address off for (`Inactive: false`) is counted as one of the three, not treated as a dead address.

Email only: texts and WhatsApp are never touched. Sign-in links, receipts and purchase emails are not refused here: Postmark already stops repeats on that stream, and wrongly refusing a paying member's sign-in link costs more than one extra bounce.

A blocked address is refused before Postmark is called, on any of the brand's streams. A refused email is a definite, recorded non-send: it is retried by the queue's own rule and fails after five attempts, and a sequence run fails with it.

Separately, a person can be **stopped for good** through the same capability as the unsubscribe link. That capability cancels everything queued for them (including webinar reminders they asked for), ends their sequences, clears their marketing consent and cannot be undone from here, so it is used only where that is right:

| Reason | When the person is stopped for good |
| --- | --- |
| Hard bounce or spam report | Always: when Postmark reports it, when a send to the address is refused, and at the owner's check. Every email to them is refused anyway. |
| Unsubscribe at Postmark | When Postmark reports it, and at the owner's check unless the person has signed up again since. Never because a later marketing email was refused: someone who signs up for the next webinar still gets the reminders they asked for. |
| 3 soft bounces in 30 days | Never. It is a temporary block held in the running process and lifts by itself. |

"Signed up again since" means a sign-up (any kind, ticked box or not) recorded after the unsubscribe: the owner's check compares the latest sign-up with the block date, and the database compares each sign-up with the stored unsubscribe time.

The contact record has no reason column, so a person stopped for a bounce or a spam report looks exactly like someone who unsubscribed, and only they can undo it (by signing up again with the box ticked). The database ledger keeps the true reason.

Without 0153 the block list is held in the running process and rebuilt from Postmark after a restart, and an instance that did not receive a webhook learns of it at the next hourly read. With 0153 every instance asks the database before each send, so a restart or a second instance forgets nothing. Sends wait up to 15 seconds for the first read of Postmark; if Postmark cannot be read they go ahead, and Postmark itself still refuses addresses on its own per-stream list. `EMAIL_BOUNCE_HANDLING=off` switches the database ledger off too. Marketing email is never sent on the process list alone once the database ledger exists: if the database cannot be asked, the MHP sweeps claim nothing at all and log one warning (a claim spends one of the five attempts and the queue has no way to hand it back without a schema change, so built-in event emails wait too: delayed, never lost); if the database stops answering after a claim, that one claimed email is a definite non-send (its attempt is spent) and nothing more is claimed that sweep. Property Predator hands the attempt back instead. Elsewhere event email falls back to the process list. Postmark's own "inactive recipient" refusal (406) is recorded as a definite non-send labelled `provider_inactive`, never an unknown. Once the database has answered in a process, a missing ledger function is treated as a fault and logged as a warning every time, never as "not applied yet". The hourly read logs a warning when any row could not be written to the database (a row the database refuses is skipped and counted; the rest of the list is still written).

**Release order and rollback for 0153.** Deploy this build to every service first, then apply 0153. Builds from before 0153 refuse to start on a database that contains it, so after 0153 is applied roll back only to a build that contains the 0153 gate.

### Postmark set-up (once per message stream)

In Postmark open the MHP server, then **each** message stream it sends on (the broadcast stream and the transactional stream), then **Webhooks → Add webhook**:

1. URL: `https://app.martinhowardproperty.co.uk/api/provider-webhooks/postmark/mhp`
2. Basic auth: user name `mhp`, password the value of `MHP_POSTMARK_WEBHOOK_SECRET`. (A custom header `X-Postmark-Webhook-Secret` with the same value also works.)
3. Tick **Bounce**, **Spam complaint** and **Subscription change**. Leave Delivery, Open and Link click unticked, and leave "include bounce content" off.
4. Press **Send test** for Bounce: Postmark should show `200`.

### The owner's page

`/hq/marketing/email-health`, linked from the marketing workspace: this month's bounces and spam reports, the last 30 days' bounce rate from Postmark's own totals, every blocked address with the reason and date, and a warning at 5% bounces or 0.05% spam reports. Those two lines are ours; Postmark's are about 10% and 0.1%.

### Another brand

Property Predator is already joined: see `docs/pp-followup-email.md` (`PP_POSTMARK_WEBHOOK_SECRET`, webhook path `/api/provider-webhooks/postmark/pp`). MHP's variables are set on the service in the Render dashboard; no blueprint in this repository declares them. For any further brand, add one entry to `EMAIL_BOUNCE_SOURCES` and set the two variables it names. Its webhook URL ends in its `key`. Its send path asks `decideRecipient(service.guard, workspaceId, address, 'marketing' | 'service')` before sending, and may register one effect to record the stop in its own contact records. The database ledger keeps only the MHP and PP workspaces (the 0153 table is pinned to them); any other brand stays on the process list.

```json
[{"key":"pp","workspaceId":"<workspace uuid>","tokenEnv":"PP_POSTMARK_SERVER_TOKEN","webhookSecretEnv":"PP_POSTMARK_WEBHOOK_SECRET","marketingStreams":["broadcast"],"serviceStreams":["outbound"]}]
```

## Release order

1. Deploy the exact-checksum 0121 compatibility bridge on Growth HQ and every active schema-bound service. Confirm both Growth HQ hosts return `200` from `/ready` and the SMS webhook and social worker are ready. The original 0120 build rejects a 0121 ledger row.
2. Apply migration 0121 with `npm run db:migrate` against the production database using the migrator URL. Confirm the ledger checksum and both `/ready` responses before proceeding.
3. Deploy this integrated app on Render manually with `MHP_MARKETING_MODE=off` or `test`. If deployment fails, redeploy the bridge, which accepts the exact 0121 schema; keep website forms unswitched and marketing off.
4. `/hq/course`: upload the bundle. Check `/app/learn` as the owner and with a non-owner Deal Desk test grant.
5. Set `MHP_MARKETING_MODE=test` with your own address, sign up on the site, confirm the confirmation and sheet emails arrive, and test the unsubscribe link.
6. Switch the site's `config.js` to `formAction: "https://app.martinhowardproperty.co.uk/api/mhp/subscribe"` and `storyFormAction: ".../api/mhp/story"`.
7. Set `MHP_MARKETING_MODE=live`.

Brevo stays untouched. Do not run the Brevo automations and these emails for the same people.

## Not in this package

Deal Desk and course buyer sequences (D4 to D8), the sheet nurture emails (templates 17 and 18 need per-sheet tips), webinar attendance import and story publishing tools.
