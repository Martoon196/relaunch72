# Property Predator — Twilio UK SMS activation inputs

Status: 0056 foundation built, **deployed dark, no live transport**. Contract
`propertypredator.twilio-sms-live/v1`, rail `sms`, provider `twilio_messaging`.
This note lists only what an activation review must supply and the exact release
order. It authorises nothing by itself, contains no secret values, and every
value below is provided at activation time — none are invented here.

## Activation inputs

- Twilio Account SID (`PROPERTY_PREDATOR_SMS_ACCOUNT_SID`).
- Restricted API key SID + secret (`TWILIO_API_KEY_SID`,
  `TWILIO_API_KEY_SECRET`) — **worker only**, with
  `TWILIO_KEY_SCOPE=restricted-api-key`.
- Messaging Service SID (`TWILIO_MESSAGING_SERVICE_SID`).
- Owned UK sender number (`PROPERTY_PREDATOR_SMS_SENDER_NUMBER`) and its Number
  SID, attached to that Messaging Service.
- Approved UK regulatory bundle SID (`TWILIO_UK_REGULATORY_BUNDLE_SID`).
- Public webhook origin (`PROPERTY_PREDATOR_SMS_WEBHOOK_PUBLIC_ORIGIN`) plus the
  two callback paths `POST /webhooks/twilio/sms/inbound` and
  `POST /webhooks/twilio/sms/status` registered in the Messaging Service with
  signature validation.
- `TWILIO_AUTH_TOKEN` placed **only** in the webhook service.
- Workspace and `twilio_messaging` live provider-connection UUIDs
  (`PROPERTY_PREDATOR_SMS_LIVE_WORKSPACE_ID`,
  `PROPERTY_PREDATOR_SMS_LIVE_CONNECTION_ID`).
- One nominated founder-owned UK test number recorded as a verified phone
  contact point with granted `sms` consent.
- One approved message version.

## Credential isolation

| Value | Worker (`property-predator-twilio-sms-live`) | Webhook (`property-predator-twilio-sms-live-webhook`) |
| --- | --- | --- |
| `PROPERTY_PREDATOR_SMS_ACCOUNT_SID` | required | required |
| `TWILIO_API_KEY_SID` | required | forbidden |
| `TWILIO_API_KEY_SECRET` | required (worker-only secret) | forbidden |
| `TWILIO_MESSAGING_SERVICE_SID` | required | forbidden |
| `TWILIO_AUTH_TOKEN` | forbidden | required (webhook-only signature key) |
| Database URL | `DATABASE_SMS_WORKER_URL` only | `DATABASE_SMS_WEBHOOK_URL` only |

The two credential sets never share a process. The dispatch worker is
permanently constrained to one database connection and one concurrent provider
call.

## Production rollout checkpoint (effect-free)

Everything in this section is reachable with provider effects OFF, delivery OFF
and the emergency pause ON. None of it sends a message or calls Twilio.

**1. Apply migration 0061, in order.** The ledger must already stand at `0060`
(the owned-social function ACL repair). Then, with `DATABASE_MIGRATOR_URL`
pointing at the target database:

```bash
npm run db:check --workspace @relaunch72/orchestrator
```

```bash
npm run db:migrate --workspace @relaunch72/orchestrator
```

Migrations are forward-only and run under one session-level advisory lock, so
concurrent deploys serialise rather than interleave. `0061` takes the ledger to
`61/61`.

`0061` **creates no roles**. It widens the `provider_connections.provider_kind`
check by one value, adds the binding and revocation tables, and grants EXECUTE
on exactly four functions — `record_sms_live_binding`, `revoke_sms_live_binding`,
`derive_sms_live_request_digest` and `property_predator_sms_activation_readiness`
— to `r72_sms_command` only. The worker and webhook identities gain nothing.

**2. Least-privilege SMS role credentials.** Three disjoint, function-only
identities, one per process, never shared:

| Identity | Environment variable | Pool max |
| --- | --- | --- |
| `r72_sms_command` | `DATABASE_SMS_COMMAND_URL` | `2` |
| `r72_sms_worker_command` | `DATABASE_SMS_WORKER_URL` | `1` |
| `r72_sms_webhook_command` | `DATABASE_SMS_WEBHOOK_URL` | `2` |

All three are table-blind: the migrations fail if any of them can read the SMS
tables directly. A generic `DATABASE_URL` cannot satisfy these boundaries —
startup requires the exact cutover identity per role.

