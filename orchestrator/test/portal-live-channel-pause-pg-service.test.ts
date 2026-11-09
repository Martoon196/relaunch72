import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PgPortalLiveChannelPauseService } from '../src/portal/live-channel-pause-pg-service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const identity = { sessionToken: 'opaque-portal-session', requestId: 'live-pause-request' };
type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

function service(disposition: unknown = 'engaged') {
  const calls: Call[] = [];
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
        || sql.includes("set_config('app.user_id'")) return { rows: [] };
    if (sql.includes('lock_active_portal_session')) return { rows: [{ active: true }] };
    return { rows: [{ disposition }] };
  }, release() {} } as unknown as PoolClient;
  return { calls, service: new PgPortalLiveChannelPauseService({
    principalResolver: { resolve: async () => ({ userId: USER, workspaceId: WORKSPACE }) },
    commandPool: { connect: async () => client },
  }) };
}

test('pause service engages one exact scope under the active portal command identity', async () => {
  const mocked = service();
  assert.deepEqual(await mocked.service.engage(identity, { scope: 'sms', commandKey: KEY }), {
    ok: true, disposition: 'engaged', scope: 'sms',
  });
  const command = mocked.calls.find((call) =>
    call.sql.includes('engage_property_predator_live_channel_pause'))!;
  assert.deepEqual(command.values.slice(0, 1), [WORKSPACE]);
  assert.equal(Buffer.isBuffer(command.values[1]), true);
  assert.equal((command.values[1] as Buffer).length, 32);
  assert.deepEqual(command.values.slice(2), ['sms', KEY]);
  assert.match(mocked.calls[0]?.sql ?? '', /SERIALIZABLE READ WRITE/u);
  assert.equal(mocked.calls.at(-1)?.sql, 'COMMIT');
});

test('pause service preserves replay and rejects invalid input before SQL', async () => {
  const replay = service('replayed');
  assert.deepEqual(await replay.service.engage(identity, { scope: 'all', commandKey: KEY }), {
    ok: true, disposition: 'replayed', scope: 'all',
  });
  const invalid = service();
  assert.deepEqual(await invalid.service.engage(identity, {
    scope: 'sms', commandKey: 'not-a-uuid',
  }), { ok: false, kind: 'validation' });
  assert.equal(invalid.calls.length, 0);
});

test('pause service maps database denial safely and exposes no release method', async () => {
  const client = { async query(sql: string) {
    if (/^(?:BEGIN|ROLLBACK)/u.test(sql) || sql.includes("set_config('app.user_id'")) {
      return { rows: [] };
    }
    if (sql.includes('lock_active_portal_session')) return { rows: [{ active: true }] };
    throw Object.assign(new Error('private detail'), { code: '42501' });
  }, release() {} } as unknown as PoolClient;
  const boundary = new PgPortalLiveChannelPauseService({
    principalResolver: { resolve: async () => ({ userId: USER, workspaceId: WORKSPACE }) },
    commandPool: { connect: async () => client },
  });
  assert.deepEqual(await boundary.engage(identity, { scope: 'customer_email', commandKey: KEY }),
    { ok: false, kind: 'forbidden' });
  assert.equal('release' in boundary, false);
  assert.equal('resume' in boundary, false);
});
