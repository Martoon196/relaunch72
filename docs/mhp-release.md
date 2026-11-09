# Martin Howard Property member app

MHP-DESK-001 adds `app.martinhowardproperty.co.uk` to the existing Growth HQ Render service. The public GitHub Pages site and the Property Predator host keep their existing routes. MHP uses the shared canonical PostgreSQL identity/CRM and its own session audience, host-only cookie, transactional email and Stripe configuration.

## Member experience

The new host provides password sign-in, email sign-in links, password reset, Your Desk and `/app/account`. A verified eligible member gets one private account workspace; Deal Desk/course/Room members also get one investor business on first login. Kit buyers get their account and purchases. Mentoring and partnership add email workflow and LeadRelay, subject to the existing provider/installation boundaries. LeadRelay entitlement alone does not create or broaden an installation grant.

Both `martin.howard1984@gmail.com` and `office@propertypredator.com` are seeded as canonical users with owner memberships on the MHP organization, and permanent `source='manual'` entitlements for all thirteen v3 products (and retained historical Kit access). Existing credentials/status are preserved; a new user remains pending until they prove email ownership. No password or verified identity is invented. These owners get full Partnership workspace capabilities and `/hq` without checkout.

`/hq` lets a verified MHP owner select an existing person or enter a new email, choose a product, optionally set an expiry, and record an audit reason. The same entitlement system grants the product features; staff do not become administrators merely by receiving a product. Each action records actor, target, product, timestamp and reason, and repeated submission of the same command is idempotent. New members use the MHP email sign-in page; granting access does not send an invitation automatically. Manual grants create no purchases or payments. No MHP revenue report or founders' counter exists yet; future reports/counters must count paid purchases/payment evidence, never entitlement totals.

Programme provisioning and the founder test business remain at `/portal/investors?view=programme`. Mentee brands, domains and encrypted mailbox data reuse the current Investor services. Google/Microsoft mailbox connection is separate from login; Google SSO remains on Property Predator.

The founder approved the course/Room versus mentoring/partnership mapping and delegated refund-window judgement. The implementation uses 30 days from the first payment for the enabled catalogue, including instalment plans, and seven days of read-only access after a full refund. The revised £47 Deal Desk has an explicit 14-day refund window and now has its five-calculator, saved-file, verdict and credit journey implemented. Paid activation still requires the Stripe sandbox checks. See [Stripe operations](mhp-stripe-operations.md) for exact amounts, provider setup and billing limits.

## DNS and Render

Existing service: `srv-da7fv1gn74is73d58hb0`, `property-predator-growth-hq`, Frankfurt. Add **only** `app.martinhowardproperty.co.uk` to that service's custom domains. Do not move the public apex or www site.

| DNS type | Name | Target |
| --- | --- | --- |
| CNAME | app | property-predator-growth-hq.onrender.com |

Render's generated subdomain can remain disabled; it is still the CNAME target. Verify DNS and the TLS certificate in Render before marking the organization-domain row verified. The migration seeds it as pending, so MHP readiness cannot falsely claim a verified host. DNS lookup on 28 October returned NXDOMAIN; this release document is not live verification.

