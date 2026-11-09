# Property Predator conversion data plane

**Status:** fixture-only foundation. Migration `0030` is ready for disposable
database rehearsal but is not authorised for production application by this
change.

## Production activation gate

**Do not stage a real customer snapshot.** Snapshot pages deliberately retain
the complete raw account/affiliate envelope as private audit evidence. The
current append-only design has no bounded retention policy and no audited
per-source-account erasure path. A later forward migration must add both,
including tests and an operator audit trail, before any real customer export is
stored. Granting `DELETE` to the import role is not an acceptable shortcut.

This slice does not enable event intake, import contacts, activate providers,
send messages, publish content or alter consent. Preview is read-only. Consent
is always `unknown` unless a later, separately reviewed evidence contract says
otherwise.

## Complete account snapshot v2

The legacy v1 importer remains supported. V2 is a separate, exact-key contract:

- `schemaVersion`: `2`
- `sourceSystem`: `property-predator.accounts/v2`
- `snapshotId`: canonical lowercase UUID
- canonical millisecond-UTC `generatedAt` and `watermark`
- `complete`: exactly `true`
- manifest: `pageCount`, `recordCount`, decimal-string
  `eventHighWatermark`, and lowercase `contentSha256`
- exactly one page per source response; the consumer collects every response
  before opening a database transaction

Each record contains only:

- `account`: UUID, canonical lowercase email, creation time, optional non-null
  display/company names, and optional Google verification evidence
  `{provider:'google',emailVerified:true,verifiedAt}`;
- `ownAffiliate`: optional UUID, strict code, source-faithful status (including
  `unknown`), creation time and optional non-null parent UUID;
- `originalAttribution`: optional referral UUID, affiliate UUID/code and
  attachment time.

The wire contract contains no provider subject, Google login identifier,
commission, subscription, payment, property, password, marketing-consent or
customer-private content field. Unknown and mixed v1/v2 keys fail closed.

## Integrity rules

The verifier rejects the entire snapshot before any staging or preview when:

- pages are missing, duplicated, non-contiguous or incomplete;
- envelope schema/source/snapshot/times/manifest differ between pages;
- page 1 has a cursor/previous hash, a cursor chain breaks, or the final page
  has a next cursor;
- record totals, page hashes, ordered page list or manifest hash differ;
- account records are not globally ordered by `account.id` ascending;
- a record timestamp exceeds the snapshot watermark;
- the snapshot is outside the 15-minute ingestion/freshness window;
- an ID, email, optional field, affiliate code/status or timestamp is outside
  the exact reviewed language.

Page SHA-256 is over canonical JSON for:

```text
{snapshotId,pageNumber,cursor,nextCursor,previousPageSha256,records}
```

Content SHA-256 is over canonical JSON for:

```text
{schemaVersion,sourceSystem,snapshotId,generatedAt,watermark,complete,
 pageCount,recordCount,eventHighWatermark,pageSha256}
```

The cross-language golden fixture is
`orchestrator/test/fixtures/property-predator-account-snapshot-v2.golden.json`.
It includes Unicode, explicit nulls, omitted optionals and one-character
affiliate codes. The file SHA-256 is
`425918e4cbb9b41615ad6447387a47962804c440082b4b968adb8e71bbe7fb29`.
Python and TypeScript both pin the literal canonical strings and literal hashes:

- page: `9d94f96060d7b02d7c3a05a824518999f7c1f7554ed9779837cb86f280111b71`
- content: `31a9d2f78da74c0428690214d643b7193030686a5aaa945b8f2ba71c22cab211`

## Staging and reconciliation

Migration `0030_property_predator_complete_snapshot_staging.sql` adds three
private, forced-RLS, workspace-scoped append-only tables:

- manifests retain the watermark, source outbox high-water sequence, counts,
  hashes, actor/request evidence and `consent_default = 'unknown'`;
- pages retain each exact source response and its chain evidence;
- quarantine retains every issue against its exact raw page/index/account.

Only an active workspace manager using `r72_import_command` may select/insert.
The web and provider roles have no visibility. The import role cannot update or
delete staging. Database checks reject partial JSON metadata/envelopes; triggers
bind pages to the manifest and quarantine rows to the exact staged account.

The verifier privately stages all duplicate raw account records rather than
silently dropping them. Duplicate identities and broken affiliate/referral
graphs are reported explicitly. A broken affiliate taints every attribution
that refers to it. Independently valid account identity can still receive a CRM
preview result while its affiliate/referral fact remains quarantined.

V2 Google evidence may match one existing email contact point. Preview never
creates a duplicate, overwrites a contact or silently upgrades a previously
unverified contact point. That case reports
`verification_evidence_not_promoted`; a future audited promotion capability is
separate work.

## Zero-write operator preview

For a local, freshly generated fixture and a disposable/read-only configured
workspace:

```text
npm run snapshot:preview -- --fixture <collected-pages.json> \
  --workspace <workspace-uuid> --user <manager-user-uuid> \
  --confirm zero-write-preview
```

The local operator command rejects fixtures over 50 MiB, verifies the entire
collected snapshot before connecting, then
uses a read-only transaction to report create/match/replay/quarantine outcomes,
source issues, unresolved affiliate facts, counts, content hash and delta-start
`eventHighWatermark`. It performs zero writes.

## Event bridge alignment

The reviewed external-event v1 catalogue remains the canonical future outbox
catalogue. The Growth HQ alias is a strict reference to that frozen list; no new
event type, live sender, dispatcher, intake switch or network effect is added by
this slice. `eventHighWatermark` is the durable starting point for a later
authorised delta catch-up after a complete snapshot.
