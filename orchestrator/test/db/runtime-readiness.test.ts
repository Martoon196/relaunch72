import assert from 'node:assert/strict';
import { CREATIVE_STUDIO_CHECKSUM, CREATIVE_STUDIO_MIGRATION } from '../../src/db/creative-studio-schema.js';
import { DIRECT_WA_CHECKSUM, DIRECT_WA_MIGRATION } from '../../src/db/mhp-wa-direct-schema.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool, QueryResult } from 'pg';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';
import { WEBINARS_CHECKSUM, WEBINARS_MIGRATION } from '../../src/db/webinar-schema.js';
import { GROUP_HQ_SSO_CHECKSUM, GROUP_HQ_SSO_MIGRATION } from '../../src/db/group-hq-sso-schema.js';
import { OPERATOR_OAUTH_CHECKSUM, OPERATOR_OAUTH_MIGRATION } from '../../src/db/operator-oauth-schema.js';
import { MHP_KITS_CHECKSUM, MHP_KITS_MIGRATION } from '../../src/db/mhp-kits-schema.js';

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

test('133 recovery bridge accepts only the exact additive MHP event phone 0134', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-event-compat-'));
  const prefix = (await discoverMigrations()).slice(0, 133);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
  const rows = prefix.map(({ filename, checksum }) => ({ filename, checksum }));
  assert.equal(rows.length, 133);
  assert.deepEqual(rows[132], { filename: '0133_seo_blog_social_dispatch_reservations.sql', checksum: '457402d6dc48129fe457044564a99720061bdc2e701e84ddbbb9cd957bba591f' });
  const eventPhone = { filename: '0134_mhp_event_phone_programme.sql', checksum: 'c3480208038aace2211f7a50cf64cb6cda45bedce980d274bdb661a7b9466e33' };
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, eventPhone]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { ...eventPhone, checksum: '0'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, eventPhone, { filename: '0135_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/);
  const priorChanged = rows.map((row, index) => index === 132 ? { ...row, checksum: '0'.repeat(64) } : row);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...priorChanged, eventPhone]), directory), /migration not present/);
});

test('134 recovery bridge accepts only the exact additive MHP signup handoff 0135', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-signup-compat-'));
  const prefix = (await discoverMigrations()).slice(0, 134);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
  const rows = prefix.map(({ filename, checksum }) => ({ filename, checksum }));
  assert.equal(rows.length, 134);
  assert.deepEqual(rows[133], { filename: '0134_mhp_event_phone_programme.sql', checksum: 'c3480208038aace2211f7a50cf64cb6cda45bedce980d274bdb661a7b9466e33' });
  const signup = { filename: '0135_mhp_event_phone_signup_handoff.sql', checksum: '9f73caa543ac243304063866897c4900301c4bb64bcf7f6d238cd668c8cc2be2' };
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, signup]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { ...signup, checksum: '0'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, signup, { filename: '0136_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/);
  const priorChanged = rows.map((row, index) => index === 133 ? { ...row, checksum: '0'.repeat(64) } : row);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...priorChanged, signup]), directory), /migration not present/);
});

