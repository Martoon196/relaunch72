# Property Predator Growth HQ — controlled production deployment

Status: **dark production deployed and verified** on 26 August 2026 at
`e18acd1`. Provider effects and email delivery remain OFF; emergency pause
remains ON.

Migration `0029_property_predator_sso_identity.sql` and the shared-login
runtime are prepared in the current branch but are **not applied or deployed**
by this document update. The production database remains on its recorded
schema-28 state until the separately authorised schema-29 cutover below.

The production manifest is [`render.property-predator.production.yaml`](../render.property-predator.production.yaml). It creates two new process-isolated services; it does not alter or reuse the free Relaunch72 payments sandbox in `render.yaml`.

No step in this document authorises customer-data import, customer email, social publishing, payments, WhatsApp, SMS or webinar effects. The first deployment is a locked control plane with email effects off.

## Fixed boundary

| Concern | Production-pilot decision |
|---|---|
| Runtime | One Render Starter web service and one isolated Starter email worker, Frankfurt |
| Canonical origin | `https://hq.propertypredator.com` |
| Database | A separate Neon production project; PostgreSQL is the only durable portal store |
| Database access | Four portal roles plus `r72_mailgun_webhook_command` in the web service; only `r72_mailgun_worker_command` in the outbound worker |
| Shared login | Optional Property Predator authorization-code + PKCE bridge; checked-in production switch OFF; native HQ password remains break-glass |
| Email | Mailgun EU signed-ingress slot only; outbound key intentionally absent and delivery disabled |
| Payments | No Stripe secrets; checkout and subscriptions must remain unavailable |
| Imports | No import credential, job, hook or automatic seed |
| Deploys | Manual only; the Blueprint has `autoDeployTrigger: off` |
| Release probe | `/health` for liveness and `/ready` for fail-closed deployment readiness |

The web service has no persistent disk because JSON journals are not production truth. Any remaining file-backed payment/build code is inaccessible as a live product path and must not receive production credentials.

## Cost guard

Current public prices checked on 26 August 2026:

