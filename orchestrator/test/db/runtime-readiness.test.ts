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

test('121 release takes the strict bundled migration path', async () => {
  const allMigrations = await discoverMigrations();
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
  const previousRelease = await marketingBridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(
    runtimePool(migrations.map(({ filename, checksum }) => ({ filename, checksum }))), previousRelease.directory));
  await assert.rejects(assertRuntimeSchemaCurrent(
    runtimePool(rows), previousRelease.directory), /schema is behind by 2 migration/);
});

test('123 ACL repair accepts exact 122 cutover and requires the eventual exact ledger', async () => {
  const { rows, directory } = await marketingBridge();
  assert.equal(rows.length, 123);
  assert.deepEqual(rows[122], {
    filename: '0123_sms_phone_receipt_trigger_acl.sql',
    checksum: '094d3118a85131c099749ecd000c4c4b9141ea6ba00e8c643190fa5cf5a1554d',
  });
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 122)), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, 122), { ...rows[122]!, checksum: '0'.repeat(64) },
  ]), directory), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 121)), directory),
    /schema is behind by 2 migration/);
});

const approvedMarketing = {
  filename: '0124_mhp_brand_marketing_workspace.sql',
  checksum: '6d17547dc37070b736f23e2a7906dc40739b66c50de262eacdbe9ace7e011209',
};
let marketingFixture: Promise<{ directory: string; rows: Array<{ filename: string; checksum: string }> }> | undefined;
function marketingBridge() {
  return marketingFixture ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-marketing-compat-'));
    const prefix = (await discoverMigrations()).slice(0, 123);
    assert.equal(prefix.length, 123);
    await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
    return { directory, rows: prefix.map(({ filename, checksum }) => ({ filename, checksum })) };
  })();
}

test('123 marketing bridge accepts exact123 and only the approved124 ledger', async () => {
  const { directory, rows } = await marketingBridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedMarketing]), directory));
});

test('123 marketing bridge rejects wrong124 checksum, duplicate124 and unknown125', async () => {
  const { directory, rows } = await marketingBridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows,
    { ...approvedMarketing, checksum: '0'.repeat(64) }]), directory), /migration not present in this release/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedMarketing, approvedMarketing]), directory), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedMarketing,
    { filename: '0125_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present in this release/);
});

test('marketing124 cannot hide a missing123, changed prefix or non-contiguous ledger', async () => {
  const { directory, rows } = await marketingBridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows.slice(0, 122), approvedMarketing]), directory), /migration not present in this release/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    { ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approvedMarketing]), directory), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows.slice(1), approvedMarketing]), directory), /not a contiguous prefix/);
});

test('marketing bridge requires the exact bundled123 tail and is unavailable to other releases', async () => {
  const { rows } = await marketingBridge();
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-marketing-wrong-tail-'));
  const prefix = (await discoverMigrations()).slice(0, 123);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename),
    migration.version === 123 ? 'SELECT 123;\n' : migration.sql, 'utf8')));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedMarketing]), directory), /checksum changed|migration not present/);
  const unrelated = await fixtureDirectory();
  const unrelatedRows = (await discoverMigrations(unrelated)).map(({ filename, checksum }) => ({ filename, checksum }));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...unrelatedRows, approvedMarketing]), unrelated), /migration not present/);
});

test('final124 application strictly requires its exact bundled124 and all earlier migrations', async () => {
  const { directory, rows } = await webinarBridge();
  assert.equal(rows.length, 124);
  assert.deepEqual(rows[123], approvedMarketing);
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 123)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 122)), directory), /schema is behind by 2 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([
    ...rows.slice(0, 123), { ...approvedMarketing, checksum: '0'.repeat(64) }]), directory), /checksum changed/);
});

const approvedWebinarReader = {
  filename: '0125_mhp_webinar_lead_candidates.sql',
  checksum: '91bd726210fe34fa4edf46565f6c5f48d9005a6a177d735d808101d44f41c259',
};
let webinarFixture: Promise<{ directory: string; rows: Array<{ filename: string; checksum: string }> }> | undefined;
function webinarBridge() {
  return webinarFixture ??= (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-webinar-compat-'));
    const prefix = (await discoverMigrations()).slice(0, 124);
    assert.equal(prefix.length, 124);
    await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
    return { directory, rows: prefix.map(({ filename, checksum }) => ({ filename, checksum })) };
  })();
}

