# 22 — DURABLE SETUP DELIVERY

**Measured:** 2026-08-24 on the local Codex branch.

**Activation:** automatic PostgreSQL onboarding is locked.
**External effects:** only the explicitly disposable Neon test database was
migrated and reset. Platform construction does not start a worker or call
Postmark (or any other provider); no production/customer database, deployment,
push, purchase or provider send was touched.

## What this slice changes

Migration `0008_setup_delivery_recovery.sql` closes the crash window between
native workspace creation and delivery of the owner's setup link. The setup
credential is no longer returned from provisioning for an in-memory “send it
now” handoff. Instead, Node encrypts the recipient and full setup URL before one
atomic database command commits both the workspace and a durable delivery job.

PostgreSQL stores:

- the SHA-256 setup-token and recipient hashes;
- an immutable delivery UUID, generation, payload version and encryption-key
  ID;
- a 12-byte IV, AES-256-GCM ciphertext and 16-byte authentication tag while the
  job is live; and
- bounded state, attempt, availability, hashed lease and terminal audit fields.

It does not store the raw setup token, raw URL, recipient address or raw lease
credential. AES-GCM additional authenticated data is domain-separated and bound
to the lowercase delivery UUID, so a ciphertext cannot be transplanted to
another job.

## Atomic provisioning

The function-only `r72_provisioning_command` role can execute only
`provision_customer_workspace_with_setup_delivery(...)`. The command commits
the organisation, native workspace, pending owner, active owner memberships,
default Sales pipeline, hashed 24-hour setup credential and encrypted generation
1 delivery together.

An identical replay returns the first canonical IDs and delivery metadata. It
does not replace the original token hash or encrypted job with freshly generated
caller material. Changed business input under the same trusted idempotency key
fails. The intended key remains the verified Stripe Checkout Session ID from a
server-side paid-order record.

The application result contains IDs, expiry, delivery generation and
`createdNow`; it never contains the raw setup token or a setup URL.

## At-least-once worker contract

`r72_setup_delivery_command` has no direct table grants. Its audited functions
provide this state machine:

1. **Readiness:** return the distinct encryption-key IDs required by currently
   claimable jobs.
2. **Claim:** the SQL primitive can take 1–25 available jobs with
   `FOR UPDATE SKIP LOCKED`, increment their bounded attempt count and apply a
   15–300 second lease. The current Node service deliberately claims exactly
   one job until per-row settlement exists. Only a hash of the random
   process-held lease credential enters SQL.
3. **Open:** authenticate and decrypt the envelope in Node. A missing rotation
   key is a readiness/alert failure; no provider payload is returned. A
   tampered payload is not sent and is released to bounded retry.
4. **Renew:** extend only the same unexpired fenced lease and never beyond setup
   token expiry.
5. **Acknowledge:** after provider acceptance, fence on the same live lease,
   mark the job delivered and erase IV/ciphertext/tag.
6. **Fail:** fence on the same live lease and either schedule a bounded retry or
   dead-letter at the eighth attempt/token-expiry boundary. Dead-lettering erases
   IV/ciphertext/tag.

Expired leases can be reclaimed. Therefore this is at-least-once delivery: a
process can crash after a provider accepted a message but before the database
acknowledgement. `deliveryId` is exposed as the stable provider idempotency key
for adapters whose provider contract supports deduplication, but the database
does not claim exactly-once email.

No provider adapter, polling loop, scheduler or background process is started by
`buildPgOnboardingPlatform(...)`. Those operational pieces remain a launch
task; configured Postmark credentials do not silently activate this path.

## Trusted reissue

`r72_setup_reissue_command` is a separate function-only identity intended for a
trusted operator/service boundary. Reissue:

- uses an immutable receipt and request fingerprint for safe idempotent replay;
- locks the still-pending user and complete active owner chain;
- verifies the supplied recipient hash equals the canonical database email;
- serializes against concurrent setup completion;
- revokes previous live setup tokens and clears stale claims;
- terminalizes their live deliveries and erases encrypted payloads; and
- creates a new 24-hour token plus the next encrypted delivery generation.

It is not connected to a public self-service recovery route. An idempotency key
reused with changed workspace, user, operator reason or recipient fails.

## Setup completion and browser handling

The account password path now fences expensive work:

1. validate the 256-bit setup-token shape;
2. obtain a two-minute database claim using only token/claim/source hashes;
3. enter the fail-fast process-wide scrypt limiter (four concurrent jobs by
   default, with no unbounded queue);
4. atomically consume that exact claim and token, activate the owner, revoke
   peers, erase their live delivery ciphertext and issue the first opaque
   14-day session; or
