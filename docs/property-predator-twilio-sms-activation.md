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

## Switch-release order

1. **Record evidence.** Live `twilio_messaging` provider connection, verified
   phone channel endpoint for the founder-owned UK test number, granted `sms`
   consent with the full PECR decision chain, and the approved message version.
   No switches change.
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
