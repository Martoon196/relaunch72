# Property Predator Growth HQ — controlled live pilot

Status: activation record, updated 29 August 2026. No provider effect is
authorised by this document.

## Pilot stack

| Rail | Current provider | Current operational posture |
|---|---|---|
| Customer email | Mailgun EU | Account/domain configured per the founder checkpoint; permission-bound worker and signed receipt/inbound paths are built; controlled owned-recipient acceptance remains |
| WhatsApp | Direct Meta Cloud API | Worker and raw signed webhook/challenge paths are built; exact app/WABA/phone/template and owned-test evidence remain |
| UK SMS | Twilio Messaging | Scheduled and under active implementation; it is a separate rail from direct Meta WhatsApp |
| Owned X publishing | Ayrshare with X credentials | Isolated worker is built; exact owned profile/account binding and one approved test post remain |
| Social DMs | Not composed | The shared Conversion Inbox model is ready, but no live social-DM adapter may be claimed |
| Webinar | Whereby deferred | Existing provider foundation remains outside the first activation strike |
| Calendar | Nylas deferred | Existing provider foundation remains outside the first activation strike |
| Social listening | Deferred | No first-pilot live adapter or spend is authorised |

Provider prices are deliberately not frozen in this decision record. Confirm the
current provider plan, tax, usage and regional terms immediately before purchase.

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

The gate is intentionally exact:

- Production Growth HQ foundation and least-privilege runtime database URL shapes.
- A dedicated Property Predator installation/workspace and exact function-only
  command, worker and webhook identities.
- Mailgun EU configuration, verified sender metadata, signed callbacks and
  suppression synchronisation.
- Direct Meta WhatsApp configuration and exact encrypted recipient binding.
- Ayrshare/X owned-profile configuration and exact connection evidence.
- Existing durable enqueue and immediate pre-call effects/pause fences.

Twilio SMS is a separate current build. Webinars, calendar/scheduler, social DMs
and listening remain deferred rails. Their missing configuration cannot block an
owned email, WhatsApp or X acceptance review; partially entered configuration is
labelled incomplete instead of being mistaken for a connection.

A successful result means **ready for manual activation review**, not live-ready.
Database schema readiness, provider-console ownership/billing, authenticated
test webhooks, seed-contact consent/opt-out evidence and a separate channel-specific
activation approval remain mandatory. Configuration names are documented in
`.env.example`; real values belong only in the deployment secret manager.

The checked-in production Blueprint contains isolated web/worker slots and exact
database identities. That composition is not permission to deploy or activate a
provider merely by adding credentials; production migration, deployment and each
owned-test effect still require separate founder approval.

Automatic customer onboarding remains deliberately locked, and several new
operations screens are still powered by labelled TEST fixtures. The separate
one-shot founder bootstrap is an offline, empty-database-only operator path: it
creates the internal Property Predator / Growth HQ boundary and a credential-free
Mailgun EU configuration row under a fail-closed control event. It is not a
customer-import or public-signup path. Before external access, run that audited
bootstrap and replace each pilot-facing fixture with a workspace-scoped production
read. The preflight prints both as manual proof gates instead of pretending an
environment variable can prove them.

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

- Mailgun domain-sending key and separate webhook signing key, EU region,
  verified sending domain, exact From identity and signed-event callback.
- Meta App ID, WABA ID, phone-number ID, webhook App Secret/verify token,
  encrypted outbound access-token binding and approved parameter-free template.
- Twilio Account SID, restricted outbound API key SID/secret, Messaging Service
  SID, owned sender/number, webhook authentication material and applicable UK
  regulatory evidence.
- Ayrshare API key, encrypted profile binding/key version, X OAuth 1 API
  key/secret and owned-profile link evidence.
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
- Meta verification and WhatsApp template approval can take time; begin this
  before the planned launch date. 360dialog is not the current transport.
- Brand24 Business plus API is approximately $698–$798/month and some Meta/X listening results omit full text, so listening remains phase two.
- Cal.com remains useful internally, but new Platform signups stopped in December 2025; it is not the multi-tenant calendar foundation.

## Separate authority required before activation

Provider setup may begin only after the user explicitly authorises account creation/purchase and names the approved providers, budget cap and Property Predator production workspace. Live delivery still requires a second, channel-specific activation approval after sandbox evidence is reviewed.
