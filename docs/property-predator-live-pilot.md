# Property Predator Growth HQ — controlled live pilot

Status: provider decision record, 26 August 2026. No live account, credential or production rail is enabled by this document.

## Pilot stack

| Rail | Pilot provider | Why this one first | Fixed starting cost |
|---|---|---|---:|
| Email | Mailgun Basic | Low-cost API delivery with cryptographically signed event webhooks while Growth HQ owns campaigns, consent and the interface | $15/month |
| WhatsApp | 360dialog Regular | Partner-oriented WABA model and a clean route from one Property Predator number to later multi-client onboarding | €49/number/month + Meta fees |
| UK SMS | Twilio | Mature UK KYC, delivery callbacks and subaccount isolation | $2.50/month number rental + usage |
| Social publishing | Ayrshare Launch | Ten isolated social profiles, posting, analytics and webhooks without first owning every social developer-app review | $299/month |
| Webinar | Whereby Embedded Build | Fully branded embedded room, signed attendance webhooks and low pilot cost | $9.99/month |
| Calendar | Nylas Calendar/Scheduler | API-driven Google/Microsoft/Exchange/iCloud calendar layer with an EU region | $10/month including five accounts |
| Social listening | Deferred | Brand24 with API costs more than the rest of the pilot stack combined | $0 during pilot |

Expected fixed pilot base: **$336.49/month + €49/month**, before VAT, email/message usage, Meta template fees and webinar overage.

Primary pricing evidence: [Mailgun](https://www.mailgun.com/pricing/), [360dialog](https://360dialog.com/pricing), [Twilio UK SMS](https://www.twilio.com/en-us/sms/pricing/gb), [Ayrshare](https://www.ayrshare.com/pricing/), [Whereby Embedded](https://whereby.com/information/embedded/pricing), [Nylas](https://www.nylas.com/pricing/).

## Activation order

1. Complete business identity, domain, privacy, terms, deletion and channel-specific consent evidence.
2. Create provider accounts without connecting them to Growth HQ.
3. Set the deployment's single `PORTAL_PRODUCT_PROFILE` value to `property_predator_growth`; the reusable repository example defaults to Relaunch72.
4. Store credentials in the deployment secret manager, never in chat, source control or browser-rendered configuration.
5. Connect one provider sandbox/test rail at a time and validate signed inbound webhooks.
6. Run only seed contacts owned by the team through draft, immutable version, approval, consent, queue, provider receipt and reconciliation.
7. Enable one Property Predator channel for a capped internal pilot.
8. Open a tiny real audience only after opt-out, suppression, bounce/failure and duplicate-webhook tests pass.
9. Expand volume and add external white-label workspaces only after audit and cost evidence are clean.

## Local configuration preflight

Run `npm run pilot:preflight` from the repository root after the deployment
settings have been entered in the host secret manager. The command is deliberately
non-mutating: it does not open a database connection, import a provider SDK, call
a provider API, deliver a message or print a configured value.

The first gate is intentionally narrow:

- Production Growth HQ foundation and least-privilege runtime database URL shapes.
- A dedicated Property Predator workspace and a declared cap of 1–25 owned internal seed recipients; runtime enforcement remains a manual proof gate.
- No live adapter is composed today. Before one is added, implement and test a runtime-enforced provider-effect kill switch at every composition and dispatch boundary; an environment declaration is not proof.
- Mailgun email configuration, EU region, verified sender metadata, signed delivery-event callback and suppression synchronisation.

WhatsApp (360dialog), UK SMS (Twilio), social publishing (Ayrshare), webinars
(Whereby) and calendar/scheduler (Nylas) are reported separately as deferred
rails. Their missing configuration cannot block the email review gate; partially
entered configuration is labelled incomplete instead of being mistaken for a
connection.

A successful result means **ready for manual activation review**, not live-ready.
Database schema readiness, provider-console ownership/billing, authenticated
test webhooks, seed-contact consent/opt-out evidence and a separate channel-specific
activation approval remain mandatory. Configuration names are documented in
`.env.example`; real values belong only in the deployment secret manager.

The checked-in `render.yaml` remains the deliberately ephemeral Relaunch72
payments test sandbox (`free`, mock builds, no PostgreSQL portal cutover). It is
not a Property Predator production blueprint and must not be made live merely by
adding credentials. A separately reviewed production service definition, durable
PostgreSQL deployment and rollback plan are still required.

The current server also leaves automatic PostgreSQL onboarding deliberately
locked, and several new operations screens are still powered by labelled TEST
fixtures. Before external access, provision the founder workspace/operator through
an audited operator path and replace each pilot-facing fixture with a workspace-
scoped production read. The preflight prints both as manual proof gates instead of
pretending an environment variable can prove them.

## Credential and verification pack

Common business evidence:

- Legal company name, Companies House number, registered/trading address and VAT ID.
- Authorised director identity, corporate email and business phone.
- Live HTTPS domain with DNS control.
- Privacy Policy, Terms, data-deletion instructions and support contact.
- Property Predator name, logos, icons and product description.
- Meta Business Portfolio/Page/Instagram, LinkedIn Company Page, TikTok business/developer account and X developer account where required.
- Separate consent and suppression evidence for email, SMS, WhatsApp and social direct messages.

Secrets/configuration to place directly into the deployment secret manager:

- Mailgun API key and signing key, EU region, verified sending domain, From identities and signed-event callback.
- 360dialog API key, Meta Portfolio/App/configuration IDs, WABA/channel IDs, number and webhook signing configuration.
- Twilio Account SID, restricted API key, Messaging Service SID, Number SID and UK Regulatory Bundle references.
- Ayrshare API key, per-workspace Profile Key, RSA private key, domain ID and webhook HMAC secret.
- Whereby API key, webhook secret and approved HTTPS origins.
- Nylas application ID/API key, EU region, webhook secret, callback URLs and Google/Microsoft OAuth applications.

## Non-negotiable gates

- Provider webhooks must be authenticated, idempotent and reconciled against durable operation IDs.
- The browser never supplies workspace identity, recipient address, provider credential or approval truth.
- Exact immutable content/message hash, current channel consent and human approval are rechecked immediately before queueing.
- A provider acceptance is not called delivered; delivery/read/failure truth comes from signed callbacks or reconciliation.
- Per-channel spend and volume caps stay at the lowest practical setting during pilot.
- Emergency pause, suppression and credential-revocation procedures are tested before external traffic.
- UK PECR sender identification and working opt-out requirements apply to email, SMS, WhatsApp and social direct marketing. See the [ICO electronic marketing guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/electronic-mail-marketing/).

## Known trade-offs

- Ayrshare's account-linking page can be branded but its approved Ayrshare origin cannot be completely hidden. X also requires separate OAuth/API funding and does not provide real-time direct-message webhooks under Ayrshare BYO credentials.
- Mixpost Enterprise is the later cost-control option at $1,199 once, but it transfers every social developer app, review, token refresh and platform-policy change to us.
- 360dialog/Meta verification and WhatsApp template approval can take days; begin this before the planned launch date.
- Brand24 Business plus API is approximately $698–$798/month and some Meta/X listening results omit full text, so listening remains phase two.
- Cal.com remains useful internally, but new Platform signups stopped in December 2025; it is not the multi-tenant calendar foundation.

## Separate authority required before activation

Provider setup may begin only after the user explicitly authorises account creation/purchase and names the approved providers, budget cap and Property Predator production workspace. Live delivery still requires a second, channel-specific activation approval after sandbox evidence is reviewed.
