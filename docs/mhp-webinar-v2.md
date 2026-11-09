# MHP webinar v2 integration

PR6 `706e86821d9e6fe84008e2a97404cbc46d09b818` is adapted to foundation f0e0403 plus its compatible bridge. Do not apply the PR's duplicate0124 or old claim/summary replacements. Additive migration0136 has canonical SHA256 `9bf6605cdc536794fae989964542eb8253cdd49ebd995d3e6dd346c01c746139`.

Public native forms keep exact apex/www Origin checks, body limits, duplicate-field rejection, honeypot and abuse admission. `/api/mhp/subscribe` retains its fields. Optional PHONE is unverified information. OPT_IN is optional ONLY for webinars: registration requests confirmation, reminders and plain replay; commercial follow-ups need the checkbox. Sheets and waitlist still require consent. The0135 cookie/303 phone-choice handoff now accepts a service-only signup; explicit phone consent, signed JOIN, identity checks, STOP and owner batch review are unchanged. Fallback never loses the accepted registration.

`/api/mhp/apply` accepts NAME, EMAIL, optional PHONE, LOCATION, EXPERIENCE, DOOR, HOURS, OBJECTIVE, OBSTACLE, SUPPORT, PRICE_UNDERSTOOD=yes, DISCUSS=yes|no, CONSENT=1, optional OPT_IN=1, SOURCE=live|replay|site|email and email_address_check. Enumerations are exported by growth-service.ts. Success303 goes to `/webinar/application-received/`. Each actual application ID owns one acknowledgement and one configured-owner notification. Queued delivery retries reuse those rows; deliberate repeat form submissions create new applications.

`/api/mhp/event` accepts a512-byte `e=<allowlisted event>&p=<site path>` beacon and always returns204. Only UTC day, event name, stripped path and count are stored. A page open does not prove attendance.

Owners use `/hq/applications`, `/hq/registrants`, `/hq/registrants?format=csv` and existing `/hq/growth`. Limits are200 applications and2,000 registrants. CSV defuses formula cells, labels submitted phones unverified and grants no contact permission. Status changes/calls/enrolments remain manual.

All messages respect existing MHP_MARKETING_MODE=off|test|live. Test mode checks the final actual recipient, including owner notifications. MHP_POSTMARK_TRANSACTIONAL_STREAM defaults to outbound; MHP_APPLICATION_NOTIFY_TO defaults to martin.howard1984@gmail.com and is stored at capture/rechecked before sending. Optional HTTPS MHP_BOOKING_URL supplies the applicant call link; otherwise reviewed PR copy promises an email within one working day.

Same-key webinar_confirm preserves deduplication. The restricted DB claim overwrites stored emailPurpose. Service confirmation removes exactly the commercial teaser, fails closed if it cannot match, and uses outbound. Marketing/legacy copy stays on broadcast. Deployed008B neutral dated reminders and PR legal footer MH196 Ltd15060897 are retained. No offers, prices or policies are invented by engineering.

Existing owner/sequence/D1 queues remain. Old claim selection and every maintenance branch exclude nonlegacy136 and owner/sequence/nonemail rows. New summary wraps current summary without removing keys. Unsubscribe stops webinar/marketing and owner/sequence emails; anchored application acknowledgements/notifications remain transactional requests. SMS workers are unchanged.

Root deploys the exact135-to136 bridge to all seven active consumers BEFORE guarded migration, verifies full ledger/grants/readiness, then deploys capable source and verifies test-mode notifications/native owner pages. Recovery retains the bridge, reconciles in-flight sends, and pauses only the new route/claim path if required. New-purpose rows wait for a capable claimant; CRM, checkout, SEO, owner/sequence queues and SMS remain available. No downmigration, migration-first release or readiness bypass. This document is source guidance, not live acceptance.
