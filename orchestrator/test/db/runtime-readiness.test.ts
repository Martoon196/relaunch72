import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-ledger-'));
  await writeFile(path.join(directory, '0001_first.sql'), 'SELECT 1;\n', 'utf8');
  await writeFile(path.join(directory, '0002_second.sql'), 'SELECT 2;\n', 'utf8');
  return directory;
}

function runtimePool(rows: Array<{ filename: string; checksum: string }>): Pick<Pool, 'query'> {
  return {
    query: (async (sql: string) => {
      assert.equal(sql.trim(), '/* database.runtime-schema-readiness */\n     SELECT filename, checksum\n     FROM app_private.runtime_schema_migrations()');
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] } as QueryResult;
    }) as Pool['query'],
  };
}

test('least-privilege runtime readiness accepts only the exact bundled migration ledger', async () => {
  const directory = await fixtureDirectory();
  const migrations = await discoverMigrations(directory);
  const exact = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(exact), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(exact.slice(0, 1)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    { ...exact[0]!, checksum: '0'.repeat(64) }, exact[1]!,
  ]), directory), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...exact, exact[0]!]), directory), /invalid runtime migration ledger/);
});

const approvedFinance = {
  filename: '0106_finance_planning_drafts.sql',
  checksum: '422d1766390910417b397bb34607f74a56c8d7744c3f88a84c4ae46e39ae40ba',
};

async function compatibilityFixture(includeFinance = false, lastFilename = '0105_public_social_planner_session_lock.sql') {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-finance-compat-'));
  const existing = (await discoverMigrations()).slice(0, 105);
  assert.equal(existing.length, 105);
  assert.equal(existing[104]?.filename, '0105_public_social_planner_session_lock.sql');
  await Promise.all(existing.map((migration) =>
    writeFile(path.join(directory, migration.version === 105 ? lastFilename : migration.filename), migration.sql, 'utf8')));
  if (includeFinance) {
    // The known-migration path must use the bundled checksum, never the bridge
    // exception. This fixture is read as source only; no SQL is executed.
    await writeFile(path.join(directory, approvedFinance.filename), 'SELECT 106;\n', 'utf8');
  }
  const migrations = await discoverMigrations(directory);
  return { directory, rows: migrations.map(({ filename, checksum }) => ({ filename, checksum })) };
}

let bridgeFixture: ReturnType<typeof compatibilityFixture> | undefined;
function bridge() { return bridgeFixture ??= compatibilityFixture(); }

test('105 bridge is ready before finance migration with its exact existing ledger', async () => {
  const { directory, rows } = await bridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
});

test('105 bridge is ready after only the exact approved finance migration', async () => {
  const { directory, rows } = await bridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedFinance]), directory));
});

test('105 bridge rejects a different finance checksum', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, { ...approvedFinance, checksum: '0'.repeat(64) },
  ]), directory), /migration not present in this release/);
});

test('approved finance does not excuse a missing earlier migration', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, -1), approvedFinance,
  ]), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(1), approvedFinance,
  ]), directory), /not a contiguous prefix/);
});

test('approved finance does not excuse a changed earlier checksum', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    { ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approvedFinance,
  ]), directory), /checksum changed/);
});

test('105 bridge rejects unknown migration 107 even alongside approved finance', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, approvedFinance, { filename: '0107_unknown.sql', checksum: 'a'.repeat(64) },
  ]), directory), /migration not present in this release/);
});

test('105 bridge rejects duplicate finance ledger rows before compatibility handling', async () => {
  const { directory, rows } = await bridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, approvedFinance, approvedFinance,
  ]), directory), /invalid runtime migration ledger/);
});

test('finance compatibility is unavailable to a different bundled prefix', async () => {
  const directory = await fixtureDirectory();
  const rows = (await discoverMigrations(directory)).map(({ filename, checksum }) => ({ filename, checksum }));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, approvedFinance,
  ]), directory), /migration not present in this release/);
});

test('105 bridge requires the exact approved final bundled migration name', async () => {
  const { directory, rows } = await compatibilityFixture(false, '0105_other.sql');
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, approvedFinance,
  ]), directory), /migration not present in this release/);
});

test('full 106 application still requires its exact bundled finance migration', async () => {
  const { directory, rows } = await compatibilityFixture(true);
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, -1)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, -1), approvedFinance,
  ]), directory), /checksum changed/);
});

const approvedMhpGrowth = {
  filename: '0121_mhp_prospects_learning.sql',
  checksum: 'a39051a348303ffc752ed449322ffee2df5d8dbd2b1a0c49673c7c918500362f',
};

