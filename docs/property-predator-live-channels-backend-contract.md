# Property Predator Live Channels backend contract

Audience: the founder-facing Live Channels UI implementer. This document describes the backend seams that exist at the 0052-0054 checkpoint. It does not define a browser-to-database API and does not authorise provider activation.

## Non-negotiable UI rules

- The browser must never receive a database URL, provider secret, encrypted credential envelope, raw recipient address, webhook signing material, or provider access token.
- The UI must call a server-side command adapter under an authenticated founder/owner session. It must not call a PostgreSQL function or repository directly.
- `queued`, `replayed`, worker readiness, and a provider receipt are different facts. Never render `sent`, `published`, `delivered`, or `connected` from an enqueue result.
- There is no aggregate Live Channels read/presenter API in this checkpoint. Until one is added, connection state, cap usage, approval state, blocked reasons, job state, and receipt history are **not available to the UI**. Render them as unavailable/unknown, not as ready or zero.
- Command failures are exceptions/transaction failures, not a structured `blockedReasons` result. Do not parse database exception text in the browser. A later backend route must map reviewed failures to safe stable codes.
- All three provider-effect processes are dark by default. No current startup/readiness path makes a provider network call.

## Truth ownership

| UI claim | Authoritative backend fact | Current UI-readable API |
| --- | --- | --- |
| Connected | Exact active live `provider_connections` record plus the channel-specific non-revoked binding/profile | None |
| Cap remaining | Durable non-cancelled job count in the database, evaluated atomically by enqueue | None; never infer from the hard-cap constant |
| Approved | Exact content/template approval identifiers revalidated inside the enqueue transaction | None |
| Eligible recipient | Exact verified endpoint, latest consent, no current suppression, and current PECR/operator permission evidence revalidated by the database | None |
| Enqueued | Successful command result (`jobId`; plus disposition for customer email) | Server command adapter only |
| Provider accepted/published | Durable worker receipt after the calling fence | None |
| Delivered/read/failed | Authenticated provider receipt projected to the durable receipt ledger | None |
| Blocked reason | Safe mapping of a command rejection or a durable `needs_attention` state | None |
| Runtime ready | Service readiness object after schema, installation, role, and function-boundary checks | Internal process readiness only; not a portal route |

The UI can be built against loading, unavailable, disabled, and action-pending states now. It must not manufacture positive channel truth while the read/presenter route is absent.

## Owned X via Ayrshare (0052)

### Existing founder command service

`OwnedPublicSocialLiveCommandService` is constructed server-side with one `workspaceId` and `providerConnectionId`. Every method requires a validated active user context with a 32-byte `portalSessionTokenHash`, runs serializably through `DATABASE_OWNED_SOCIAL_COMMAND_URL` as `r72_owned_social_command`, and returns `providerEffects: 'none'`.

Exact service inputs and outputs:

```text
recordProfile(context, {
  profileId, displayName, providerProfileRefSha256, ownedAccountRefSha256,
  envelope: { algorithm: 'aes-256-gcm-v1', keyVersion, ivBase64,
              ciphertextBase64, authTagBase64, aadSha256,
              profileKeySha256 },
  xOAuthLinkEvidenceSha256, linkedAt, evidenceObservedAt
}) -> { profileId, providerEffects: 'none' }

revokeProfile(context, {
  profileId, revocationEvidenceSha256, reasonCode
}) -> { revocationId, providerEffects: 'none' }

enqueue(context, {
  profileId, contentItemId, contentVersionId, approvalRequestId,
  approvalDecisionId, sourceAttestationId, operationTag,
  idempotencyKeySha256, requestSha256, scheduledFor | null
}) -> {
  jobId, providerEffects: 'none', caps: { daily: 1, monthly: 3 }
}
```

The database requires an active owner/admin user context, an active live Ayrshare social connection, a non-revoked owned X profile, the latest approved `social_post` content version, and a source attestation valid through the effect time plus 15 minutes. Initial X content is ASCII text only, at most 280 characters, and link-free. Idempotent replay returns the existing job UUID; a different request digest conflicts.

### Runtime/readiness truth

`property-predator-owned-public-social-live` uses only `DATABASE_OWNED_SOCIAL_WORKER_URL` as `r72_owned_social_worker_command`, one database connection, one non-overlapping operation per cycle, and caps of one publish per owned profile per UTC day and three per UTC month.

Readiness reports:

- mode: `disabled | owned_profile_live`;
- provider: Ayrshare, network X, credential scope `single-owned-profile`, credentials/adapter loaded flags, and `networkCallsMadeAtReadiness: false`;
- exact database role, current schema, matching installation, and function boundary;
- provider-effects, pause, loop-started, and hard-cap fields.

