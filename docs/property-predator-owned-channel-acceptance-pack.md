# Property Predator — owned-channel acceptance pack

**Status:** draft for founder approval

**Provider effects:** false

**Purpose:** controlled operational acceptance only; no customer campaign

**Workspace/brand:** Property Predator

**LAPS stage:** not applicable — infrastructure acceptance is not marketing evidence

This pack supplies one exact, deliberately unpromotional asset per live channel.
It does not authorise a provider call. Each run still requires the exact
founder-owned destination/account, current provider connection, operator
authority, immutable content approval and channel-specific permission evidence.

## Shared approval record

Record these values before approving any asset:

- workspace ID;
- provider connection ID;
- operator user ID and authority evidence;
- exact founder-owned person/account and endpoint IDs;
- approval ID bound to the immutable content version and digest;
- command key unique to the channel and acceptance attempt;
- intended start and expiry times;
- provider effects enabled only for the isolated worker involved in the test;
- emergency posture and initial cap evidence; and
- the founder's explicit approval for that exact channel and owned target.

Never place a raw email address, telephone number, access token, provider
credential or webhook secret in this document, a command key or a portal notice.

## 1. Customer email — Mailgun EU

**Account/domain setup:** complete per the originating Growth HQ task.

**Channel owner:** Email Specialist

**Message class:** founder-owned operational acceptance

**Intended CTA:** exact reply marker only

**Subject**

`Property Predator channel acceptance — email`

**Preview text**

`Controlled founder-owned delivery and inbound-reply proof.`

**Plain-text body**

```text
Property Predator channel acceptance

This is a controlled operational test to a founder-owned email address.
No customer campaign is active.

Please reply with this exact marker:
PP-EMAIL-REPLY-OK

That reply will be used only to prove the signed inbound path and its link to the Conversion Inbox.

Property Predator
```

**Acceptance evidence**

1. The permission-bound command resolves the exact campaign, person, endpoint,
   consent/purpose, suppression, operator and approved content version.
2. Mailgun accepts one call from the isolated EU worker.
3. A signed accepted/delivered event settles the exact operation without replay
   duplication.
4. The founder reply is signature-verified and projected into the existing
   Conversion Inbox thread and Lead 360 person.
5. Daily/monthly usage increments by exactly one and the bounded receipt contains
   no recipient address or provider payload.

## 2. Meta WhatsApp Cloud

**Channel owner:** Direct Response Copywriter for the operational wording; Meta
template approval remains a separate provider decision.

**Suggested template name:** `property_predator_channel_acceptance_v1`

**Variables:** none

**Message class:** founder-owned operational acceptance

**Template body**

```text
Property Predator channel acceptance.

This is a controlled test to a founder-owned number. No customer campaign is active.

Reply PP-WA-REPLY-OK to confirm the signed inbound path.
```

**Acceptance evidence**

1. Meta has approved the exact parameter-free template; Growth HQ stores the
   exact template identity and content digest.
2. The command resolves the current WABA, phone-number binding, owned recipient,
   consent/purpose, operator authority and approval evidence.
3. The one-at-a-time worker makes one call and binds Meta's exact recipient and
   message response to the leased operation.
4. Signed status events reconcile the operation, including a safe
   outcome-unknown path when the provider result cannot be proved.
5. The founder reply is signature-verified and projected into the same Conversion
   Inbox and Lead 360 records.
6. Usage increments by exactly one against the initial daily/monthly caps.

## 3. Owned X account — Ayrshare

**Channel owner:** Social Media Manager

**Format:** one link-free, ASCII-only owned-account post

**Message class:** public operational acceptance; not a promotion

**Post**

```text
Property Predator is testing its owned publishing connection. This is a controlled operational post. No customer campaign is active.
```

**Acceptance evidence**

1. The exact X account is founder-owned and bound to the approved Ayrshare
   profile/connection evidence.
2. The command resolves the approved immutable post, operator authority and
   current account binding; it accepts no caller-supplied body or target.
3. The isolated worker makes one provider call and does not retry an ambiguous
   outcome blindly.
4. Provider acceptance/reconciliation produces one bounded receipt and increments
   the daily/monthly post caps by exactly one.
5. The post is visually inspected on the owned X account, then retained or
   manually deleted only by an explicitly authorised founder action.

## 4. UK SMS — Twilio Messaging

**Channel owner:** Direct Response Copywriter for the operational wording

**Format:** GSM-7-compatible plain text; one segment per message

**Message class:** founder-owned operational acceptance

**Message A — delivery and ordinary inbound proof**

```text
Property Predator test: controlled delivery to a founder-owned number. No customer campaign is active. Reply PP-SMS-OK to confirm receipt.
```

**Message B — opt-out proof; requires a second explicit approval**

```text
Property Predator opt-out test. Reply STOP to prove suppression. This is a controlled test to a founder-owned number.
```

**Acceptance evidence**

1. Both messages remain one GSM-7 segment after exact provider encoding is
   calculated; segment usage, not message count, is capped.
2. The command resolves the Twilio Messaging Service, owned sender and recipient,
   SMS-specific consent/purpose, suppression, operator and immutable approval.
3. The calling fence rechecks every authority and the 10/day, 50/month and
   one-concurrent-call limits immediately before Twilio.
4. Signed delivery and inbound callbacks reconcile Message A into the existing
   Conversion Inbox and Lead 360 records.
5. Message B is never queued until Message A is fully reconciled and the founder
   separately approves the opt-out proof.
6. An authenticated `STOP`/`OptOutType` event immediately records SMS suppression.
   A later `START` must not override a separate manual, legal or compliance
   suppression.
7. No automatic reply is sent when Twilio has already handled an Advanced
   Opt-Out confirmation.

## Founder approval order

Run one channel at a time:

1. customer email;
2. WhatsApp;
3. owned X post;
4. SMS Message A;
5. SMS Message B only after Message A is proven.

For every step, stop after the first provider call and reconcile the receipt,
inbox projection, Lead 360 linkage, cap arithmetic and secret-free Live Channels
snapshot before approving the next channel.

## Current blockers

The copy is complete. Provider execution remains blocked until the exact values in
the shared approval record are supplied and the founder approves the immutable
version for a nominated owned target/account. Missing provider accounts or
credentials for WhatsApp, Ayrshare/X or Twilio remain separate activation inputs;
Mailgun account/domain setup is not listed as missing.
