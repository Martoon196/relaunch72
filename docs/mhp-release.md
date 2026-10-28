# Martin Howard Property member app

MHP-DESK-001 adds `app.martinhowardproperty.co.uk` to the existing Growth HQ Render service. The public GitHub Pages site and the Property Predator host keep their existing routes. MHP uses the shared canonical PostgreSQL identity/CRM and its own session audience, host-only cookie, transactional email and Stripe configuration.

## Member experience

The new host provides password sign-in, email sign-in links, password reset, Your Desk and `/app/account`. A verified eligible member gets one private account workspace; course/Room members also get one investor business on first login. Kit buyers get their account and purchases. Mentoring and partnership add email workflow and LeadRelay, subject to the existing provider/installation boundaries. LeadRelay entitlement alone does not create or broaden an installation grant.

Both `martin.howard1984@gmail.com` and `office@propertypredator.com` are seeded as canonical users with owner memberships on the MHP organization, and permanent `source='manual'` entitlements for all thirteen v3 products (and retained historical Kit access). Existing credentials/status are preserved; a new user remains pending until they prove email ownership. No password or verified identity is invented. These owners get full Partnership workspace capabilities and `/hq` without checkout.

`/hq` lets a verified MHP owner select an existing person or enter a new email, choose a product, optionally set an expiry, and record an audit reason. The same entitlement system grants the product features; staff do not become administrators merely by receiving a product. Each action records actor, target, product, timestamp and reason, and repeated submission of the same command is idempotent. New members use the MHP email sign-in page; granting access does not send an invitation automatically. Manual grants create no purchases or payments. No MHP revenue report or founders' counter exists yet; future reports/counters must count paid purchases/payment evidence, never entitlement totals.

Programme provisioning and the founder test business remain at `/portal/investors?view=programme`. Mentee brands, domains and encrypted mailbox data reuse the current Investor services. Google/Microsoft mailbox connection is separate from login; Google SSO remains on Property Predator.

The founder approved the course/Room versus mentoring/partnership mapping and delegated refund-window judgement. The implementation uses 30 days from the first payment for the enabled catalogue, including instalment plans, and seven days of read-only access after a full refund. The revised £47 Deal Desk has an explicit 14-day refund window and remains unavailable for purchase until its separate calculator/credit/verdict journey is built. See [Stripe operations](mhp-stripe-operations.md) for exact amounts, provider setup and billing limits.

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

Do not deploy this commit against the 112-migration database: the unchanged strict readiness gate will correctly refuse it. Do not apply 0113–0118 while the current 112-only process is serving traffic: its readiness would then reject the unknown schema. Preserve the established enabled PP journeys throughout.

The compatible bridge is commit `a74249411dfedc0bd9fbd3ee7687150db4592204`, tree `feeb04f4e44c899b654dee1ab02aeec402a05fd3`. Its parent is first bridge `c5609d873720a1921e482deb2ed654ead1f8d48f`, whose parent is live base `78b6ef625adf377cef0c14fab299fca14d44a54b`. The second bridge commit adds the three new MHP roles to the disposable-test allowlist; the application/readiness code is unchanged. The exact-object API publisher must promote this chain one verified direct child at a time. Only the corrected bridge is the deployment/recovery target. Publishing these commits on the PR branch does not deploy or alter the live branch.

The local release package contains `prepare-mhp-cutover.mjs`, which generates an inspectable 112-to-118 JSON statement packet with exact installation UUID, ledger precondition, all six migration bodies and final ledger checks. It never connects to a database. Execute that packet in one database transaction only after the compatible bridge is actually serving. The ordinary `db:migrate` command commits files individually and is **not** the atomic cutover procedure for this release.

1. Freeze the reviewed source SHA and record its checks. Rehearse exact 0113–0118 plus synthetic auth/commerce/member/manual-grant proofs on the named isolated Neon branch; no live credentials or provider sends in that proof.
2. Prepare and verify a compatible bridge/recovery artifact from the current PP release which recognizes only the complete exact 112 or 118 migration ledger while MHP stays disabled. The prior Investor release's 112-schema recovery is not sufficient. Test both its pre- and post-migration readiness. Do not proceed until this executable artifact and recovery SHA exist.
3. Deploy that bridge manually. Confirm PP `/ready`, password/SSO and programme routes. Apply only the reviewed six migrations transactionally with the existing 112 ledger/hash precondition. Read back the exact ledger.
4. Merge the reviewed MHP PR to `codex/relaunch72-platform-foundation`, set scoped secrets and manually deploy the exact resulting SHA. Keep billing and member mail delivery off initially. Render environment updates can trigger deployment even with auto-deploy off, so apply them only at the reviewed cutover point.
5. After actual DNS/TLS verification, mark exactly the MHP organization-domain row `status='verified', verified_at=clock_timestamp()` using the migration/operator role and exact org/hostname predicate. Enable MHP, then verify `https://app.martinhowardproperty.co.uk/ready` and the PP readiness endpoint. No change from `/ready` to `/health` is allowed.
6. Founder completes their own email ownership proof, signs in, edits the test business, creates a contact/task and drafts the enquiry site. Verify independent member isolation and read-only access with synthetic accounts. Connect an owned mailbox and enable sending only after its explicit send/reply proof.
7. Configure and prove the separate Stripe sandbox/account, webhook, finite schedules, portal and full refunds before live Payment Link activation. Return the eligible real URLs only after successful API setup; placeholders are not payment links.

If a post-cutover MHP issue occurs, disable only MHP billing/mail delivery or the MHP host as appropriate, keep PP working and manually deploy the verified compatible recovery SHA. Preserve the new schema and financial receipts. Do not down-migrate customer/payment tables or deploy the unmodified 112-only release after migration. Forward recovery must keep exact parent/tree/ref verification and `force:false` publication.

The v3 catalogue retires the Kit without deleting its history. Six standard course/Room/mentoring offers are configured for later provider setup; six Deal Desk/webinar/founders/early offers remain inactive until their capabilities and eligibility are implemented. Partnership is manual/invoice only. The owner pilot requires no Stripe connection. The capture/email design and exact reuse boundaries are recorded in [MHP email and capture](mhp-email-and-capture.md).

This PR contains source and the release procedure. It is not evidence that DNS, provider credentials, a recovery artifact, Stripe sandbox proof or the manual production cutover have been completed. The release receipt supplies exact tested source and operational status.

## Excluded

Course catalogue UI, lessons, progress, lesson assistant, Zoom import, tax, changes to the public marketing site and expansion of PP billing/provider permissions are outside this pass.
