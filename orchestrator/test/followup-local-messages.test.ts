import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanyContentTransactionRunner, CreateCompanyContentVersionCommand } from '../src/company-content-pg/index.js';
import { LocalFlowMessages } from '../src/followup-sequences/messages.js';
import { FlowLocalStore, checkedFlowLocalManifest, publishFlowLocal, type FlowStoredLocal } from '../src/followup-sequences/local-store.js';
import { flowMessageVersionCommand } from '../src/followup-sequences/content.js';
import { canonicalFlowMessage, FLOW_SMS_DRAFT_SCHEMA } from '../src/followup-sequences/channel-drafts.js';
import { followupSequenceSha } from '../src/followup-sequences/definition.js';
import { ids, identity, now, review as emailReview } from './helpers/mhp-owner-email-fixture.js';
const brand = { canonical: '{"native":"synthetic"}', sha256: followupSequenceSha('{"native":"synthetic"}'), ref: 'native-synthetic-brand', productName: 'Synthetic PP', primaryColor: null, accentColor: null };
const context = { actorKind: 'user' as const, userId: identity.userId, workspaceId: identity.workspaceId, requestId: ids.request };
const input = { channel: 'sms' as const, title: 'Sample follow-up', contentItemId: '', previousVersionId: '', payload: { schema: FLOW_SMS_DRAFT_SCHEMA, bodyText: 'Hello {{FIRSTNAME}}, sample only.' } };
function fixture() {
  const state = { row: null as FlowStoredLocal | null, lost: false, writes: 0, authorized: 0, command: null as CreateCompanyContentVersionCommand | null };
  const transactions = { run: async (_context: unknown, operation: (transaction: unknown) => Promise<unknown>) => operation({ query: async (_sql: string, params: unknown[]) => {
    const row = state.row; return { rows: row && (params[1] === row.contentVersionId || params[2] === row.sourceVersion) ? [row] : [] };
  } }) } as CompanyContentTransactionRunner;
  const dependencies = {
    brand: 'pp' as const, authorize: async () => { state.authorized++; return context; }, brandSnapshot: async () => brand,
    reader: { listCatalog: async () => ({ items: [], nextCursor: null }), getExactReview: async () => null },
    adapter: { createVersion: async (_context: unknown, command: CreateCompanyContentVersionCommand) => {
      state.writes++; state.command = command; const sha = followupSequenceSha(command.content);
      state.row = { contentItemId: ids.item, contentVersionId: ids.version, sourceItemId: command.source.itemId, sourceVersion: command.source.version,
        previousVersionId: command.previousVersionId ?? null, canonicalContent: command.content, contentSha256: sha, title: command.title, authorAllowed: true,
        blobStorageKey: command.blob.storageKey, brandSnapshotRef: command.brand.snapshotRef, metadata: command.metadata ?? {} };
      if (state.lost) throw new Error('Synthetic response lost after durable save');
      return { disposition: 'applied' as const, contentItemId: ids.item, contentVersionId: ids.version, versionNumber: 1, contentSha256: sha, sourceAttestationId: ids.proof, sourceAttestationExpiresAt: new Date(now + 900000).toISOString() };
    }, refreshSourceAttestation: async () => { throw new Error('Not used'); } },
    approvals: { requestApproval: async () => { throw new Error('Not used'); }, decideApproval: async () => { throw new Error('Not used'); } }, transactions, local: new FlowLocalStore(transactions),
  } satisfies ConstructorParameters<typeof LocalFlowMessages>[0];
  return { state, dependencies, messages: new LocalFlowMessages(dependencies) };
}
test('native local message save and lost-response retry reuse exact source revision without another body store', async () => {
  const f = fixture(); f.state.lost = true;
  const first = await f.messages.save(identity, ids.request, ids.command, input, now);
  const retry = await f.messages.save(identity, ids.request, ids.command, input, now + 1000);
  assert.equal(first.replayed, true); assert.deepEqual(retry, first); assert.equal(f.state.writes, 1);
  assert.equal(f.state.command!.source.system, 'pp.owner-sms'); assert.equal(f.state.command!.kind, 'other');
  assert.equal(f.state.command!.content, canonicalFlowMessage('sms', input.payload)); assert.ok(f.state.authorized >= 2);
  await assert.rejects(f.messages.save(identity, ids.request, ids.command, { ...input, payload: { ...input.payload, bodyText: 'Different text' } }, now), { status: 409 });
  assert.equal(f.state.writes, 1);
});
test('local source manifests bind current native brand, author, exact MIME/channel hashes and provenance', async () => {
  const f = fixture(); await f.messages.save(identity, ids.request, ids.command, input, now);
  const command = f.state.command!, local = f.state.row!, sha = followupSequenceSha(command.content);
  const review = { ...emailReview, kind: 'other' as const, contentMimeType: command.contentMimeType, source: command.source,
    canonicalContent: command.content, contentSha256: sha, blobSha256: sha, brandSha256: brand.sha256 };
  const exact = { local, review, snapshot: brand, metadataKey: 'flowMessage' as const, schema: 'growthhq.local-message/v1', manifestSchema: 'pp.owner-message-source/v1', workspaceId: context.workspaceId, channel: 'sms' };
  assert.match(checkedFlowLocalManifest(exact), /^[0-9a-f]{64}$/u);
  for (const patch of [{ authorAllowed: false }, { brandSnapshotRef: 'other' }, { blobStorageKey: 'other' }]) assert.throws(() => checkedFlowLocalManifest({ ...exact, local: { ...local, ...patch } }), { status: 409 });
  assert.throws(() => checkedFlowLocalManifest({ ...exact, snapshot: { ...brand, canonical: '{"changed":true}' } }), { status: 409 });
  assert.throws(() => checkedFlowLocalManifest({ ...exact, channel: 'whatsapp' }), { status: 409 });
});
test('MHP email continues through the existing native email service, with no generic email creation', async () => {
  const f = fixture(); let saved = 0;
  const messages = new LocalFlowMessages({ ...f.dependencies, brand: 'mhp', mhpEmail: {
    review: async () => { throw new Error('Not used'); }, publish: async () => { throw new Error('Not used'); },
    save: async (_identity, _request, value) => { saved++; assert.equal(value.subject, 'Sample'); return { contentItemId: ids.item, contentVersionId: ids.version, replayed: false }; },
  } });
  await messages.save(identity, ids.request, ids.command, { ...input, channel: 'email', payload: { schema: 'propertypredator.email-draft/v1', subject: 'Sample', bodyText: 'Hello {{FIRSTNAME}}' } }, now);
  assert.equal(saved, 1); assert.equal(f.state.writes, 0);
  assert.throws(() => flowMessageVersionCommand({ brand: 'mhp', workspaceId: identity.workspaceId, snapshot: brand, channel: 'email', commandId: ids.command,
    title: 'Sample', payload: { schema: 'propertypredator.email-draft/v1', subject: 'Sample', bodyText: 'Hello' }, previous: null, now }), { status: 400 });
});
test('publication reuses a committed exact refresh receipt then requests and decides one local approval', async () => {
  const f = fixture(); await f.messages.save(identity, ids.request, ids.command, input, now); const calls: string[] = [];
  const transactions = { run: async (_context: unknown, operation: (transaction: unknown) => Promise<unknown>) => operation({ query: async () => ({ rows: [{ status: 'succeeded', result: { contentItemId: ids.item, contentVersionId: ids.version } }] }) }) } as CompanyContentTransactionRunner;
  const publish = { context, review: emailReview, local: f.state.row!, snapshot: brand, manifestSha256: '0'.repeat(64), commandId: ids.command, now, transactions,
    adapter: { refreshSourceAttestation: async () => { throw new Error('Must reuse committed receipt'); } },
    approvals: { requestApproval: async () => { calls.push('request'); return { disposition: 'applied' as const, approvalRequestId: ids.approval, contentItemId: ids.item, contentVersionId: ids.version, contentSha256: emailReview.contentSha256, requestNumber: 1 }; },
      decideApproval: async () => { calls.push('approve'); return { disposition: 'applied' as const, approvalRequestId: ids.approval, approvalDecisionId: ids.proof, contentItemId: ids.item, contentVersionId: ids.version, decision: 'approved' as const, contentSha256: emailReview.contentSha256 }; } } };
  await publishFlowLocal(publish); assert.deepEqual(calls, ['request', 'approve']);
  await publishFlowLocal({ ...publish, review: { ...emailReview, approvalStatus: 'approved' } }); assert.deepEqual(calls, ['request', 'approve']);
  await assert.rejects(publishFlowLocal({ ...publish, review: { ...emailReview, isLatest: false } }), { status: 409 });
});
