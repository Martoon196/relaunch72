# Property Predator — production cutover checklist for `0090`-`0092`

**Candidate:** `codex/relaunch72-platform-foundation` @ `80ee590f794032d4440acbf83394fa7cfd707e56`
**Prepared:** 2 September 2026
**Status:** **BLOCKED - do not begin.**

> ## Blocking precondition
>
> Migration `0090` currently **cannot apply to a Neon database**. Its own guard
> raises
> `Daily Outreach role has unsafe inbound membership: r72_daily_outreach_definer<-neondb_owner`
> because Neon grants every newly created role back to `neondb_owner`
> (`grantor = cloud_admin`, `admin_option = true`, `set_option = false`), and that
> grant cannot be revoked by `neondb_owner`.
>
> Until this is resolved **and** the 38 disposable-PostgreSQL integration and
> attack tests pass against a clean reset, **no step below may be started.** See
> the 2 September 2026 checkpoint in
> `property-predator-current-execution-plan.md`.

This checklist is forward-only. It never resets, rewrites or re-seeds. It imports
no customer data. It enables no provider effect.

---

## 0. Preconditions

- [ ] Defect 2 (Neon platform role membership) resolved and reviewed.
- [ ] Clean disposable reset, 92 migrations applied, **38/38** integration and
      attack tests passing.
- [ ] `npm run typecheck` clean and the full application suite green.
- [ ] Production ledger verified as a contiguous, checksum-matching prefix
      through `0089` **before** any forward apply.
- [ ] Fresh explicit authority from Martin to deploy and to migrate production.
      Authority for one step is never authority for the next.

## 1. Database identities - least privilege

Five roles are involved. **Only three ever receive a credential.** The two
`*_definer` roles are `NOLOGIN` function owners and must never be given one.

| Role | Login | Purpose | Credential slot |
|---|---|---|---|
| `r72_daily_outreach_read` | LOGIN, NOINHERIT | Table-blind Daily Outreach / Creator Watch reads | `DATABASE_DAILY_OUTREACH_READ_URL` |
| `r72_daily_outreach_command` | LOGIN, NOINHERIT | Table-blind Daily Outreach writes via function allowlist | `DATABASE_DAILY_OUTREACH_COMMAND_URL` |
| `r72_daily_outreach_definer` | **NOLOGIN** | Function owner only | **none - never provision** |
| `r72_zernio_inbound_webhook_command` | LOGIN, NOINHERIT | Signed inbound Zernio DM/comment ingestion only | `DATABASE_ZERNIO_INBOUND_WEBHOOK_URL` |
| `r72_zernio_inbound_definer` | **NOLOGIN** | Function owner only | **none - never provision** |

- [ ] Each of the three login identities gets a **fresh, unique** password.
- [ ] No identity reuses `DATABASE_WEB_URL`, the Zernio **outbound** command
      identity, or any existing worker credential.
- [ ] The two Daily Outreach identities stay disjoint: the read identity holds no
      write function, the command identity no broad read.
- [ ] The Zernio inbound identity is independent of the outbound rail and can
      never read `ZERNIO_API_KEY`.
- [ ] Prove for each identity, as that identity: exact function allowlist, table
      blindness, and denial of elevated roles.

## 2. Render secret slots

Set on the Growth HQ service. `sync: false` slots are secrets, entered directly
and never committed.

Secrets (`sync: false`):

- [ ] `DATABASE_DAILY_OUTREACH_READ_URL`
- [ ] `DATABASE_DAILY_OUTREACH_COMMAND_URL`
- [ ] `DATABASE_ZERNIO_INBOUND_WEBHOOK_URL`
- [ ] `PROPERTY_PREDATOR_ZERNIO_INBOUND_CONNECTION_ID`
- [ ] `PROPERTY_PREDATOR_ZERNIO_INBOUND_PROVIDER_PROFILE_ID`
- [ ] `ZERNIO_INBOUND_WEBHOOK_CREDENTIAL_VERSION`
- [ ] `ZERNIO_INBOUND_WEBHOOK_SECRET`

Fixed values already in the Blueprint - confirm, do not change:

- [ ] `DATABASE_DAILY_OUTREACH_READ_POOL_MAX` = `2`
- [ ] `DATABASE_DAILY_OUTREACH_COMMAND_POOL_MAX` = `2`
- [ ] `DATABASE_ZERNIO_INBOUND_WEBHOOK_POOL_MAX` = `2`
- [ ] `PROPERTY_PREDATOR_DAILY_OUTREACH_PROGRAMME_KEY` = `founder_daily_linkedin`
- [ ] `PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED` = `false` (stays false at cutover)

