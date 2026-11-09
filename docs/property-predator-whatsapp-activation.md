# Property Predator — Meta WhatsApp activation readiness

This rail is composed and dark. Nothing in this document sends a message,
connects an account or enables a provider effect. A first WhatsApp effect
remains a separate, explicitly authorised decision.

## What is already proven in code

| Capability | Where | State |
| --- | --- | --- |
| Owned-number binding, AES-256-GCM sealed token, rotation and revocation | `0053` `record_whatsapp_live_binding` / `revoke_whatsapp_live_binding` | composed |
| Exactly one Meta-approved, parameter-free template pinned to approved company bytes | `0053` `property_predator_whatsapp_live_templates` + `record_whatsapp_live_template` | composed |
| Founder command → authority → job, 1/day and 3/month per binding | `0053` `authorize_and_enqueue_whatsapp_live_job` | composed |
| One-at-a-time worker with lease fencing and outcome-unknown quarantine | `0053` claim/load/begin/settle + `workers/meta-whatsapp-live` | composed |
| Challenge verification and raw-byte `X-Hub-Signature-256` webhook | `services/meta-whatsapp-live-webhook` | composed |
| `sent` / `delivered` / `read` / `failed` / `deleted` status projection, replay and conflict detection | `0053` `record_whatsapp_live_status` | composed |
| Signed inbound → Conversion Inbox conversation, message, urgent admin-call task and Lead 360 origin | `0055` `record_whatsapp_live_inbound_projection` | composed |
| Engage-only emergency pause fencing the `→ calling` transition inside the database | `0057` `guard_live_channel_job_calling_pause` | composed |
| Read-only, zero-send activation readiness for one exact owned target | `0058` `property_predator_whatsapp_activation_readiness` | composed |

## The zero-send readiness probe

`0058` adds one `STABLE` `SECURITY DEFINER` function that writes nothing,
creates no authority or job, and cannot reach a provider. It returns one row
per dimension carrying a boolean and a non-sensitive blocker code.

The supplied recipient is converted to a SHA-256 digest before it crosses any
boundary and is compared against the digest the database itself derives from
the verified contact point. The number is never returned, logged or echoed.

Dimensions, in order:

`operator_authority`, `provider_connection`, `owned_binding`,
`approved_template`, `template_content_current`, `recipient_endpoint`,
`recipient_matches_supplied_owned_target`, `current_consent`,
`suppression_clear`, `inbound_ingress`, `cap_headroom`,
`emergency_pause_clear`.

### Deliberately not pre-proved

The PECR sender route, PECR instigator route and the `whatsapp.send`
permission-use receipt are bound to the exact request id of the command that
consumes them. They cannot honestly be pre-proved by a separate read, so the
report lists them as command-time evidence rather than claiming readiness.

## Remaining provider values

None of these exist in this repository or in any environment inspected here.
Each must be supplied by an authorised human at activation time.

### Meta account evidence
- `PROPERTY_PREDATOR_META_WHATSAPP_APP_ID` — Meta app id
- `PROPERTY_PREDATOR_META_WHATSAPP_WABA_ID` — WhatsApp Business Account id
- `PROPERTY_PREDATOR_META_WHATSAPP_PHONE_NUMBER_ID` — the owned number's id
- `PROPERTY_PREDATOR_META_WHATSAPP_APP_SECRET` — webhook signature key, webhook process only
- `PROPERTY_PREDATOR_META_WHATSAPP_VERIFY_TOKEN` — challenge token, webhook process only
- A Graph access token for the owned number, sealed through
  `encryptMetaWhatsAppDispatchCredentials` before it reaches the database. The
  plaintext token is never stored, and the worker is the only process holding
  the credential encryption key.

### Owned number and recipient evidence
- The owned WhatsApp sender number, bound through `record_whatsapp_live_binding`
  with `ownership_evidence_sha256` and `ownership_observed_at`.
- One nominated founder-owned UK recipient in `+44` E.164 form, existing as a
  verified `app.contact_points` row with `kind = 'whatsapp'`,
  `is_verified = true`, `dedupe_state = 'normal'`, `deleted_at IS NULL`.
- A current `granted` consent event on that exact endpoint for the chosen
  purpose, with no later suppression event.
- An explicit written ownership attestation from the founder that the number is
  theirs and that they consent to receiving the test message.

### Template evidence
- One Meta-approved template with `parameter_count = 0` and
  `provider_status = 'approved'`.
- Its immutable provider template name and language code.
- `provider_template_ref_sha256` and `provider_approval_evidence_sha256`
  capturing the exact Meta approval artefact, plus `provider_approved_at`.
- A company content version whose bytes re-derive to `content_sha256`, with an
  approval request and an `approved` approval decision.

### Rehearsal settings for the readiness probe
```
PROPERTY_PREDATOR_REHEARSAL_WORKSPACE_ID
PROPERTY_PREDATOR_WHATSAPP_LIVE_BINDING_ID
PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_TEMPLATE_ID
PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PERSON_ID
PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_ENDPOINT_ID
PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_CONSENT_EVIDENCE_ID
PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_PURPOSE
PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT
PROPERTY_PREDATOR_REHEARSAL_WHATSAPP_RECIPIENT_OWNED=true
```

## Activation order

1. Supply the Meta account evidence into the Render secret slots. Both
   processes stay dark: `PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE=disabled`,
   `PROPERTY_PREDATOR_WHATSAPP_WEBHOOK_MODE=disabled`.
2. Record the owned-number binding and the approved template through the
   founder command boundary.
3. Run the zero-send readiness probe until every dimension reads ready.
4. Obtain separate, explicit authorisation for one owned test message, together
   with the command-time PECR and permission-use evidence.
5. Only then flip the activation tuple. Both live modes require all four of
   `mode`, provider-effects, not-paused and the pinned provider id; a partial
   tuple raises rather than silently downgrading.

The emergency pause has no release function by design. Engaging it is a
one-way, durable decision recorded as append-only evidence.