- Render Starter begins at **$7/month** for a continuously running 0.5 CPU / 512 MB service. The process-isolated pilot uses two, so its expected Render base is **$14/month**. Render compute is prorated; verify the live checkout amount against [Render pricing](https://render.com/pricing) before creating either service.
- Mailgun Basic is **$15/month** before usage. See [Mailgun pricing](https://www.mailgun.com/pricing/).
- Neon Launch has no fixed monthly minimum. It is usage-based at **$0.106/CU-hour** plus **$0.35/GB-month** storage; Neon's intermittent 1 GB example is approximately **$15/month**. See [Neon pricing](https://neon.com/pricing).

Therefore the fixed base is approximately **$29/month** before VAT and email usage. A small intermittent Neon production database brings the expected starting total to approximately **$44/month**, but Neon is variable. For cap review, conservatively treat one US dollar as one pound rather than relying on a favourable exchange rate: the expected base is then £44 with £56 headroom. Set provider budget alerts before deployment and stop before purchase if the checkout subtotal, projected variable use or required upgrade could take recurring spend to £100/month before VAT. No account or billing mutation is performed by this deployment artifact.

## 1. Production Neon boundary

The separate `property-predator-growth-hq-production-eu` Neon project now exists in AWS Frankfurt. It was created empty; no project was cloned, promoted, reset or repurposed.

1. The production compute is capped at 0.25–1 CU and scales to zero after five inactive minutes.
2. All 27 reviewed forward-only migrations through `0027_property_predator_founder_bootstrap.sql` were applied on 26 August 2026. The final migration was rehearsed through the same atomic connector transaction on the disposable database before production. Never place the direct administrative connection or `DATABASE_MIGRATOR_URL` in Render.
3. Every production pool must prove the same opaque `PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID`; the underlying singleton table remains unreadable to runtime roles.
4. Run the one-shot founder bootstrap only while the production database is still empty. Set `PROPERTY_PREDATOR_FOUNDER_BOOTSTRAP_CHANGE_REFERENCE` to the reviewed lowercase change reference and `PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID` to the exact installation UUID, then run `npm run founder:bootstrap`. The command re-verifies every local/database migration checksum and the installation UUID before one transaction reuses `app_private.provision_customer_workspace` to create only Property Predator, Growth HQ, its pending founder, the default Sales pipeline, one Mailgun EU connection row, one dark control event and the hashed owned seed attestation for `office@propertypredator.com`.
5. Open the printed `127.0.0.1` handoff URL once. It is memory-only, has no-store headers, closes after its first response or 20 minutes and never writes the setup URL to disk. Copy the founder setup link and the four Render values, then destroy the page. A replay returns the same database IDs but cannot claim its newly generated raw setup token is valid; use the audited setup-reissue path if the first link is lost.
6. The Mailgun connection is logical configuration only. It is `active` because signed-webhook/readiness correlation requires a canonical live connection, but it stores no credential, creates no endpoint or inbox, makes no provider call and is governed by an append-only control event with provider effects OFF, delivery OFF and emergency pause ON.
7. After migrations create the application roles, issue separate random credentials for:
   - `r72_web`
   - `r72_identity_command`
   - `r72_crm_command`
   - `r72_content_command`
   - `r72_content_adapter`, used only through `DATABASE_CONTENT_ADAPTER_URL` for active-session-fenced company-asset metadata reads
   - `r72_mailgun_worker_command`, used only through `DATABASE_MAILGUN_WORKER_URL`
   - `r72_mailgun_webhook_command`, used only through `DATABASE_MAILGUN_WEBHOOK_URL`
8. Put each role's pooled Neon URL into only its matching Render secret slot. The URL username must exactly match the role name. Keep `DATABASE_SSL_MODE=verify-full`.
9. Run `npm run db:check` with the direct migration identity outside the web service. Then start the release with only the seven runtime identities.

The production workspace and first operator must be created through an audited operator path. Do not run demo seeding or import legacy/customer contacts during this pilot.

## 2. Render Blueprint creation

1. In Render choose **New → Blueprint** and connect the Relaunch72 repository.
2. Explicitly set the Blueprint path to `render.property-predator.production.yaml`. Do not use the default `render.yaml`.
3. Keep Blueprint Auto Sync disabled. The service itself also has automatic deploys disabled.
4. Confirm the proposed services are `property-predator-growth-hq` and `property-predator-email-worker`; both are in Frankfurt, use Starter and have exactly one instance.
5. Enter every `sync:false` value in Render's secret manager. Do not paste credentials into chat, source control, build arguments or public environment groups.
6. Confirm the web service has no `DATABASE_MAILGUN_WORKER_URL` or `MAILGUN_API_KEY`, and the worker has no portal-role URL, `DATABASE_MAILGUN_WEBHOOK_URL`, `SESSION_SECRET`, `MAILGUN_SIGNING_KEY` or `MAILGUN_API_KEY` during the dark deployment.
7. Confirm there is no Stripe, Postmark, Brevo, Anthropic, generic database, migrator, import or customer-list credential.
8. Do not trigger a deploy until `/ready` and the named email-worker entrypoint exist in the reviewed commit and the readiness contracts below are tested.

Render runs `npm ci`, type-checking and the complete local test suite before it can start the new release. A failed build or failed `/ready` probe must leave the prior successful release serving.

## 3. DNS — fill only after Render creates the service

Do not guess Render's target. After service creation, copy the exact generated `onrender.com` hostname from the Render dashboard.

At the DNS provider for `propertypredator.com`, review and then create:

| Type | Host/name | Target/value | TTL |
|---|---|---|---:|
| CNAME | `hq` | `property-predator-growth-hq.onrender.com` | Automatic |

Before adding it, remove only conflicting `A`, `AAAA` or `CNAME` records for the exact `hq` host after confirming they are unused. Do not alter apex, `www`, mail or unrelated subdomains.

In Render, add/verify `hq.propertypredator.com` and wait for its managed TLS certificate. If Cloudflare manages DNS, use **DNS only** while Render verifies the hostname and set SSL/TLS to Full; proxying can be reviewed after verification. If the zone uses CAA records, ensure they permit `letsencrypt.org` and `pki.goog` before requesting the certificate. Render's current procedure is documented at [Custom Domains](https://render.com/docs/custom-domains).

The web manifest disables the Render subdomain. Do not re-enable it as a second production origin without a reviewed reason.

## 4. Mailgun account and DNS

Create Mailgun in its EU region and keep delivery disabled in Growth HQ.

1. Add the dedicated sending subdomain `mg.propertypredator.com` in Mailgun.
2. Copy the exact SPF, DKIM, tracking and verification records returned by Mailgun. Do not pre-invent values or replace the domain's existing apex mail records.
3. Store the webhook signing key only in the web service. Do not put an API key or sending identity in either Render process during the dark deployment. A later activation change may add the API key only to the isolated worker; neither process may ever receive both credentials.
4. Configure the Mailgun event webhook as `https://hq.propertypredator.com/api/provider-webhooks/mailgun/events`; the checked-in router authenticates the untouched signature fields before event parsing or persistence.
5. Treat DNS and suppression synchronisation as unverified until each has direct console/test evidence; those claims are not accepted from editable environment labels.
6. Keep both provider-effect switches false and the emergency pause true. Mailgun test events may prove signed ingress; they do not authorise delivery.

Mailgun signs webhook events. The application must verify timestamp, token and signature over the untouched provider fields before parsing or persistence. See [Mailgun's webhook-security documentation](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks).

## 5. Release and readiness gates

`GET /health` is process liveness. It must return HTTP 200 but is not sufficient for release: the existing response deliberately reports payment blockers while payments are disabled.

`GET /ready` is the required Render health-check path. It must not return success until the reviewed application implementation proves at least:

- exact bundled migration ledger through `r72_web`;
- one exact database-installation UUID independently proven by all seven runtime identities;
- PostgreSQL portal mounted with no fallback to legacy JSON stores;
- exact `r72_identity_command`, `r72_crm_command`, `r72_content_command` and metadata-only `r72_content_adapter` role readiness;
- dedicated `r72_mailgun_webhook_command` identity ready through `DATABASE_MAILGUN_WEBHOOK_URL`; worker readiness remains isolated from web readiness;
- provider effects false and emergency pause true;
- no public lead capture, checkout, subscription, demo seed or automatic import;
- the dedicated pilot workspace and internal-seed policy are valid;
- no secret or connection value is returned in the body.

After `/ready` is green, manually verify:

1. `GET /portal` redirects to the protected login rather than rendering demo data.
2. `GET /portal/login` is HTTPS and returns the Property Predator product profile.
3. `GET /health` reports the portal ready while checkout, subscriptions and public leads remain unavailable.
4. `npm run pilot:preflight` prints setting names only and makes no database or provider call. Its result is configuration evidence, not activation approval.
5. An authenticated Mailgun test webhook is accepted once, an exact replay is idempotent, and invalid/replayed/expired signatures fail closed.
6. No outbound request occurs while either effect switch is false or emergency pause is true.

The first external send still requires a separate activation approval naming up to ten owned internal seed recipients.

The background worker has no public HTTP endpoint. Its entrypoint must fail startup unless `DATABASE_MAILGUN_WORKER_URL` authenticates as exactly `r72_mailgun_worker_command`, the migration ledger is exact, all policy/cap values are valid and its effects state is disabled. It must not call Mailgun merely to prove readiness. Render process health plus a redacted worker-readiness log/audit record forms its first-deploy evidence.

The existing `pilot:preflight` command is an aggregate operator report: it expects evidence for web and worker roles together. It is **not** a per-process boot gate. Never add `DATABASE_MAILGUN_WORKER_URL` to the web service, or portal/`DATABASE_MAILGUN_WEBHOOK_URL` identities to the worker, just to make that aggregate report green. A deployment-level release check may combine redacted evidence from both isolated processes.

## 6. Rollback

Before every deploy, set/confirm:

```text
PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false
PROPERTY_PREDATOR_EMAIL_DELIVERY_ENABLED=false
PROPERTY_PREDATOR_EMAIL_EMERGENCY_PAUSED=true
```

If readiness or acceptance fails:

1. Keep the three controls in the state above.
2. In Render, roll back to the last known-good deploy.
3. Do not reverse a forward-only database migration. Ship a reviewed forward repair if schema work is implicated.
4. If provider integrity is uncertain, revoke the affected Mailgun credential before resuming ingress tests.
5. Record the release commit, failed proof, rollback deploy and operator in the audit log.

No rollback may enable a provider effect or restore an older credential without a fresh readiness run.

## 7. Secret rotation

- **Database roles:** rotate one role at a time. Create the new credential, update only the matching Render slot, manually deploy/restart, prove role and schema readiness, then revoke the old credential.
- **Mailgun API key:** keep delivery paused, create the replacement, update Render, prove API authentication without sending, then revoke the old key.
- **Mailgun signing key:** accept the new key only after an explicit rotation window is implemented. Prove new signed test events, then remove the old verifier. Never silently accept both indefinitely.
- **Session secret:** rotating it signs out every operator. Schedule the change, update the generated value, redeploy and verify login/CSRF before access is restored.
- **Property Predator SSO client secret:** use a dedicated secret that is not
  `SESSION_SECRET` or a main-site signing/JWT secret. Keep SSO disabled, rotate
  both applications together, prove a seed login, then retire the old value.

Never log a secret, URL, email address or raw webhook body during rotation. Evidence records contain redacted identifiers and hashes only.

## 8. Operator Action Centre schema-28 cutover

Migration `0028_operator_action_control_foundation.sql` adds only the
workspace-scoped assignment and snooze overlay for the authoritative Action
Centre. It does not complete source work, import leads or enable a provider
effect.

This is an exact-ledger cutover: the schema-27 web release must reject schema
28, and the schema-28 web release must reject schema 27. Apply the migration
and immediately deploy the exact reviewed commit. Expect a short fail-closed
readiness window between those two actions; roll forward if either step needs
repair.

Before the cutover:

1. Prove the founder receipt already exists and do not attempt to rerun the
   one-time founder bootstrap. Its reviewed boundary remains permanently
   pinned to migrations `0001`–`0027`.
2. Prove the disposable database passes the full integration suite at schema
   28 and record the exact release commit.
3. Keep provider effects OFF, email delivery OFF and the emergency pause ON.
4. Confirm the exact schema-28 release is available to Render before changing
   the production ledger.

After the cutover, require all of the following before accepting the release:

- `/ready` returns HTTP 200 with no blockers on the exact 28-file ledger;
- an authenticated owner can open `/portal/actions`;
- the queue contains only production database facts and never fixture labels;
- assignment and snooze commands are CSRF-protected, replay-safe and leave the
  originating task, journey, approval or provider record untouched; and
- the web and dark worker readiness evidence still reports zero provider
  effects.

## 9. Shared Property Predator login — schema-29 cutover (prepared, not deployed)

Migration `0029_property_predator_sso_identity.sql` adds only the immutable
Property Predator issuer/subject link, minimal affiliate/source metadata and a
nullable external-identity provenance marker on otherwise ordinary opaque HQ
sessions. It creates no user, organisation, workspace or membership, imports no
affiliate/customer data and grants no provider capability.

This is another exact-ledger cutover. A schema-28 release must reject schema 29,
and the schema-29 release must reject schema 28. Rehearse on the explicitly
disposable test database, apply the one forward migration, then immediately
deploy the exact reviewed commit. Do not rerun the schema-27 founder bootstrap.

Before applying migration 0029:

1. Confirm the existing HQ founder user UUID belongs to canonical contact email
   `office@propertypredator.com` and already has an active Growth HQ membership.
   Put that UUID in `PROPERTY_PREDATOR_SSO_BOOTSTRAP_USER_ID`; never guess it.
2. Confirm the main-site founder/admin Google identity is exactly
   `martin.howard1984@gmail.com`, is Google-verified, and put only that address
   in `PROPERTY_PREDATOR_SSO_BOOTSTRAP_EMAILS`. The two emails intentionally do
   not match: the immutable external subject is linked to the pre-existing HQ
   user, while the canonical HQ contact email remains unchanged.
3. Configure client id exactly `growth-hq`; issuer exactly
   `https://propertypredator.com`; authorize URL exactly
   `https://propertypredator.com/sso.html`; token URL exactly
   `https://propertypredator.com/api/auth/sso/token`; and callback exactly
   `https://hq.propertypredator.com/portal/auth/property-predator/callback`.
4. Generate one dedicated 32+ character client secret shared only by the two
   SSO backends. It must not equal `SESSION_SECRET` or any JWT/Google secret.
5. Keep `PROPERTY_PREDATOR_SSO_ENABLED=false` in the reviewed first schema-29
   release. The Blueprint declares this switch `sync: false`: set it directly
   on the Growth HQ web service and use **Save and deploy**, so later Blueprint
   syncs preserve the reviewed operator value. Keep provider effects OFF, email
   delivery OFF and emergency pause ON. SSO activation does not authorise any
   customer communication.

Activation is a separate configuration step after both applications are live:

1. Set the exact same client id/secret/callback contract on the main site and
   Growth HQ, then enable SSO only on the web service. The email worker receives
   none of these values.
2. Verify `/portal/login` shows **Continue with Google**, **Continue with
   Property Predator**, and the existing Growth HQ password form.
3. Use the owned founder Google identity. The browser carries only a one-use
   authorization code, PKCE state/verifier transaction and the resulting opaque
   HQ cookie. The client secret travels by HTTPS Basic authentication on the
   server-to-server token request; no main JWT, refresh token or Google token is
   retained by HQ.
4. Confirm the first verified assertion activates and links the pre-existing
   founder only, retires any outstanding one-time setup link and does not change
   `office@propertypredator.com`.
5. Confirm a returning issuer/subject signs in without bootstrap configuration;
   an arbitrary affiliate gets no HQ user or membership; suspended memberships
   fail closed; every callback clears its short-lived transaction cookie; and
   logout/revocation still operates on the normal opaque HQ session.

Federated pilot sessions expire after 24 hours while password sessions retain
their existing lifetime. This limits stale access after a main-site account
change. An authenticated main-site lifecycle revocation webhook or backchannel
introspection contract must revoke sessions by `external_identity_id` before
shared login expands beyond the owned founder pilot.

If any check fails, set `PROPERTY_PREDATOR_SSO_ENABLED=false` and redeploy/restart
the web service. Password login remains the break-glass path. Do not reverse
migration 0029; ship a forward repair. Full protocol and data-boundary details
are in [`property-predator-shared-login.md`](property-predator-shared-login.md).

## Current deployed state and remaining activation blockers

- Render web and worker services are live in Frankfurt on the same reviewed
  commit, `16f1f88`, with manual deploys and the Render subdomain disabled.
- `hq.propertypredator.com` is a verified CNAME to the exact Render target and
  Render has issued its managed certificate.
- Live `GET /health` and `GET /ready` both return HTTP 200. The readiness body
  is exactly `{"ready":true,"blockers":[]}`. Health reports the PostgreSQL
  portal and signed Mailgun ingress ready while checkout, subscriptions and
  public lead capture remain unavailable.
- `GET /portal` redirects unauthenticated requests to `/portal/login`; no demo
  portal or JSON fallback is mounted.
- The worker's live redacted readiness record proves `dark-production`, exact
  `r72_mailgun_worker_command`, database boundary ready, provider effects OFF,
  delivery OFF, emergency pause ON, no dispatch loop, no provider adapter and
  zero provider network calls. The pilot remains limited to one owned internal
  seed, ten recipients, ten messages per run and 100 messages per UTC month.
- The separate Frankfurt Neon project is on the exact 28-file ledger. All six
  restricted role credentials authenticate through only their matching Render
  slots. No owner or migrator URL is present in either service.
- The founder receipt proves one internal Property Predator / Growth HQ
  workspace, its pending owner, the dark Mailgun EU connection and the hashed
  owned seed. It imported no customer, contact, inbox, consent, message or
  provider-operation data.
- Mailgun EU and `mg.propertypredator.com` are configured. SPF, rotating DKIM
  and tracking DNS resolve publicly. A domain-level webhook now covers all
  eight supported delivery, engagement, failure and suppression event classes
  at the signed Growth HQ endpoint.
- Mailgun's fabricated test event reached the live route and was rejected as
  unmatched with HTTP 503. This is expected fail-closed evidence: synthetic
  provider IDs cannot create delivery history. It caused no outbound effect or
  customer write.
- No Mailgun sending API key exists in Render. The real adapter and database
  authorization boundary are implemented and tested but remain deliberately
  uncomposed; the live worker cannot send.

Before any external delivery:

1. Reissue the founder setup link against the canonical `.com` origin if the
   first memory-only handoff link was lost, then prove login and CSRF.
2. Reconcile Mailgun suppression truth and retain direct test evidence.
3. Name no more than ten owned internal seed recipients and obtain the separate
   final activation approval.
4. Add a restricted Mailgun sending key only to the isolated worker, compose
   the reviewed adapter, repeat all release gates and keep the emergency pause
   ON until the final activation moment.
5. Keep TEST fixture projections inaccessible to external users and import no
   customer data without a separately reviewed import rehearsal.

## Schema-28 cutover evidence — 26 August 2026

The authorised Operator Action Centre cutover completed as a forward-only
release with every provider effect still disabled:

- the migration runner first proved the production ledger was a valid
  27-migration prefix with only
  `0028_operator_action_control_foundation.sql` pending;
- the atomic migration reported `1 applied, 27 already current`, followed by
  `Database schema is current`;
- the production ledger contains 28 migrations and records migration 0028 with
  SHA-256
  `745a613cd30e967cc8c9371a096cf2c8e0498c84fa58bac031f4acd945c691fa`;
- the new controls, append-only audit-event and command-receipt relations exist
  and contained zero rows immediately after cutover;
- Render deployed exact commit
  `16f1f88f3a0219874b3e5bb22e2d5606737f20aa` to web deploy
  `dep-da7imt15efls73e3vneg` and worker deploy
  `dep-da7in0rbc2fs73d04k4g`;
- both independent Render builds passed 1,208 tests: 1,194 passed, 14 skipped
  by design and zero failed;
- live `/ready` returned HTTP 200 with exactly
  `{"ready":true,"blockers":[]}`;
- live `/health` returned HTTP 200 with portal readiness true while checkout,
  subscriptions, public lead capture and external-event ingestion remained
  unavailable;
- unauthenticated `/portal` and `/portal/actions` both redirected to
  `/portal/login`, whose response retained PropertyPredator branding; and
- the live worker emitted its redacted `dark-production` readiness record for
  `r72_mailgun_worker_command`, with provider effects false, email delivery
  false, emergency pause true, no dispatch loop, no provider adapter and zero
  provider network calls.

No founder bootstrap was rerun, no customer or contact was imported, no live
assignment/snooze command was submitted, and no email or provider effect was
enabled. Authenticated founder rendering of `/portal/actions` remains a manual
session check after the founder completes or resumes sign-in; the disposable
schema-28 integration proof remains authoritative for command mutation and RLS
behaviour.
