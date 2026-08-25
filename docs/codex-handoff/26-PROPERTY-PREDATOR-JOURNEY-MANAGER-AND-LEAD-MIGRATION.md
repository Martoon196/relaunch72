# 26 — PROPERTY PREDATOR JOURNEY MANAGER AND LEAD MIGRATION

**Measured:** 2026-08-25 on `codex/relaunch72-platform-foundation`.

**Status:** Property Predator now has a branded visual Journey Manager for the
conversion runtime described in handoff 25, plus a versioned, replay-safe
foundation for bringing legacy contacts and their original affiliate
attribution into the shared CRM. This is build and test work only. No production
deployment, live-source read, customer import, message, post, provider action or
purchase has occurred.

## Visual Journey Manager

`/portal/journeys` is now a first-class Property Predator navigation
destination. Its read model shows the exact saved definition state for the
current workspace rather than presenting a mock workflow canvas. The screen
includes:

- the Self-serve and Agency LAPS routes as visual milestone rails;
- the exact event or commerce evidence that advances each milestone;
- immutable definition versions and per-route active, missing or drifted state;
- the shared score model, component allocation, score bands and rule count;
- explicit exclusions for signals that do not contribute to the score; and
- one overall readiness state: ready, action required or degraded.

The page is responsive, keyboard-readable and uses the Property Predator dark
ink, teal and warm-metallic visual language. It explains topology and readiness;
it is not evidence that an email, WhatsApp, social, webinar or listening
provider is connected.

This screen is the topology, automation and evidence **brain**: it answers what
the routes are, which exact evidence advances them and whether their stored
definitions are safe to run. It is not yet the polished drag-and-drop people
board for operating individual leads. That operational **Journey Board**—people
and opportunities arranged by route and stage, with filters, safe actions and
Lead 360 drill-through—is the next UX layer. It should consume the same saved
journey/enrolment facts rather than creating a second funnel truth.

### Explicit setup boundary

Journey installation is deliberately separate from viewing the page. A `GET`
only reads the workspace's current definitions. A `POST` to
`/portal/journeys/foundation` can publish the reviewed immutable v2 foundation,
but only after all of these checks pass:

1. an active signed portal session resolves to the workspace;
2. the actor is a workspace owner or admin;
3. the form has a valid session-bound CSRF token;
4. the request carries a valid UUID command key; and
5. the actor types the exact confirmation `INSTALL PREDATOR JOURNEYS`.

The command uses the existing manager-authorised conversion publisher. Both
Property Predator routes are now published in one transaction: either the
complete reviewed pair lands or neither route does. This supersedes the
two-transaction interruption behaviour documented in handoff 25. An exact
replay is safe.

Conflict protection is enforced twice. The server reloads current readiness
before accepting the setup action, then the command transaction locks and
rechecks every immutable score, route, milestone and trigger record. Readiness
and replay compare the deep stored score JSON and journey settings as well as
hashes, versions and relational topology; matching a digest while carrying
different stored settings is not accepted. If an immutable version already
contains different bytes or settings, the screen reports protected drift,
locks setup and overwrites nothing. The command publishes only definitions: it
does not enrol or advance a lead, drain an outbox, send a message, publish a post
or call a provider.

## Legacy lead import foundation

Migration `0019_legacy_lead_import_foundation.sql` adds a dedicated
`r72_import_command` boundary, private staging and receipts, public sanitised
provenance, and typed source-owned attribution facts. Exact raw attribution JSON
is stored in a separate private payload table; the ordinary portal role cannot
read URL tokens, provider metadata, IP addresses or incidental PII contained in
that raw object. All records are workspace-bound under forced row-level
security. The import role is manager-only and has the narrow
select/insert/update surface needed for rehearsal and append; it cannot update
an existing live contact.

The canonical input is schema-versioned and content-hashed. It preserves:

- the source system, batch key, source record ID and original creation time;
- contact name/company and source-backed email or phone identities;
- whether the source can actually verify each identity;
- affiliate source ID, affiliate name/code and referral code;
- UTM, referrer and landing-page attribution when supplied;
- the exact source-owned attribution object; and
- dangling affiliate, referral, commission or attribution facts that cannot be
  safely attached to a CRM contact.

The workflow has three intentional phases:

1. **Dry run** validates, hashes and deduplicates in a read-only transaction and
   returns create, match, replay and quarantine decisions with `writes: 0`.
2. **Stage** stores one immutable canonical batch in a serializable transaction.
   Reusing a batch key with identical bytes is a replay; different bytes fail
   closed.
3. **Commit** locks and revalidates the staged bytes, then creates a contact,
   matches an existing contact by source-verified identity, replays an existing
   receipt, or quarantines the row. It appends receipts, provenance and
   attribution in the same serializable transaction.

Unresolved source facts also receive one canonical receipt per workspace,
source system, record kind and source record ID. Overlapping full and
incremental batches may retain their own staged occurrence, but they cannot
silently duplicate the underlying unresolved affiliate/referral/commission
fact across batches; changed canonical bytes fail closed.

Database triggers, rather than caller-supplied values, own the manager identity,
request ID, lifecycle state and action timestamps on import batches, rows,
receipts, provenance and attribution records. Update guards allow only the
reviewed staged → committing → terminal transitions and reject mutation of
audit identity or immutable source fields.

Dedupe never treats account existence, a truthy source value or an unverified
address as proof. No verified identity, a shared/quarantined endpoint, an
inactive owner, split identities, a changed source payload or an unresolved
source relationship all lead to quarantine. When an imported row matches a live
contact, the importer appends provenance and does not overwrite that contact's
current name, company or endpoint data.

