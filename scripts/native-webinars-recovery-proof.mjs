// Exact prepared 0144 recovery source against disposable 0145; never remote/live.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1'].includes(url.hostname));
assert.equal(url.pathname, '/relaunch72_test');
assert.equal(process.env.RELAUNCH72_DATABASE_INTEGRATION, 'explicit-disposable-run');
const root = path.resolve('recovery-source');
const { assertRuntimeSchemaCurrent } = await import(pathToFileURL(path.join(root, 'orchestrator/src/db/runtime-readiness.ts')).href);
const migrationDir = path.join(root, 'orchestrator/src/db/migrations');
const admin = new pg.Pool({ connectionString: url.toString(), max: 1 });
const password = randomUUID() + randomUUID();
let runtime;
try {
  const sql = await admin.query('SELECT format(\'ALTER ROLE r72_web PASSWORD %L\', $1::text) AS sql', [password]);
  await admin.query(sql.rows[0].sql);
  url.username = 'r72_web'; url.password = password;
  runtime = new pg.Pool({ connectionString: url.toString(), max: 1 });
  await assertRuntimeSchemaCurrent(runtime, migrationDir, {});
  const { rows } = await runtime.query('SELECT filename,checksum FROM app_private.runtime_schema_migrations() ORDER BY filename');
  assert.equal(rows.length, 145);
  assert.equal(rows.at(-1).filename, '0145_native_webinars.sql');
  const changed = rows.map((r, i) => i === 144 ? { ...r, checksum: '0'.repeat(64) } : r);
  await assert.rejects(assertRuntimeSchemaCurrent({ query: async () => ({ rows: changed }) }, migrationDir, {}));
  await assert.rejects(assertRuntimeSchemaCurrent({ query: async () => ({ rows: [...rows, { filename: '0146_unreviewed.sql', checksum: 'a'.repeat(64) }] }) }, migrationDir, {}));
  console.log(JSON.stringify({ proof: 'prepared144RecoveryOnExact145', actualRuntimeRole: 'r72_web', assertions: 3, pass: 3, fail: 0, skipped: 0, production: false }));
} finally {
  await runtime?.end();
  await admin.end();
}
