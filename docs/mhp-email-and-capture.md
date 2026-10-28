# MHP capture and email on Relaunch72

Decision from the founder's 28 October request: Growth HQ should own MHP prospects as well as members. Relaunch72 owns contacts, consent evidence, templates, sequence state, send history and owner controls. A separately configured provider delivers email. Prop Invest UK's Brevo list 11 remains in Brevo and must not be imported or altered by this work.

This is a bounded follow-on package, **MHP-CAPTURE-001**, after the host/auth/owner Desk release. It is a design and source-reuse map, not a claim that the following automations are built or live. The supplied spec's references to existing Brevo templates are not the template HTML itself. Templates 16–33 must be exported, reviewed against the revised v3 prices, and versioned before enabling sends. Marketing copy is not recreated from template titles.

## Existing building blocks

| Area | Current source | Reuse boundary |
| --- | --- | --- |
| Canonical contacts and attributes | CRM schema and `orchestrator/src/portal/crm-service.ts` | A dedicated MHP marketing workspace; no prospect access to member accounts and no cross-brand contact leakage. |
| Consent and suppression | `orchestrator/src/consent-pg/eligibility.ts`, migrations 0014/0018 and consent event tables | Append evidence and recheck current suppression at send time. An opt-in is not a login or paid entitlement. |
| Journey state | `orchestrator/src/conversion-pg/`, migrations 0014 and 0018 | Reuse event/enrolment/idempotency patterns; the eight MHP sequences are not implemented. |
| Versioned campaign steps | migration 0051 and campaign services | Reuse approved versions and step delays; do not repurpose a live PP campaign or its installation grants. |
| Durable sending and receipts | `orchestrator/src/customer-email-live-pg/`, `orchestrator/src/workers/customer-email-live/runner.ts` | Reuse enqueue, lease, bounded retry and receipt patterns. Existing sender/domain/caps and one-recipient pilot controls are PP-specific. |
| Provider adapter | `orchestrator/src/providers/mailgun-eu-http-adapter.ts` | Existing adapter is text-only and PP-bound; it cannot deliver these HTML templates unchanged merely by switching a flag. |
| Current Brevo integration | `orchestrator/src/email/brevo.ts`, server lead/customer hooks | Contact upsert only. The current `/api/subscribe` does not create a canonical MHP prospect or execute a local nurture sequence. |
| MHP login delivery | `orchestrator/src/mhp/transactional-mail.ts` | Auth-only Brevo/Postmark switch. Never route marketing through this login helper. |

