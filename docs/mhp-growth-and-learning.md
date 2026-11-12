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
| The email came straight back (hard bounce) | Every email: marketing, webinar and sign-up emails too. The address does not work. |
| They marked an email as spam | Every email from the brand, a confirmation they ask for later included (owner rule, 12 November 2026). |
| They unsubscribed through Postmark's own link or list | Marketing email only. An event email they asked for (a booking or webinar confirmation, a reminder) still goes. A fresh sign-up after the unsubscribe lets marketing go again; so does Postmark telling us they re-subscribed. |
| Their mailbox refused email 3 times in 30 days | All marketing email, for as long as that stays true. Fewer than that is only counted. Held in the running process only. |

Nothing ever lifts a hard bounce or a spam report automatically: once it is in the database, reactivating the address in Postmark or signing up again does not let email go to it. (There is no owner button to lift one yet.)

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

Without 0153 the block list is held in the running process and rebuilt from Postmark after a restart, and an instance that did not receive a webhook learns of it at the next hourly read. With 0153 every instance asks the database before each send, so a restart or a second instance forgets nothing. Sends wait up to 15 seconds for the first read of Postmark; if Postmark cannot be read they go ahead, and Postmark itself still refuses addresses on its own per-stream list. If the database cannot be asked, the send guard falls back to the process list rather than failing the send. `EMAIL_BOUNCE_HANDLING=off` switches the database ledger off too.

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
