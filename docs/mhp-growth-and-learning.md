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

Bounce and complaint webhooks (Postmark suppresses these itself), Deal Desk and course buyer sequences (D4 to D8), the sheet nurture emails (templates 17 and 18 need per-sheet tips), webinar attendance import and story publishing tools.
