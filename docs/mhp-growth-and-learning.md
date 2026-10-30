# MHP sign-ups, webinar emails and the training centre

Package **MHP-GROWTH-001**. It replaces the Brevo forms and automations for martinhowardproperty.co.uk with Relaunch72, and adds the members' training centre at `https://app.martinhowardproperty.co.uk/app/learn`.

## What it adds

| Route | Who | What |
| --- | --- | --- |
| `POST /api/mhp/subscribe` | Public, from the static site | Takes the existing form fields (`FIRSTNAME`, `EMAIL`, `OPT_IN`, `LEVEL`, `CHEATSHEET`, `CHEATSHEET_MODULE`, `CHEATSHEET_LINK`, honeypot `email_address_check`). Origin must be the public site. Source rate limit uses the `auth.setup` policy (20 per 15 minutes per source). Redirects to `/thanks/?for=webinar|sheet|waitlist`. |
| `POST /api/mhp/apply` | Public, from `/webinar/apply/` | One Lane Mentoring application (MHP-GROWTH-002, migration 0124). Same protections as subscribe: site Origin, `application/x-www-form-urlencoded`, honeypot `email_address_check`, `auth.setup` source rate limit, body up to 16 KB, control characters rejected. Fields: `NAME`, `EMAIL`, `PHONE` (optional), `LOCATION`, `EXPERIENCE`, `DOOR`, `HOURS`, `OBJECTIVE`, `OBSTACLE`, `SUPPORT`, `PRICE_UNDERSTOOD=yes`, `DISCUSS=yes/no`, `CONSENT=1` (privacy), optional `OPT_IN=1` (marketing), optional `SOURCE` (`live`, `replay`, `site`, `email`). No savings or balances are collected. Redirects to `/webinar/application-received/`; a validation error shows a 400 message page. |
| `POST /api/mhp/event` | Public beacon | Cookieless funnel counter: body `e=<name>&p=<path>` as `text/plain` or form-encoded, at most 512 bytes, site Origin, `read.page` source rate limit. Always `204` with `access-control-allow-origin: https://martinhowardproperty.co.uk`, even when ignored. Names: `webinar_page_viewed`, `live_page_opened`, `replay_page_opened`, `diagnostic_started`, `diagnostic_completed`, `offer_viewed`, `application_started`. Stores a daily count per name and path only: no identifiers, IPs or cookies. **"Page opened" is a page load, not proof anyone watched.** |
| `POST /api/mhp/story` | Public | The testimonial form. Rejects `£` in the number answer. Stored with status `received` for review; nothing is published automatically. Redirects to `/thanks/?for=story`. |
| `GET/POST /email/unsubscribe?p=&t=` | Signed link | HMAC of the prospect id with the session secret. GET shows a confirm button; POST (including RFC 8058 one-click) unsubscribes and cancels every unsent email. |
| `/app/learn`, `/app/learn/NN`, `/app/learn/NN/KK` | Signed-in members | Catalogue, module and lesson pages, task tick, complete and private notes. |
| `/hq/growth` | Programme admins | Counts only: sign-ups by form, level, sends, stories, learners, the webinar funnel (registrations, live page opens, applications, with stage-to-stage percentages; calls and enrolments are recorded manually for now) and 30-day page-event counts. No addresses. |
| `/hq/applications` | Programme admins | Read-only table of the latest 200 applications, newest first, with every field, status and date. |
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
| Webinar | Service emails to every registrant: confirmation now; 24 hours before; 1 hour before; replay 08:00 UK next morning (`webinar_replay` with the mentoring step if they ticked the optional tips box, otherwise `webinar_replay_plain` with no offer). Marketing, only with consent: `webinar_followup` Fri 08:00 UK (start + 36.5h); `webinar_90days` Sat 08:00 UK (start + 60.5h, expires at midnight after the Saturday 23:59 close, start + 76.5h); `webinar_casestudy` Sun 08:00 UK (start + 84.5h). |
| Application | `application_received` to the applicant and `application_notify` to `MHP_APPLICATION_NOTIFY_TO`, both due now on the Postmark transactional stream. Applying cancels that person's unsent `webinar_followup`, `webinar_90days` and `webinar_casestudy`. An earlier unsubscribe does not stop these two (the applicant asked for a reply); OPT_IN on the form clears it, as on any sign-up. |
| Waitlist | Stored only. |