**3. Render service bindings.** Three services, three credential sets:

| Service | Command | Database URL | Twilio secrets |
| --- | --- | --- | --- |
| Growth HQ web | existing web service | `DATABASE_SMS_COMMAND_URL` | none |
| SMS worker | `serve:twilio-sms-live` | `DATABASE_SMS_WORKER_URL` | `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_MESSAGING_SERVICE_SID` |
| SMS webhook | `serve:twilio-sms-live-webhook` | `DATABASE_SMS_WEBHOOK_URL` | `TWILIO_AUTH_TOKEN`, `PROPERTY_PREDATOR_SMS_WEBHOOK_PUBLIC_ORIGIN` |

`TWILIO_AUTH_TOKEN` belongs to the webhook process alone and must never be set
on the worker; the restricted API key belongs to the worker alone and must never
be set on the webhook. The Growth HQ web service holds no Twilio credential at
all — the founder bind command reduces the Account SID and Messaging Service SID
to digests and stores no secret.

**4. Emergency pause ON, delivery and provider effects OFF.** Deploy with:

```
PROPERTY_PREDATOR_SMS_LIVE_MODE=disabled
PROPERTY_PREDATOR_SMS_WEBHOOK_MODE=disabled
PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED=true
PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false
PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED=false
PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED=false
```

The environment switch is not the only fence. The durable pause is a row in
`app.property_predator_live_channel_pause_events` for scope `all` or `sms`,
engaged by the founder command, and a `BEFORE UPDATE` trigger rejects the
transition to `calling` while it exists. A worker that passed
`emergencyPaused: false` still could not dispatch.

**5. Zero-send health and readiness rehearsal.** Effect-free by construction:

```bash
npm run pilot:preflight --workspace @relaunch72/orchestrator
```

This reads environment shape only — no database write, no Twilio call. Then
start each service and confirm it reports dark readiness: startup verifies role
identity, exact function signatures and table-blindness, and makes no provider
call. Finally open Live Channels and confirm the SMS rail reads
`PROVIDER_NOT_CONFIGURED` until a sender is bound, then reports its true posture
afterwards. Receipts stay `NONE YET` until a real signed status callback lands.

**Exit condition.** Ledger `61/61`, three services dark, pause engaged, all
effect switches false, preflight green. No message has been sent and no Twilio
call has been made.

## Switch-release order

1. **Record evidence.** Live `twilio_messaging` provider connection, verified
   phone channel endpoint for the founder-owned UK test number, granted `sms`
   consent with the full PECR decision chain, and the approved message version.
   Bind the sender through the founder-only Live Channels command, which mints
   the connection and owned `+44` endpoint from digested evidence. No switches
   change.
2. **Deploy dark.** Both services with `PROPERTY_PREDATOR_SMS_LIVE_MODE=disabled`,
   `PROPERTY_PREDATOR_SMS_WEBHOOK_MODE=disabled`,
   `PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED=true`,
   `PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false`,
   `PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED=false`,
   `PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED=false`.
3. **Prove signed webhooks.** Set
   `PROPERTY_PREDATOR_SMS_WEBHOOK_MODE=signed_live` and drive provider test
   events at both registered callback paths; verify `X-Twilio-Signature`
   validation and durable replay/conflict receipts.
4. **Set receipts confirmed.** `PROPERTY_PREDATOR_SMS_RECEIPTS_CONFIRMED=true`
   only after step 3 evidence.
5. **Release for one owned test send.** In one reviewed change:
   `PROPERTY_PREDATOR_SMS_EMERGENCY_PAUSED=false`,
   `PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=true`,
   `PROPERTY_PREDATOR_SMS_DELIVERY_ENABLED=true`,
   `PROPERTY_PREDATOR_SMS_LIVE_MODE=owned_number_live` — scoped to the
   nominated founder-owned UK test number only.

## Invariant — readiness never calls Twilio

Readiness and startup verify configuration shape and database function
signatures only. No readiness, health or startup path performs a Twilio API
call; the only provider call is a leased, fenced dispatch of an authorised job.

## UK PECR

Marketing SMS to the UK requires prior granted consent; purpose `marketing` is
enforced at enqueue and re-checked immediately before the provider call. Every
send carries a working opt-out: STOP is honoured immediately, and START never
overrides a manual suppression.
