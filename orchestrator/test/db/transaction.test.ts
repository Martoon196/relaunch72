import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { requestDatabaseContext, workerDatabaseContext } from '../../src/db/rls.js';
import { InactivePortalSessionError, withTransaction } from '../../src/db/transaction.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

class FakeClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  released = false;
  releaseArgument: boolean | Error | undefined;
  failOn?: string;
  failRollback = false;
  sessionActive = true;

  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.calls.push({ sql, values });
    if (this.failRollback && sql === 'ROLLBACK') throw new Error('failed: ROLLBACK');
    if (this.failOn && sql.includes(this.failOn)) throw new Error(`failed: ${this.failOn}`);
    const rows = sql.includes('portal_session') ? [{ active: this.sessionActive }] : [];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }

  release(error?: boolean | Error): void {
    this.released = true;
    this.releaseArgument = error;
  }
}

function fakePool(client: FakeClient): Pick<Pool, 'connect'> {
  return {
    connect: async () => client as unknown as PoolClient,
  } as Pick<Pool, 'connect'>;
}

test('withTransaction installs RLS context before domain SQL and commits', async () => {
  const client = new FakeClient();
  const result = await withTransaction(
    fakePool(client),
    requestDatabaseContext({ workspaceId: WORKSPACE_ID, userId: USER_ID, requestId: 'request-42' }),
    async (transaction) => {
      await transaction.query('SELECT id FROM app.workspaces');
      return 'done';
    },
    { isolation: 'serializable' },
  );

  assert.equal(result, 'done');
  assert.match(client.calls[0]!.sql, /^BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE$/);
  assert.match(client.calls[1]!.sql, /set_config\('app\.workspace_id', \$2, true\)/);
  assert.deepEqual(client.calls[1]!.values, [USER_ID, WORKSPACE_ID, 'user', 'request-42']);
  assert.equal(client.calls[2]!.sql, 'SELECT id FROM app.workspaces');
  assert.equal(client.calls[3]!.sql, 'COMMIT');
  assert.equal(client.released, true);
  assert.equal(client.releaseArgument, false);
});

test('worker context writes an empty user setting and read-only mode is explicit', async () => {
  const client = new FakeClient();
  await withTransaction(
    fakePool(client),
    workerDatabaseContext({ workspaceId: WORKSPACE_ID, requestId: 'job-9' }),
    async () => undefined,
    { readOnly: true, isolation: 'repeatable read' },
  );
  assert.equal(client.calls[0]!.sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(client.calls[1]!.values, ['', WORKSPACE_ID, 'worker', 'job-9']);
});

test('portal contexts revalidate the exact session inside each read or write transaction', async () => {
  const sessionHash = Buffer.alloc(32, 7);
  for (const readOnly of [true, false]) {
    const client = new FakeClient();
    await withTransaction(
      fakePool(client),
      requestDatabaseContext({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        requestId: readOnly ? 'portal-read' : 'portal-write',
        portalSessionTokenHash: sessionHash,
      }),
      async (transaction) => { await transaction.query('domain operation'); },
      { readOnly },
    );
    assert.match(client.calls[1]!.sql, readOnly
      ? /active_portal_session/
      : /lock_active_portal_session/);
    assert.deepEqual(client.calls[1]!.values, [sessionHash, USER_ID, WORKSPACE_ID]);
    assert.match(client.calls[2]!.sql, /set_config/);
    assert.equal(client.calls[3]!.sql, 'domain operation');
  }
});

test('an inactive portal session rolls back before RLS context or domain SQL is used', async () => {
  const client = new FakeClient();
  client.sessionActive = false;
  await assert.rejects(
    withTransaction(
      fakePool(client),
      requestDatabaseContext({
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        requestId: 'revoked-session',
        portalSessionTokenHash: Buffer.alloc(32, 8),
      }),
      async (transaction) => { await transaction.query('must not run'); },
    ),
    InactivePortalSessionError,
  );
  assert.equal(client.calls.some((call) => call.sql.includes('set_config')), false);
  assert.equal(client.calls.some((call) => call.sql === 'must not run'), false);
  assert.equal(client.calls.at(-1)!.sql, 'ROLLBACK');
});

test('withTransaction rolls back and releases on domain or commit failure', async () => {
  for (const failOn of ['domain operation', 'COMMIT']) {
    const client = new FakeClient();
    client.failOn = failOn;
    await assert.rejects(
      withTransaction(
        fakePool(client),
        requestDatabaseContext({ workspaceId: WORKSPACE_ID, userId: USER_ID, requestId: 'request-fail' }),
        async (transaction) => {
          await transaction.query('domain operation');
        },
      ),
      new RegExp(`failed: ${failOn}`),
    );
    assert.equal(client.calls.at(-1)!.sql, 'ROLLBACK');
    assert.equal(client.released, true);
    assert.equal(client.releaseArgument, false);
  }
});

test('a client whose rollback fails is destroyed instead of returning to the tenant pool', async () => {
  const client = new FakeClient();
  client.failOn = 'domain operation';
  client.failRollback = true;
  await assert.rejects(
    withTransaction(
      fakePool(client),
      requestDatabaseContext({ workspaceId: WORKSPACE_ID, userId: USER_ID, requestId: 'rollback-fail' }),
      async (transaction) => {
        await transaction.query('domain operation');
      },
    ),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(client.released, true);
  assert.equal(client.releaseArgument, true);
});

test('invalid context fails before a pool client is acquired', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('must not connect'); } } as Pick<Pool, 'connect'>;
  for (const [context, expected] of [
    [{ actorKind: 'user', workspaceId: 'caller-controlled-garbage', requestId: 'r' }, /workspaceId must be a UUID/],
    [{ actorKind: 'hacker', workspaceId: WORKSPACE_ID, requestId: 'r' }, /actorKind must be user, worker, webhook or system/],
    [{ actorKind: 'worker', workspaceId: WORKSPACE_ID, userId: USER_ID, requestId: 'r' }, /non-user database context must not carry userId/],
    [{ actorKind: 'user', workspaceId: WORKSPACE_ID, userId: USER_ID, requestId: 'r', portalSessionTokenHash: Buffer.alloc(31) }, /32-byte Buffer/],
    [{ actorKind: 'worker', workspaceId: WORKSPACE_ID, requestId: 'r', portalSessionTokenHash: Buffer.alloc(32) }, /Only a user database context/],
  ] as const) {
    await assert.rejects(
      withTransaction(
        pool,
        context as never,
        async () => undefined,
      ),
      expected,
    );
  }
  assert.equal(connected, false);
});