test('final134 SMS runtime preserves SEO131–133 and strictly requires exact134', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-final134-'));
  const prefix = (await discoverMigrations()).slice(0, 134);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
  const rows = prefix.map(({ filename, checksum }) => ({ filename, checksum }));
  assert.equal(rows.length, 134);
  assert.deepEqual(rows[127], { filename: '0128_mhp_sequence_capture_entry.sql', checksum: '09b35b4eaf6e934c8f560e8d9d645bd3b9f37a34268f77f4afd974ecd1b54e97' });
  assert.deepEqual(rows[128], { filename: '0129_mhp_local_channel_drafts.sql', checksum: '649ba68b60954b6e76d4e702511321e59eff0785128051ed7b81f968abe1b57a' });
  assert.deepEqual(rows[129], { filename: '0130_mhp_owned_sms_pilot.sql', checksum: 'e6bb5be3a87e0fde3e29d3f47edde1c5daf8492f4c368f80e2e4335f5b239797' });
  assert.deepEqual(rows[130], { filename: '0131_seo_blog_engine.sql', checksum: '904c4651c51da6507370ca7eb2f271ca0347a27d76c60b0f24a19aba01695784' });
  assert.deepEqual(rows[131], { filename: '0132_seo_blog_social_promotion.sql', checksum: '6a413abf1e1f04c7ce7cfa181c2ee6c7ced7b0155fcc2c4106ff860c98fa03cb' });
  assert.deepEqual(rows[132], { filename: '0133_seo_blog_social_dispatch_reservations.sql', checksum: '457402d6dc48129fe457044564a99720061bdc2e701e84ddbbb9cd957bba591f' });
  assert.deepEqual(rows[133], { filename: '0134_mhp_event_phone_programme.sql', checksum: 'c3480208038aace2211f7a50cf64cb6cda45bedce980d274bdb661a7b9466e33' });
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 133)), directory), /schema is behind by 1 migration/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 132)), directory), /schema is behind by 2 migration/);
  for (const at of [0, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133]) {
    const corrupt = rows.map((row, index) => index === at ? { ...row, checksum: '0'.repeat(64) } : row);
    await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(corrupt), directory), /checksum changed/);
  }
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows.slice(0, 129), rows[130]!]), directory), /not a contiguous prefix/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, rows[130]!]), directory), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { filename: '0135_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/);
});

test('final135 signup handoff runtime requires exact135 and preserves prior ledger', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-signup135-'));
  const prefix = (await discoverMigrations()).slice(0,135);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory,migration.filename),migration.sql,'utf8')));
  const rows = prefix.map(({filename,checksum})=>({filename,checksum}));
  assert.equal(rows.length, 135);
  assert.deepEqual(rows[134], { filename: '0135_mhp_event_phone_signup_handoff.sql', checksum: '9f73caa543ac243304063866897c4900301c4bb64bcf7f6d238cd668c8cc2be2' });
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows),directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0, 134)),directory), /schema is behind by 1 migration/);
  const changed = rows.map((row, index) => index === 134 ? { ...row, checksum: '0'.repeat(64) } : row);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(changed),directory), /checksum changed/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { filename: '0136_unknown.sql', checksum: 'a'.repeat(64) }]),directory), /migration not present/);
});

test('135 recovery bridge accepts only exact136 and preserves all prior checks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-webinar136-compat-'));
  const prefix = (await discoverMigrations()).slice(0, 135);
  assert.equal(prefix.length, 135);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
  const rows = prefix.map(({ filename, checksum }) => ({ filename, checksum }));
  const applications = { filename: '0136_mhp_webinar_applications.sql', checksum: '9bf6605cdc536794fae989964542eb8253cdd49ebd995d3e6dd346c01c746139' };
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows), directory));
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool([...rows, applications]), directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, { ...applications, checksum: '0'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, applications, applications]), directory), /invalid runtime migration ledger/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows, applications, { filename: '0137_unknown.sql', checksum: 'a'.repeat(64) }]), directory), /migration not present/);
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows.slice(0, 134), applications]), directory), /migration not present/);
  for (const at of [0, 120, 123, 125, 126, 127, 130, 131, 132, 133, 134]) {
    const changed = rows.map((row, index) => index === at ? { ...row, checksum: '0'.repeat(64) } : row);
    await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...changed, applications]), directory), /checksum changed|migration not present/);
  }
});

