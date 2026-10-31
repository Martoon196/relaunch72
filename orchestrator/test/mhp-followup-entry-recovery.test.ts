import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanyContentService, CompanyContentTransactionRunner, CreateCompanyContentVersionCommand } from '../src/company-content-pg/index.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { MhpSequenceService, PgMhpSequenceRepository, type MhpSequenceRepository } from '../src/mhp/followup-sequence-service.js';
import { mhpSequencePage } from '../src/mhp/followup-sequence-view.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { canonicalFollowupSequence, readCanonicalFollowupSequence, followupSequenceSha, FOLLOWUP_SEQUENCE_V2_SCHEMA } from '../src/followup-sequences/definition.js';
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
const future = readCanonicalFollowupSequence(canonicalFollowupSequence({ ...definition, schema: FOLLOWUP_SEQUENCE_V2_SCHEMA, entry: { mode: 'webinar_signup', source: 'mhp.capture/v2' } }));
const recoveryRuns = [{ id: sequenceIds.run, contentItemId: sequenceIds.item, contentVersionId: sequenceIds.version,
  email: 'synthetic-recovery@example.invalid', firstName: 'Recovery fixture', state: 'paused' as const, position: 0,
  dueAt: new Date(now).toISOString(), reason: null, createdAt: new Date(now).toISOString(), lastAcceptedAt: null,
  inFlight: false, unknownProofId: null, steps: [] }];
