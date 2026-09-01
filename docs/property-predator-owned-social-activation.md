# Property Predator — owned public social activation readiness

> Current launch target: **Instagram + LinkedIn through Ayrshare and the Growth HQ calendar**. Migration `0066` extends the original `0052` X-only foundation with network-specific profile evidence, exact planning-intent binding and immutable approved media. X is retained only as a backwards-compatible code path and is deferred from the production manifest until an owned X account and its separate BYOK/OAuth requirements are available.

For the Instagram/LinkedIn launch, Render uses `PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK=instagram_linkedin`, `AYRSHARE_API_KEY`, the profile-envelope key/version and `PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN`. The X OAuth1 secrets described later in this historical foundation section are **not** required or present for the current launch. Each calendar publication is admitted only when its exact immutable planning intent, matching network target, current content approval, fresh source attestation and approved media set pass the `0066` database command.

This rail is composed and dark. Nothing in this document publishes a post,
connects an account or enables a provider effect. A first owned-account
publication remains a separate, explicitly authorised decision.

## What is already proven in code

| Capability | Where | State |
| --- | --- | --- |
| Owned Ayrshare/X profile binding with an AES-256-GCM sealed profile key and hashed account identity | `0052` `record_owned_social_profile` | composed |
| Permanent, one-per-profile revocation | `0052` `revoke_owned_social_profile` | composed |
| Founder enqueue re-proving approval, source attestation, content currency and the X v1 text shape | `0052` `enqueue_owned_social_job` | composed |
| One-at-a-time worker with lease fencing, publish/reconcile attempts and outcome-unknown quarantine | `0052` claim/load/begin/settle + `workers/owned-public-social-live` | composed |
| Hard publish caps, 1 per UTC day and 3 per UTC month, per owned profile | `0052` enqueue and begin-call | composed |
| Engage-only emergency pause fencing the `→ calling` transition inside the database | `0057` `owned_social_live_emergency_pause` | composed |
| Read-only, zero-publication activation readiness for one exact owned account and post | `0059` `property_predator_owned_social_activation_readiness` | composed |
| Founder command database boundary assertion | `assertOwnedPublicSocialCommandBoundaryReady` | composed |

## The zero-publication readiness probe

`0059` adds one `STABLE` `SECURITY DEFINER` function that writes nothing,
creates no job, and cannot reach Ayrshare. It returns one row per dimension
carrying a boolean and a non-sensitive blocker code:

`operator_authority`, `provider_connection`, `owned_profile`,
`owned_account_matches_supplied`, `ownership_link_evidence`,
`approved_content`, `content_version_current`, `source_attestation_valid`,
`publishable_text`, `cap_headroom`, `receipt_path_clear`,
`emergency_pause_clear`.

The owned account is supplied as a SHA-256 digest and compared against the
digest `0052` stored. No account reference, profile key or post body is ever
returned.

Two facts the probe reports that the rail-level truth deliberately does not:

- **Per-profile caps.** `0052` counts 1/day and 3/month per owned profile; the
  founder-facing rail truth counts per workspace. The probe reports the
  stricter grain that the command boundary will actually enforce.
- **Full connection facts.** The rail truth's binding check does not re-assert
  `environment = 'live'` or `provider_kind = 'social'`. The probe does, exactly
  as the enqueue does.

### The publishable-text rule is the one most likely to surprise

`0052` requires the approved bytes to be ASCII-printable, at most 280
characters, and to contain **no URL, scheme, `www.` or bare domain at all**.
A post that merely mentions `propertypredator.com` is refused. The probe and
the deterministic rehearsal apply the identical rule, so a rehearsal can never
pass where the real publication would be refused.

## Deterministic publication rehearsal

`deriveOwnedSocialPublicationRehearsal` performs no provider call and no
database call. It fixes the canonical derivation of the two digests `0052`
stores but does not itself recompute — `idempotency_key_sha256` and
`request_sha256` — so a replay of the same owned publication produces
byte-identical digests and the database idempotency check becomes meaningful
rather than caller-dependent.

It reports the owned-account digest, the content hash and whether it matches
the approval, the publishable-text verdict with named failures, the caps, and
the expected receipt contract (`accepted` → `reconciliation_pending`,
`published` → `succeeded`, `outcome_unknown` → `needs_attention`, unique on
`workspace_id, job_id, lease_version`, evidence in `receipt_sha256`).