test('final136 capable runtime stays strict for new applications and every historical row', async()=>{
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-mhp-applications136-'));
  const prefix = (await discoverMigrations()).slice(0,136);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory,migration.filename),migration.sql,'utf8')));
  const rows=prefix.map(({filename,checksum})=>({filename,checksum}));
  assert.equal(rows.length,136);
  assert.deepEqual(rows[135],{filename:'0136_mhp_webinar_applications.sql',checksum:'9bf6605cdc536794fae989964542eb8253cdd49ebd995d3e6dd346c01c746139'});
  await assert.doesNotReject(assertRuntimeSchemaCurrent(runtimePool(rows),directory));
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(rows.slice(0,135)),directory),/schema is behind by 1 migration/);
  for(const at of [0,120,123,125,126,127,130,131,132,133,134,135]){
    const changed=rows.map((row,index)=>index===at?{...row,checksum:'0'.repeat(64)}:row);
    await assert.rejects(assertRuntimeSchemaCurrent(runtimePool(changed),directory),/checksum changed/);
  }
  await assert.rejects(assertRuntimeSchemaCurrent(runtimePool([...rows,{filename:'0137_unknown.sql',checksum:'a'.repeat(64)}]),directory),/migration not present/);
});

test('WhatsApp141 runtime strictly requires141, defaults140, creators139, methods138 and every prior ledger row', async () => {
  // Render also runs this suite while the temporary deployment bridge is set.
  // Strict-mode assertions must not inherit that service environment.
  // Pinned to the 141 release's own bundle: later releases add migrations after it.
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-runtime-whatsapp141-'));
  const prefix = (await discoverMigrations()).slice(0, 141);
  await Promise.all(prefix.map(migration => writeFile(path.join(directory, migration.filename), migration.sql, 'utf8')));
  const assertStrictSchemaCurrent = (pool: Pick<Pool, 'query'>) => assertRuntimeSchemaCurrent(pool, directory, {});
  const rows=prefix.map(({filename,checksum})=>({filename,checksum}));
  assert.equal(rows.length,141);
  assert.deepEqual(rows[140],{filename:'0141_mhp_event_whatsapp_programme.sql',checksum:'f2a7617a925f39d41ac3a606de9f9dd864b52a2725d8ed7c89d37737c4fe747c'});
  assert.equal(rows[137]!.filename,'0138_seo_blog_method_packs.sql');
  assert.match(rows[137]!.checksum,/^[0-9a-f]{64}$/);
  assert.equal(rows[138]!.filename,'0139_method_evidence_campaign_creators.sql');
  assert.equal(rows[139]!.filename,'0140_private_method_automatic_defaults.sql');
  assert.deepEqual(rows[135],{filename:'0136_mhp_webinar_applications.sql',checksum:'9bf6605cdc536794fae989964542eb8253cdd49ebd995d3e6dd346c01c746139'});
  assert.deepEqual(rows[136],{filename:'0137_seo_blog_media_storage.sql',checksum:'ff85dc3ee825e2529333fc8efb0de070a05e43786717d9ae279aa469e41e1255'});
  await assert.doesNotReject(assertStrictSchemaCurrent(runtimePool(rows)));
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,137))),/schema is behind by 4 migration/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,138))),/schema is behind by 3 migration/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,139))),/schema is behind by 2 migration/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.filter((_,i)=>i!==135))),/not a contiguous prefix at 0137_seo_blog_media_storage.sql/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,140))),/schema is behind by 1 migration/);
  for (const at of [0,120,123,125,126,127,130,131,132,133,134,135,136,137,138,139,140]) {
    const changed=rows.map((row,index)=>index===at?{...row,checksum:'0'.repeat(64)}:row);
    await assert.rejects(assertStrictSchemaCurrent(runtimePool(changed)),/checksum changed/);
  }
  await assert.rejects(assertStrictSchemaCurrent(runtimePool([...rows,{filename:'0142_unknown.sql',checksum:'a'.repeat(64)}])),/migration not present/);
});


