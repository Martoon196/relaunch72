import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PgOwnedPublicSocialLiveCommandService } from '../src/owned-public-social-pg/index.js';
import { encryptOwnedProfileKey } from '../src/public-social-outbound/owned-live-foundation.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  user: '22222222-2222-4222-8222-222222222222',
  connection: '33333333-3333-4333-8333-333333333333',
  profile: '44444444-4444-4444-8444-444444444444',
  revocation: '55555555-5555-4555-8555-555555555555',
  contentItem: '66666666-6666-4666-8666-666666666666',
  contentVersion: '77777777-7777-4777-8777-777777777777',
  approvalRequest: '88888888-8888-4888-8888-888888888888',
  approvalDecision: '99999999-9999-4999-8999-999999999999',
  attestation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  job: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  planningIntent: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
});

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const context = Object.freeze({
  actorKind: 'user' as const,
  workspaceId: IDS.workspace,
  userId: IDS.user,
  requestId: 'founder-owned-social-command',
  portalSessionTokenHash: Buffer.alloc(32, 7),
});

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function commandPool(
  domain: (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>,
): { pool: { connect(): Promise<PoolClient> }; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('lock_active_portal_session')) return { rows: [{ active: true }] };
      if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
          || sql.includes("set_config('app.user_id'")) return { rows: [] };
      return domain(sql, values);
    },
    release() {},
  } as unknown as PoolClient;
  return { pool: { connect: async () => client }, calls };
}