> This canonical derivation is a client-side convention. `0052` compares the
> stored digests for idempotency but does not re-derive them, so nothing yet
> forces a different caller to use the same definition. Enforcing it would
> require changing the `enqueue_owned_social_job` contract.

## Remaining provider and account inputs

None of these exist in this repository or in any environment inspected here.

### Ayrshare account
- `AYRSHARE_API_KEY` — the Ayrshare account API key
- `AYRSHARE_X_OAUTH1_API_KEY` and `AYRSHARE_X_OAUTH1_API_SECRET` — the OAuth1
  pair for the exact owned X profile
- `PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_BASE64` — exactly 32
  bytes, canonical base64, worker process only
- `PROPERTY_PREDATOR_PUBLIC_SOCIAL_PROFILE_ENCRYPTION_KEY_VERSION`
- `PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID` and
  `PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_CONNECTION_ID`

The per-profile Ayrshare **Profile Key** is not an environment value. It is
sealed into the database by `record_owned_social_profile` and decrypted in
memory for a single leased operation.

### Owned X account evidence
- The exact founder-owned X account, and its Ayrshare profile reference. Only
  their digests are stored: `owned_account_ref_sha256` and
  `provider_profile_ref_sha256`. There is no cleartext handle column anywhere.
- `x_oauth_link_evidence_sha256` plus `linked_at` and `evidence_observed_at`,
  with `linked_at` no more than five minutes after observation.
- OAuth permissions must be `read_write`.
- A written attestation that the X account is founder-owned.

### Approved test post evidence
- One `company_content_versions` row with `content_kind = 'social_post'` whose
  bytes re-derive to `content_sha256`, and which is the **latest** version of
  its item.
- A `company_content_approval_requests` row pinned to that same digest and a
  `company_content_approval_decisions` row with `decision = 'approved'`.
- A `company_content_source_attestations` row pinned to the same content, blob
  and brand digests, already checked and not expiring within fifteen minutes of
  the intended publication moment.
- The post text must satisfy the X v1 rule above.

## Known gaps before a first authorised effect

1. ~~No founder command runtime wiring.~~ **Closed.** The command service is now
   composed into the portal from `DATABASE_OWNED_SOCIAL_COMMAND_URL` alone, and
   the founder workflow below is usable.
2. **No profile-linking wiring, so no Profile Key exists yet.**
   `AYRSHARE_PROFILE_LINKING_PORTAL_READY` is `false`, the binding repository
   has no implementation, and the Ayrshare Integration Package private key and
   domain are not plumbed anywhere.
3. **The worker's pause switch is read once at startup.** A pause engaged
   mid-run through the portal is honoured because `0057` fences the `→ calling`
   transition in the database, not because the process notices. The worker's
   readiness line will report a stale `safety.emergencyPaused` after a
   database-side pause. Restart the worker to refresh it.
4. **The worker boundary probe is not a strict allowlist.** Unlike the WhatsApp
   rail, a stray `GRANT EXECUTE` on an unrelated `app_private` function to
   `r72_owned_social_worker_command` would pass readiness silently.

## The founder workflow now usable

All three commands live on the existing Live Channels control room at
`/portal/channels/live`, under **Owned X account commands**. Each is a
CSRF-protected POST requiring a deliberate confirmation checkbox and a
scope-bound command key, gated to the Property Predator profile and an
authenticated session. Founder/admin authority is enforced by Postgres, not by
the router.

1. **Bind one owned X profile** — `POST /portal/channels/live/owned-social/profile`.
   Accepts the Ayrshare profile reference, the owned X account reference, the
   Profile Key and the OAuth link evidence with its timing. The Profile Key is
   sealed with the existing owned-social encryption contract inside the portal
   service and never stored, echoed, logged, rendered or returned; the account
   and profile references are reduced to digests in the same statement. The
   control renders as an honest disabled button unless this process holds the
   encryption contract.
2. **Revoke a bound profile** — `POST /portal/channels/live/owned-social/revocation`.
   Append-only and permanent. A rotation is a revoke followed by binding the
   successor profile; there is deliberately no un-revoke.
3. **Stage one approved publication** — `POST /portal/channels/live/owned-social/staging`.
   Runs the `0059` readiness probe first and refuses unless every dimension
   passes, then enqueues through `enqueue_owned_social_job` with digests the
   service derives itself. Database-only: it claims no worker lease and calls
   no provider.