test('payments142 release is ready before and after its exact additive 0142, and strict otherwise', async () => {
  const prefix=(await discoverMigrations()).slice(0,142);
  const directory=await mkdtemp(path.join(tmpdir(),'r72-payments142-'));
  await Promise.all(prefix.map(m=>writeFile(path.join(directory,m.filename),m.sql,'utf8')));
  const assertStrictSchemaCurrent = (pool: Pick<Pool, 'query'>) => assertRuntimeSchemaCurrent(pool, directory, {});
  const rows=prefix.map(({filename,checksum})=>({filename,checksum}));
  assert.equal(rows.length,142);
  assert.deepEqual(rows[140],{filename:'0141_mhp_event_whatsapp_programme.sql',checksum:'f2a7617a925f39d41ac3a606de9f9dd864b52a2725d8ed7c89d37737c4fe747c'});
  assert.deepEqual(rows[141],{filename:'0142_mhp_payments_live.sql',checksum:'2f5ee2ad95de6244a080d20120b106820536eca8f0df5ca6a8a124c8e78f910d'});
  // Deployed to every consumer first: the exact 0141 ledger with only 0142 pending is ready.
  await assert.doesNotReject(assertStrictSchemaCurrent(runtimePool(rows.slice(0,141))));
  // After the migration it is strict as usual.
  await assert.doesNotReject(assertStrictSchemaCurrent(runtimePool(rows)));
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,140))),/schema is behind by 2 migration/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,137))),/schema is behind by 5 migration/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool([...rows.slice(0,141),{...rows[141]!,checksum:'0'.repeat(64)}])),/checksum changed|migration not present/);
  for (const at of [0,120,135,136,137,138,139,140]) {
    const changed=rows.slice(0,141).map((row,index)=>index===at?{...row,checksum:'0'.repeat(64)}:row);
    await assert.rejects(assertStrictSchemaCurrent(runtimePool(changed)),/checksum changed/);
  }
  await assert.rejects(assertStrictSchemaCurrent(runtimePool([...rows,{filename:'0143_unknown.sql',checksum:'a'.repeat(64)}])),/migration not present/);
});

async function prefixDirectory(count:number,label:string):Promise<string>{
  const prefix=(await discoverMigrations()).slice(0,count);
  const directory=await mkdtemp(path.join(tmpdir(),`r72-${label}-`));
  await Promise.all(prefix.map(m=>writeFile(path.join(directory,m.filename),m.sql,'utf8')));
  return directory;
}

test('MHP inbox 143 cutover and recovery accept only the exact adjacent ledgers', async()=>{
  // The exact 143-file release the MHP inbox shipped, reconstructed from today's source (later files are a separate release).
  const shipped=(await discoverMigrations()).slice(0,143);
  const bundle=await mkdtemp(path.join(tmpdir(),'r72-mhp143-'));
  await Promise.all(shipped.map(m=>writeFile(path.join(bundle,m.filename),m.sql,'utf8')));
  const rows=shipped.slice(0,142).map(({filename,checksum})=>({filename,checksum}));
  const successor={filename:'0143_mhp_whatsapp_direct_inbox.sql',checksum:'69eae7f9f1672973b6dcf72fd093922df7cf94580da9f535e063a1fa886bc42e'};
  const check=(dbRows:typeof rows)=>assertRuntimeSchemaCurrent(runtimePool(dbRows),bundle,{});
  await check(rows);
  await check([...rows,successor]);
  await assert.rejects(check([...rows,{...successor,checksum:'a'.repeat(64)}]));
  await assert.rejects(check([...rows.slice(0,-1),successor]));
  await assert.rejects(check([...rows,successor,{filename:'0144_unreviewed.sql',checksum:'a'.repeat(64)}]));
});

