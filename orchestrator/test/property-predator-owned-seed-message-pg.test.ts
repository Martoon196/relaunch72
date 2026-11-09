import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL,
  PropertyPredatorOwnedSeedMessageService,
  PropertyPredatorOwnedSeedMessageValidationError,
} from '../src/property-predator-owned-seed-message-pg/index.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  contentVersion: '33333333-3333-4333-8333-333333333333',
  contentDecision: '44444444-4444-4444-8444-444444444444',
  message: '55555555-5555-4555-8555-555555555555',
  messageVersion: '66666666-6666-4666-8666-666666666666',
  approvalRequest: '77777777-7777-4777-8777-777777777777',
  approvalDecision: '88888888-8888-4888-8888-888888888888',
});
const DIGESTS = Object.freeze({
  subject: 'a'.repeat(64), body: 'b'.repeat(64), source: 'c'.repeat(64),
});

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function database(respond: (sql: string) => unknown[]): Readonly<{
  pool: Pick<Pool, 'connect'>;
  calls: Call[];
}> {
  const calls: Call[] = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes("set_config('app.user_id'")) return { rows: [{}] };
    return { rows: respond(sql) };
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return Object.freeze({
    pool: { connect: async () => client } as Pick<Pool, 'connect'>,
    calls,
  });
}

function context() {
  return Object.freeze({
    actorKind: 'user' as const, workspaceId: IDS.workspace,
    userId: IDS.user, requestId: 'owned-seed-message-unit',
  });
}

function evidence() {
  return {
    subjectSha256: Buffer.from(DIGESTS.subject, 'hex'),
    bodySha256: Buffer.from(DIGESTS.body, 'hex'),
    sourceContentSha256: Buffer.from(DIGESTS.source, 'hex'),
  };
}

test('service creates a hash-bound draft without accepting copy, recipient or provider input', async () => {
  const db = database((sql) => sql.includes('create_property_predator_owned_seed_message_draft')
    ? [{ disposition: 'created', messageId: IDS.message,
      messageVersionId: IDS.messageVersion,
      companyContentVersionId: IDS.contentVersion,
      companyContentApprovalDecisionId: IDS.contentDecision, ...evidence() }] : []);
  const service = new PropertyPredatorOwnedSeedMessageService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  const result = await service.createDraft(context(), {
    commandKey: 'campaign:email:draft:001',
    companyContentVersionId: IDS.contentVersion,
  });
  assert.deepEqual(result, {
    disposition: 'created', messageId: IDS.message,
    messageVersionId: IDS.messageVersion,
    companyContentVersionId: IDS.contentVersion,
    companyContentApprovalDecisionId: IDS.contentDecision,
    subjectSha256: DIGESTS.subject, bodySha256: DIGESTS.body,
    sourceContentSha256: DIGESTS.source,
    recipient: PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL,
    providerEffects: false, lifecycleAtCommand: 'draft',
  });
  const call = db.calls.find((candidate) => candidate.sql.includes('create_property_predator'));
  assert.deepEqual(call?.values, [IDS.workspace, IDS.contentVersion, 'campaign:email:draft:001']);
  assert.doesNotMatch(JSON.stringify(call?.values), /office@|mailgun|subject|body/i);
});

test('service requests then explicitly approves the exact message version', async () => {
  const db = database((sql) => {
    if (sql.includes('request_property_predator')) return [{
      disposition: 'requested', messageId: IDS.message,
      messageVersionId: IDS.messageVersion,
      approvalRequestId: IDS.approvalRequest, ...evidence(),
    }];
    if (sql.includes('decide_property_predator')) return [{
      disposition: 'decided', messageId: IDS.message,
      messageVersionId: IDS.messageVersion,
      approvalRequestId: IDS.approvalRequest,
      approvalDecisionId: IDS.approvalDecision, decision: 'approved', ...evidence(),
    }];
    return [];
  });
  const service = new PropertyPredatorOwnedSeedMessageService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  const requested = await service.requestApproval(context(), {
    commandKey: 'campaign:message:request:001', messageId: IDS.message,
    reviewNote: 'Review the exact owned-seed proof.',
  });
  assert.equal(requested.lifecycleAtCommand, 'approval_pending');
  assert.equal(requested.approvalRequestId, IDS.approvalRequest);
  const decided = await service.decideApproval(context(), {
    commandKey: 'campaign:message:approve:001',
    approvalRequestId: IDS.approvalRequest, decision: 'approved',
  });
  assert.equal(decided.lifecycleAtCommand, 'approved');
  assert.equal(decided.approvalDecisionId, IDS.approvalDecision);
  assert.deepEqual(
    db.calls.find((candidate) => candidate.sql.includes('decide_property_predator'))?.values,
    [IDS.workspace, IDS.approvalRequest, 'approved', null, 'campaign:message:approve:001'],
  );
});