Dry-run batch planning now models identities created by earlier rows. It catches
both multiple planned owners and the case where a later row would bridge an
earlier planned contact to a different existing contact. Those split-identity
cases quarantine during the zero-write rehearsal instead of first appearing at
commit.

### Property Predator v1 adapter

The pure `property-predator-v1` adapter maps explicit exports of `users`,
`affiliates`, `affiliate_referrals` and `affiliate_commissions` to the canonical
contract without database or network I/O. It joins a single valid referral to
the referred account and preserves the affiliate identifiers and code as
source-owned strings; it does not manufacture platform UUIDs or infer missing
relationships.

An affiliate quarantined for a missing owner, broken parent, duplicate owner or
duplicate code cannot be reused as trusted lead attribution. Any referral that
points at that affiliate is quarantined as a source-integrity conflict too.

Commission rows are retained for reconciliation but are never converted into
ordinary CRM attribution or a lead. Payout and commission state belongs in a
separately controlled affiliate-ledger migration.

## Candidate source audit — not a cutover count

A read-only, aggregate-only inspection found a **local candidate** Property
Predator SQLite snapshot with:

| Candidate source record | Count |
|---|---:|
| User/account rows | 24 |
| Affiliate rows | 2 |
| Referral rows | 2 |
| Commission rows | 1 |

The same snapshot contains material referential gaps:

- one of the two affiliate rows points to an owner account absent from `users`;
- one of the two referral rows points to a referred account absent from
  `users`; and
- the commission points to a referred account absent from `users`.

Those facts are why unresolved source records have an explicit private
quarantine instead of being dropped or attached to a fabricated contact. These
figures do **not** establish that the local file is the current production
source, and 24 user/account rows must not be presented as 24 qualified sales
leads without a business classification step.

A fresh authoritative export from the actual live source is required at
cutover. The export must be taken under separate production-data authority and
must be reconciled independently; this strike neither accessed nor changed that
source.

## Reconciliation still required

The CRM import does not yet settle these separate domains:

- **Identity evidence:** the current source contract requires explicit
  `email_verified: true`; it does not infer verification from registration.
  Rows without trustworthy verification evidence will quarantine until an
  operator decides how the source proves identity.
- **Marketing consent and suppression:** historical opt-in fields need a
  reviewed mapping that preserves purpose, policy/source evidence, timestamp
  and later withdrawal. Contact import must not silently grant permission to
  send.
- **Subscription state:** product access, cancellation and billing truth must be
  reconciled from the authoritative subscription/payment records, not inferred
  from a contact row.
- **Affiliate money:** commission, payout, reversal and payee-verification data
  require an affiliate-ledger migration and financial reconciliation. The CRM
  adapter intentionally only retains the source record for later review.
- **Business classification:** user accounts, purchasers, affiliates, prospects
  and test/admin accounts may overlap; the authoritative export needs explicit
  classification before sales reporting is trusted.

## Operational cutover checklist

1. Identify the authoritative live database and obtain separate, explicit
   read/export authority. Do not use the discovered local snapshot as a proxy.
2. Define a source freeze or deterministic high-water mark so records cannot
   change between export and reconciliation.
3. Take a recoverable source backup and a versioned, access-controlled export.
   Record table counts, time bounds and checksums without putting PII in logs.
4. Export users, affiliates, referrals and commissions with their original IDs
   and timestamps. Export identity-verification, consent/suppression,
   subscription and financial evidence separately rather than inventing it.
5. Run source integrity checks: duplicate IDs and normalised endpoints, missing
   owners/referred accounts/affiliates, multiple referrals per account, invalid
   timestamps and incomplete financial references.
6. Convert the reviewed source export through the pinned Property Predator
   adapter. Preserve the canonical batch and its hash as the cutover artefact.
7. Run the importer in dry-run mode against the target workspace. Reconcile
   every create, match, replay and quarantine count to the source; commit
   nothing while unexplained differences remain.
8. Resolve identity evidence and business classification. Approve each
   quarantine disposition explicitly; never weaken dedupe to force a count to
   match.
9. Stage the exact approved bytes through the dedicated import-command
   connection. Confirm the saved batch ID, row count and input hash.
10. Commit that staged batch once as an authorised workspace manager. Treat an
    exact repeat as replay, and stop on any hash, role, RLS or integrity
    conflict.
11. Reconcile post-commit contacts, matches, receipts, provenance, attribution
    and quarantines against the dry run and source export. Confirm existing
    live contacts were not overwritten.
12. Separately migrate and reconcile consent, subscriptions and the affiliate
    financial ledger. Do not enable automated outreach until permission and
    suppression truth is proven.
13. Retain the source backup/export and signed reconciliation report through
    acceptance. Keep the old system read-only until business owners approve the
    counts and sampled records.

## Verification status

The measured proof for this strike is:

- focused changed-surface Journey Manager, conversion-publication, importer,
  adapter, SQL, configuration and portal tests: **174/174 passed**;
- ordinary non-destructive suite: **801 total — 793 passed, 8 explicitly gated
  live-database tests skipped, 0 failed**;
- a guarded reset of the explicitly disposable `TEST_DATABASE_URL`, followed by
  all forward migrations `0001`–`0019`: passed;
- explicit disposable-Neon integration suite: **8/8 passed**; and
- TypeScript checking: passed after the final Journey Manager CSS adjustment.

These are local and disposable-test-environment results. They are not evidence
of production deployment, a live customer import or a connected provider.

## Honest next boundary

The next UX strike is the operational Journey Board described above. The next
production-facing migration strike is not “copy the local file.” It is to
secure a current authoritative export, agree the
identity/consent/subscription and affiliate-ledger mappings, run a zero-write
reconciliation, and obtain an explicit go/no-go before staging or committing
customer data. Workflow/outbox consumers and provider connections remain
separate work after that data boundary is proven.
