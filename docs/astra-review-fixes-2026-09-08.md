# Astra HQ review — 8 September 2026

Review base: combined held candidate `6b6f5aa627ddc8b31d6a6b88fba9cf4dea5c7b7e`.

This correction checkout is local source work. Neither the original Inbox candidate `781faaf05e8fe49d899474bb5a1a55b98b887b00` nor the combined candidate was changed or published. The existing automatic public-source publication hold remains in force.

## Corrections

1. **P2 — empty comments-only source displayed a 1970 check time.** With a connected LinkedIn comments account and no posts, the synthetic empty DM queue's timestamp took precedence over the successful comments-feed check. The status now takes the actual comments check when no DM read ran. A service regression test failed with `1970-01-01T00:00:00.000Z` before the fix and passes with the fixture's real observation time. No new provider call was added.
2. **P2 — an unread Inbox source was labelled ready.** Opening Live social previously marked Messages & follow-ups ready whenever its service was configured, even if that source would fail to load. It now says Check on open (or Not available when absent). A real router test supplies an unavailable conversion service, proves it is not read, and requires the truthful status. The successful Conversion Inbox route still marks its own completed read ready.
3. **P2 — rejected draft requests were offered an ineffective retry.** Validation, changed-evidence and access failures were discarded by the campaign router and shown as generic temporary failures. The response now preserves the failure category, shows bounded guidance, and includes only temporarily unavailable channels in the same-intent retry form. A completely rejected request returns 400, 409 or 403 as appropriate; partial packs remain 207 and retain saved-version links. Arbitrary internal service/provider messages are never echoed. The generation, persistence, evidence and approval contracts were not changed.

## Verification

- Four new regression tests failed before the product fixes: comments-only timestamp, unread conversion readiness, definitive failure classification, and a mixed saved/validation/unavailable pack.
- Focused offline regression: **89 passed, 0 failed, 0 skipped** across Company Content, generated-draft lifecycle, composition, campaign-router, Inbox source-status, Inbox router and social messaging tests.
- TypeScript typecheck: passed.
- Full offline regression: **2,971 passed, 0 failed, 39 expected database-integration skips; 3,010 total**, 156.6 seconds. Evidence retained in the overnight workspace at `_verification/hq-astra-review-full.log`.
- `git diff --check`: passed.
- No production account, database or provider was called. No migration, dependency version, approval policy or outbound capability changed.
- The corrected renderer was exercised by router tests; a new visual browser review is not claimed here.

## Next-track boundary identified during review

Durable draft review is not an end-to-end scheduling proof. Generated drafts currently retain source system `property_predator_generation` with a ten-minute source attestation in `property-predator-generation-approval.ts`. The existing owned-source sync and public-social JIT attestor handle `propertypredator.company-content`; the JIT attestor rejects another source system. An expired generated draft is therefore not covered by those refresh paths. This was not repaired by extending expiry, changing source identity or weakening approval checks. The next HQ track must define and prove exact generated-source revalidation before claiming a reliable create → approve → schedule journey.

The review found no confirmed tenant leak or duplicate paid effect in the inspected new Inbox/draft paths. This statement is limited to source review and the isolated tests above; it does not replace the existing disposable PostgreSQL proof or live multi-user acceptance.
