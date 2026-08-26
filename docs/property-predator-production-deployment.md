# Property Predator Growth HQ — controlled production deployment

Status: **prepared, not deployed**. Last reviewed 26 August 2026.

The production manifest is [`render.property-predator.production.yaml`](../render.property-predator.production.yaml). It creates two new process-isolated services; it does not alter or reuse the free Relaunch72 payments sandbox in `render.yaml`.

No step in this document authorises customer-data import, customer email, social publishing, payments, WhatsApp, SMS or webinar effects. The first deployment is a locked control plane with email effects off.

## Fixed boundary

| Concern | Production-pilot decision |
|---|---|
| Runtime | One Render Starter web service and one isolated Starter email worker, Frankfurt |
| Canonical origin | `https://hq.propertypredator.com` |
| Database | A separate Neon production project; PostgreSQL is the only durable portal store |
| Database access | Four portal roles plus `r72_mailgun_webhook_command` in the web service; only `r72_mailgun_worker_command` in the outbound worker |
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
   - `r72_mailgun_worker_command`, used only through `DATABASE_MAILGUN_WORKER_URL`
   - `r72_mailgun_webhook_command`, used only through `DATABASE_MAILGUN_WEBHOOK_URL`
8. Put each role's pooled Neon URL into only its matching Render secret slot. The URL username must exactly match the role name. Keep `DATABASE_SSL_MODE=verify-full`.
9. Run `npm run db:check` with the direct migration identity outside the web service. Then start the release with only the six runtime identities.

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
| CNAME | `hq` | `<EXACT HOST RETURNED BY RENDER>.onrender.com` | 300 |

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
- one exact database-installation UUID independently proven by all six runtime identities;
- PostgreSQL portal mounted with no fallback to legacy JSON stores;
- exact `r72_identity_command`, `r72_crm_command` and `r72_content_command` role readiness;
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

Never log a secret, URL, email address or raw webhook body during rotation. Evidence records contain redacted identifiers and hashes only.

## Current blockers — service creation may be prepared, but deployment must not start yet

- The separate Frankfurt Neon project is on the exact 27-file ledger and the one-shot audited founder bootstrap has completed. Six fresh role credentials still need to be issued into their exact Render secret slots.
- The founder receipt proves one internal Property Predator / Growth HQ workspace, its pending owner, the dark Mailgun EU connection and the hashed owned seed. It imported no customer, contact, inbox, consent, message or provider-operation data.
- `/ready`, live dependency rechecks, canonical-host enforcement and the database-installation proof now exist, but production credentials and binding evidence are not yet configured.
- The named `serve:property-predator-email-worker` entrypoint now exists and is tested. It is deliberately inert: it verifies schema, database identity and policy, then idles without importing a provider adapter or reading an API key.
- The real Mailgun adapter and database authorization boundary are implemented and tested, but deliberately not composed into the dark worker. Composition and any outbound key require the separate final activation approval.
- The authenticated Mailgun router is mounted in the working release, but its production signing key, dedicated database identity and signed provider test-event evidence do not yet exist.
- Mailgun account ownership, EU region, sending-domain DNS, suppression evidence and billing cap are not yet proven.
- Pilot-facing TEST fixture projections must be replaced or kept inaccessible before external users receive access.
- No production deploy, DNS mutation, purchase or live send has been performed by this artifact-only change.
