# 22 — DURABLE SETUP DELIVERY

**Measured:** 2026-08-24 on the local Codex branch.

**Activation:** automatic PostgreSQL onboarding is locked.
**External effects:** only the explicitly disposable Neon test database was
migrated and reset. Platform construction starts no worker and calls no email
provider. No production/customer database, deployment, push, purchase, Stripe
charge or provider send was touched.

## Durable payload boundary

Migration `0008_setup_delivery_recovery.sql` closes the crash window between
native workspace creation and delivery of the owner's setup link. Node encrypts
the canonical recipient and full setup URL before the database transaction.
PostgreSQL stores only:

- SHA-256 setup-token and recipient hashes;
- an immutable delivery UUID, generation, payload version and encryption-key
  ID;
- a 12-byte IV, AES-256-GCM ciphertext and 16-byte authentication tag while the
  job is live; and
- bounded state, attempt, availability, hash-only lease and terminal audit
  fields.

It does not store the raw token, URL, email address or lease credential. The
AES-GCM additional authenticated data is domain-separated and bound to the
lowercase delivery UUID, so ciphertext cannot be transplanted to another row.

Migration `0013_setup_delivery_provider_settlement.sql` closes the settlement
gap. The worker can no longer erase ciphertext through the old unattributed
acknowledgement. It must persist an opaque provider ID/reference and provider
acceptance timestamp under the same live lease fence, or explicitly record a
permanent provider rejection. The initial claim lease is also capped at the
setup-token expiry.

## Paid atomic provisioning

The function-only `r72_provisioning_command` role cannot directly execute the
inner `provision_customer_workspace_with_setup_delivery(...)` primitive.
Migration `0012_paid_checkout_provenance.sql` revokes that runtime shortcut.
The role can only authorize and execute
`fulfil_paid_portal_checkout_with_setup_delivery(...)` for an exact financially
paid portal order presented with its correct unexpired hash-only browser claim.

That wrapper commits the organisation, native workspace, pending owner, active
owner memberships, default Sales pipeline, hashed 24-hour setup credential,
encrypted generation 1 delivery, claim consumption and paid-order linkage in
one transaction. A lost-response replay returns the first canonical result only
while the bounded claim grant remains live; replacement credential material is
ignored. The first successful fulfilment commits the normalized business input.
After that commit, replay ignores every replacement field and returns only the
canonical result while the claim remains unexpired. The inner primitive retains
changed-input receipt rejection, but it is uncomposed and unavailable to runtime
roles. The application result never exposes the raw token or setup URL.

## At-least-once dispatcher contract

`r72_setup_delivery_command` has no direct table grants. Its audited functions
and the provider-neutral dispatcher implement this state machine:

1. **Readiness:** report encryption-key IDs required by claimable rows.
2. **Claim:** take one available row with `FOR UPDATE SKIP LOCKED`, increment its
   bounded attempt count and apply a 15–300 second lease that cannot outlive the
   setup token. Only the hash of the random process-held lease enters SQL.
3. **Open:** authenticate and decrypt in Node. A missing key or
   unreadable/tampered payload is a fatal readiness condition. Nothing is sent,
   ciphertext is preserved for configuration/key recovery, and the in-process
   loop exits instead of hot-retrying or falsely dead-lettering customer access.
4. **Renew/call:** renew the exact fenced lease and abort a provider call before
   lease expiry. Provider timeouts and transient errors receive bounded
   exponential retry.
5. **Settle acceptance:** under the same live lease, persist provider
   ID/reference and acceptance/recorded timestamps, set state `delivered` and
   erase IV/ciphertext/tag.
6. **Fail:** under the same lease, schedule retry, dead-letter at the bounded
   attempt/token-expiry boundary, or record an explicit permanent rejection.
   Terminal failure erases IV/ciphertext/tag.

The database state named `delivered` currently means **provider-accepted
handoff**, not confirmed inbox delivery. Delivered, bounced and complained
webhook states remain future provider work.

The contract is at-least-once: a process can crash after provider acceptance
but before database settlement, causing a retry. The delivery UUID is a stable
correlation key, but there is no provider-independent exactly-once guarantee.

The dispatcher has bounded provider timeout, lease renewal, secret-safe events,
exponential retry and fenced settlement. Its included provider is network-free
and for tests only. `buildPgOnboardingPlatform(...)` starts no scheduler or
background process. A deployment supervisor must treat unreadable payload/key
readiness as a fatal latch instead of continuously restarting the worker.

