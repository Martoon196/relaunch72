# Meta communications adapters — effects-OFF operator note

Status: production-shaped contracts, **no live transport**. Both adapters default to
`disabled`; the only other accepted mode is `contract_test`, backed by an opaque,
in-memory scripted HTTP transport. There is no `fetch`, socket client, provider
registration, migration, secret lookup, or live credential path in this slice.

## What is represented

- WhatsApp Cloud API template requests to the versioned Phone Number ID
  `/messages` endpoint.
- WhatsApp Business Account `messages` webhook ingestion.
- Facebook Page Messenger and Instagram professional-account `messages` webhook
  ingestion.
- Facebook and Instagram text reply request contracts inside a current,
  evidence-bound 24-hour customer-inbound window.
- Meta's GET callback verification ceremony (`hub.mode=subscribe`, exact
  `hub.verify_token`, echo `hub.challenge`).
- Meta POST authentication using `X-Hub-Signature-256` HMAC-SHA256 over the
  **exact raw request bytes**, before UTF-8 decoding or JSON parsing.
- Verified inbound text normalised to the existing `RecordTestInboundCommand`
  seam. Provider message IDs become deterministic hashed command keys, so the
  existing inbox command receipt supplies durable replay and conflict handling.

Attachments, postbacks, quick replies, message echoes, delivery statuses,
WhatsApp non-text messages, free-form WhatsApp sessions, sponsored messages and
outside-window DM mechanisms do not become send capabilities here. Unsupported
inbound event types are ignored only after the whole request has passed the
signature and workspace/resource binding checks.

## Required binding and evidence

Credential bundles are runtime-opaque objects. Their serialised form contains
only workspace ID, connection ID, credential version, Graph API version and the
bound Meta resource IDs. Access token, app secret and callback verification token
are held in a private runtime map; neither values nor hashes are written to
request evidence, results, captured contract requests or errors. Captured
`Authorization` is always `Bearer [REDACTED]`. A copied or forged bundle is not
accepted.

The HTTP/router layer must resolve one bundle using a workspace-qualified
connection lookup before calling either verifier. It must pass the unmodified raw
body bytes and the single `X-Hub-Signature-256` header value. Never reconstruct
the body from parsed JSON. The parser then checks:

- credential workspace and connection;
- app credential authenticity;
- numeric app, Page, WABA, Phone Number and Instagram professional-account IDs;
- webhook `object`, entry resource ID and recipient/metadata resource ID;
- bounded request size, entries, changes, messaging events, strings and IDs;
- a contact binding by SHA-256 of the provider sender ID before producing an
  inbox command.

Every outbound contract request additionally requires an immutable message
version and body hash, approval decision bound to that exact version, current
channel consent, current PECR decision, instigator decision, recipient hash,
and fresh workspace/connection control evidence. The rate, daily volume and GBP
spend counters must all have capacity. An engaged emergency pause blocks the
request. `providerEffects` must remain `false` in this contract slice.

The safe default control factory returns emergency pause engaged, all capacity
consumed and provider effects false. It is intentionally unusable for outbound
contract execution until trusted control evidence is supplied. Even then,
`contract_test` only records the production-shaped request and consumes a scripted
response; it cannot reach Meta.

## Replay and ambiguous outcomes

Outbound requests are hashed across endpoint, exact body, approval/evidence hash
and control hash. A retry with the same operation ID and idempotency key returns
the cached contract result and does not consume another scripted response. Reuse
with different immutable input fails with `MetaIdempotencyConflictError`.

Transport failures, 408/409/429 and 5xx responses are `outcome_unknown`; they are
not treated as safe retries or successful delivery. These are contract results,
not evidence that Meta accepted or delivered a real message. A future live worker
requires a durable single-caller lease and provider reconciliation design before
any effect mode can be introduced.

## Meta setup and review blockers before any separate activation

Keep provider effects off until all of these are independently evidenced:

1. Meta Business verification and an approved Meta app for the correct business.
2. WhatsApp Business Account and Phone Number ID ownership, app subscription to
   the WABA, approved template names/languages/categories, and recipient opt-in.
3. Page access and the required Page task plus `pages_messaging` review for
   Facebook Messenger.
4. A bound Instagram professional account, the applicable Instagram messaging
   permissions/review, and webhook subscription to `messages` (and separately
   `messaging_postbacks` before postbacks are supported).
5. A public HTTPS callback, app-secret rotation procedure, verification-token
   rotation procedure, data-use/privacy disclosures and deletion process.
6. Provider-specific rate limits, template pricing/fees, account-quality limits,
   messaging-window policy and the current supported Graph API version confirmed
   in Meta's dashboard for the exact app.
7. Durable credential retrieval, durable webhook replay receipts, durable
   provider-operation calling fences, reconciliation, monitoring and an operator
   emergency-stop runbook. None is created by this contract-only strike.

## Official research basis

Research was limited to Meta's official developer collections and documentation
(reviewed 28 August 2026):

- [WhatsApp Cloud API official collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)
- [Send WhatsApp template message](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text)
- [WhatsApp webhook payload reference](https://www.postman.com/meta/whatsapp-business-platform/folder/vzaxn16/webhook-payload-reference)
- [WhatsApp messages object](https://www.postman.com/meta/whatsapp-business-platform/folder/1dtuocp/messages-object)
- [WhatsApp phone-number lookup](https://www.postman.com/meta/whatsapp-business-platform/request/86mq7mn/get-phone-numbers)
- [Messenger Platform webhook setup and signature contract](https://www.postman.com/meta/messenger-platform-api/folder/22794852-b5d97624-14d8-4e67-a2e4-529add49ca58)
- [Messenger text Send API request](https://www.postman.com/meta/messenger-platform-api/request/0mu35la/text-message)
- [Instagram API official collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)

Meta's dashboard and current app review remain authoritative for permissions,
supported Graph versions, pricing and account-specific eligibility. This note
does not convert documentation into provider approval.
