import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { CompanyContentService, CompanyContentTransactionRunner } from '../src/company-content-pg/index.js';
import type { FlowMessageReview } from '../src/followup-sequences/messages.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import { refreshMhpOwnedSmsObservation } from '../src/mhp/owned-sms-service.js';
import { ids, identity, review } from './helpers/mhp-owner-email-fixture.js';
async function observationFixture() {
  const context = requestDatabaseContext({ userId: identity.userId, workspaceId: identity.workspaceId, requestId: ids.request,
    portalSessionTokenHash: createHash('sha256').update(identity.sessionToken).digest() });
  const bodyText = 'Martin Howard Property owned test.', canonical = JSON.stringify({ bodyText, schema: 'growthhq.sms-draft/v1' });
  const sha = createHash('sha256').update(canonical).digest('hex');
  const detail: FlowMessageReview = { review: { ...review, kind: 'other', approvalStatus: 'approved', approvalStale: false, canonicalContent: canonical, contentSha256: sha, blobSha256: sha,
    source: { system: 'mhp.owner-sms', itemId: `owner-sms:${ids.item}`, version: `edit:${ids.version}` } }, channel: 'sms',
    payload: { schema: 'growthhq.sms-draft/v1', bodyText }, valid: true, local: null, manifestSha256: sha };
  const state = { receipt: null as null | { status: string; result: { contentItemId: string; contentVersionId: string; sourceAttestationExpiresAt: string } }, refreshes: 0 };
  const transactions: CompanyContentTransactionRunner = { run: async (_context, operation, options) => {
    assert.equal(options.readOnly, true);
    return operation({ query: async (sql: string) => { assert.match(sql, /companyContent.refreshSourceAttestation/u); return { rows: state.receipt ? [state.receipt] : [] }; } } as never);
  } };
  const adapter: Pick<CompanyContentService, 'refreshSourceAttestation'> = { refreshSourceAttestation: async (_context, command) => {
    state.refreshes++; assert.equal(command.contentVersionId, ids.version); assert.equal(command.expected.source.system, 'mhp.owner-sms');
    assert.equal(command.attestation.catalogSha256, detail.manifestSha256);
    state.receipt = { status: 'succeeded', result: { contentItemId: ids.item, contentVersionId: ids.version, sourceAttestationExpiresAt: command.attestation.expiresAt } };
    return { disposition: 'applied', ...state.receipt.result, sourceAttestationId: ids.approval, providerEffects: false };
  } };
  return { state, input: { context, detail, commandId: ids.command, now: Date.parse('2026-11-01T12:00:00Z'), transactions, adapter } };
}
test('already approved SMS gets one exact new source observation; same-command retry reuses durable receipt before timestamps', async () => {
  const f = await observationFixture(); await refreshMhpOwnedSmsObservation(f.input);
  await refreshMhpOwnedSmsObservation({ ...f.input, now: f.input.now + 1000 }); assert.equal(f.state.refreshes, 1);
});
test('an expired partial source receipt cannot be renewed by replaying the old owned test', async () => {
  const f = await observationFixture(); await refreshMhpOwnedSmsObservation(f.input);
  await assert.rejects(refreshMhpOwnedSmsObservation({ ...f.input, now: f.input.now + 900_001 }), /expired/u); assert.equal(f.state.refreshes, 1);
});
test('changed receipt identity or a foreign source cannot produce an observation', async () => {
  const f = await observationFixture(); f.state.receipt = { status: 'succeeded', result: { contentItemId: ids.prospect, contentVersionId: ids.version, sourceAttestationExpiresAt: '2026-11-01T12:15:00Z' } };
  await assert.rejects(refreshMhpOwnedSmsObservation(f.input), /different text/u);
  await assert.rejects(refreshMhpOwnedSmsObservation({ ...f.input, detail: { ...f.input.detail, review: { ...f.input.detail.review, source: { ...f.input.detail.review.source, system: 'pp.owner-sms' } } } }), /current MHP text/u);
  assert.equal(f.state.refreshes, 0);
});
