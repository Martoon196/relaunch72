# Canonical HQ stop relay

`stop-relay.mjs` is a server-only, explicitly invoked adapter. It creates no
route, grant, connection, queue, scheduler, CRM record, campaign or provider send.
It is not imported by application startup. Merely deploying the file enables
no outreach and drains no historical events.

## Supported existing contracts

Source: `integrations/external-events/contracts.ts`, the exact PropertyPredator
v1 first-party catalogue. The adapter deliberately revalidates the two mapped
shapes; a schema expansion needs review and a matching contract test.

- `commerce.purchase.completed` -> LeadRelay `purchase.confirmed`. Require its
  Stripe provider, positive collected amount, lowercase currency and exact
  configured product mapping. Conversion reference retains checkout session and
  product, rather than an AI assertion or a CRM stage label.
- `sales.appointment.booked` -> `meeting.booked`, preserving the source's
  appointment reference and start time. This is the authoritative source
  appointment reference; the schema does not establish that it is specifically
  a Google Calendar event ID. This adapter never reserves a calendar event.

Destination: existing LeadRelay `POST /hooks/{workspace}/events`, strict
`HookInput` in `backend/app/schemas.py` and transaction in `backend/app/api.py`.
Raw UTF-8 JSON is signed as HMAC-SHA256 over `timestamp + '.' + exact_raw_body`,
using `X-LeadRelay-Timestamp` and `X-LeadRelay-Signature`. LeadRelay accepts the
timestamp only within its existing five-minute window.

Email-only `privacy.consent.updated` cannot become LeadRelay's global
`lead.opt_out`: doing so would widen channel/purpose scope. The current source
catalogue has no canonical verified reply event. Those events remain unsupported,
not invented aliases. Before combined campaigns, a separately reviewed reply and
channel-aware suppression translation/wiring is still needed. Refunds and
subscription cancellations also do not restart sales follow-up.

## Required owner wiring — not implemented or configured here

1. Construct the relay with deployment-owned `installation`: exact HQ workspace,
   installation ID, LeadRelay workspace, trusted HTTPS origin, dedicated hook
   secret and allowed purchase product keys. Supply secrets from secure runtime
   configuration, not browser JSON, prompts, Git or event data. Do not reuse the
   HQ browser gateway bearer key as the hook secret. The origin has no path,
   query, credentials, fragment, private IP or arbitrary payload-selected target.
2. Implement `loadCanonicalEvent({hqWorkspaceId,eventId})` using already verified
   canonical evidence in `app_private.external_event_shadow_receipts` after the
   existing signature/record/projection boundary. Return exactly
   `{hqWorkspaceId,source:'property_predator',event}`. Never wrap request JSON or
   a user-supplied event in this callback as a substitute for that authority.
   Existing runtime database roles do not automatically gain ledger SELECT;
   choose a reviewed existing read capability or narrowly approved loader role.
3. Implement `resolveLeadBinding(query)` from explicit persisted identity/field
   mappings. Its result must echo the same HQ workspace, installation, LR
   workspace, source/account identity, event type and product, plus the actual
   `leadId` and `stopScope:'all_sales_followup_for_lead'`. Never guess by email,
   use a client-supplied lead ID or copy one business's mapping into another.
   The existing HookInput stops sales follow-up for the entire mapped lead:
   use it only where that is the explicitly intended scope. The adapter does
   not turn a product-specific purchase into permission to stop unrelated work.
4. Use one existing durable, claimed stop-delivery outbox owner. Persist/freeze
   the intended mapping and canonical payload for each target before delivery;
   protect the same event ID against changed bytes or remapping across retries.
   The module owns no persistence or in-memory receipt cache. Its stable event
   ID is a hash of HQ workspace, installation and source event ID. Event IDs do
   not include a payload hash: conflicting reuse must yield409, not a new event.
5. Filter source/type/product/target eligibility BEFORE a batch LIMIT. Record
   per-target exclusion or a bounded deferred outcome; do not leave old excluded
   rows permanently ahead of eligible stop events. An unsupported/held target
   must not poison a shared HQ outbox, acknowledge other subscribers' work or
   mark the original source event globally delivered.
6. Only `{disposition:'delivered',duplicate:boolean,...}` is a confirmed stop
   receipt. It requires exact bounded HTTP200 JSON `{ok:true,duplicate:boolean}`.
   `held` means do not acknowledge that stop delivery and hold the relevant
   campaign/dispatch eligibility for reconciliation. Use bounded per-target
   backoff; no automatic provider/call retry or new event ID. Replaying the same
   stop with a fresh signature timestamp is safe under receiver idempotency;
   HTTP409 requires operator reconciliation rather than endless retries.
7. Wire existing purchase/booking evidence before enabling outreach. Receiving
   a stop across two services is not an atomic cross-system lock: this sender
   cannot recall a provider-accepted call. The campaign owner must check current
   conversion/stop evidence at its final dispatch boundary and hold when required
   upstream evidence or pending stop delivery is unavailable. Keep exactly one
   follow-up scheduler; the relay never schedules or enrolls.

The transport performs at most one request per invocation, follows no redirects,
has a bounded 250–10000ms deadline including response streaming and limits the
receipt to4096 bytes. Failures return fixed reason codes without URLs, provider
bodies, credentials, personal data or error text. Both accepted first delivery
and verified receiver duplicate can be acknowledged by the owning target outbox.

## Release evidence and remaining limits

This adapter adds no migration, startup wiring, worker activation or dependency.
Root's current production inspection supersedes older investor checkpoint docs:
HQ source `78b6ef625adf377cef0c14fab299fca14d44a54b` is already deployed and its
EU production ledger has112 exact matching migration checksums. Preserve that
live source as the rollback base; do not roll back to pre-0107 code against112.
No migration is required by this module.

The contract tests use synthetic events, mappings and HTTP receipts. The HQ-only
source-contract test additionally parses fixtures through the actual canonical
event parser. These tests are not evidence of deployed mappings, a connected
hook secret, production outbox consumption, a real stop receipt or any campaign
send. Secure mappings/loader/outbox wiring and live stop/cancellation acceptance
remain owner integration work before a combined campaign can run.