The Render connector exposes service and deployment operations but no custom-domain operation in this session. Add/verify the hostname in [the service settings](https://dashboard.render.com/web/srv-da7fv1gn74is73d58hb0/settings). The user retains their browser/computer control.

## Environment

Keep `PORTAL_PRODUCT_PROFILE`, `PORTAL_BASE_URL`, PP SSO, global Stripe/Brevo/Postmark variables and existing PP safety gates unchanged. `MHP_ENABLED=true` explicitly mounts the second host. It starts with `MHP_BILLING_ENABLED=false` for the founder's manual pilot.

For the already configured Brevo sender, set these directly in Render's secret environment:

```
MHP_TRANSACTIONAL_PROVIDER=brevo
MHP_BREVO_SENDER_ID=1
MHP_BREVO_API_KEY=<secret in Render only>
```

Alternatively use `MHP_TRANSACTIONAL_PROVIDER=postmark`, `MHP_POSTMARK_SERVER_TOKEN` and `MHP_POSTMARK_FROM`. Never put provider keys in chat, command-line arguments, commit history, screenshots or these docs. Sign-in delivery has a bounded concurrency limit and timeout; an interrupted delivery can be requested again. It is not a durable mail queue.

Reuse the existing `INVESTOR_MAIL_ENCRYPTION_KEY`. `MHP_INVESTOR_MAIL_DELIVERY_ENABLED` defaults off. Only enable it after the owned mailbox send/reply check on MHP. Optional mailbox OAuth uses `MHP_INVESTOR_GOOGLE_CLIENT_ID/CLIENT_SECRET` and `MHP_INVESTOR_MICROSOFT_CLIENT_ID/CLIENT_SECRET`, with callback `https://app.martinhowardproperty.co.uk/portal/investors/mail/callback`. Custom SMTP/IMAP does not require either OAuth app.

MHP billing is a separate account and key family; the complete environment and restricted permissions are in [Stripe operations](mhp-stripe-operations.md). Creating the PR does not configure that account, send a message, collect a payment or activate a Payment Link.

## Cutover and recovery

The final app requires exact schema120. The compatible bridge is commit a5278917f08a519001fa5f8c04604582a3afff56, tree9e4972612aa0cea6ed0460237120b17e0f14a0e4, direct parentec153f935a4946f08b12c509fcd5b740d0cc5011. It preserves the PP application and accepts only complete112 or120; it refuses partial113–119. Old118 bridges are historical and cannot recover a120 database.

The local MHP-DEALDESK-001 package contains prepare-mhp-dealdesk-cutover.mjs and the reviewed atomic112-to120 packet. The packet verifies installation UUID, exact112 ledger, all eight migration bodies and the full120 post-state. The ordinary db:migrate command commits each file separately and must not be substituted for this cutover.

1. Verify the authoritative deployment ref and publish its reviewed direct-child history with the API-only exact-object publisher. Keep Render on manual deployment; intermediate history publication is not a reason to deploy an intermediate app.
2. Deploy only the compatible120 bridge. Confirm its exact Render commit, existing PP /ready and the named login/investor smoke while the database remains112.
3. Apply the eight migrations in one transaction while the bridge serves PP. On any error roll back the whole transaction. Verify the120 ledger and PP /ready afterwards.
4. Prepare the final release's concrete forward-recovery child with the exact bridge tree, then publish/deploy the ratified final app. Keep MHP billing and member mail delivery off for the owner pilot.
5. After DNS/TLS verification and transactional-mail configuration, mark only the MHP organization domain verified, enable MHP and verify /ready on both exact hosts. Preserve the readiness gate; never replace it with /health.
6. The founder proves email ownership, tests their business, calculators, saved files and verdict queue. An owner has unlimited capabilities; use a separate manually granted non-owner test identity to exercise the three-file/30-day limits. Paid credits require separate Stripe sandbox evidence.

Use the executable cutover/recovery instructions and receipts in the task's mhp-dealdesk-recovery-20261028 package. The isolated49assertion proof, final-slot concurrency test and atomic112-to120 rehearsal are source evidence; they are not production execution. For recovery after120, publish a forward child restoring the exact compatible bridge application tree while preserving schema and data. Do not down-migrate or deploy an112/118-only build.

The v3 catalogue retires the Kit without deleting its history. Seven standard Deal Desk/course/Room/mentoring offers are configured for provider setup; five webinar/founders/early offers remain inactive until their eligibility is implemented. Partnership is manual/invoice only. The owner pilot requires no Stripe connection. The capture/email design and exact reuse boundaries are recorded in [MHP email and capture](mhp-email-and-capture.md).

This PR contains source and the release procedure. It is not evidence that DNS, provider credentials, Stripe sandbox proof or the manual production cutover have been completed. The release receipt supplies exact tested source and operational status.

## Excluded

Course catalogue UI, lessons, progress, lesson assistant, Zoom import, tax, changes to the public marketing site and expansion of PP billing/provider permissions are outside this pass.

See [the owner setup walkthrough](mhp-owner-pilot.md), [calculator provenance](mhp-calculator-provenance.md) and [Deal Desk commerce](mhp-deal-desk-commerce.md) for this continuation.
