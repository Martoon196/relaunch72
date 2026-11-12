# MHP-WA-121 open decisions — proposals for Martin to ratify (12 November 2026)

PROPOSALS ONLY until Martin ratifies them. Migration `0151_mhp_whatsapp_owner_one_to_one.sql` on
`claude/whatsapp-contact-send` implements each one behind an explicit state, so each can be changed
without touching the 0053/0141/0143 rail. Nothing here is deployed, and the feature stays off
(`MHP_WHATSAPP_OWNER_SENDS` unset) until Martin switches it on.

This is founder operational policy, not legal advice. Martin chooses the lawful basis and the evidence
for each person; the software records what he chose and refuses combinations that do not fit.

## 1. Owner-attested WhatsApp number (needs ratification)

**Today:** a WhatsApp contact point is `is_verified` only when the person has messaged the MHP number
(signed inbound, 0141 JOIN, or the 0055 projection). A number Martin typed, or a phone number in another
brand's CRM, is not proven to be that person's WhatsApp. The 0053 enqueue requires `is_verified`.

**Proposal:** a separate, recorded state, `owner_attested`, in the new append-only
`app_private.mhp_wa_owner_attestations`:
- Martin ticks "I have checked this is their WhatsApp number" while recording permission. The row
  stores who, when, the request, the evidence kind and note, and the exact endpoint identity digest
  (kind, value and normalised number) of the MHP contact point.
- It satisfies only purpose `mhp.owner-one-to-one`. It never sets `contact_points.is_verified`, never
  satisfies the 0053 enqueue, the 0141 event rail or any other purpose. A test pins that 0151 contains
  no `is_verified` write.
- If the number on the point changes, the digest no longer matches and the state falls back to
  `unverified`. Withdrawing permission also writes a `withdrawn` attestation.
- When the person later messages the MHP number, the existing signed path verifies the point and the
  state becomes `meta_verified`; the attestation is then no longer needed.

**Risk to weigh:** a wrong number reaches a stranger. Meta's own delivery receipt (`delivered`) and a
reply are the only real proof. The daily cap and one-template-per-person-per-day pacing (item 3) limit
the damage of a mistake.

## 2. Lawful basis, evidence kinds and the PECR route recorded (needs ratification)

**Proposal:** permission uses the existing 0063 founder rail (`record_contact_permission_decision`,
owner or admin only, idempotent receipts) for channel `whatsapp` and purpose `mhp.owner-one-to-one`,
on the MHP contact point. Martin picks one evidence kind and writes a short note (8–500 characters,
stored as text in the attestation and as a digest in the consent event). Only these combinations are
accepted:

| Evidence kind | Consent | Legitimate interests | PECR route recorded on the 0053 authority |
|---|---|---|---|
| `asked_to_be_contacted` — they asked Martin to WhatsApp them | yes | yes | `solicited_request` |
| `written_consent` — signed form, email or message saying yes | yes | no | `individual_consent` |
| `business_introduction` — a single B2B introduction | no | yes | `corporate_subscriber_reg23` |
| `existing_client` — a current or recent client, similar service | no | yes | `individual_soft_opt_in` |

- Never claim consent Martin did not get: `consent` is refused with `business_introduction` and
  `existing_client`.
- Each send writes the 0141-style owner review chain (compliance subject, pack, legal and commercial
  review, publication, PECR sender and instigator route decisions) with
  `mhp.founder-operator-review-not-legal-advice` as the review authority, valid for ten minutes.
- A withdrawal, a later denial, an opt-out on any MHP point with that number, a WhatsApp suppression
  (any purpose or this purpose), a signed WhatsApp STOP, or an opt-out/suppression on the original
  brand's own point blocks the send. Withdrawal and suppression are re-checked at begin-call.

**To ratify:** the table above, especially whether `existing_client` should be allowed at all on
WhatsApp, and whether `corporate_subscriber_reg23` is the right label for a business introduction to
a personal mobile number (the honest alternative is to record `unknown` and not allow it).

## 3. Daily cap and pacing for owner one-to-one templates (needs ratification)

**Proposal:**
- At most **20** owner one-to-one templates per UTC day for the MHP number (`mhp_wa_owner_daily_cap()`),
  counted from queued sends that were not expired or blocked before reaching Meta.
- At most **one** template to the same WhatsApp number in any rolling 24 hours (unless the previous one
  failed). After the person replies, free text in the 24-hour window is the normal next step.
- In-window free-text replies are not counted against the cap (they follow the 0143 rules unchanged).
- The legacy 0053 owner-action pilot caps (1/day, 3/month) and the 0141 event rail are unchanged;
  owner one-to-one jobs are excluded from the legacy sender-wide daily unique index exactly as 0141
  excluded event jobs.

**To ratify:** the number 20, and the one-per-24-hours rule.

## 4. Meta restrictions become holds, never "sent" (needs ratification)

**Proposal:** when Meta refuses a call (or a signed `failed` status carries an error code), the send is
recorded as `failed` with Meta's code and, for these codes, a hold is written that blocks new owner
sends until it passes. Nothing can clear a hold early.

| Code | Meaning (Meta) | Hold |
|---|---|---|
| 368 | temporarily blocked for policy violations | whole number, 24 hours |
| 131048 | spam rate limit hit | whole number, 24 hours |
| 131031 | business account locked | whole number, 24 hours |
| 190 | access token invalid | whole number, 24 hours |
| 80007 | WABA rate limit | whole number, 1 hour |
| 130429 | throughput rate limit | whole number, 15 minutes |
| 131056 | pair rate limit (same person) | that person, 1 hour |
| 131049 | marketing message not delivered (healthy ecosystem) | that person, 24 hours |
| 131050 | person stopped marketing messages | that person, 365 days |

A message is `accepted` only when Meta returned a `wamid` for exactly that recipient. Timeouts, 429/5xx
and malformed answers are `outcome_unknown` and are never retried automatically; Growth HQ says "Not
confirmed by Meta — check before resending".

**To ratify:** the list and the durations, and whether 131050 should instead write a permanent
WhatsApp suppression.

## 5. Smaller choices made in the candidate (for the record)

- **Cross-brand mirror.** The person is mirrored into the MHP workspace as a `lead` with source
  `mhp:owner-one-to-one:<brand>` and an unverified, consent-unknown WhatsApp point; an existing MHP
  WhatsApp point for the same number is reused; two MHP contacts with the same number are refused
  (`mhp_contact_ambiguous`). The link is recorded; the original brand contact is never moved or edited.
  Outcome activities are written on both the original brand contact and the MHP contact.
- **The send actor must manage both workspaces.** The MHP direct owner (0143 predicate) runs the send,
  and must also pass `can_manage_workspace` on the original brand workspace. If the brands are owned
  by different R72 users this fails closed.
- **Template evidence.** Only the worker's server-side Meta read (`GET /{waba}/message_templates`,
  refreshed every five minutes, valid fifteen) counts, and the exact template is read again
  immediately before begin-call. Body variables are supported (named or positional); headers, footers
  and buttons are allowed only when they need no value. The first time a template is used, a 0053
  template row is registered from the owner's confirmed choice of that exact Meta text.
- **Free text** is only the 0143 in-window reply (`mhp_wa_direct_queue`), unchanged. It needs no
  marketing permission (it is a reply to the person's own message) but is refused after STOP,
  opt-out, suppression or a hold.