## Trusted reissue and browser setup

`r72_setup_reissue_command` is a separate function-only identity for a trusted
operator/service boundary. Reissue is idempotent, locks the still-pending owner
and full active ownership chain, checks the recipient hash against the canonical
database email, serializes against setup completion, revokes prior live setup
tokens, erases their live payloads and creates the next encrypted generation. It
is not connected to a public self-service recovery route.

Account setup obtains a short database reservation before bounded scrypt work,
then atomically consumes that exact claim/token, activates the owner, revokes
peers and issues the first opaque 14-day session. The first browser request
stores the emailed token in a ten-minute AES-256-GCM encrypted,
`HttpOnly; SameSite=Lax` cookie scoped to `/portal/setup`, then redirects `303`
to a clean URL. The form uses synchronizer CSRF, `no-store` and
`Referrer-Policy: no-referrer`.

The initial email click still reaches the edge as `?token=...`. CDN/proxy/access
logs must redact that query before customer traffic. Multi-instance deployment
also needs an explicit shared abuse limiter; process-local throttles are not the
whole launch control.

## Composition and configuration

The always-on customer portal remains separate, using exact `r72_web`,
`r72_identity_command` and `r72_crm_command` connections.

The sensitive activation process is constructed explicitly with
`buildPgOnboardingPlatform(...)`. It uses `DATABASE_WEB_URL` only for transient
ledger readiness, closes that pool, then retains:

- `DATABASE_PUBLIC_URL` → `r72_public`;
- `DATABASE_WEBHOOK_URL` → `r72_webhook`;
- `DATABASE_PROVISIONING_COMMAND_URL` → `r72_provisioning_command`;
- `DATABASE_SETUP_DELIVERY_COMMAND_URL` →
  `r72_setup_delivery_command`; and
- `DATABASE_SETUP_REISSUE_COMMAND_URL` → `r72_setup_reissue_command`.

It also requires a canonical bare-HTTPS `PORTAL_BASE_URL` (loopback HTTP only in
development), an active delivery key ID and a keyring of canonical unpadded
base64url 32-byte AES keys. The builder verifies the ledger, exact
`current_user` for every pool and availability of historical keys, then returns
a composed `PgPaidCheckoutService` plus `PgSetupDeliveryService`. It never
exposes the unrestricted inner provisioning adapter. Construction calls no
provider and starts no worker.

Key rotation is additive: deploy the new key alongside old keys, make it active,
allow old rows to settle/reissue/expire, and remove an old key only after
readiness reports no claimable row needs it. Logical ciphertext erasure does not
remove historical WAL or backups; retention and crypto-shredding policy remain
an operational decision.

## Proof

On 2026-08-24, a freshly reset disposable direct-Neon run passed **3 tests, 0
failures and 0 skips**. PostgreSQL applied the complete `0001`–`0013` ledger and
proved delivery/reissue roles, atomic provisioning, lease fencing, terminal
erasure, reissue/setup races, reservation/consumption, first-session issuance,
provider-acceptance persistence, settlement after a simulated database outage,
permanent rejection, changed-byte Stripe replay rejection, claim expiry and
concurrent claim-bound paid fulfilment.

No real Stripe charge or provider send was performed. Static/unit tests use
fakes and the provider-neutral network-free adapter. The final sequential
repository suite, including the real database tests, passed **610/610 with 0
failures and 0 skips**; typechecking and diff checking also pass.

## Remaining launch gates

1. Provision every runtime `LOGIN` role in the deployment secret plane and
   preflight each exact role URL; migrations intentionally create no passwords.
2. Implement a real transactional-email adapter and an operational supervisor;
   keep recipient, decrypted URL, raw token and raw lease out of logs.
3. Wire the detached paid Checkout/webhook/intake path and same-origin browser
   `sessionStorage` claim behind an off-by-default gate.
4. Redact `?token=` at every ingress/access-log layer.
5. Approve restore, alert, key-rotation, fatal-readiness and multi-instance abuse
   runbooks.
6. Define repeat-purchase/existing-email policy and replace remaining
   file-backed order/pipeline execution paths before live activation.
7. Run real-browser payment, recovery and owner acceptance.

The disposable Neon proof is green 3/3, but automatic onboarding remains locked
on those gates.