The emergency pause control is unchanged and still engage-only.

## Activation order

1. Supply the Ayrshare account values into the Render secret slots. The worker
   stays dark: `PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE=disabled`,
   `PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false`,
   `PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED=true`.
2. Complete Ayrshare profile linking for the owned X account and seal the
   resulting Profile Key through `record_owned_social_profile`.
3. Record the approved `social_post` content version, its approval decision and
   its source attestation.
4. Run the zero-publication readiness probe until every dimension reads ready,
   and the deterministic rehearsal until the post is publishable.
5. Obtain separate, explicit authorisation for one owned test publication.
6. Only then flip the activation tuple. All of mode, provider-effects,
   not-paused, provider id and network must agree, plus `NODE_ENV=production`;
   a partial tuple raises rather than silently downgrading.

The emergency pause has no release function by design.

## Zernio pilot candidate for Facebook, Instagram and LinkedIn

The existing Ayrshare/X rail is not being replaced or widened implicitly.
Zernio is the lower-cost pilot candidate for Facebook Pages, Instagram
professional accounts and LinkedIn organisations. The provider's current
[connection reference](https://docs.zernio.com/connect/get-connect-url) and
[multi-tenant guide](https://docs.zernio.com/multi-tenant) document the exact
headless OAuth start used by the local contract-test seam.

`ZernioConnectionContract` is deliberately **contract-test only**. Its default
mode is disabled and cannot perform network I/O. The branded test transport can
only prove construction of one bounded `GET /api/v1/connect/{platform}` request
with bearer authentication, a fixed Growth HQ callback, an exact
workspace/connection/profile credential binding, no redirects followed and no
OAuth browser opened. It accepts only `facebook`, `instagram` and `linkedin`.
It does not create a Zernio profile, connect an account, persist a callback,
select a Facebook Page or LinkedIn organisation, receive a webhook, publish,
schedule, read analytics, reply to a comment/DM, disconnect an account or make
any provider call from production.

### Complete blockers before any real account connection

1. Obtain written SaaS/embedded-use rights, DPA/subprocessor and data-region
   evidence, support/SLA terms, platform-partner evidence and an exit/deletion
   commitment. Public marketing is not the executed contract.
2. Create the company-owned provider account, one workspace-scoped profile and
   restricted API credential; bind their non-secret identities to an immutable
   Growth HQ connection record. No shared team-wide account ID may be accepted
   without the local workspace mapping.
3. Add a short-lived, one-use callback receipt bound to the initiating portal
   session, workspace, connection, profile, network and provider-state digest.
   A browser callback is navigation evidence, never proof that an account is
   connected.
4. Implement the documented headless secondary-selection ceremonies for
   Facebook Pages and LinkedIn organisations, with the provider temporary token
   confined to the server-side command boundary. Instagram's selected login
   method must be pinned because Facebook Login adds its own selection step.
5. The local raw-byte verifier now accepts only `account.connected` and
   `account.disconnected`, verifies the lowercase-hex HMAC-SHA256
   `X-Zernio-Signature`, requires the payload ID to equal
   `X-Zernio-Event-Id`, enforces the bound provider profile/network and reduces
   provider identifiers to hashes. Still add a separate webhook service and
   database receipt boundary to deduplicate at-least-once delivery, persist
   before `2xx`, and route by the already-bound provider profile. The
   [webhook guide](https://docs.zernio.com/webhooks) is the current signature
   and idempotency reference.
6. Resolve a current provider-document conflict in writing before setting retry
   monitoring: the webhook overview says webhooks are never automatically
   disabled, while the create-webhook reference says ten consecutive delivery
   failures disable them. Readiness must not assume either behaviour.
7. Add account-health reconciliation, revocation/disconnect, missed-webhook
   recovery, cost/rate-limit fairness and migration-out tests. A signed
   `account.connected` receipt plus an exact account-list/health reconciliation
   is required before the portal may label a connection live.
8. Build and review a separate publish/schedule/reconcile adapter and its
   content, approval, cap, pause and receipt boundaries. A successful OAuth
   connection never grants publishing permission by itself.

Until all eight items are closed, Growth HQ must display Zernio as
`adapter_contract_verified` at most. It must show zero live Zernio connections,
offer no executable connect button and make no provider-effect claim.
