# Private production methods and campaign creators

Version 0.1.1 expands the original writing choices, preserves the planner's
format through article production, and requires concrete review evidence.
It also gives an owner a place to create, edit, approve and export email
campaigns and feedback/referral request kits for each brand.

This is a prepared private release. It changes no subscription or public
commercial approval. Provider delivery and deployment are separate actions.

## Production methods

Eight immutable releases are in `orchestrator/method-packs/0.1.1/`, with
identical authoring copies and exact pins under
`docs/relaunch72-rule-packs/releases/0.1.1/`. Original 0.1.0 files remain.

The shared core contains an original catalogue of 61 article formats, 14
opening approaches and eight copy structures. Selection follows audience,
awareness, purpose and available evidence. Formats requiring interviews,
customer evidence or original datasets cannot be selected without those
inputs. A wide library is not an instruction to force every format into a
cluster or invent material to fill it.

Planning receipts record a format and rationale for every article. The engine
persists those decisions, including the originating receipt, in each brief.
Writing receives that format. Section revisions preserve their original
receipt's format and exact method versions. Legacy revisions keep their
legacy policy.

Research inputs and citations carry retrieval time plus publication date,
observation period and confidence when supplied. Missing metadata stays null
or unknown; a retrieval date does not establish a statistic's observation
period. Social and revision paths retain the available citation metadata.

Confirmed visual guidance is selected by brand, document version and hash.
Actual reviewed hero assets are included only with matching canonical review
and binary identity; a withdrawal suppresses that asset context. Guidance
may supply exact colours/fonts; a missing logo file is never invented.
Placement, available asset IDs, descriptions and dimensions reach the method.

The 0.1.1 sidecar requires typed claim references, source assessments, owner
decisions and stage-specific evidence. Findings must pass with pointers to
actual draft or decision content. Unassessed checks, missing evidence,
unsupported references, changed format choices and false real-image evidence
hold the draft within the bounded retry policy. These are model-reported
decisions with structural/reference validation, not independent semantic
verification or proof of conversion performance. Human review remains.

## Campaign creators

`SEO_BLOG_METHOD_PACKS=true` and `SEO_BLOG_CAMPAIGN_CREATORS=true` compose the
owner-only campaign authoring store. Both default off. The worker has no
campaign-creator composition or campaign-delivery port.

Inbox Engine creates one to seven welcome, onboarding, education or
promotional emails. Each has proposed relative timing, a purpose, three
subject options, a chosen subject, preview, plain-text body and one confirmed
brand action. Promotional work needs an approved offer. The editor uses
ordinary fields rather than exposing JSON to the owner.

Word of Mouth Engine creates feedback requests, referral invitations or
both. It includes optional short/standard requests, neutral questions, a
gentle follow-up, three referral-message lengths, a permission checklist and
exact owner-supplied incentive terms (default None). It never creates a
customer testimonial, captures consent, attributes referrals or sends a
request. Real responses, permission records and delivery remain separate.

The current confirmed profile, audience and action must belong to the
brand. Conflicting or stale profiles cannot generate or approve a campaign.
Edits append an immutable version and clear approval. Edited versions are
owner-authored and do not inherit a claim that the generation receipt
describes the edited body. Approval pins the current version/hash. Export
checks the current confirmed profile and approval and produces text or JSON.
There is no sending/scheduling/recipient-list endpoint.

### Paid generation and recovery

A campaign command is durable before a model call. Input comparison uses
canonical values, because PostgreSQL JSONB changes key order. Replaying a
command cannot start another generation; changed inputs cannot reuse it.

The database serialises starts against the brand and reserves 350,000 model
tokens. This is conservative headroom, not an invoice: two requests are
bounded to 150 KB UTF-8 each and 20,000 output tokens each. Ordinary method
preflight can require additional remaining headroom. Known usage is charged
once through the method receipt. Rejected work releases the reservation;
uncertain work retains it. There is no automatic paid retry after a crash.

Accepted creator receipts save the exact bounded output text as well as its
hash. “Check saved run” can recover that exact draft after an interrupted
asset write without another model call. Transport uncertainty remains
uncertain; an immutable unknown receipt is not silently upgraded to success.

Migration 139 adds forced-RLS campaign/version tables under the existing
NOLOGIN/NOBYPASSRLS method definer. Runtime logins remain table-blind. Every
command re-locks the genuine current owner session and brand authority.
Approvals, profile/assignment changes, exact receipt bindings and concurrent
allowance reservations are enforced inside database boundaries.