Worker outcomes are `disabled | idle | published_or_pending | failed_or_attention`. Durable provider receipt kinds are `accepted | published | failed | outcome_unknown`. An expired or ambiguous calling attempt is fenced to `needs_attention` and is not automatically republished.

### Dark default and activation evidence

Dark tuple:

```text
PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE=disabled
PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false
PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED=true
```

Activation additionally requires the exact workspace/connection IDs, `ayrshare`/`x` provider tuple, a 32-byte profile-envelope encryption key and version, `AYRSHARE_API_KEY`, `AYRSHARE_X_OAUTH1_API_KEY`, and `AYRSHARE_X_OAUTH1_API_SECRET`. The database must contain evidence for the exact owned X account/profile, read-write OAuth link, encrypted Ayrshare profile key, current approval, and current source attestation.

The first proof target must be an explicitly supplied owned X profile and one explicitly approved owned test post. No customer or inferred account is a valid target.

## Meta WhatsApp Cloud (0053)

### Existing founder command service

`MetaWhatsAppLiveCommandService` is server-side only and is bound to one `workspaceId`. Every method requires `MetaWhatsAppLiveUserContext`: normal database request context plus `actorKind: 'user'`, `userId`, and `portalSessionTokenHash`. The PostgreSQL implementation uses only `DATABASE_WHATSAPP_LIVE_COMMAND_URL` as `r72_whatsapp_live_command`, locks the active portal session, and runs serializably. Its encrypted `envelope` is an outbound dispatch envelope whose canonical plaintext contains exactly one field, `accessToken`; `appSecret` and `verifyToken` are rejected here and belong only to the isolated webhook service.

```text
recordBinding(context, {
  binding: { bindingId, workspaceId, connectionId, appId, wabaId,
             phoneNumberId, graphApiVersion: 'v24.0' },
  ownedPhoneSha256,
  envelope: { algorithm: 'aes-256-gcm-v1', keyVersion, ivBase64,
              ciphertextBase64, authTagBase64, aadSha256,
              secretPayloadSha256 },
  ownershipEvidenceSha256, ownershipObservedAt, predecessorBindingId | null
}) -> bindingId UUID

revokeBinding(context, { bindingId, evidenceSha256 }) -> revocationId UUID

recordTemplate(context, {
  bindingId, templateId, contentItemId, contentVersionId,
  approvalRequestId, approvalDecisionId, templateName,
  templateRefSha256, languageCode, category: 'utility' | 'marketing',
  providerApprovalEvidenceSha256, providerApprovedAt
}) -> templateId UUID

authorizeAndEnqueue(context, {
  bindingId, templateId, contactId, contactPointId, consentEventId,
  complianceSubjectId, policyPublicationEventId,
  pecrSenderDecisionEventId, pecrInstigatorDecisionEventId,
  permissionUseReceiptId, purpose, authorityValidUntil,
  operationId, idempotencyKeySha256, requestSha256
}) -> jobId UUID
```

The command accepts identifiers and digests, not a browser-supplied phone number. The database resolves the exact verified WhatsApp endpoint and revalidates the active live Meta messaging connection, current non-revoked owned-number binding, parameter-free provider-approved template, company content approval, latest channel/purpose consent, absence of suppression, published policy, PECR sender/instigator decisions, operator membership, and consumed `whatsapp.send` permission evidence. Enqueue does not call Meta.

### Worker and webhook readiness

`property-predator-meta-whatsapp-live-worker` uses only `DATABASE_WHATSAPP_LIVE_WORKER_URL` as `r72_whatsapp_live_worker_command`. It processes one non-overlapping job per cycle with one recipient, one template, one send per binding per UTC day, and three per UTC month. Readiness reports Meta Graph `v24.0`, credential source `job-bound-encrypted-envelope`, `credentialEnvelopeLoadedAtReadiness: false`, `adapterInstantiatedAtReadiness: false`, and `networkCallsMadeAtReadiness: false`, plus the exact database and safety fields.

Cycle outcomes are `disabled | idle | accepted | failed_or_attention`. Provider outcomes are `accepted | failed | outcome_unknown`. The durable calling fence is entered before transport; ambiguous outcomes become `needs_attention` with no automatic retry.

`property-predator-meta-whatsapp-live-webhook` uses only `DATABASE_WHATSAPP_LIVE_WEBHOOK_URL` as `r72_whatsapp_live_webhook_command` and exposes:

```text
GET  /health
GET  /webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
POST /webhooks/meta/whatsapp   (raw body; no query string)
```

POST verifies the exact raw bytes with `X-Hub-Signature-256`, limits the body to 262,144 bytes, and validates the exact WABA/phone binding before recording events. Success is `{ "accepted": true }`. Internally, receipt commands return `applied | replayed | conflict`; a conflict is rejected. Signed statuses are `sent | delivered | read | failed | deleted`. Verified inbound events use the `conversion_inbox_and_lead360` projection seam. The webhook readiness object proves raw-body verification and that outbound token, envelope key, and readiness provider calls are absent.