test('service resumes one bounded hash-only workflow snapshot by exact company content version', async () => {
  const db = database((sql) => sql.includes('resume_property_predator_owned_seed_message')
    ? [{
      messageId: IDS.message, messageVersionId: IDS.messageVersion,
      companyContentVersionId: IDS.contentVersion, phase: 'staged',
      approvalRequestId: IDS.approvalRequest, ...evidence(),
    }] : []);
  const service = new PropertyPredatorOwnedSeedMessageService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  const result = await service.resume(context(), {
    companyContentVersionId: IDS.contentVersion,
  });
  assert.deepEqual(result, {
    messageId: IDS.message, messageVersionId: IDS.messageVersion,
    companyContentVersionId: IDS.contentVersion, phase: 'staged',
    approvalRequestId: IDS.approvalRequest,
    subjectSha256: DIGESTS.subject, bodySha256: DIGESTS.body,
    sourceContentSha256: DIGESTS.source,
    recipient: PROPERTY_PREDATOR_OWNED_SEED_MESSAGE_EMAIL,
  });
  assert.equal('providerEffects' in (result ?? {}), false);
  assert.equal('providerConnectionId' in (result ?? {}), false);
  assert.equal('bodyText' in (result ?? {}), false);
  const call = db.calls.find((candidate) => candidate.sql.includes('resume_property_predator'));
  assert.deepEqual(call?.values, [IDS.workspace, IDS.contentVersion]);
});

test('service returns null when no owned-seed workflow exists for the exact version', async () => {
  const db = database(() => []);
  const service = new PropertyPredatorOwnedSeedMessageService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  assert.equal(await service.resume(context(), {
    companyContentVersionId: IDS.contentVersion,
  }), null);
});

test('portal commands revalidate the active portal session before the live-message function', async () => {
  const db = database((sql) => {
    if (sql.includes('active_portal_session')) return [{ active: true }];
    if (sql.includes('create_property_predator_owned_seed_message_draft')) return [{
      disposition: 'created', messageId: IDS.message,
      messageVersionId: IDS.messageVersion,
      companyContentVersionId: IDS.contentVersion,
      companyContentApprovalDecisionId: IDS.contentDecision, ...evidence(),
    }];
    if (sql.includes('resume_property_predator_owned_seed_message')) return [{
      messageId: IDS.message, messageVersionId: IDS.messageVersion,
      companyContentVersionId: IDS.contentVersion, phase: 'drafted',
      approvalRequestId: null, ...evidence(),
    }];
    return [];
  });
  const service = new PropertyPredatorOwnedSeedMessageService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  await service.createDraft({
    ...context(), portalSessionTokenHash: Buffer.alloc(32, 7),
  }, {
    commandKey: 'campaign:email:portal:001',
    companyContentVersionId: IDS.contentVersion,
  });
  await service.resume({
    ...context(), portalSessionTokenHash: Buffer.alloc(32, 7),
  }, { companyContentVersionId: IDS.contentVersion });
  const lockIndex = db.calls.findIndex((call) => call.sql.includes('lock_active_portal_session'));
  const draftIndex = db.calls.findIndex((call) => call.sql.includes('create_property_predator'));
  assert.ok(lockIndex >= 0 && draftIndex > lockIndex);
  const resumeIndex = db.calls.findIndex((call) => call.sql.includes('resume_property_predator'));
  const secondLockIndex = db.calls.findIndex(
    (call, index) => index > draftIndex && call.sql.includes('active_portal_session'),
  );
  assert.ok(secondLockIndex > draftIndex && resumeIndex > secondLockIndex);
});

test('service validates human approval commands before any SQL', async () => {
  const db = database(() => []);
  const service = new PropertyPredatorOwnedSeedMessageService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  await assert.rejects(
    service.createDraft({ ...context(), actorKind: 'system', userId: undefined }, {
      commandKey: 'valid-key', companyContentVersionId: IDS.contentVersion,
    }),
    PropertyPredatorOwnedSeedMessageValidationError,
  );
  await assert.rejects(
    service.decideApproval(context(), {
      commandKey: 'valid-key', approvalRequestId: IDS.approvalRequest,
      decision: 'rejected',
    }),
    /requires a decisionNote/,
  );
  await assert.rejects(
    service.requestApproval(context(), {
      commandKey: 'contains spaces', messageId: IDS.message,
    }),
    /commandKey is invalid/,
  );
  assert.equal(db.calls.length, 0);
});

test('service checks the dedicated table-blind boundary', async () => {
  const db = database((sql) => sql.includes('owned_seed_message_boundary_ready')
    ? [{ ready: true }] : []);
  const service = new PropertyPredatorOwnedSeedMessageService({
    commandPool: db.pool, workspaceId: IDS.workspace,
  });
  await service.assertReady();
  assert.ok(db.calls.some((call) => call.sql.includes('owned_seed_message_boundary_ready')));
});