On the webinar form the tips box is optional: registering is itself the request for the webinar emails, so a missing `OPT_IN` saves the sign-up with `marketing_consent=false`. Cheat sheets and the waitlist still require it.

Templates declare their stream: `broadcast` (default; carries `List-Unsubscribe` and `List-Unsubscribe-Post`) or `outbound` (transactional; no list headers). The applicant's acknowledgement keeps the footer and unsubscribe link; the owner notification has neither. In test mode the allowlist is applied to the address actually used, so the owner notification needs the owner address in `MHP_MARKETING_TEST_TO`.

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
| `MHP_POSTMARK_TRANSACTIONAL_STREAM` | `outbound` | Postmark transactional stream for the two application emails. |
| `MHP_APPLICATION_NOTIFY_TO` | `martin.howard1984@gmail.com` | Where new-application notifications go. |
| `MHP_BOOKING_URL` | none | Optional `https` link for the "Book your 20-minute call" button. Unset: the acknowledgement says Martin will email within one working day. |
| `MHP_WEBINAR_STARTS_AT` | `2026-11-04T19:30:00Z` | UTC. November is GMT, so this is 19:30 UK. |
| `MHP_WEBINAR_CAMPAIGN` | `webinar-YYYY-MM-DD` | Change for each new webinar so reminders are keyed separately. |

## Release order

1. Deploy the exact-checksum 0121 compatibility bridge on Growth HQ and every active schema-bound service. Confirm both Growth HQ hosts return `200` from `/ready` and the SMS webhook and social worker are ready. The original 0120 build rejects a 0121 ledger row.
2. Apply migration 0121 with `npm run db:migrate` against the production database using the migrator URL. Confirm the ledger checksum and both `/ready` responses before proceeding.
3. Deploy this integrated app on Render manually with `MHP_MARKETING_MODE=off` or `test`. If deployment fails, redeploy the bridge, which accepts the exact 0121 schema; keep website forms unswitched and marketing off.
4. `/hq/course`: upload the bundle. Check `/app/learn` as the owner and with a non-owner Deal Desk test grant.
5. Set `MHP_MARKETING_MODE=test` with your own address, sign up on the site, confirm the confirmation and sheet emails arrive, and test the unsubscribe link.
6. Switch the site's `config.js` to `formAction: "https://app.martinhowardproperty.co.uk/api/mhp/subscribe"` and `storyFormAction: ".../api/mhp/story"`.
7. Set `MHP_MARKETING_MODE=live`.

Brevo stays untouched. Do not run the Brevo automations and these emails for the same people.

## Release order for 0124 (applications and events)

1. Apply migration 0124 with `npm run db:migrate` (migrator URL). It is additive apart from `CREATE OR REPLACE` of `mhp_claim_marketing_sends` and `mhp_growth_summary`, which keep their signatures and grants.
2. Deploy this app. Set `MHP_BOOKING_URL` if a booking page exists, and check `MHP_APPLICATION_NOTIFY_TO`.
3. In test mode, add the owner address to `MHP_MARKETING_TEST_TO`, apply on the site and confirm both application emails arrive.

Note: the running 0123 build's runtime schema check rejects a ledger row it does not know, so keep the gap between steps 1 and 2 short (or ship an exact-checksum bridge first, as was done for 0121).

## Not in this package

Bounce and complaint webhooks (Postmark suppresses these itself), Deal Desk and course buyer sequences (D4 to D8), the sheet nurture emails (templates 17 and 18 need per-sheet tips), webinar attendance import and story publishing tools.