test('record profile stores exact encrypted owned-account evidence with no provider effect', async () => {
  const mocked = commandPool(async (sql) => {
    assert.match(sql, /record_owned_social_profile/u);
    return { rows: [{ id: IDS.profile }] };
  });
  const service = new PgOwnedPublicSocialLiveCommandService({
    commandPool: mocked.pool,
    workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  const plaintextProfileKey = 'owned-ayrshare-profile-key-001';
  const envelope = encryptOwnedProfileKey({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    profileId: IDS.profile,
    profileKey: plaintextProfileKey,
    keyVersion: 'render-kms-v1',
    encryptionKey: Buffer.alloc(32, 3),
    iv: Buffer.alloc(12, 4),
  });

  assert.deepEqual(await service.recordProfile(context, {
    profileId: IDS.profile,
    displayName: 'Property Predator on X',
    providerProfileRefSha256: sha('ayrshare-profile-ref'),
    ownedAccountRefSha256: sha('owned-x-account'),
    envelope,
    xOAuthLinkEvidenceSha256: sha('x-read-write-link-evidence'),
    linkedAt: '2026-08-29T10:00:00.000Z',
    evidenceObservedAt: '2026-08-29T10:01:00.000Z',
  }), { profileId: IDS.profile, providerEffects: 'none' });

  const command = mocked.calls.find((call) => call.sql.includes('record_owned_social_profile'));
  assert.ok(command);
  assert.deepEqual(command.values.slice(0, 4), [
    IDS.workspace, IDS.connection, IDS.profile, 'Property Predator on X',
  ]);
  assert.equal(command.values.includes(plaintextProfileKey), false);
  assert.equal(command.values.length, 15);
  assert.ok(command.values.slice(4, 13).every((value, index) =>
    index === 2 || Buffer.isBuffer(value)));
  assert.match(mocked.calls[0]?.sql ?? '', /SERIALIZABLE READ WRITE/u);
  assert.deepEqual(
    mocked.calls.find((call) => call.sql.includes('lock_active_portal_session'))?.values,
    [context.portalSessionTokenHash, IDS.user, IDS.workspace],
  );
  assert.ok(mocked.calls.findIndex((call) => call.sql.includes('lock_active_portal_session'))
    < mocked.calls.findIndex((call) => call.sql.includes("set_config('app.user_id'")));
  assert.equal(mocked.calls.at(-1)?.sql, 'COMMIT');
});

test('revoke and enqueue return exact durable identifiers and never claim a provider call', async () => {
  const mocked = commandPool(async (sql) => {
    if (sql.includes('revoke_owned_social_profile')) {
      return { rows: [{ id: IDS.revocation }] };
    }
    if (sql.includes('enqueue_owned_social_job')) return { rows: [{ id: IDS.job }] };
    throw new Error('unexpected SQL');
  });
  const service = new PgOwnedPublicSocialLiveCommandService({
    commandPool: mocked.pool,
    workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });

  assert.deepEqual(await service.revokeProfile(context, {
    profileId: IDS.profile,
    revocationEvidenceSha256: sha('founder-revocation-evidence'),
    reasonCode: 'operator.revoked',
  }), { revocationId: IDS.revocation, providerEffects: 'none' });
  assert.deepEqual(await service.enqueue(context, {
    profileId: IDS.profile,
    contentItemId: IDS.contentItem,
    contentVersionId: IDS.contentVersion,
    approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.attestation,
    operationTag: 'property-predator-owned-x-v1',
    idempotencyKeySha256: sha('owned-social-idempotency'),
    requestSha256: sha('owned-social-request'),
    scheduledFor: null,
  }), {
    jobId: IDS.job,
    providerEffects: 'none',
    caps: { daily: 1, monthly: 3 },
  });

  const revocation = mocked.calls.find((call) => call.sql.includes('revoke_owned_social_profile'));
  assert.deepEqual(revocation?.values.slice(0, 3), [
    IDS.workspace, IDS.connection, IDS.profile,
  ]);
  const enqueue = mocked.calls.find((call) => call.sql.includes('enqueue_owned_social_job'));
  assert.deepEqual(enqueue?.values.slice(0, 9), [
    IDS.workspace, IDS.connection, IDS.profile, IDS.contentItem, IDS.contentVersion,
    IDS.approvalRequest, IDS.approvalDecision, IDS.attestation,
    'property-predator-owned-x-v1',
  ]);
  assert.equal(enqueue?.values[11], null);
  assert.equal(mocked.calls.filter((call) => call.sql === 'COMMIT').length, 2);
});

test('Instagram calendar enqueue uses the v2 function with every parameter in exact order', async () => {
  const mocked = commandPool(async (sql) => {
    assert.match(sql, /enqueue_owned_social_job_v2/u);
    assert.doesNotMatch(sql, /\$10::uuid, \$10::uuid/u);
    return { rows: [{ id: IDS.job }] };
  });
  const service = new PgOwnedPublicSocialLiveCommandService({
    commandPool: mocked.pool,
    workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  const scheduledFor = '2026-09-02T09:30:00.000Z';
  await service.enqueue(context, {
    network: 'instagram', planningIntentId: IDS.planningIntent,
    profileId: IDS.profile, contentItemId: IDS.contentItem,
    contentVersionId: IDS.contentVersion, approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision, sourceAttestationId: IDS.attestation,
    operationTag: 'pp-calendar-instagram-1',
    idempotencyKeySha256: sha('instagram-calendar-idempotency'),
    requestSha256: sha('instagram-calendar-request'), scheduledFor,
  });
  const command = mocked.calls.find((call) => call.sql.includes('enqueue_owned_social_job_v2'));
  assert.deepEqual(command?.values, [
    IDS.workspace, IDS.connection, IDS.profile, 'instagram', IDS.planningIntent,
    IDS.contentItem, IDS.contentVersion, IDS.approvalRequest, IDS.approvalDecision,
    IDS.attestation, 'pp-calendar-instagram-1',
    Buffer.from(sha('instagram-calendar-idempotency'), 'hex'),
    Buffer.from(sha('instagram-calendar-request'), 'hex'), scheduledFor,
  ]);
});

test('cross-workspace, missing-session and malformed evidence fail before pool acquisition', async () => {
  let connections = 0;
  const service = new PgOwnedPublicSocialLiveCommandService({
    commandPool: { connect: async () => {
      connections += 1;
      throw new Error('must not connect');
    } },
    workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  const revoke = {
    profileId: IDS.profile,
    revocationEvidenceSha256: sha('revoke'),
    reasonCode: 'operator.revoked',
  };
  await assert.rejects(service.revokeProfile(
    { ...context, workspaceId: IDS.connection }, revoke,
  ), /trusted workspace/u);
  await assert.rejects(service.revokeProfile(
    { ...context, portalSessionTokenHash: undefined } as never, revoke,
  ), /portal session/u);
  await assert.rejects(service.enqueue(context, {
    profileId: IDS.profile,
    contentItemId: IDS.contentItem,
    contentVersionId: IDS.contentVersion,
    approvalRequestId: IDS.approvalRequest,
    approvalDecisionId: IDS.approvalDecision,
    sourceAttestationId: IDS.attestation,
    operationTag: 'property-predator-owned-x-v1',
    idempotencyKeySha256: 'not-a-digest',
    requestSha256: sha('request'),
    scheduledFor: null,
  }), /idempotencyKeySha256/u);
  assert.equal(connections, 0);
});

test('a mismatched record result rolls back instead of presenting success', async () => {
  const mocked = commandPool(async () => ({ rows: [{ id: IDS.job }] }));
  const service = new PgOwnedPublicSocialLiveCommandService({
    commandPool: mocked.pool,
    workspaceId: IDS.workspace,
    providerConnectionId: IDS.connection,
  });
  const envelope = encryptOwnedProfileKey({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    profileId: IDS.profile,
    profileKey: 'owned-ayrshare-profile-key-002',
    keyVersion: 'render-kms-v1',
    encryptionKey: Buffer.alloc(32, 3),
    iv: Buffer.alloc(12, 5),
  });
  await assert.rejects(service.recordProfile(context, {
    profileId: IDS.profile,
    displayName: 'Property Predator on X',
    providerProfileRefSha256: sha('provider'),
    ownedAccountRefSha256: sha('account'),
    envelope,
    xOAuthLinkEvidenceSha256: sha('oauth'),
    linkedAt: '2026-08-29T10:00:00.000Z',
    evidenceObservedAt: '2026-08-29T10:00:00.000Z',
  }), /did not match/u);
  assert.equal(mocked.calls.at(-1)?.sql, 'ROLLBACK');
});
