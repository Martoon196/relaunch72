import assert from 'node:assert/strict';
import test from 'node:test';
import { PgOwnedPublicSocialLiveRepository } from '../src/owned-public-social-pg/repository.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';

test('repository keeps every SQL operation bound to its constructor workspace and connection', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const commandPool = {
    async connect() {
      return {
        async query(sql: string, values: unknown[] = []) {
          calls.push({ sql, values });
          return sql.includes('claim_owned_social_job')
            ? { rows: [{ jobId: JOB, profileId: PROFILE, leaseVersion: '1', attemptKind: 'publish' }] }
            : { rows: [] };
        },
        release() { return undefined; },
      };
    },
  };
  const repository = new PgOwnedPublicSocialLiveRepository(commandPool as never, {
    workspaceId: WORKSPACE, connectionId: CONNECTION,
  });
  const lease = Buffer.alloc(32, 1);
  const claim = await repository.claimOne({ leaseToken: lease, leaseSeconds: 60 });
  assert.equal(claim?.workspaceId, WORKSPACE);
  assert.equal(claim?.connectionId, CONNECTION);
  assert.match(calls[0]?.sql ?? '', /BEGIN/u);
  assert.deepEqual(calls[1]?.values, ['', WORKSPACE, 'worker', `owned-social:claim:${CONNECTION}`]);
  const domain = calls.find((call) => call.sql.includes('claim_owned_social_job'));
  assert.deepEqual(domain?.values.slice(0, 2), [WORKSPACE, CONNECTION]);
  assert.match(calls.at(-1)?.sql ?? '', /COMMIT/u);
});

test('repository rejects cross-workspace claims before touching SQL', async () => {
  let called = false;
  const repository = new PgOwnedPublicSocialLiveRepository({
    async connect() { called = true; throw new Error('must not connect'); },
  } as never, { workspaceId: WORKSPACE, connectionId: CONNECTION });
  await assert.rejects(repository.markCalling({
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    connectionId: CONNECTION, profileId: PROFILE, jobId: JOB,
    leaseVersion: 1, attemptKind: 'publish', leaseToken: Buffer.alloc(32),
    providerEffectsEnabled: true, emergencyPaused: false,
  }));
  assert.equal(called, false);
});