## Runtime scope

| Pack | Connected private capability |
|---|---|
| Engine Room | Shared production discipline |
| Editor's Desk | Existing one-pillar/six-supporting blog clusters |
| Longform Forge | Articles and existing revision paths |
| Hook & Close | Buy-intent blog CTA placement, not standalone sales pages |
| Multiplier | Current Instagram/LinkedIn two-post/six-post recipes |
| Art Director | Existing alt text and artwork instructions, not image generation |
| Inbox Engine | Campaign authoring, review and export |
| Word of Mouth Engine | Request-kit authoring, review and export |

Brain Builder, Deal Shaper, Funnel Scan and Focus Room remain unavailable
registry entries. The old 0.1.0 email/referral releases also remain unavailable;
the new runtime contracts require their exact reviewed 0.1.1 versions.

## Compatible release sequence

Do not deploy strict old-137 code against a database containing 138/139.
Do not edit/reapply 137 or change frozen migration 138. The exact checksums
for 138 and 139 are in the 0.1.1 release manifest and schema bridge.

1. Use the exact validated source. Keep both feature flags false. Set
   `RL72_METHOD_SCHEMA_BRIDGE=138-139` only for the controlled transition.
2. Deploy that source to all seven shared-schema services listed below.
   The explicit bridge admits only the exact 137/138 prefixes while both
   features are off. Changed/unknown migration history still fails closed.
3. With the fleet compatible, apply frozen 138 once, then frozen 139 once
   through the existing migration operator. No private organisation or brand
   assignment is created by either migration.
4. Confirm the exact 139 ledger and remove the bridge setting. Keep the
   features off until private enrollment and activation are prepared. A
   rollback after migration must remain compatible with 139.
5. Verify the actual founder-owned organisation/workspace mapping. An
   operator enrolls only the verified owned organisation in
   `app.seo_blog_method_private_organizations` with evidence. This is not a
   customer self-enrollment or public entitlement. Existing organization
   enrollment is reused; do not insert a duplicate or infer ownership from
   a matching brand name.
6. Keep new automatic generation held during activation. Enable the portal
   flags, then use each brand's Production rules screen to assign the exact
   reviewed six packs, optionally including the two creators. The internal
   command checks registry approval, hashes, dependencies and expected
   assignment revision. Enable the SEO worker flag after the intended brand
   assignments are complete. Never resume uncertain jobs automatically.
7. Pilot one brand with a controlled paid article/social set and campaign
   draft, inspect actual facts/voice/evidence/usage, then extend to the other
   owned brands. Reuse existing approved spend limits if sufficient. No
   public test posts or messages are required. Image setup remains separate.

Affected shared-schema services (recorded live fleet, 4 November):

- `relaunch72-seo-blog-worker` — `srv-dbj8k2gae00c73dgrgcg`
- `property-predator-growth-hq` — `srv-da7fv1gn74is73d58hb0`
- `property-predator-owned-public-social-live` — `srv-da99sd5g1s2s739novjg`
- `property-predator-twilio-sms-live` — `srv-da9e0pmgekts73fvncvg`
- `property-predator-twilio-sms-live-webhook` — `srv-da9e0pmgekts73fvnd00`
- `martin-howard-property-twilio-sms-live` — `srv-dbj47567bikc73ecfdtg`
- `martin-howard-property-twilio-sms-live-webhook` — `srv-dbj4ceajnfac73c47530`

The operating pack names Martin Howard Property, Property Predator, Prop
Invest UK and Key Properties UK. The rollout must map their real workspaces;
this source change does not assert that their current live profiles are all
confirmed or silently mark any fact conflict resolved.

## Validation and remaining commercial work

The release review ledger records the final exact tested commit, checksums,
offline suite, disposable PostgreSQL proof and fictional UI preview checks.
The earlier core-release checks and original 0.1.0 gate remain recorded.
New tests exercise the changed contracts; no live paid model/image generation
or marketing delivery is part of this preparation.

Private authorization comes from the owner's 4 November request to finish
the six packs and add the two creators. The validation gate must pass before
activation. Public commercial approval, packaging and prices remain separate;
rewriting is not itself recorded commercial permission. No checkout,
subscription or tenant-wide paid entitlement has been implemented here.