let mhpGrowthFixture: Promise<{ directory: string; rows: Array<{ filename: string; checksum: string }> }> | undefined;
function mhpGrowthBridge() {
  return mhpGrowthFixture ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-growth-compat-'));
    const bundled = await discoverMigrations();
    const existing = bundled.slice(0, 120);
    assert.equal(existing.length, 120);
    assert.equal(existing[119]?.filename, '0120_mhp_deal_desk_credit.sql');
    await Promise.all(existing.map((migration) => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
    const migrations = await discoverMigrations(directory);
    return { directory, rows: migrations.map(({ filename, checksum }) => ({ filename, checksum })) };
  })();
}

test('120 bridge accepts the exact 0120 ledger and approved 0121', async () => {
  const { directory, rows } = await mhpGrowthBridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedMhpGrowth]), directory));
});

test('120 bridge rejects a wrong 0121 checksum and an unknown 0122', async () => {
  const { directory, rows } = await mhpGrowthBridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, { ...approvedMhpGrowth, checksum: '0'.repeat(64) },
  ]), directory), /migration not present in this release/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, approvedMhpGrowth, { filename: '0122_unknown.sql', checksum: 'a'.repeat(64) },
  ]), directory), /migration not present in this release/);
});

test('approved 0121 cannot hide a missing or changed 0120 ledger row', async () => {
  const { directory, rows } = await mhpGrowthBridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, -1), approvedMhpGrowth,
  ]), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, -1), { ...rows[119]!, checksum: '0'.repeat(64) }, approvedMhpGrowth,
  ]), directory), /checksum changed/);
});

// Writes the first `count` bundled migrations to a directory, standing in for
// the release that bundled exactly those files.
async function bundleOf(count: number): Promise<string> {
  const migrations = (await discoverMigrations()).slice(0, count);
  assert.equal(migrations.length, count);
  const directory = await mkdtemp(path.join(tmpdir(), `r72-runtime-${count}-bundle-`));
  await Promise.all(migrations.map((migration) => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
  return directory;
}

test('121 release takes the strict bundled migration path', async () => {
  const allMigrations = await discoverMigrations();
  assert.ok(allMigrations.length >= 123);
  const bundle123 = await bundleOf(123);
  const migrations = allMigrations.slice(0, 122);
  assert.equal(migrations.length, 122);
  assert.equal(migrations[120]?.filename, approvedMhpGrowth.filename);
  assert.equal(migrations[120]?.checksum, approvedMhpGrowth.checksum);
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-121-compat-'));
  await Promise.all(migrations.slice(0, 121).map((migration) =>
    writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
  const rows = migrations.slice(0, 121).map(({ filename, checksum }) => ({ filename, checksum }));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, -1)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, -1), { ...approvedMhpGrowth, checksum: '0'.repeat(64) },
  ]), directory), /checksum changed/);
  const approvedSmsPhone = {
    filename: '0122_property_predator_sms_phone_verification.sql',
    checksum: '52904bc9e50db657c537f6033814455db185e30877091196b47ea586aed60e8d',
  };
  await assert.doesNotReject(assertRuntimeSchemaCurrent(
    runtimePool([...rows, approvedSmsPhone]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows, { ...approvedSmsPhone, checksum: '0'.repeat(64) },
  ]), directory), /migration not present in this release/);
  await assert.doesNotReject(assertRuntimeSchemaCurrent(
    runtimePool(migrations.map(({ filename, checksum }) => ({ filename, checksum }))), bundle123));
  await assert.rejects(assertRuntimeSchemaCurrent(
    runtimePool(rows), bundle123), /schema is behind by 2 migration/);
});

test('123 ACL repair accepts exact 122 cutover and requires the eventual exact ledger', async () => {
  const bundle123 = await bundleOf(123);
  const rows = (await discoverMigrations()).slice(0, 123).map(({ filename, checksum }) => ({ filename, checksum }));
  assert.deepEqual(rows[122], {
    filename: '0123_sms_phone_receipt_trigger_acl.sql',
    checksum: '094d3118a85131c099749ecd000c4c4b9141ea6ba00e8c643190fa5cf5a1554d',
  });
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 122)), bundle123));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), bundle123));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, 122), { ...rows[122]!, checksum: '0'.repeat(64) },
  ]), bundle123), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 121)), bundle123),
    /schema is behind by 2 migration/);
});

test('124 release takes the strict path: no cutover allowance for 0123 or 0124', async () => {
  const migrations = await discoverMigrations();
  const rows = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
  assert.equal(rows.length, 124);
  assert.equal(rows[123]?.filename, '0124_mhp_applications_events.sql');
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows)));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 123))), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 122))), /schema is behind by 2 migration/);
  // The live 0123 build does not know 0124: migrate and deploy close together.
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows), await bundleOf(123)), /migration not present in this release/);
});