test('creative144 release is ready only on the exact applied MHP 0143 ledger with 0144 pending, never during the 0143 cut-over', async () => {
  const directory=await prefixDirectory(144,'creative144');
  const assertStrictSchemaCurrent = (pool: Pick<Pool, 'query'>) => assertRuntimeSchemaCurrent(pool, directory, {});
  const rows=(await discoverMigrations()).slice(0,144).map(({filename,checksum})=>({filename,checksum}));
  assert.equal(rows.length,144);
  assert.deepEqual(rows[141],{filename:'0142_mhp_payments_live.sql',checksum:'2f5ee2ad95de6244a080d20120b106820536eca8f0df5ca6a8a124c8e78f910d'});
  assert.deepEqual(rows[142],{filename:DIRECT_WA_MIGRATION,checksum:DIRECT_WA_CHECKSUM});
  assert.deepEqual(rows[143],{filename:CREATIVE_STUDIO_MIGRATION,checksum:CREATIVE_STUDIO_CHECKSUM});
  // Deployed to every consumer before 0144 is applied: exact 0143 ledger, only 0144 pending.
  await assert.doesNotReject(assertStrictSchemaCurrent(runtimePool(rows.slice(0,143))));
  await assert.doesNotReject(assertStrictSchemaCurrent(runtimePool(rows)));
  // Not a substitute for the MHP inbox cut-over: 0143 must already be applied (and 0142 before it).
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,142))),/schema is behind by 2 migration/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool(rows.slice(0,141))),/schema is behind by 3 migration/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool([...rows.slice(0,142),{...rows[142]!,checksum:'0'.repeat(64)}])),/checksum changed/);
  await assert.rejects(assertStrictSchemaCurrent(runtimePool([...rows.slice(0,143),{...rows[143]!,checksum:'0'.repeat(64)}])),/checksum changed|migration not present/);
  for (const at of [0,120,136,140,141,142]) {
    const changed=rows.slice(0,143).map((row,index)=>index===at?{...row,checksum:'0'.repeat(64)}:row);
    await assert.rejects(assertStrictSchemaCurrent(runtimePool(changed)),/checksum changed/);
  }
  await assert.rejects(assertStrictSchemaCurrent(runtimePool([...rows,{filename:'0145_unknown.sql',checksum:'a'.repeat(64)}])),/migration not present/);
});

test('webinars146 cutover and prepared limits145 recovery require the exact applied limits ledger', async()=>{
  // The exact 146-file native webinars release, reconstructed from today's source (147 is a separate release).
  const all=(await discoverMigrations()).slice(0,146).map(({filename,checksum})=>({filename,checksum}));
  assert.equal(all.length,146);
  assert.equal(all[144]!.filename,'0145_seo_owner_limits.sql');
  assert.equal(all[144]!.checksum,'5cfa689e208bb4cf2197451dd04b00d2a214e1368887106e005b2e26e0a664df');
  assert.deepEqual(all[145],{filename:WEBINARS_MIGRATION,checksum:WEBINARS_CHECKSUM});
  const through145=all.slice(0,145), native=all[145]!;
  const releaseDir=await prefixDirectory(146,'native146-release');
  const capable=(rows:typeof all)=>assertRuntimeSchemaCurrent(runtimePool(rows),releaseDir,{});
  await capable(through145); await capable(all);
  await assert.rejects(capable(all.slice(0,144)),/schema is behind by 2/);
  await assert.rejects(capable([...through145,{...native,checksum:'0'.repeat(64)}]),/checksum changed/);
  await assert.rejects(capable([...all.slice(0,144),native]),/not a contiguous prefix|behind/);
  const recoveryDir=await prefixDirectory(145,'limits145-native146-recovery');
  const recovery=(rows:typeof all)=>assertRuntimeSchemaCurrent(runtimePool(rows),recoveryDir,{});
  await recovery(through145); await recovery(all);
  await assert.rejects(recovery([...through145,{...native,checksum:'0'.repeat(64)}]),/migration not present/);
  await assert.rejects(recovery([...all.slice(0,144),native]),/migration not present|not a contiguous prefix/);
  for(const at of [0,120,136,140,141,142,143,144]) {
    const changed=all.map((r,i)=>i===at?{...r,checksum:'0'.repeat(64)}:r);
    await assert.rejects(capable(changed),/checksum changed/);
    await assert.rejects(recovery(changed),/checksum changed|migration not present/);
  }
  await assert.rejects(capable([...all,{filename:'0147_unknown.sql',checksum:'a'.repeat(64)}]),/migration not present/);
  await assert.rejects(recovery([...all,{filename:'0147_unknown.sql',checksum:'a'.repeat(64)}]),/migration not present/);
  // The released 146 binary stays ready once exactly the reviewed Group HQ 147 is applied, and nothing else.
  const ghq=(await discoverMigrations())[146]!;
  assert.deepEqual({filename:ghq.filename,checksum:ghq.checksum},{filename:GROUP_HQ_SSO_MIGRATION,checksum:GROUP_HQ_SSO_CHECKSUM});
  await capable([...all,{filename:ghq.filename,checksum:ghq.checksum}]);
  await assert.rejects(capable([...all,{filename:ghq.filename,checksum:'0'.repeat(64)}]),/migration not present/);
  await assert.rejects(capable([...through145,{filename:ghq.filename,checksum:ghq.checksum}]),/migration not present|not a contiguous prefix/);
});