### Dark default and activation evidence

Worker dark tuple:

```text
PROPERTY_PREDATOR_WHATSAPP_LIVE_MODE=disabled
PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false
PROPERTY_PREDATOR_WHATSAPP_EMERGENCY_PAUSED=true
```

Webhook dark value: `PROPERTY_PREDATOR_WHATSAPP_WEBHOOK_MODE=disabled`.

Activation requires the exact owned Meta app ID, WABA ID, business phone-number ID, active live provider connection ID, owned-phone digest/evidence, an encrypted dispatch envelope containing exactly the outbound access token only, its envelope key and version for the worker, and separate app-secret/verify-token values for the webhook. The dispatch codec rejects any payload carrying the app secret or verify token, including a legacy three-secret envelope. The webhook process must never receive the access token or envelope key; the command/worker path must never receive webhook verification secrets.

The first proof requires an explicitly supplied owned/test WhatsApp recipient with a verified contact point and exact consent, policy, PECR, operator, and permission-use evidence; one exact parameter-free Meta-approved template with matching company approval; and signed challenge/status/inbound test events for that same owned binding. Do not select a customer or send until the activation scope is explicitly confirmed.

## Mailgun EU customer email (0054)

### Existing 23-argument command seam

`CustomerEmailLiveCommandService` is constructed server-side with `workspaceId` and `providerConnectionId`. It requires a validated active user context with a 32-byte `portalSessionTokenHash`. Its `authorizeAndEnqueue` command contributes the remaining 21 values, making the exact 23-argument database call:

```text
authorizeAndEnqueue(CustomerEmailLiveUserContext, {
  campaignTemplateVersionId,
  campaignTemplateStepId,
  campaignStepContentSha256,
  campaignApprovalRequestId,
  campaignApprovalDecisionId,
  messageVersionId,
  messageApprovalRequestId,
  messageApprovalDecisionId,
  channelEndpointId,
  consentEventId,
  complianceSubjectId,
  policyPublicationEventId,
  pecrSenderDecisionEventId,
  pecrInstigatorDecisionEventId,
  permissionUseReceiptId,
  authorityValidUntil,
  providerOperationId,
  messageDeliveryId,
  correlationId,
  idempotencyKeySha256,
  requestSha256
}) -> {
  jobId,
  disposition: 'queued' | 'replayed',
  providerEffects: 'none',
  caps: { daily: 10, monthly: 50, recipientsPerJob: 1 }
}
```

The SQL order places `messageDeliveryId` immediately after `providerOperationId`; the repository owns this ordering. The browser must not reconstruct or call the 23-argument SQL function.

The canonical request digest binds the SQL-derived `sendingDomain` immediately after `providerConnectionId`, and binds `authorityValidUntil` immediately after `permissionUseReceiptId` and before `providerOperationId`. The timestamp is the canonical UTC millisecond ISO string produced by `Date.toISOString()` (for example `2026-08-29T10:10:00.000Z`). The action scope is exactly `email:{workspaceId}:{providerConnectionId}:{sendingDomain}:{campaignVersionId}:{campaignStepId}:{campaignStepContentShaHex}:{messageVersionId}:{recipientEndpointIdentityShaHex}:{purpose}:{consentEventId}`. The authenticated server adapter, not the browser, owns both digests.

The database resolves the recipient rather than accepting an email string. It requires an active live `mailgun_eu` email connection with `email.send`, active owner/admin and portal-session context, exact campaign-step and message approvals, approved pilot content, verified endpoint, latest consent, no current suppression, current policy/PECR/operator evidence, and a consumed `email.send` permission-use receipt. It snapshots `sender_endpoint_normalized_address` only from an active live outbound/bidirectional Mailgun endpoint whose `address` and `normalized_address` are both exactly `mg.propertypredator.com`. It enforces 10 jobs per provider connection per UTC day, 50 per UTC month, one recipient per job, exact request digest, and idempotent replay. Enqueue has `providerEffects: 'none'` and cannot call Mailgun.

### Signed receipt seam

`CustomerEmailSignedReceiptProjector` is constructed with the webhook-only pool, workspace ID, and provider connection ID:

```text
recordSignedReceipt(externalEventId) -> 'applied' | 'replayed' | 'not_applicable'
```

This projector does **not** authenticate a raw Mailgun request. It may run only after the existing Mailgun ingress has verified the signature and durably recorded the matching `mailgun_webhook_events` row. It uses only `DATABASE_CUSTOMER_EMAIL_WEBHOOK_URL` as `r72_customer_email_webhook_command` and projects exact event/job/recipient bindings. `failed`, `complained`, and `unsubscribed` remain failed; `delivered`, `opened`, and `clicked` can prove success; other applicable events retain `awaiting_receipt`. The projection result is not a receipt-history DTO.