## 3. Zernio workspace, connection and profile bindings

Inbound is a **separate boundary** from the existing outbound rail. First confirm
the outbound bindings are unchanged:

- [ ] `PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID` - unchanged
- [ ] `PROPERTY_PREDATOR_ZERNIO_PROVIDER_PROFILE_ID` - unchanged
- [ ] `PROPERTY_PREDATOR_ZERNIO_MESSAGING_ACCOUNT_IDS` - unchanged
- [ ] `PROPERTY_PREDATOR_ZERNIO_COMMENT_ACCOUNT_BINDINGS` - unchanged
- [ ] `PROPERTY_PREDATOR_ZERNIO_INSTAGRAM_ACCOUNT_ID` - unchanged
- [ ] `PROPERTY_PREDATOR_ZERNIO_LINKEDIN_ACCOUNT_ID` - unchanged

Then bind inbound to the **exact owned** connection and profile:

- [ ] `PROPERTY_PREDATOR_ZERNIO_INBOUND_CONNECTION_ID` - the exact owned
      connection, verified against the Zernio console.
- [ ] `PROPERTY_PREDATOR_ZERNIO_INBOUND_PROVIDER_PROFILE_ID` - the exact owned
      profile for that same connection.
- [ ] Confirm neither points at a third-party or unowned account.

## 4. Inbound webhook signing secret

- [ ] `ZERNIO_INBOUND_WEBHOOK_SECRET` is a **new, dedicated HMAC secret**
      generated for this route only.
- [ ] It is **not** `ZERNIO_API_KEY` and shares no material with it. The inbound
      route never reads `ZERNIO_API_KEY`.
- [ ] `ZERNIO_INBOUND_WEBHOOK_CREDENTIAL_VERSION` is set and matches the value
      registered with Zernio, so rotation stays correlated.
- [ ] The same secret is registered on the Zernio side for the callback URL.

## 5. Effect gates - prove before saving and again after deploy

- [ ] `PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED` = `false`
- [ ] `PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED` = `true`
- [ ] `PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED` = `false`
- [ ] Customer-email, WhatsApp and SMS pause switches untouched at their current
      safe values.

No message, comment, DM or customer communication is authorised by this
checklist. There is no release command in the application.

## 6. Forward migration

- [ ] Re-verify the production ledger is a contiguous checksum-matching prefix
      through `0089`.
- [ ] Apply **only** the forward suffix `0090`, `0091`, `0092` under the
      migration advisory lock.
- [ ] Confirm the ledger reads 92/92 with no reset, rewrite or data import.
- [ ] Confirm both `*_definer` roles exist as `NOLOGIN` and own their functions.

## 7. Deploy and readiness

- [ ] Publish the reviewed release graph and record its exact SHA.
- [ ] Confirm the service starts and reports ready.
- [ ] Confirm each of the three new identities authenticates in production and
      passes its table-blindness and function-allowlist probe.
- [ ] Confirm Daily Outreach and Creator Watch render read-only with effects off.

## 8. Signed inbound proof - before enabling inbound processing

`PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED` stays `false` until every step passes.

- [ ] Send a **signed owned/test** inbound payload, from the owned account only.
- [ ] Confirm the signature verifies against `ZERNIO_INBOUND_WEBHOOK_SECRET` and
      the credential version matches.
- [ ] Confirm an unsigned or wrong-secret payload is **rejected**.
- [ ] Confirm a replayed payload is **de-duplicated**, not double-projected.
- [ ] Confirm a payload for a non-bound account or connection is **rejected**
      before any write.
- [ ] Confirm a malformed payload is **quarantined**, not marked delivered.
- [ ] Confirm the evidence lands account-scoped in Conversion Inbox as
      **read-only**, with no reply, comment or provider call attempted.
- [ ] Only then, under **separate explicit authority**, set
      `PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED` to `true`, with provider effects
      still `false` and the social emergency pause still `true`.

## 9. Rollback

- [ ] Migrations `0090`-`0092` are forward-only. Roll back by redeploying the
      previous release graph and leaving the ledger in place, never by reverting
      migrations.
- [ ] Setting `PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED` back to `false` disables
      inbound processing immediately, without a migration.
