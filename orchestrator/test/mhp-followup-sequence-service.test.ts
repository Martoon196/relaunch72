import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanyContentService, CompanyContentTransactionRunner, CreateCompanyContentVersionCommand } from '../src/company-content-pg/index.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { MhpSequenceService, PgMhpSequenceRepository, type MhpSequenceRepository } from '../src/mhp/followup-sequence-service.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { readCanonicalFollowupSequence, followupSequenceSha } from '../src/followup-sequences/definition.js';
import { ids, identity, tokenHash, now, snapshot as emailSnapshot, review as emailReview, local as emailLocal } from './helpers/mhp-owner-email-fixture.js';
import { sequenceIds, sequenceDefinition as definition, sequenceSnapshot as snapshot, sequenceDetail as detail } from './helpers/mhp-sequence-fixture.js';

function fixture() {
  const state = { allowed: true, saved: false, refreshReceipt: false, refreshLost: false, saveLost: false, calls: [] as string[], command: null as CreateCompanyContentVersionCommand | null,
    review: { ...detail.review }, local: { ...detail.local }, status: { ...emailSnapshot.status }, emailApproved: true, emailLatest: true };
  const context = (value: DatabaseRequestContext) => { assert.equal(value.userId, identity.userId); assert.equal(value.workspaceId, identity.workspaceId); assert.deepEqual(value.portalSessionTokenHash, tokenHash); };
  const repository: MhpSequenceRepository = { snapshot: async () => snapshot.database,
    local: async (_given, version) => version ? state.local : state.saved ? state.local : null,
    command: async (_given, input) => { state.calls.push(input.action); return { action: input.action, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, changed: 3, remaining: 0, blocked: 0, inFlight: 0, replayed: false }; } };
  const adapter: Pick<CompanyContentService, 'createVersion' | 'refreshSourceAttestation'> = {
    createVersion: async (given, command) => { context(given); state.command = command; state.calls.push('save'); state.saved = true;
      state.local = { ...state.local, title: command.title, canonicalContent: command.content, contentSha256: followupSequenceSha(command.content), previousVersionId: command.previousVersionId ?? null,
        sourceItemId: command.source.itemId, sourceVersion: command.source.version, metadata: command.metadata ?? {} };
      if (state.saveLost) throw new Error('Committed save response lost');
      return { disposition: 'applied', contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, versionNumber: 1, contentSha256: followupSequenceSha(command.content), sourceAttestationId: ids.proof, sourceAttestationExpiresAt: new Date(now + 900_000).toISOString() }; },
    refreshSourceAttestation: async (given, command) => { context(given); state.calls.push('refresh'); state.refreshReceipt = true; if (state.refreshLost) throw new Error('Refresh response lost');
      return { disposition: 'applied', contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, sourceAttestationId: ids.proof, sourceAttestationExpiresAt: command.attestation.expiresAt, providerEffects: false }; },
  };
  const transactions = { run: async (given: DatabaseRequestContext, operation: any) => { context(given); return operation({ query: async () => ({ rows: state.refreshReceipt ? [{ status: 'succeeded', result: { contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version } }] : [] }) }); } } as CompanyContentTransactionRunner;
  const service = new MhpSequenceService({ marketingWorkspace: { snapshot: async given => { if (!state.allowed) throw new MhpCommerceError(403, 'Owner required'); return { userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: given.workspaceId === identity.workspaceId }; } },
    repository, reader: { listCatalog: async given => { context(given); return snapshot.catalog; }, getExactReview: async given => { context(given); return state.review; } },
    adapter, adapterTransactions: transactions, approvals: { requestApproval: async (given, command) => { context(given); state.calls.push('request'); return { disposition: 'applied', approvalRequestId: ids.request, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, requestNumber: 1, contentSha256: detail.review.contentSha256 }; },
      decideApproval: async (given, command) => { context(given); state.calls.push('approve'); state.review = { ...state.review, approvalStatus: 'approved', approvalDecisionId: ids.approval }; return { disposition: 'applied', approvalRequestId: ids.request, approvalDecisionId: ids.approval, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, decision: 'approved', contentSha256: detail.review.contentSha256 }; } },
    emails: { snapshot: async given => { context({ ...given, actorKind: 'user', requestId: ids.request, portalSessionTokenHash: tokenHash }); return emailSnapshot; },
      review: async () => ({ review: { ...emailReview, isLatest: state.emailLatest, approvalStatus: state.emailApproved ? 'approved' : 'unrequested' }, local: emailLocal }),
      get status() { return state.status; } }, campaign: definition.campaign });
  return { state, service, repository };
}
const input = { commandId: ids.command, contentItemId: '', previousVersionId: '', definition };
const action = { action: 'enrol' as const, commandId: ids.command, itemId: sequenceIds.item, versionId: sequenceIds.version, runId: '', ackProofId: '' };