test('124 reader bridge accepts exact124 and exact125 while rejecting changed, duplicate and future rows', async () => {
  const { directory, rows } = await webinarBridge();
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedWebinarReader]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { ...approvedWebinarReader, checksum: '0'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedWebinarReader, approvedWebinarReader]), directory), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedWebinarReader, { filename: '0126_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/);
});

test('reader125 cannot hide missing124 or corrupt earlier ledger rows', async () => {
  const { directory, rows } = await webinarBridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows.slice(0, 123), approvedWebinarReader]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1), approvedWebinarReader]), directory), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows.slice(1), approvedWebinarReader]), directory), /not a contiguous prefix/);
});

test('reader125 bridge is unavailable to the old123 prefix', async () => {
  const { directory, rows } = await marketingBridge();
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, approvedMarketing, approvedWebinarReader]), directory), /migration not present/);
});

test('final133 SEO social runtime strictly requires exact133 and every earlier migration', async () => {
  const rows = (await discoverMigrations()).map(({ filename, checksum }) => ({ filename, checksum }));
  assert.equal(rows.length, 133);
  assert.deepEqual(rows[127], { filename: '0128_mhp_sequence_capture_entry.sql', checksum: '09b35b4eaf6e934c8f560e8d9d645bd3b9f37a34268f77f4afd974ecd1b54e97' });
  assert.deepEqual(rows[128], { filename: '0129_mhp_local_channel_drafts.sql', checksum: '649ba68b60954b6e76d4e702511321e59eff0785128051ed7b81f968abe1b57a' });
  assert.deepEqual(rows[129], { filename: '0130_mhp_owned_sms_pilot.sql', checksum: 'e6bb5be3a87e0fde3e29d3f47edde1c5daf8492f4c368f80e2e4335f5b239797' });
  assert.deepEqual(rows[130], { filename: '0131_seo_blog_engine.sql', checksum: '904c4651c51da6507370ca7eb2f271ca0347a27d76c60b0f24a19aba01695784' });
  assert.deepEqual(rows[131], { filename: '0132_seo_blog_social_promotion.sql', checksum: '6a413abf1e1f04c7ce7cfa181c2ee6c7ced7b0155fcc2c4106ff860c98fa03cb' });
  assert.deepEqual(rows[132], { filename: '0133_seo_blog_social_dispatch_reservations.sql', checksum: '457402d6dc48129fe457044564a99720061bdc2e701e84ddbbb9cd957bba591f' });
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows)));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 132))), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 131))), /schema is behind by 2 migration/);
  for (const at of [0, 124, 125, 126, 127, 128, 129, 130, 131, 132]) {
    const corrupt = rows.map((row, index) => index === at ? { ...row, checksum: '0'.repeat(64) } : row);
    await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(corrupt)), /checksum changed/);
  }
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows.slice(0, 129), rows[130]!])), /not a contiguous prefix/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, rows[130]!])), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { filename: '0134_unknown.sql', checksum: 'a'.repeat(64) }])), /migration not present/);
});

test('133 recovery bridge accepts only the exact additive MHP event phone 0134', async () => {
  const rows = (await discoverMigrations()).map(({ filename, checksum }) => ({ filename, checksum }));
  assert.equal(rows.length, 133);
  assert.deepEqual(rows[132], { filename: '0133_seo_blog_social_dispatch_reservations.sql', checksum: '457402d6dc48129fe457044564a99720061bdc2e701e84ddbbb9cd957bba591f' });
  const eventPhone = { filename: '0134_mhp_event_phone_programme.sql', checksum: 'c3480208038aace2211f7a50cf64cb6cda45bedce980d274bdb661a7b9466e33' };
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows)));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, eventPhone])));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { ...eventPhone, checksum: '0'.repeat(64) }])), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, eventPhone, { filename: '0135_unknown.sql', checksum: 'a'.repeat(64) }])), /migration not present/);
  const priorChanged = rows.map((row, index) => index === 132 ? { ...row, checksum: '0'.repeat(64) } : row);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...priorChanged, eventPhone])), /migration not present/);
});