test('Group HQ 147 cutover requires the exact applied native146 ledger and nothing beyond it', async()=>{
  // The exact 147-file Group HQ release, reconstructed from today's source (148 is a separate release).
  const all=(await discoverMigrations()).slice(0,147).map(({filename,checksum})=>({filename,checksum}));
  assert.equal(all.length,147);
  assert.deepEqual(all[145],{filename:WEBINARS_MIGRATION,checksum:WEBINARS_CHECKSUM});
  assert.deepEqual(all[146],{filename:GROUP_HQ_SSO_MIGRATION,checksum:GROUP_HQ_SSO_CHECKSUM});
  const through146=all.slice(0,146), ghq=all[146]!;
  const releaseDir=await prefixDirectory(147,'ghq147-release');
  const capable=(rows:typeof all)=>assertRuntimeSchemaCurrent(runtimePool(rows),releaseDir,{});
  await capable(through146); await capable(all);
  await assert.rejects(capable(all.slice(0,145)),/schema is behind by 2/);
  await assert.rejects(capable([...through146,{...ghq,checksum:'0'.repeat(64)}]),/checksum changed/);
  await assert.rejects(capable([...all.slice(0,145),ghq]),/not a contiguous prefix|behind/);
  for(const at of [0,120,140,144,145]) {
    const changed=all.map((r,i)=>i===at?{...r,checksum:'0'.repeat(64)}:r);
    await assert.rejects(capable(changed),/checksum changed/);
  }
  await assert.rejects(capable([...all,{filename:'0148_unknown.sql',checksum:'a'.repeat(64)}]),/migration not present/);
  // The released 147 binary stays ready once exactly the reviewed operator OAuth 148 is applied, and nothing else.
  const oauth=(await discoverMigrations())[147]!;
  assert.deepEqual({filename:oauth.filename,checksum:oauth.checksum},{filename:OPERATOR_OAUTH_MIGRATION,checksum:OPERATOR_OAUTH_CHECKSUM});
  await capable([...all,{filename:oauth.filename,checksum:oauth.checksum}]);
  await assert.rejects(capable([...all,{filename:oauth.filename,checksum:'0'.repeat(64)}]),/migration not present/);
  await assert.rejects(capable([...through146,{filename:oauth.filename,checksum:oauth.checksum}]),/migration not present|not a contiguous prefix/);
});

