# Property Predator source receiver activation

Status: the receiver is composed and dark. This branch adds the dedicated key
slots, an isolated no-network preflight and the paired source/receiver contract
tests. It deploys nothing, binds no value, generates no secret and accepts no
event.

This is the **receiving** half. The sending half lives in the Property Predator
repository on `claude/property-predator-growth-event-activation` and has its own
runbook. Neither half works alone, and the order below matters.

---

## The exact shared values

Two values must be byte-identical on both sides, and a third must agree by
construction. Everything else is owned by one side only.

| Purpose | Growth HQ (this repo) | Property Predator (source) |
| --- | --- | --- |
| **Key identity** | `PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID` | `PROPERTY_PREDATOR_GROWTH_HQ_EVENT_KEY_ID` |
| **Dedicated HMAC secret** | `PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL` | `PROPERTY_PREDATOR_GROWTH_HQ_EVENT_SECRET_BASE64URL` |
| **Endpoint** | route is `POST /api/external-events/v1/property-predator` | `PROPERTY_PREDATOR_GROWTH_HQ_EVENT_ENDPOINT` must end in that exact path |

Owned by Growth HQ alone:

- `PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID` — the one workspace this key
  may write shadow events into. Nothing in a signed body can choose or override
  it.
- `PROPERTY_PREDATOR_EXTERNAL_EVENTS_TRUSTED_PROXY_ADDRESSES` — exact socket
  peers allowed to assert `X-Forwarded-Proto`. Leave empty unless a reviewed
  proxy terminates TLS in front.
- `PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED` — the switch. It is a Blueprint
  literal `false`, so a sync can never turn the bridge on; an operator flips it
  in the dashboard.

Owned by Property Predator alone: `PROPERTY_PREDATOR_GROWTH_HQ_EVENT_DELIVERY_ENABLED`
and `PROPERTY_PREDATOR_GROWTH_HQ_EVENT_TIMEOUT_SECONDS`.

**The secret must be dedicated.** The loader refuses one that exactly reuses the
Stripe, session, sandbox, Postmark or Brevo values, and the preflight surfaces
that refusal as a named blocker. Generate it once, on the source side, and paste
the same value here — never derive it from an existing credential.

## Deployment order

The receiver goes first. If the source is enabled while this side is dark, every
delivery earns a `401` or `404`, and a `401` is **permanent** for the source: the
event is quarantined rather than retried, and someone has to redrive it by hand.

1. **Bind the receiver key.** In the Growth HQ dashboard set
   `PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID`, `..._WORKSPACE_ID` and
   `..._HMAC_SECRET_BASE64URL`. Leave `..._ENABLED` at `false`.
2. **Preflight the receiver, still dark.**

   ```bash
   npm run receiver:preflight --workspace @relaunch72/orchestrator
   ```

   It makes no network call. It proves the route, the receipt contract, the key
   binding and the transport posture, and names any missing value. It reports
   `bridge_switch` as unverifiable while dark, which is expected; it reports
   `source_worker_delivery` as unverifiable **always**, because no local command
   can prove the sender reached this receiver.
3. **Prove the shadow store schema** against the target database, then deploy
   Growth HQ and turn `PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED=true`. The
   route is now open and authenticating, with nothing to receive yet.
4. **Bind and enable the source** using its own runbook: migrate the source
   database, bind the matching key id and the same secret, run the source
   preflight, then start exactly one dispatcher worker.

## The owned founder event

The first real delivery must be one event about one account you own.

The founder's Property Predator account predates the event producer, so its
`identity.account.created` fact does not exist yet. The source side appends it
with its bounded reconcile command, using the founder's exact existing account
UUID read from the production database. That command never delivers; it only
makes the fact exist so the dispatcher has exactly one thing to send.

Do not invent an account id, and do not reconcile a customer account to test the
bridge. One founder-owned account is the whole activation set.

## What a successful activation looks like

The source worker logs one `delivered` outcome, and this receiver returned:

- `202` with `{"accepted":true,"disposition":"shadow"|"projected","replayed":false}`
  for the first delivery, or
- `200` with the same shape and `"replayed":true` for an exact replay.

Those two are the only receipts the source accepts. A receipt whose `replayed`
flag disagrees with its status is a contract failure that the source quarantines
rather than treating as delivered, and the paired contract tests assert this
receiver can never emit one.

Then confirm the account appears in the Conversion Inbox and that Lead 360 shows
its account-created evidence.

## Bounded failure handling

| Receiver response | Source behaviour |
| --- | --- |
| `401 authentication_failed` | permanent — key id or secret mismatch |
| `409 event_conflict` | permanent — different immutable bytes already received |
| `413 payload_too_large` | permanent — both sides cap bodies at 32 KiB |
| `415 content_type_must_be_application_json` | permanent |
| `422 invalid_event_contract` | permanent |
| `429` / `5xx` | retried behind the claim fence with jittered backoff |
| timeout / no answer | retried; the outcome is unknown, not lost |

Every failure body is a single low-cardinality `error` token. No response,
success or failure, carries the key id, the secret, an event body, a database
host or a role name, and all of them are `no-store` and `nosniff`.

A quarantined event is a decision point, not something to retry blindly. Read
the token, fix the cause, then redrive deliberately.

## Rollback

Set `PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED=false` and redeploy, or disable
delivery on the source side. Undelivered events stay durable in the source
outbox, and its sequence high-water never rewinds, so nothing is lost by closing
the receiver.