test('save reuses content kind other and exact body/hash/brand/source manifest with no enrol/provider effects', async () => {
  const f = fixture(); assert.equal((await f.service.save(identity, ids.request, input, now)).replayed, false);
  const command = f.state.command!; assert.equal(command.kind, 'other'); assert.equal(command.source.system, 'mhp.followup-sequence');
  assert.deepEqual(readCanonicalFollowupSequence(command.content), definition); assert.equal(command.blob.sha256, followupSequenceSha(command.content));
  assert.equal(command.source.itemId, `sequence:${ids.command}`); assert.equal(command.source.version, `edit:${ids.command}`);
  assert.doesNotMatch(command.content, /bodyText|recipient|password|token/u); assert.deepEqual(f.state.calls, ['save']);
  assert.equal((await f.service.save(identity, ids.request, input, now + 60_000)).replayed, true); assert.deepEqual(f.state.calls, ['save']);
  await assert.rejects(f.service.save(identity, ids.request, { ...input, definition: { ...definition, title: 'Changed input' } }, now), { status: 409 });
});
test('committed save response loss recovers exact stored revision without a second version', async () => {
  const f = fixture(); f.state.saveLost = true; assert.equal((await f.service.save(identity, ids.request, input, now)).replayed, true); assert.deepEqual(f.state.calls, ['save']);
});
test('one Publish records real-user source refresh and exact approval; retry has no enrol effect', async () => {
  const f = fixture(); f.state.refreshLost = true; await f.service.publish(identity, ids.request, sequenceIds.item, sequenceIds.version, ids.command, now);
  await f.service.publish(identity, ids.request, sequenceIds.item, sequenceIds.version, ids.command, now + 60_000);
  assert.deepEqual(f.state.calls, ['refresh', 'request', 'approve']);
});
test('personal/non-owner, wrong brand/campaign and stale publish fail before mutations', async () => {
  const f = fixture(); await assert.rejects(f.service.save({ ...identity, workspaceId: ids.prospect }, ids.request, input), { status: 403 });
  f.state.allowed = false; await assert.rejects(f.service.command(identity, ids.request, action), { status: 403 }); f.state.allowed = true;
  for (const change of [{ brand: 'pp' }, { campaign: 'foreign' }]) await assert.rejects(f.service.save(identity, ids.request, { ...input, definition: { ...definition, ...change } }), { status: 400 });
  f.state.review = { ...f.state.review, isLatest: false }; await assert.rejects(f.service.publish(identity, ids.request, sequenceIds.item, sequenceIds.version, ids.command), { status: 409 });
  assert.deepEqual(f.state.calls, []);
});
test('Start/resume refuse unavailable delivery while pause/cancel remain usable', async () => {
  const f = fixture(); f.state.status = { ...f.state.status, mode: 'off', providerReady: false };
  await assert.rejects(f.service.command(identity, ids.request, action), { status: 409 });
  await f.service.command(identity, ids.request, { ...action, action: 'pause' }); await f.service.command(identity, ids.request, { ...action, action: 'cancel' }); assert.deepEqual(f.state.calls, ['pause', 'cancel']);
});
test('Start reports unpublished or older selected email versions before any enrolment command', async () => {
  const f = fixture(); f.state.emailApproved = false;
  assert.deepEqual((await f.service.review(identity, ids.request, sequenceIds.item, sequenceIds.version)).blockers, ['email_version_not_ready']);
  await assert.rejects(f.service.command(identity, ids.request, action), { status: 409 });
  f.state.emailApproved = true; f.state.emailLatest = false;
  await assert.rejects(f.service.command(identity, ids.request, action), { status: 409 }); assert.deepEqual(f.state.calls, []);
  f.state.emailLatest = true; assert.equal((await f.service.command(identity, ids.request, action)).changed, 3);
});
test('PG boundary hashes real native token, uses server campaign and exact unknown proof only', async () => {
  const calls: { sql: string; args: unknown[] }[] = [];
  const pool = { query: async (sql: string, args: unknown[]) => { calls.push({ sql, args }); return { rows: [{ value: { action: 'resume', contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version, changed: 1, remaining: 0, blocked: 0, inFlight: 0, replayed: false } }] }; } } as any;
  const repository = new PgMhpSequenceRepository(pool, pool);
  await repository.command(identity, { ...action, action: 'resume', runId: sequenceIds.run, ackProofId: sequenceIds.proof, campaign: definition.campaign, requestId: ids.request });
  assert.deepEqual(calls[0]!.args[0], tokenHash); assert.deepEqual(calls[0]!.args.slice(1), ['resume', ids.command, sequenceIds.version, definition.campaign, sequenceIds.run, sequenceIds.proof, ids.request]);
  assert.match(calls[0]!.sql, /^SELECT app_private\.mhp_sequence_command/u);
});