Postmark supports separate transactional and Broadcast streams. Promotional messages need a Broadcast stream and unsubscribe handling; login/reset/receipts use transactional delivery. See [Message Streams](https://postmarkapp.com/support/article/how-to-create-and-send-through-message-streams) and [unsubscribe headers](https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header). A reusable provider interface must distinguish purpose, stream, HTML/text, headers and provider receipt ID. Do not reuse PP credentials or change its sending authorization.

## First implementation package

1. Add MHP-host `POST /api/mhp/subscribe` and `POST /api/mhp/story`, accepting the supplied plain HTML field names. Bound body size and field lengths, exact public-domain Origin/CORS, honeypot, source rate limits and idempotent capture. Success redirects only to `https://martinhowardproperty.co.uk/thanks/`.
2. Persist submission timestamp, source IP, trusted source-page identity and the server's consent-text version. Store submitted consent separately from current permission and suppression. Story publication consent and exclusions are distinct from marketing permission. A pasted `CHEATSHEET_LINK` is not trusted: resolve approved sheet identifiers/URLs from a server-side catalogue to prevent sending arbitrary links.
3. Store the supplied contact attributes with typed validation and record MHP segments. Persist LEVEL L1/L2/L3, support member level updates, and distinguish purchase flags from manual access. Owner/test seeds and staff grants must not become paid buyers or increment sales/founder counts.
4. Import templates 16–33 as immutable approved versions, preserving the supplied HTML and mapping only the documented contact/default token syntax. Add the five Advocate/Promote templates only once their actual copy is provided. Classify each message by purpose: a sales follow-up is marketing even if the source document labels the template transactional.
5. Implement durable sequence enrolment/steps for D1–D5 with event keys, due timestamps, cancellation and a send-time consent/refund/product check. Requested sheet delivery is separate from marketing follow-ups. Preserve each request's sheet values so another form does not rewrite already scheduled content accidentally. Suppress duplicate active D1 tip sequences while allowing requested delivery of the new sheet.
6. Configure webinar time and Europe/London timezone rather than embedding one event date. Derive reminders/replay/follow-up times from that event. Represent the weekday 08:00–09:30 welcome window and test daylight-saving transitions. Pin D3's day numbers to a documented anchor before activation; the supplied trigger/delay wording is ambiguous.
7. Add signed one-click unsubscribe, bounce and complaint intake and durable contact suppression. Unsubscribe prevents marketing; necessary transactional messages remain independently classified. Record provider acceptance separately from delivered/opened/clicked. Opens are observational provider events, not proof a person read a message.
8. Add `/hq` contact history, template/sequence status, audited resend/skip actions and a test preview. Test delivery redirects only synthetic campaign recipients to Martin; never redirect another person's production password-reset/login link. Idempotent resend uses an explicit new audited attempt.
9. Change the public site's `brevoFormAction` to `formAction` only once capture endpoints are deployed and verified. Keep the previous action as an executable recovery option. Do not activate both Brevo and local copies of the same sequence for the same contact.

## Purchase and later feature dependencies

- **D4 is The Deal Desk, not the retired Kit.** The founder's v3 catalogue is authoritative: £47, 14-day refund; permanent six calculators, 30-day writable Desk, three deal files, verdict task and expiring £47 course credit. These capabilities are not created by adding a catalogue row. Paid activation is blocked until the complete journey is implemented and tested.
- D5 course variants must use actual paid purchase evidence. Refund stops the paid sequence. Manual access can have its own welcome policy without setting `COURSE_BUYER=true` or inventing payment dates.
- Lesson/module progress, deal files, clinic attendance and a verdict submission form are not yet built in this app. D6 event wiring waits for those sources. Webinar attendance CSV import is a new explicitly requested follow-on capability; it is not part of the earlier Desk release's Zoom exclusion.
- D7 rewards require the precise referral coupon, qualifying payment rules, annual cap and an idempotent credit ledger. Do not infer referral eligibility from a manual grant or give a reward twice on webhook replay. The revised £997 webinar/referral product and £47 course credit must be reconciled with any promotion-code rules before activation.
- D8, founders' pricing and early mentoring require server-checked eligibility, actual webinar/cohort configuration, and an atomic paid-member counter. Public reusable links for gated products must remain inactive while these checks are absent. Partnership remains invoice/manual only.
- The MHP public repository names the six calculators but contains no working calculator implementation. Candidate non-tax models exist in the separate PP repository; they require explicit mapping and validation. Tax implementation remains excluded.

## Acceptance and cutover

Before any live campaign: prove capture validation/consent persistence, cross-brand isolation, fixed redirect and anti-abuse; duplicate/request ordering; timezone scheduling; refund/unsubscribe suppression; provider failure/retry/receipt idempotency; audited owner actions; no purchase counter movement from manual grants; and one owned-address send/unsubscribe/reply proof. Record exact source, migrated schema and provider configuration. Keep sending disabled until approved template HTML and brand-specific delivery credentials are present. Do not disable working PP or Prop Invest UK journeys.

## Deal Desk implementation update —28October2026

MHP-DEALDESK-001 ports the five verified existing calculators (the later founder instruction); EPC remains not built. Saved files, three lifetime slots,30-day writes, permanent reading, verdict intake/owner response and course credit are implemented in0119/0120. D4 purchase attributes and three durable template handoffs exist but remain held. No D1–D8 marketing delivery or Brevo template export is implied. See [Deal Desk commerce](mhp-deal-desk-commerce.md) and [owner pilot](mhp-owner-pilot.md). Earlier design sections describe the source requirements, not current live status.
