# Property Predator — owned public social activation readiness

> Current launch target: **Instagram + LinkedIn through Zernio**. Growth HQ uses
> the Zernio rail for calendar publishing and reconciliation, supported DMs,
> comment inbox reads and approval-gated comment replies. Ayrshare is retained
> as dormant historical/replacement-provider code; it is not the current
> execution route. X remains deferred until its separate account and API
> requirements exist.

Migration `0080` remains the hardened calendar foundation: exact planning
intent/target, current approval and attestation, immutable approved media,
effect-time revalidation, cancellation/reschedule coordination and durable
receipts. Migrations `0085`–`0089` put the current Zernio authority around that
foundation:

| Migration | Current authority |
| --- | --- |
| `0085` | Zernio-qualified Instagram/LinkedIn account bindings, enqueue, leases, publish/reconcile receipts and hard proof caps |
| `0086` | Network-qualified immutable reply ledger for both Instagram and LinkedIn comments |
| `0087` | Provider-qualified live-channel truth; only active, non-revoked Zernio evidence and Zernio receipts can make the owned-social row ready |
| `0088` | Atomic calendar-to-Zernio command that selects the exact connected account, derives the binding and enqueues through `0085` |
| `0089` | Exact Zernio social-DM control-room truth, including connection/account, approval, delivery, receipt and pause evidence without provider identifiers, message text or PII |

The proof ceiling is deliberately small: **one publication per UTC day and
three per UTC month, per exact Zernio account and network**. Both enqueue and
effect-time begin enforce the caps; `0087` reports the same usage grain.

This rail is composed. The current production candidate selects the active,
capped Zernio tuple for the exact owned Instagram and LinkedIn accounts; the
runtime still cannot call Zernio without the matching secret-manager values,
database binding, current content approval, due calendar job and cap/pause
proof. Nothing in this document itself publishes a post or connects an account.
The already approved controlled owned-account proof is the only current effect
scope; cold outreach, unsolicited comments and customer communications are not.

## Current Zernio Instagram/LinkedIn release boundary

The reviewed rail can be returned to a fully dark rollback posture with
`PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE=disabled`,
`PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false` and
`PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED=true`.

The active worker tuple must be exact, not partial:
`PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE=zernio_live`, provider id `zernio`,
the explicitly selected Instagram/LinkedIn network set, provider effects ON,
emergency pause OFF, exact workspace/connection/account bindings and the
restricted `ZERNIO_API_KEY`. Instagram also requires the shared media-signing
key in the web and worker secret managers so the provider can fetch a short-lived
URL bound to the exact approved workspace, job, storage key, digest, MIME and
expiry. The worker never receives the private company-content bearer. The same global effects switch and emergency pause gate
outbound DM and comment replies; inbox reads may remain available while sends
are disabled or paused.

Before the controlled owned-account proof, verify all of the following:

- the exact Zernio Instagram and LinkedIn account IDs match the immutable
  connected-account and publish-binding evidence;
- an unauthenticated provider-style GET of each signed approved-media URL
  returns the exact MIME type and blob SHA-256 during its 15-minute validity,
  while expired, tampered or wrong assets return the same generic not-found response;
- the calendar command reaches the `0085` Zernio job path, not a historical
  Ayrshare function;
- provider receipts reconcile only to the exact Zernio job/account/network;
- the 1/day and 3/month proof caps are visible and enforced; and
- provider keys, internal bearers and client tokens never appear in URLs,
  rendered pages, receipts or telemetry.

This document describes readiness; it does not itself connect an account or
publish/reply. Those remain controlled runtime decisions inside the approved
owned-account proof ceiling.

## Historical dormant Ayrshare/X foundation reference

The remaining Ayrshare/X sections preserve useful implementation history,
rehearsal contracts and a replacement-provider option. They are dormant and
are **not** current Instagram/LinkedIn launch instructions.

## Historical Ayrshare/X capability record

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

## Historical X-only provider and account inputs (deferred)

These inputs belong only to the deferred X compatibility path below. They are
not the current Instagram/LinkedIn calendar activation instructions.

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

## Historical X gaps before a first authorised effect

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

## Historical X founder workflow now composed

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

## Historical X activation order

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

## Current Zernio publishing and messaging foundation

Migrations `0074`–`0079` compose the Zernio connected-account, signed webhook,
inbox-read and original Instagram reply foundation. The current launch suffix
then closes the provider split:

- `0085` routes Instagram and LinkedIn calendar jobs through the Zernio posting
  and reconciliation client while retaining `0080`'s immutable content,
  approval, media, lease, pause and receipt controls;
- `0086` extends the same immutable draft → approval → decision → claim → settle
  ledger to exact LinkedIn comment targets without rewriting the Instagram
  history;
- `0087` makes the control-room owned-social truth Zernio-qualified and reports
  its exact connection, binding, caps, pause and receipt blockers; and
- `0088` gives the portal one atomic, account-qualified calendar command rather
  than trusting caller-supplied publish capability; and
- `0089` replaces the central `social_dm` row with exact Zernio connection,
  account, approval, delivery, receipt and pause truth while retaining only
  hash evidence and zero publication caps for the reply-only rail.

The Growth HQ social inbox may read configured Zernio DMs, comment posts and
comment threads. Outbound DMs and Instagram/LinkedIn comment replies use the
immutable approval ledger and require provider effects ON plus the emergency
pause OFF before any provider call. Reads do not require outbound effects.
Every outbound target remains bound to its exact provider connection, network,
account and conversation/comment reference.

### Current controlled-proof inputs

1. Apply the reviewed migration chain through `0089`; do not skip from `0080`
   directly to the worker.
2. Supply the restricted Zernio credential through the runtime secret manager,
   plus the exact live connection/profile and Instagram/LinkedIn account IDs.
3. Reconcile those account IDs against active, non-revoked database evidence
   and an exact ownership/link proof.
4. Supply the same high-entropy media-signing key to the Growth HQ web and
   Zernio worker secret managers, then prove the short-lived provider URL
   returns the exact approved bytes, MIME type and digest.
5. Confirm the control-room truth names `zernio`, shows no ambiguous receipt,
   reports cap headroom and has the emergency pause state expected for the
   proof.
6. Use only separately authorised owned-account proofs. The database and worker
   allow no more than **1 publication per UTC day and 3 per UTC month for each
   account/network**.
7. Reconcile the provider post ID and per-platform status/URL, or quarantine an
   ambiguous outcome instead of guessing that it failed.

Procurement and operational evidence still matters: retain the executed
embedded-use rights, DPA/subprocessor and data-region evidence, support/SLA and
exit/deletion commitments; rehearse account-health reconciliation,
disconnect/revocation, missed-webhook recovery, idempotency and rate-limit
fairness against owned accounts.

## Dormant Ayrshare replacement path

The earlier Ayrshare tables, functions, worker and X compatibility contracts
remain deliberately intact. They are useful provenance and a replacement-
provider option, but they must not be configured alongside the Zernio launch
tuple or represented as the current calendar authority. Re-activating Ayrshare
would require its own reviewed account bindings, secrets, readiness proof and
separate effects authorisation; no Zernio connection or receipt may be treated
as Ayrshare evidence, or vice versa.