5. release the claim when setup cannot complete.

The browser never posts the emailed token. The first
`GET /portal/setup?token=...` stores it in a ten-minute AES-256-GCM encrypted,
`HttpOnly; SameSite=Lax` cookie scoped to `/portal/setup`, then redirects with
`303` to the clean path. The form uses a synchronizer CSRF token bound to that
cookie. Responses are `no-store` with `Referrer-Policy: no-referrer`.

This is a URL cleanup, not token consumption. The email URL remains valid until
database completion, expiry or trusted reissue. The first request still contains
the raw query credential, so edge/CDN/proxy access logs must redact `token`
before customer traffic is enabled.

The current setup throttle is bounded and process-local. It keys by token hash
and, only when a deployment supplies an authenticated trusted-proxy resolver,
by a hashed client source. `X-Forwarded-For` is never trusted by default. A
multi-instance deployment needs a deliberate shared throttle or equivalent
edge control.

## Composition and required configuration

The customer portal stays independently available with only:

- `DATABASE_WEB_URL` → `r72_web`;
- `DATABASE_IDENTITY_COMMAND_URL` → `r72_identity_command`; and
- `DATABASE_CRM_COMMAND_URL` → `r72_crm_command`.

The sensitive onboarding process must be constructed explicitly with
`buildPgOnboardingPlatform(...)`. It uses `DATABASE_WEB_URL` for a transient
migration-ledger readiness check, closes that pool, then retains:

- `DATABASE_PROVISIONING_COMMAND_URL` → `r72_provisioning_command`;
- `DATABASE_SETUP_DELIVERY_COMMAND_URL` →
  `r72_setup_delivery_command`; and
- `DATABASE_SETUP_REISSUE_COMMAND_URL` → `r72_setup_reissue_command`.

It also requires:

- `PORTAL_BASE_URL`: a bare HTTPS origin with no credentials, path, query or
  fragment. Only loopback development may use HTTP. The setup URL is derived as
  the exact `/portal/setup` path.
- `SETUP_DELIVERY_ACTIVE_KEY_ID`: the trimmed ID used for new envelopes.
- `SETUP_DELIVERY_KEYS_JSON`: a JSON object containing 1–32 key IDs mapped to
  canonical, unpadded base64url encodings of exactly 32 random bytes. The active
  ID must be present.

The builder verifies the migration ledger, exact `current_user` for each pool,
and historical key availability before returning a provisioning service. Any
failure closes partially constructed pools and leaves onboarding unavailable.

## Key rotation rule

Rotation is additive first:

1. generate and store a new 32-byte key in the deployment secret manager;
2. add it to `SETUP_DELIVERY_KEYS_JSON` without removing old keys;
3. point `SETUP_DELIVERY_ACTIVE_KEY_ID` at the new ID and restart;
4. allow old live deliveries to be delivered, reissued, expire or dead-letter;
5. remove an old key only after readiness shows no claimable delivery requires
   it.

Terminal delivery rows retain audit metadata but no ciphertext, so they do not
keep an old decrypt key operationally necessary. A missing required key fails
startup instead of silently dead-lettering customer access.

## Proof and launch gates

On 2026-08-24, the disposable direct-Neon run passed **2 tests, 0 failures and
0 skips**. PostgreSQL applied the complete `0001`–`0011` ledger and proved the
delivery/reissue roles, atomic provisioning, lease fencing, terminal erasure,
reissue/setup races, setup reservation/consumption and first-session issuance.
Migration `0009` contains the forward session-clock and minimum row-lock
privilege repairs surfaced by the managed run; `0010` contains the portable
lease-renewal repair; `0011` closes the remaining volatile lifecycle-default
class without weakening chronology constraints. The final sequential complete
suite reports **577 passed, 0 failed and 0 skipped**. Static contracts,
typechecking and diff-checking also pass.

Before customer activation:

1. provision passwords or managed identities for every runtime `LOGIN` role in
   the hosting secret/control plane, then supply and preflight each exact
   role-specific database URL; migrations intentionally create no credentials;
2. implement and test the provider dispatcher without logging recipient,
   decrypted URL, raw setup token or raw lease;
3. redact `?token=` at every ingress/access-log layer;
4. complete paid-order provenance/fulfilment, restore/alert/key-rotation and
   multi-instance abuse-control runbooks; and
5. run real-browser owner acceptance.

The disposable Neon proof passed 2/2. No provider send has been performed, and
automatic PostgreSQL onboarding remains locked on the remaining gates above.
