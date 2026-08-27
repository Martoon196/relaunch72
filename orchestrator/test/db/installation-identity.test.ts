import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { assertExpectedDatabaseInstallation } from '../../src/db/installation-identity.js';

const EXPECTED = '8ec0c86f-6e5a-4f11-bcb4-b5798c9885f2';
const PRODUCTION_ROLES = [
  'r72_web',
  'r72_identity_command',
  'r72_crm_command',
  'r72_content_command',
  'r72_mailgun_webhook_command',
  'r72_mailgun_worker_command',
  'r72_test_inbox_webhook_command',
] as const;

function installationPool(
  rows: Array<{ installationId: unknown }>,
  observe?: (sql: string) => void,
): Pick<Pool, 'query'> {
  return {
    query: (async (sql: string) => {
      observe?.(sql);
      return {
        rows,
        rowCount: rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as QueryResult;
    }) as Pool['query'],
  };
}

test('installation identity accepts one exact UUID through the function-only query', async () => {
  let sql = '';
  await assert.doesNotReject(assertExpectedDatabaseInstallation(
    installationPool([{ installationId: EXPECTED }], (query) => { sql = query; }),
    EXPECTED,
  ));
  assert.match(sql, /SELECT app_private\.runtime_database_installation_id\(\)::text/);
  assert.doesNotMatch(sql, /database_installation_identity/);
  assert.equal(sql.includes(EXPECTED), false);
});

test('all seven runtime role pools can be pinned independently to one expected UUID', async () => {
  const queried: string[] = [];
  await Promise.all(PRODUCTION_ROLES.map(async (role) => {
    await assertExpectedDatabaseInstallation(
      installationPool([{ installationId: EXPECTED }], () => { queried.push(role); }),
      EXPECTED,
    );
  }));
  assert.deepEqual(queried.sort(), [...PRODUCTION_ROLES].sort());
});

test('installation identity requires a canonical expected UUID before querying', async () => {
  let queries = 0;
  const pool = installationPool(
    [{ installationId: EXPECTED }],
    () => { queries += 1; },
  );
  for (const value of [
    undefined,
    '',
    '8EC0C86F-6E5A-4F11-BCB4-B5798C9885F2',
    'postgresql://r72_web:secret@example.invalid/growth_hq',
  ]) {
    await assert.rejects(
      assertExpectedDatabaseInstallation(pool, value),
      /Expected database installation UUID is required/,
    );
  }
  assert.equal(queries, 0);
});

test('installation identity fails closed on missing, malformed, or different evidence', async () => {
  for (const rows of [
    [],
    [{ installationId: null }],
    [{ installationId: 'not-a-uuid' }],
    [{ installationId: EXPECTED }, { installationId: EXPECTED }],
  ]) {
    await assert.rejects(
      assertExpectedDatabaseInstallation(installationPool(rows), EXPECTED),
      /Database installation identity could not be verified/,
    );
  }

  const actual = 'c08017df-d03c-481a-8f36-2efdb1c3071b';
  await assert.rejects(
    assertExpectedDatabaseInstallation(
      installationPool([{ installationId: actual }]),
      EXPECTED,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Database installation identity mismatch');
      assert.equal(error.message.includes(EXPECTED), false);
      assert.equal(error.message.includes(actual), false);
      return true;
    },
  );
});

test('installation identity discards database errors that may contain credentials', async () => {
  const secret = 'postgresql://r72_web:do-not-leak@example.invalid/growth_hq';
  const pool = {
    query: async () => { throw new Error(secret); },
  } as unknown as Pick<Pool, 'query'>;

  await assert.rejects(
    assertExpectedDatabaseInstallation(pool, EXPECTED),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Database installation identity could not be verified');
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