function withFuture(f: ReturnType<typeof fixture>) {
  const body = canonicalFollowupSequence(future), sha = followupSequenceSha(body);
  f.state.review = { ...f.state.review, canonicalContent: body, contentSha256: sha };
  f.state.local = { ...f.state.local, canonicalContent: body, contentSha256: sha, exact: { ...f.state.local.exact!, canonicalContent: body, contentSha256: sha, definition: future } };
}
test('recovery reads exact v2 intent but refuses new v2 Save and predecessor downgrade', async () => {
  const f = fixture();
  await assert.rejects(f.service.save(identity, ids.request, { ...input, definition: future }, now), { status: 409 });
  withFuture(f); assert.equal((await f.service.review(identity, ids.request, sequenceIds.item, sequenceIds.version)).definition.entry?.mode, 'webinar_signup');
  await assert.rejects(f.service.save(identity, ids.request, { ...input, contentItemId: sequenceIds.item, previousVersionId: sequenceIds.version }, now), { status: 409 });
  assert.deepEqual(f.state.calls, []);
});
test('recovery refuses v2 Publish/Start/Resume while genuine pause/stop/cancel remain', async () => {
  const f = fixture(); withFuture(f);
  await assert.rejects(f.service.publish(identity, ids.request, sequenceIds.item, sequenceIds.version, ids.command, now), { status: 409 });
  await assert.rejects(f.service.command(identity, ids.request, action), { status: 409 });
  await assert.rejects(f.service.command(identity, ids.request, { ...action, action: 'resume', runId: sequenceIds.run }), { status: 409 });
  for (const kind of ['pause','stop','cancel'] as const) await f.service.command(identity, ids.request, { ...action, action: kind });
  assert.deepEqual(f.state.calls, ['pause','stop','cancel']);
});
test('recovery rejects historical v1 save replay with v2 predecessor, retaining valid v1 replay', async () => {
  const f = fixture();
  const oldReview = f.state.review, oldLocal = f.state.local;
  withFuture(f); const futureLocal = f.state.local;
  f.repository.local = async (_identity, version) => version ? futureLocal : { ...oldLocal,
    previousVersionId: sequenceIds.version, sourceVersion: `edit:${ids.command}` };
  await assert.rejects(f.service.save(identity, ids.request, { ...input, contentItemId: sequenceIds.item, previousVersionId: sequenceIds.version }, now), { status: 409 });
  assert.deepEqual(f.state.calls, []);
  f.state.review = { ...oldReview, isLatest: false }; f.state.local = oldLocal;
  f.repository.local = async (_identity, version) => version ? oldLocal : { ...oldLocal,
    previousVersionId: sequenceIds.version, sourceVersion: `edit:${ids.command}` };
  assert.equal((await f.service.save(identity, ids.request, { ...input, contentItemId: sequenceIds.item, previousVersionId: sequenceIds.version }, now)).replayed, true);
  assert.deepEqual(f.state.calls, []);
});
test('recovery Resume requires an exact visible v1 person and exact immutable v1 review with127 missing hint', async () => {
  const f = fixture();
  await assert.rejects(f.service.command(identity, ids.request, { ...action, action: 'resume' }), { status: 409 });
  for (const schema of [FOLLOWUP_SEQUENCE_V2_SCHEMA]) {
    f.repository.snapshot = async () => ({ ...snapshot.database, runs: recoveryRuns.map(run => ({ ...run, definitionSchema: schema })) });
    await assert.rejects(f.service.command(identity, ids.request, { ...action, action: 'resume', runId: sequenceIds.run }), { status: 409 });
  }
  f.repository.snapshot = async () => ({ ...snapshot.database, runs: recoveryRuns.map(run => ({ ...run, definitionSchema: 'growthhq.followup-sequence/v1' })) });
  await f.service.command(identity, ids.request, { ...action, action: 'resume', runId: sequenceIds.run });
  f.repository.snapshot = async () => ({ ...snapshot.database, runs: recoveryRuns.map(run => ({ ...run, definitionSchema: undefined })) });
  await f.service.command(identity, ids.request, { ...action, action: 'resume', runId: sequenceIds.run });
  await assert.rejects(f.service.command(identity, ids.request, { ...action, action: 'resume', runId: ids.request }), { status: 409 });
  f.state.local = { ...f.state.local, valid: false };
  await assert.rejects(f.service.command(identity, ids.request, { ...action, action: 'resume', runId: sequenceIds.run }), { status: 409 });
  f.state.local = { ...f.state.local, valid: true };
  f.repository.snapshot = async () => ({ ...snapshot.database, runs: recoveryRuns.map(run => ({ ...run, contentVersionId: ids.request, definitionSchema: undefined })) });
  await assert.rejects(f.service.command(identity, ids.request, { ...action, action: 'resume', runId: sequenceIds.run }), { status: 409 });
  f.state.review = { ...f.state.review, contentVersionId: ids.request };
  await assert.rejects(f.service.command(identity, ids.request, { ...action, action: 'resume', runId: sequenceIds.run }));
  assert.deepEqual(f.state.calls, ['resume','resume']);
});
test('recovery native v2 page hides unsupported mutations and labels retained entry intent', () => {
  const html = mhpSequencePage({ snapshot: { ...snapshot, database: { ...snapshot.database, runs: recoveryRuns.map(run => ({ ...run, definitionSchema: FOLLOWUP_SEQUENCE_V2_SCHEMA })) } },
    detail: { ...detail, definition: future, review: { ...detail.review, approvalStatus: 'approved' } }, csrf: 'synthetic', commandId: ids.command, returnCommandId: ids.request });
  assert.match(html, /future webinar entry intent/u); assert.match(html, /recovery release can read, pause, stop or cancel/u);
  assert.doesNotMatch(html, /data-sequence-editor|action="[^"]*\/(?:save|publish|enrol|resume)"/u);
  assert.match(html, /action="[^"]*\/cancel"/u); assert.match(html, /action="[^"]*\/stop"/u);
});
test('recovery v1 authoring stays available but all bulk Resume controls are absent', async () => {
  const f = fixture(); await f.service.save(identity, ids.request, input, now); assert.deepEqual(f.state.calls, ['save']);
  const html = mhpSequencePage({ snapshot: { ...snapshot, database: { ...snapshot.database, runs: recoveryRuns.map(run => ({ ...run, definitionSchema: 'growthhq.followup-sequence/v1' })) } },
    detail, csrf: 'synthetic', commandId: ids.command, returnCommandId: ids.request });
  assert.match(html, /data-sequence-editor/u); assert.match(html, /Resume this person/u); assert.doesNotMatch(html, /Resume ready runs/u);
});
