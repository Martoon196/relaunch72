# Property Predator — owned public social (Ayrshare/X) activation readiness

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

1. **No founder command runtime wiring.** `PgOwnedPublicSocialLiveCommandService`
   is constructed by nothing outside its own test, and `DATABASE_OWNED_SOCIAL_COMMAND_URL`
   is provisioned on the web service but never used. There is currently no code
   path that can call `record_owned_social_profile` or `enqueue_owned_social_job`,
   so no job can exist for the worker to claim. This is the largest remaining
   blocker and it is a portal composition decision, not a database one.
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