test('module kits 149 cutover requires the exact applied operator OAuth 148 ledger and nothing beyond it', async()=>{
  const all=(await discoverMigrations()).map(({filename,checksum})=>({filename,checksum}));
  assert.equal(all.length,149);
  assert.deepEqual(all[147],{filename:OPERATOR_OAUTH_MIGRATION,checksum:OPERATOR_OAUTH_CHECKSUM});
  assert.deepEqual(all[148],{filename:MHP_KITS_MIGRATION,checksum:MHP_KITS_CHECKSUM});
  const through148=all.slice(0,148), kits=all[148]!;
  const capable=(rows:typeof all)=>assertRuntimeSchemaCurrent(runtimePool(rows),undefined,{});
  await capable(through148); await capable(all);
  await assert.rejects(capable(all.slice(0,147)),/schema is behind by 2/);
  await assert.rejects(capable([...through148,{...kits,checksum:'0'.repeat(64)}]),/checksum changed/);
  await assert.rejects(capable([...all.slice(0,147),kits]),/not a contiguous prefix|behind/);
  await assert.rejects(capable([...all,{filename:'0150_unknown.sql',checksum:'a'.repeat(64)}]),/migration not present/);
});

test('operator OAuth 148 binary stays ready after the exact additive kits 149 and nothing else', async()=>{
  const directory=await prefixDirectory(148,'oauth148-historical');
  const all=(await discoverMigrations()).map(({filename,checksum})=>({filename,checksum}));
  const rows=all.slice(0,148);
  const check=(r:typeof rows)=>assertRuntimeSchemaCurrent(runtimePool(r),directory,{});
  await check(rows);
  await check([...rows,all[148]!]);
  await assert.rejects(check([...rows,{...all[148]!,checksum:'0'.repeat(64)}]),/checksum changed|migration not present/);
  await assert.rejects(check([...rows,{filename:'0150_unknown.sql',checksum:'a'.repeat(64)}]),/migration not present/);
});

test('operator OAuth 148 cutover requires the exact applied Group HQ 147 ledger and nothing beyond it', async()=>{
  const all=(await discoverMigrations()).slice(0,148).map(({filename,checksum})=>({filename,checksum}));
  const directory=await prefixDirectory(148,'oauth148-cutover');
  assert.equal(all.length,148);
  assert.deepEqual(all[146],{filename:GROUP_HQ_SSO_MIGRATION,checksum:GROUP_HQ_SSO_CHECKSUM});
  assert.deepEqual(all[147],{filename:OPERATOR_OAUTH_MIGRATION,checksum:OPERATOR_OAUTH_CHECKSUM});
  const through147=all.slice(0,147), oauth=all[147]!;
  const capable=(rows:typeof all)=>assertRuntimeSchemaCurrent(runtimePool(rows),directory,{});
  await capable(through147); await capable(all);
  await assert.rejects(capable(all.slice(0,146)),/schema is behind by 2/);
  await assert.rejects(capable([...through147,{...oauth,checksum:'0'.repeat(64)}]),/checksum changed/);
  await assert.rejects(capable([...all.slice(0,146),oauth]),/not a contiguous prefix|behind/);
  for(const at of [0,120,144,145,146]) {
    const changed=all.map((r,i)=>i===at?{...r,checksum:'0'.repeat(64)}:r);
    await assert.rejects(capable(changed),/checksum changed/);
  }
  await assert.rejects(capable([...all,{filename:'0149_unknown.sql',checksum:'a'.repeat(64)}]),/migration not present/);
});

test('owner limits 145 accepts only the exact applied Studio 144 ledger or its full successor', async()=>{
  const directory=await prefixDirectory(145,'limits145-historical');
  const rows=(await discoverMigrations()).slice(0,145).map(({filename,checksum})=>({filename,checksum}));
  assert.equal(rows.length,145);
  const check=(r:typeof rows)=>assertRuntimeSchemaCurrent(runtimePool(r),directory,{});
  await check(rows.slice(0,144));
  await check(rows);
  await assert.rejects(check(rows.slice(0,143)),/schema is behind by 2/);
  for(const at of [0,136,142,143,144]) {
    const changed=rows.map((r,i)=>i===at?{...r,checksum:'0'.repeat(64)}:r);
    await assert.rejects(check(changed),/checksum changed/);
  }
  await assert.rejects(check([...rows,{filename:'0146_unknown.sql',checksum:'a'.repeat(64)}]),/migration not present/);
});
