import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverMigrations } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';
import { MHP_WHATSAPP_MIGRATION, MHP_WHATSAPP_MIGRATION_SHA } from '../../src/db/mhp-whatsapp-schema-bridge.js';
import { assertMetaWhatsAppLiveCommandBoundaryReady, assertMetaWhatsAppLiveWorkerBoundaryReady, assertMetaWhatsAppLiveWebhookBoundaryReady } from '../../src/whatsapp-live-pg/readiness.js';

const directory = fileURLToPath(new URL('../../src/db/migrations/', import.meta.url));
const next = { filename: MHP_WHATSAPP_MIGRATION, checksum: MHP_WHATSAPP_MIGRATION_SHA };
test('140 recovery accepts exact140 and exact141 only; gaps, unknown rows and checksum drift remain errors', async () => {
  const migrations = await discoverMigrations(directory);
  assert.equal(migrations.length, 140);
  const base = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
  const probe = (rows: typeof base) => assertRuntimeSchemaCurrent({ query: async () => ({ rows }) } as never, directory, {});
  await probe(base); await probe([...base, next]);
  for (const rows of [[...base, { ...next, checksum: 'ff'.repeat(32) }], [...base.slice(0, 139), next],
    [...base, next, { filename: '0142_unknown.sql', checksum: 'ff'.repeat(32) }],
    [...base.slice(0, 138), { ...base[138]!, checksum: 'ff'.repeat(32) }, base[139]!, next]]) await assert.rejects(probe(rows));
  const capableDirectory = await mkdtemp(path.join(tmpdir(), 'mhp-wa-strict-141-'));
  await Promise.all(migrations.map(m => writeFile(path.join(capableDirectory, m.filename), m.sql)));
  await writeFile(path.join(capableDirectory, MHP_WHATSAPP_MIGRATION), '-- synthetic bundled next migration; never executed\nSELECT 141;\n');
  const capable = await discoverMigrations(capableDirectory);
  await assert.rejects(assertRuntimeSchemaCurrent({ query: async () => ({ rows: base }) } as never, capableDirectory, {}), /behind by 1/u);
  await assertRuntimeSchemaCurrent({ query: async () => ({ rows: capable.map(({ filename, checksum }) => ({ filename, checksum })) }) } as never, capableDirectory, {});
});

test('recovery role probes admit the new grants only with exact140 and141 ledger pins, retaining blindness checks', async () => {
  const migrations = await discoverMigrations(directory), base = migrations.map(({ filename, checksum }) => ({ filename, checksum }));
  for (const probe of [assertMetaWhatsAppLiveCommandBoundaryReady, assertMetaWhatsAppLiveWorkerBoundaryReady, assertMetaWhatsAppLiveWebhookBoundaryReady]) {
    const run = async (rows: typeof base, blind = true) => {
      let allowed: string[] = [];
      await probe({ query: async (sql: string, args: string[]) => {
        if (sql.includes('bridge-ledger')) return { rows };
        allowed = args;
        return { rows: [{ exactRole: true, schemaUsage: true, allowedFunctionsReady: true, extraFunctionsDenied: true, tableBlind: blind, elevatedRolesDenied: true }] };
      } } as never);
      return allowed.filter(v => /mhp_/u.test(v));
    };
    assert.equal((await run(base)).length, 0);
    assert.ok((await run([...base, next])).length > 0);
    assert.equal((await run([...base, { ...next, checksum: 'ff'.repeat(32) }])).length, 0);
    await assert.rejects(run([...base, next], false), /boundary is not exact/u);
  }
});