Receipt projection is enabled only when all three values are exact `true`: `PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_ENABLED`, `PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED`, and `MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED`. The customer-email workspace and provider-connection IDs must equal the canonical Mailgun ingress workspace and connection IDs exactly. A mismatched binding keeps projection unavailable rather than acknowledging an unprojectable event.

### Worker readiness and dark default

`property-predator-customer-email-live` uses only `DATABASE_CUSTOMER_EMAIL_WORKER_URL` as `r72_customer_email_worker_command`, one database connection, and one non-overlapping operation per cycle. `load_customer_email_live_job` returns the snapshotted `sending_domain` immediately after `provider_connection_id`; the repository carries it as job material. Before `markCalling` or any send, the worker requires that value, `MAILGUN_SENDING_DOMAIN`, and the canonical domain of `MAILGUN_FROM_EMAIL` all equal `mg.propertypredator.com`. A mismatch fails as an invalid binding without a provider call.

Readiness reports provider `mailgun_eu`, region `eu`, sending domain `mg.propertypredator.com`, credential scope `domain-sending`, credentials/adapter flags, `networkCallsMadeAtReadiness: false`, the exact database boundary, and the 1/10/50 safety limits. `receipts.operatorConfirmed` reports only the local operator attestation; `receipts.remoteHealthCheckedAtReadiness` is always `false`.

Dark tuple:

```text
PROPERTY_PREDATOR_CUSTOMER_EMAIL_LIVE_MODE=disabled
PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED=false
PROPERTY_PREDATOR_CUSTOMER_EMAIL_DELIVERY_ENABLED=false
PROPERTY_PREDATOR_CUSTOMER_EMAIL_EMERGENCY_PAUSED=true
PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED=false
```

Active mode additionally requires `NODE_ENV=production`, provider `mailgun_eu`, exact workspace/connection IDs, `MAILGUN_REGION=eu`, `MAILGUN_SENDING_DOMAIN=mg.propertypredator.com`, `MAILGUN_KEY_SCOPE=domain-sending`, an exact domain-sending key, a canonical `MAILGUN_FROM_EMAIL` on that same domain, and exact `PROPERTY_PREDATOR_CUSTOMER_EMAIL_RECEIPTS_CONFIRMED=true`. In active mode, missing, `false`, mixed-case, whitespace-padded, or any other malformed receipt value fails closed. Disabled mode accepts only a missing value or exact `false`; exact `true` and malformed values are rejected. Confirmation is a local operator attestation set only after the canonical signed Mailgun route and 0054 projector pass protected proof; it is not remote-health proof. The worker rejects a broad `MAILGUN_API_KEY` and any `MAILGUN_SIGNING_KEY`; signature material belongs only in the webhook ingress. A transport exception is non-retryable `needs_attention` with `mailgun_customer_outcome_unknown` pending signed-receipt reconciliation.

### Minimal activation and protected proof inputs

- Provider: the exact Mailgun EU account, verified `mg.propertypredator.com` DNS/domain, one canonical verified `MAILGUN_FROM_EMAIL` on that domain, one domain-sending key, and the webhook signing key isolated to ingress.
- Database binding: exact live workspace, Mailgun provider-connection, and active outbound/bidirectional channel-endpoint IDs; the endpoint `address` and `normalized_address` must both be `mg.propertypredator.com`.
- Receipt path: exact canonical ingress workspace/connection IDs matching the customer-email IDs, the three receipt/ingress/signature switches above, and one valid signed event projected through 0054. Only after this proof may the worker attestation be set to exact `true`.
- Test delivery: one explicitly supplied owned/internal recipient; exact campaign version/step/content hash and approvals; exact message version and approvals; endpoint, latest consent, no current suppression, compliance subject, published policy, PECR sender/instigator decisions, consumed permission-use receipt, validity timestamp, and fresh operation/delivery/correlation/idempotency/request identifiers.

No customer address may be inferred or targeted, and activation requires explicit confirmation of this exact proof scope.

## What Claude can safely implement now

- Premium founder-only visual states driven by explicit props: loading, unavailable, dark/paused, awaiting backend confirmation, and attention required.
- Command forms that collect only the identifiers/evidence listed above, provided their submit handlers remain disabled until the corresponding authenticated server adapter exists.
- Receipt and cap layouts with an unavailable state, not fabricated rows or `0 used` values.
- A clear separation between `enqueue accepted`, `provider accepted`, and terminal receipt states.

Do not add direct database access, expose internal readiness endpoints publicly, derive readiness from Render service existence, or label a channel active merely because credentials have been entered. The missing backend presenter must be implemented and reviewed before positive connection/cap/approval/receipt truth can be shown.
