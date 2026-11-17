/**
 * Migration 0158 (Affiliate Studio, slice 1, data layer) on a disposable PostgreSQL with the real roles.
 *
 * 1. The real runner: the disposable database is reset and built to 0156 then 0157 with the runner; readiness of this
 *    build and of the 157-file build on 0156 (two pending: not ready), on 0157 (0158 absent from the ledger, pending
 *    for this build: ready) and after 0158 (applied: ready, the 157-file build through its successor bridge, while the
 *    released 157 build's strict check refuses); the stores answer "not opened yet" while 0158 is absent; a failure
 *    forced in the middle of the file (and at its very end) rolls everything back; 0158 is applied by the runner and a
 *    second run is a no-op.
 * 2. On real roles, through the stores on the content-command login and through the functions directly: business A
 *    cannot list, read, add, edit, retire or import for business B; a missing, junk, short, expired, revoked or other
 *    person's session, a worker, a viewer and the wrong login are refused (42501); every login role is refused direct
 *    SELECT/INSERT/UPDATE/DELETE/TRUNCATE on the four tables and EXECUTE on every function but the three commands
 *    (r72_content_command only); rows cannot be updated, deleted or truncated even by the owner; replays answer the
 *    first result; the 500-product and 200-report caps.
 * Amazon is not involved. All people and values are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { assertDisposableTestDatabase, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { discoverMigrations, runMigrations, validateAppliedState } from '../../src/db/migrate.js';
import { assertRuntimeSchemaCurrent } from '../../src/db/runtime-readiness.js';
import { AFFILIATE_CHECKSUM, AFFILIATE_MIGRATION } from '../../src/db/affiliate-schema.js';
import { EMAIL_ALLOWLIST_MIGRATION } from '../../src/db/email-allowlist-schema.js';
import { NOT_OPENED_YET, PgAffiliateProductStore, type AffiliateOwner } from '../../src/affiliate/product-store.js';
import { PgAffiliateReportStore } from '../../src/affiliate/report-store.js';

const skip = testDatabaseSkipReason();
type Admin = Awaited<ReturnType<typeof openTestDatabase>>;
const hash = (token: string) => createHash('sha256').update(token).digest();
const TABLES = ['affiliate_products', 'affiliate_product_commands', 'affiliate_programme_settings', 'affiliate_report_imports'];
const COMMANDS = ['affiliate_product_command(uuid,bytea,text,jsonb)', 'affiliate_programme_command(uuid,bytea,text,jsonb)', 'affiliate_report_command(uuid,bytea,text,jsonb)'];
const HELPERS = ['affiliate_owner(uuid,bytea)', 'affiliate_uuid(jsonb,text)', 'affiliate_product_json(app.affiliate_products)', 'affiliate_settings_json(uuid,text)'];
const PAGE = 'https://www.amazon.co.uk/dp/B08N5WRWNW';
const POUND = String.fromCharCode(0xa3);

/** A pool logged in as `role` (password set for this run only; the disposable cluster trusts local connections anyway). */
async function login(admin: Admin, role: string, max = 4): Promise<pg.Pool> {
  assertDisposableTestDatabase(process.env.TEST_DATABASE_URL ?? '');
  const password = randomUUID() + randomUUID();
  const statement = await admin.query<{ sql: string }>("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql", [role, password]);
  await admin.query(statement.rows[0]!.sql);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.username = role;
  url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max, application_name: 'relaunch72-disposable-affiliate' });
}

async function prefixDirectory(count: number, replace?: { filename: string; sql: string }): Promise<string> {
  const prefix = (await discoverMigrations()).slice(0, count);
  const directory = await mkdtemp(path.join(tmpdir(), `r72-affiliate-${count}-`));
  await Promise.all(prefix.map(m => writeFile(path.join(directory, m.filename), m.sql, 'utf8')));
  if (replace) await writeFile(path.join(directory, replace.filename), replace.sql, 'utf8');
  return directory;
}

async function resetDisposable(): Promise<void> {
  const child = spawn(process.execPath, ['--import', './test/windows-node24-shim.mjs', '--import', 'tsx', 'test/db/reset-disposable.ts'],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  const [code] = await once(child, 'exit') as [number | null];
  assert.equal(code, 0, 'the disposable reset ran');
}

interface Person { readonly id: string; readonly token: string; readonly owner: AffiliateOwner }
interface World { readonly a: string; readonly b: string; readonly ownerA: Person; readonly ownerB: Person; readonly viewerA: Person; readonly both: Person;
  readonly expiredA: Person; readonly revokedA: Person }

async function session(admin: Admin, user: string, workspace: string, expires = "now()+interval '2 hours'", revoked = false): Promise<string> {
  const token = `affiliate-${randomUUID()}${randomUUID()}`;
  await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,revoked_at,created_at,last_seen_at)
    VALUES($1,$2,$3,$4,${expires},${revoked ? 'now()' : 'NULL'},now()-interval '3 hours',now()-interval '3 hours')`, [hash(token), hash(`csrf${token}`), user, workspace]);
  return token;
}

/** Two content businesses A and B: an owner each, a viewer of A, one person who runs both, an expired and a revoked session. */
async function seed(admin: Admin): Promise<World> {
  const orgA = randomUUID(), orgB = randomUUID(), a = randomUUID(), b = randomUUID();
  const ids = { ownerA: randomUUID(), ownerB: randomUUID(), viewerA: randomUUID(), both: randomUUID() };
  const tag = a.slice(0, 8);
  await ownerQuery(admin, `DO $s$ BEGIN
    PERFORM set_config('app.request_id','affiliate-fixture',true);
    INSERT INTO app.organizations(id,name,slug,kind) VALUES('${orgA}','Aff A','aff-a-${tag}','direct_customer'),('${orgB}','Aff B','aff-b-${tag}','direct_customer');
    INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES('${a}','${orgA}','Business A','aff-a-${tag}','Europe/London'),
      ('${b}','${orgB}','Business B','aff-b-${tag}','Europe/London');
    INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES
      ('${ids.ownerA}','owner-a-${tag}@aff-proof.co.uk','Ann A','active',clock_timestamp()),('${ids.ownerB}','owner-b-${tag}@aff-proof.co.uk','Bob B','active',clock_timestamp()),
      ('${ids.viewerA}','viewer-a-${tag}@aff-proof.co.uk','Vic A','active',clock_timestamp()),('${ids.both}','both-${tag}@aff-proof.co.uk','Bo Both','active',clock_timestamp());
    INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${orgA}','${ids.ownerA}','owner','active'),('${orgB}','${ids.ownerB}','owner','active'),
('${orgA}','${ids.both}','admin','active'),('${orgB}','${ids.both}','admin','active');
    INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${a}','${orgA}','${ids.ownerA}','owner','active'),
      ('${b}','${orgB}','${ids.ownerB}','owner','active'),('${a}','${orgA}','${ids.viewerA}','viewer','active'),('${a}','${orgA}','${ids.both}','admin','active'),
      ('${b}','${orgB}','${ids.both}','admin','active');
    INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) VALUES('${a}','${orgA}','${ids.ownerA}','{}'::jsonb),('${b}','${orgB}','${ids.ownerB}','{}'::jsonb);
  END $s$`);
  const person = async (id: string, ws: string, expires?: string, revoked?: boolean): Promise<Person> => {
    const token = await session(admin, id, ws, expires, revoked);
    return { id, token, owner: { userId: id, requestId: `req-${randomUUID().slice(0, 8)}`, sessionToken: token, selectedWorkspaceId: ws } };
  };
  return { a, b, ownerA: await person(ids.ownerA, a), ownerB: await person(ids.ownerB, b), viewerA: await person(ids.viewerA, a), both: await person(ids.both, a),
    expiredA: await person(ids.ownerA, a, "now()-interval '1 minute'"), revokedA: await person(ids.ownerA, a, undefined, true) };
}

type Answer = { value?: unknown; code?: string; detail?: string };
/** One function call in its own transaction, with exactly the request context given (no store in between). */
async function direct(pool: pg.Pool, ctx: { workspace: string; user?: string | null; kind?: string }, fn: string, ws: string, sessionHash: Buffer | null,
  action: string, input: unknown): Promise<Answer> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id',$1,true),set_config('app.workspace_id',$2,true),set_config('app.actor_kind',$3,true),set_config('app.request_id','aff-direct',true)`,
      [ctx.user ?? '', ctx.workspace, ctx.kind ?? 'user']);
    const value = (await client.query(`SELECT app_private.${fn}($1,$2,$3,$4::jsonb) AS value`, [ws, sessionHash, action, JSON.stringify(input)])).rows[0]?.value;
    await client.query('COMMIT');
    return { value };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = error as { code?: string; detail?: string };
    return { code: e.code, detail: e.detail };
  } finally { client.release(); }
}
const product = (affiliateUrl = `${PAGE}?tag=shop-a-21`, name = 'Steel kettle') => ({ programme: 'amazon_uk', merchantName: 'Amazon UK', productName: name,
  merchantProductId: 'B08N5WRWNW', productUrl: PAGE, affiliateUrl, infoUrl: null, notes: null, ownerUsed: false });
const settingsInput = (trackingId: string, expectedRevision = 0, commandId = randomUUID()) => ({ commandId, programme: 'amazon_uk', expectedRevision,
  settings: { trackingId, registeredSite: 'https://www.business-a.example', siteListedConfirmed: true, accountConfirmed: true } });

test('0158 through the real runner: readiness absent, pending and applied; not opened yet; a forced failure rolls back; a second run is a no-op', { skip, timeout: 900_000 }, async () => {
  let admin = await openTestDatabase();
  const pools: pg.Pool[] = [];
  try {
    await resetDisposable();
    // The exact 158-file Affiliate Studio release, reconstructed from today's source (0159 is a separate release).
    const all = (await discoverMigrations()).slice(0, 158);
    assert.equal(all.length, 158);
    const build158 = await prefixDirectory(158);
    assert.deepEqual([all[157]!.filename, all[157]!.checksum], [AFFILIATE_MIGRATION, AFFILIATE_CHECKSUM]);
    const build157 = await prefixDirectory(157);
    // From empty to 0156: two pending for this build, not ready (the 157-file build admits its own 0157 pending).
    await runMigrations(admin, await prefixDirectory(156));
    let web = await login(admin, 'r72_web', 2);
    pools.push(web);
    await assert.rejects(assertRuntimeSchemaCurrent(web, build158, {}), /schema is behind by 2 migration\(s\); first pending: 0157_email_connect_allowlist\.sql/u);
    await assertRuntimeSchemaCurrent(web, build157, {});
    // To 0157 with the runner: 0158 is absent from the ledger and pending for this build: both builds are ready.
    assert.deepEqual((await runMigrations(admin, build157)).applied, [EMAIL_ALLOWLIST_MIGRATION]);
    await assertRuntimeSchemaCurrent(web, build158, {});
    await assertRuntimeSchemaCurrent(web, build157, {});
    assert.equal((await ownerQuery<{ r: string | null }>(admin, "SELECT to_regclass('app.affiliate_products')::text AS r"))[0]!.r, null);

    // The stores on the real content-command login while 0158 is absent: "not opened yet", nothing thrown.
    await resetIdentityTables(admin);
    const world = await seed(admin);
    const content = await login(admin, 'r72_content_command');
    pools.push(content);
    const products = new PgAffiliateProductStore(content, world.ownerA.owner), reports = new PgAffiliateReportStore(content, world.ownerA.owner);
    assert.equal(await products.list(world.a), NOT_OPENED_YET);
    assert.equal(await products.settings(world.a, 'amazon_uk'), NOT_OPENED_YET);
    assert.equal(await products.add({ workspaceId: world.a, details: { programme: 'amazon_uk', link: PAGE, productName: 'K', ownerUsed: false } }), NOT_OPENED_YET);
    assert.equal(await reports.list(world.a), NOT_OPENED_YET);
    assert.equal(await reports.save({ workspaceId: world.a, month: '2026-10', originalText: `Tracking ID,Earnings\nshop-a-21,${POUND}1.00\n` }), NOT_OPENED_YET);

    // A failure forced in the middle of 0158, and one at its very end: the runner rolls the whole file back.
    const sql = all[157]!.sql;
    const middle = 'GRANT CREATE ON SCHEMA app_private TO r72_affiliate_definer;\n';
    assert.equal(sql.split(middle).length, 2);
    for (const [label, broken] of [['middle', sql.replace(middle, `DO $x$ BEGIN RAISE EXCEPTION 'forced mid-file failure'; END $x$;\n${middle}`)],
      ['end', `${sql}DO $x$ BEGIN RAISE EXCEPTION 'forced end-of-file failure'; END $x$;\n`]] as const) {
      await assert.rejects(runMigrations(admin, await prefixDirectory(157, { filename: AFFILIATE_MIGRATION, sql: broken })), /forced (?:mid|end)/u, label);
      const left = (await ownerQuery<Record<string, unknown>>(admin, `SELECT
        (SELECT max(filename) FROM app_private.schema_migrations) AS last,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname LIKE 'affiliate\\_%') AS relations,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND p.proname LIKE 'affiliate\\_%') AS functions,
        (SELECT count(*) FROM pg_roles WHERE rolname='r72_affiliate_definer') AS roles,
        (SELECT count(*) FROM app_private.workspace_table_registry WHERE schema_name='app' AND table_name=ANY($1::text[])) AS registry,
        (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='app' AND t.typname LIKE 'affiliate\\_%') AS types`, [TABLES]))[0]!;
      assert.deepEqual(left, { last: EMAIL_ALLOWLIST_MIGRATION, relations: '0', functions: '0', roles: '0', registry: '0', types: '0' }, label);
      await assertRuntimeSchemaCurrent(web, build158, {});
    }

    // 0158 by the same runner; a second run is a no-op.
    const result = await runMigrations(admin, build158);
    assert.deepEqual(result.applied, [AFFILIATE_MIGRATION]);
    const again = await runMigrations(admin, build158);
    assert.deepEqual(again.applied, []);
    assert.equal(again.alreadyApplied.length, 158);
    const ledger = await ownerQuery<{ filename: string; checksum: string }>(admin, 'SELECT filename,checksum FROM app_private.schema_migrations WHERE filename=$1', [AFFILIATE_MIGRATION]);
    assert.deepEqual(ledger, [{ filename: AFFILIATE_MIGRATION, checksum: AFFILIATE_CHECKSUM }]);
    // Applied: this build and the 157-file build (its successor bridge) are ready; the released 157 build's strict
    // check (no bridge) refuses the unknown ledger row, which is why this build must be everywhere first.
    web = await login(admin, 'r72_web', 2);
    pools.push(web);
    await assertRuntimeSchemaCurrent(web, build158, {});
    await assertRuntimeSchemaCurrent(web, build157, {});
    const applied = new Map((await ownerQuery<{ filename: string; checksum: string }>(admin, 'SELECT filename,checksum FROM app_private.schema_migrations')).map(r => [r.filename, r.checksum]));
    assert.throws(() => validateAppliedState(all.slice(0, 157), applied), /migration not present/u);
    // Everything 0158 created exists once, owned as designed.
    const made = (await ownerQuery<Record<string, unknown>>(admin, `SELECT
      (SELECT string_agg(c.relname||':'||pg_get_userbyid(c.relowner)||':'||c.relrowsecurity||c.relforcerowsecurity,',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='app' AND c.relkind='r' AND c.relname LIKE 'affiliate\\_%') AS tables,
      (SELECT string_agg(p.proname||':'||pg_get_userbyid(p.proowner)||':'||p.prosecdef||':'||array_to_string(p.proconfig,';'),',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app_private' AND p.proname LIKE 'affiliate\\_%') AS functions,
      (SELECT string_agg(table_name,',' ORDER BY table_name) FROM app_private.workspace_table_registry WHERE schema_name='app' AND table_name LIKE 'affiliate\\_%') AS registry,
      has_schema_privilege('r72_affiliate_definer','app_private','CREATE') AS can_create`))[0]!;
    assert.equal(made.tables, TABLES.slice().sort().map(t => `${t}:r72_owner:truetrue`).join(','));
    assert.equal(made.functions, ['affiliate_owner', 'affiliate_product_command', 'affiliate_product_json', 'affiliate_programme_command', 'affiliate_report_command',
      'affiliate_settings_json', 'affiliate_uuid'].map(f => `${f}:r72_affiliate_definer:true:search_path=pg_catalog`).join(','));
    assert.equal(made.registry, TABLES.slice().sort().join(','));
    assert.equal(made.can_create, false);
  } finally {
    for (const pool of pools) await pool.end().catch(() => undefined);
    await admin.end();
  }
  // Leave the database complete for the next test file.
  admin = await openTestDatabase();
  await admin.end();
});

test('0158 on real roles: tenant isolation, sessions, direct access, append-only, replays and caps', { skip, timeout: 900_000 }, async () => {
  const admin = await openTestDatabase();
  const pools: pg.Pool[] = [];
  try {
    await resetIdentityTables(admin);
    const w = await seed(admin);
    const content = await login(admin, 'r72_content_command');
    pools.push(content);
    const storeA = new PgAffiliateProductStore(content, w.ownerA.owner), storeB = new PgAffiliateProductStore(content, w.ownerB.owner);
    const reportsA = new PgAffiliateReportStore(content, w.ownerA.owner), reportsB = new PgAffiliateReportStore(content, w.ownerB.owner);
    const hA = hash(w.ownerA.token), hB = hash(w.ownerB.token);
    const ctxA = { workspace: w.a, user: w.ownerA.id }, ctxB = { workspace: w.b, user: w.ownerB.id };

    // --- The owner flow through the stores ---
    assert.deepEqual(await storeA.list(w.a), { ok: true, value: [] });
    assert.deepEqual(await storeA.settings(w.a, 'amazon_uk'), { ok: true, value: null });
    const early = await storeA.add({ workspaceId: w.a, details: { programme: 'amazon_uk', link: `${PAGE}?tag=shop-a-21`, productName: 'Kettle', ownerUsed: false } });
    assert.equal(!early.ok && early.kind === 'refused' && early.reason, 'settings_required');
    assert.equal((await direct(content, ctxA, 'affiliate_product_command', w.a, hA, 'add', { commandId: randomUUID(), productId: randomUUID(), product: product() })).code, '55000',
      'the database itself refuses a product before the programme details');
    const settingsCommand = randomUUID();
    const saved = await storeA.saveSettings({ workspaceId: w.a, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'shop-a-21', registeredSite: 'www.business-a.example',
      siteListedConfirmed: true, accountConfirmed: true, commandId: settingsCommand });
    assert.deepEqual(saved, { ok: true, value: { replayed: false, revision: 1 } });
    assert.deepEqual(await storeA.saveSettings({ workspaceId: w.a, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'shop-a-21', registeredSite: 'www.business-a.example',
      siteListedConfirmed: true, accountConfirmed: true, commandId: settingsCommand }), { ok: true, value: { replayed: true, revision: 1 } }, 'a replay answers the first result');
    const reused = await storeA.saveSettings({ workspaceId: w.a, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'shop-x-21', registeredSite: 'www.business-a.example',
      siteListedConfirmed: true, accountConfirmed: true, commandId: settingsCommand });
    assert.equal(!reused.ok && reused.kind === 'refused' && reused.reason, 'command_reused');
    const stale = await storeA.saveSettings({ workspaceId: w.a, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'shop-a-21', registeredSite: 'www.business-a.example',
      siteListedConfirmed: true, accountConfirmed: true });
    assert.equal(!stale.ok && stale.kind === 'refused' && stale.reason, 'stale');
    // Both confirmations are required by the database too.
    for (const settings of [{ siteListedConfirmed: false }, { accountConfirmed: false }, { siteListedConfirmed: 'true' }, { trackingId: 'shop-a-20' }, { registeredSite: 'http://x.example' },
      { registeredSite: 'https://x.example/path' }]) {
      const input = settingsInput('shop-a-21', 1);
      const answer = await direct(content, ctxA, 'affiliate_programme_command', w.a, hA, 'save', { ...input, settings: { ...input.settings, ...settings } });
      assert.ok(answer.code === '22023' || answer.code === '23514', JSON.stringify(settings));
    }

    const productId = randomUUID(), addCommand = randomUUID();
    const added = await storeA.add({ workspaceId: w.a, productId, commandId: addCommand, details: { programme: 'amazon_uk',
      link: 'https://www.amazon.co.uk/Steel-Kettle/dp/B08N5WRWNW/ref=sr_1_1?keywords=kettle&th=1', productName: 'Steel kettle', notes: 'Boils fast.', ownerUsed: true,
      infoUrl: 'https://maker.example/kettle' } });
    assert.deepEqual(added, { ok: true, value: { replayed: false, productId, revision: 1, status: 'active' } });
    assert.deepEqual(await storeA.add({ workspaceId: w.a, productId, commandId: addCommand, details: { programme: 'amazon_uk',
      link: 'https://www.amazon.co.uk/Steel-Kettle/dp/B08N5WRWNW/ref=sr_1_1?keywords=kettle&th=1', productName: 'Steel kettle', notes: 'Boils fast.', ownerUsed: true,
      infoUrl: 'https://maker.example/kettle' } }), { ok: true, value: { replayed: true, productId, revision: 1, status: 'active' } });
    const got = await storeA.get(w.a, productId);
    assert.ok(got.ok && got.value);
    assert.deepEqual([got.value.affiliateUrl, got.value.productUrl, got.value.merchantProductId, got.value.ownerUsed, got.value.notes, got.value.infoUrl, got.value.status],
      [`${PAGE}?tag=shop-a-21`, PAGE, 'B08N5WRWNW', true, 'Boils fast.', 'https://maker.example/kettle', 'active']);
    const edited = await storeA.edit({ workspaceId: w.a, productId, expectedRevision: 1, details: { programme: 'amazon_uk', link: PAGE, productName: 'Steel kettle 1.7 L', ownerUsed: false } });
    assert.deepEqual(edited, { ok: true, value: { replayed: false, productId, revision: 2, status: 'active' } });
    const staleEdit = await storeA.edit({ workspaceId: w.a, productId, expectedRevision: 1, details: { programme: 'amazon_uk', link: PAGE, productName: 'X', ownerUsed: false } });
    assert.equal(!staleEdit.ok && staleEdit.kind === 'refused' && staleEdit.reason, 'stale');
    const retireCommand = randomUUID();
    assert.deepEqual(await storeA.retire({ workspaceId: w.a, productId, expectedRevision: 2, commandId: retireCommand }), { ok: true, value: { replayed: false, productId, revision: 3, status: 'retired' } });
    assert.deepEqual(await storeA.retire({ workspaceId: w.a, productId, expectedRevision: 2, commandId: retireCommand }), { ok: true, value: { replayed: true, productId, revision: 3, status: 'retired' } });
    const afterRetire = await storeA.edit({ workspaceId: w.a, productId, expectedRevision: 3, details: { programme: 'amazon_uk', link: PAGE, productName: 'X', ownerUsed: false } });
    assert.equal(!afterRetire.ok && afterRetire.kind === 'refused' && afterRetire.reason, 'stale', 'a retired product is not edited');
    const listed = await storeA.list(w.a);
    assert.ok(listed.ok);
    assert.deepEqual(listed.value.map(p => [p.productId, p.revision, p.status, p.productName]), [[productId, 3, 'retired', 'Steel kettle 1.7 L']]);
    // The database refuses a link with another tag, a non-canonical link, or a product id it already holds.
    assert.deepEqual(await direct(content, ctxA, 'affiliate_product_command', w.a, hA, 'add', { commandId: randomUUID(), productId: randomUUID(), product: product(`${PAGE}?tag=someone-21`) }),
      { code: '22023', detail: 'affiliate_tag_mismatch' });
    for (const bad of [{ affiliateUrl: `${PAGE}?tag=shop-a-21&x=1` }, { productUrl: `${PAGE}/` }, { merchantProductId: 'b08n5wrwnw' }, { productName: '<b>x</b>' },
      { ownerUsed: 'yes' }, { infoUrl: 'http://maker.example' }, { infoUrl: 'https://u@maker.example/' }, { notes: 'a\u0000b' }, { notes: 'n'.repeat(2001) }, { programme: 'amazon_com' }]) {
      const p = { ...product(), ...bad };
      if ('merchantProductId' in bad) p.affiliateUrl = `https://www.amazon.co.uk/dp/${bad.merchantProductId}?tag=shop-a-21`;
      const answer = await direct(content, ctxA, 'affiliate_product_command', w.a, hA, 'add', { commandId: randomUUID(), productId: randomUUID(), product: p });
      assert.ok(['22023', '23514', '55000', '22P05'].includes(answer.code ?? ''), `${JSON.stringify(bad)}: ${answer.code}`);
    }
    assert.equal((await direct(content, ctxA, 'affiliate_product_command', w.a, hA, 'add', { commandId: randomUUID(), productId, product: product() })).code, '40001');

    // Reports through the store: kept once per file and month; the same file again answers the first id.
    const text = `Tracking ID\tClicks\tOrdered Items\tShipped Items\tEarnings\nshop-a-21\t412\t9\t8\t${POUND}23.40\nOthers\t3\t0\t0\t${POUND}0.10\n`;
    const first = await reportsA.save({ workspaceId: w.a, month: '2026-10', originalText: text });
    assert.ok(first.ok && first.value.replayed === false);
    assert.deepEqual(await reportsA.save({ workspaceId: w.a, month: '2026-10', originalText: text }), { ok: true, value: { replayed: true, id: first.value.id } });
    assert.deepEqual(await reportsA.save({ workspaceId: w.a, month: '2026-10', originalText: text, commandId: first.value.id }), { ok: true, value: { replayed: true, id: first.value.id } });
    const november = await reportsA.save({ workspaceId: w.a, month: '2026-11', originalText: text });
    assert.ok(november.ok && november.value.replayed === false && november.value.id !== first.value.id);
    const reportList = await reportsA.list(w.a);
    assert.ok(reportList.ok);
    assert.deepEqual(reportList.value.map(r => [r.reportStart, r.reportEnd, r.rowCount, r.summary.knownEarningsMinor, r.summary.unallocatedEarningsMinor]).sort(),
      [['2026-10-01', '2026-10-31', 2, 2350, 10], ['2026-11-01', '2026-11-30', 2, 2350, 10]]);
    const one = await reportsA.get(w.a, first.value.id);
    assert.ok(one.ok && one.value);
    assert.deepEqual(one.value.payload.rows.map(r => [r.trackingId, r.isOther, r.earningsMinor]), [['shop-a-21', false, 2340], ['Others', true, 10]]);
    // The same command id with other figures, or the same file and month with other figures: refused.
    const body = (await ownerQuery<{ payload: unknown; source_sha256: string }>(admin, 'SELECT payload,source_sha256 FROM app.affiliate_report_imports WHERE workspace_id=$1 AND id=$2', [w.a, first.value.id]))[0]!;
    const changed = { ...(body.payload as Record<string, unknown>), knownEarningsMinor: 999999 };
    const saveInput = (id: string, payload: unknown, sourceSha = body.source_sha256) => ({ id, programme: 'amazon_uk', source: 'user_uploaded_amazon_tracking_id_summary', sourceSha,
      reportStart: '2026-10-01', reportEnd: '2026-10-31', currency: 'GBP', payload });
    assert.deepEqual(await direct(content, ctxA, 'affiliate_report_command', w.a, hA, 'save', saveInput(first.value.id, changed)), { code: '23505', detail: 'affiliate_command_reused' });
    assert.deepEqual(await direct(content, ctxA, 'affiliate_report_command', w.a, hA, 'save', saveInput(randomUUID(), changed)), { code: '23505', detail: 'affiliate_report_conflict' });
    for (const bad of [{ reportEnd: '2027-12-31' }, { reportEnd: '2026-09-30' }, { reportStart: '2026-02-30' }, { currency: 'USD' }, { source: 'other' }, { payload: { rows: [] } },
      { payload: { ...(body.payload as object), rows: [1] } }, { programme: 'amazon_com' }, { sourceSha: 'x' }]) {
      const answer = await direct(content, ctxA, 'affiliate_report_command', w.a, hA, 'save', { ...saveInput(randomUUID(), body.payload, 'f'.repeat(64)), ...bad });
      assert.ok(['22023', '22008', '22007', '23514'].includes(answer.code ?? ''), `${JSON.stringify(bad)}: ${answer.code}`);
    }

    // --- Business A cannot list, read, add, edit, retire or import for business B ---
    assert.ok((await storeB.saveSettings({ workspaceId: w.b, programme: 'amazon_uk', expectedRevision: 0, trackingId: 'shop-b-21', registeredSite: 'www.business-b.example',
      siteListedConfirmed: true, accountConfirmed: true })).ok);
    const productB = randomUUID();
    assert.ok((await storeB.add({ workspaceId: w.b, productId: productB, details: { programme: 'amazon_uk', link: PAGE, productName: 'B kettle', ownerUsed: false } })).ok);
    const reportB = await reportsB.save({ workspaceId: w.b, month: '2026-10', originalText: text.replace('shop-a-21', 'shop-b-21') });
    assert.ok(reportB.ok);
    const forbidden = (answer: { ok: boolean; kind?: string; reason?: string }) => assert.equal(!answer.ok && answer.kind === 'refused' && answer.reason, 'forbidden');
    forbidden(await storeA.list(w.b) as never);
    forbidden(await storeA.get(w.b, productB) as never);
    forbidden(await storeA.settings(w.b, 'amazon_uk') as never);
    forbidden(await storeA.saveSettings({ workspaceId: w.b, programme: 'amazon_uk', expectedRevision: 1, trackingId: 'shop-a-21', registeredSite: 'x.example', siteListedConfirmed: true, accountConfirmed: true }) as never);
    forbidden(await storeA.add({ workspaceId: w.b, details: { programme: 'amazon_uk', link: PAGE, productName: 'X', ownerUsed: false } }) as never);
    forbidden(await storeA.edit({ workspaceId: w.b, productId: productB, expectedRevision: 1, details: { programme: 'amazon_uk', link: PAGE, productName: 'X', ownerUsed: false } }) as never);
    forbidden(await storeA.retire({ workspaceId: w.b, productId: productB, expectedRevision: 1 }) as never);
    forbidden(await reportsA.list(w.b) as never);
    forbidden(await reportsA.get(w.b, reportB.ok ? reportB.value.id : '') as never);
    forbidden(await reportsA.save({ workspaceId: w.b, month: '2026-12', originalText: text }) as never);
    // Directly, whichever workspace the request context names, A's session never acts on B.
    const everyCall: readonly [string, string, unknown][] = [
      ['affiliate_product_command', 'list', {}], ['affiliate_product_command', 'get', { productId: productB }],
      ['affiliate_product_command', 'add', { commandId: randomUUID(), productId: randomUUID(), product: product(`${PAGE}?tag=shop-b-21`) }],
      ['affiliate_product_command', 'edit', { commandId: randomUUID(), productId: productB, expectedRevision: 1, product: product(`${PAGE}?tag=shop-b-21`) }],
      ['affiliate_product_command', 'retire', { commandId: randomUUID(), productId: productB, expectedRevision: 1 }],
      ['affiliate_programme_command', 'get', { programme: 'amazon_uk' }], ['affiliate_programme_command', 'save', settingsInput('shop-a-21', 1)],
      ['affiliate_report_command', 'list', {}], ['affiliate_report_command', 'get', { id: reportB.ok ? reportB.value.id : randomUUID() }],
      ['affiliate_report_command', 'save', saveInput(randomUUID(), body.payload, 'e'.repeat(64))],
    ];
    for (const [fn, action, input] of everyCall) {
      for (const ctx of [{ workspace: w.b, user: w.ownerA.id }, { workspace: w.a, user: w.ownerA.id }, { workspace: w.b, user: w.ownerB.id }]) {
        assert.equal((await direct(content, ctx, fn, w.b, hA, action, input)).code, '42501', `${fn} ${action} as A on B (${JSON.stringify(ctx)})`);
      }
      // A asking about its own business with B's product or report id finds nothing of B's.
      if (action === 'get' && fn !== 'affiliate_programme_command') assert.equal((await direct(content, ctxA, fn, w.a, hA, action, input)).value, null, `${fn} get of B's id inside A`);
    }
    // A's list holds none of B's rows; B's rows are untouched.
    const listA = await storeA.list(w.a);
    assert.ok(listA.ok && !listA.value.some(p => p.productId === productB));
    const rowsB = await ownerQuery<{ n: string }>(admin, `SELECT (SELECT count(*) FROM app.affiliate_products WHERE workspace_id=$1)+(SELECT count(*) FROM app.affiliate_programme_settings WHERE workspace_id=$1)
      +(SELECT count(*) FROM app.affiliate_report_imports WHERE workspace_id=$1) AS n`, [w.b]);
    assert.equal(rowsB[0]!.n, '3');
    // Someone who runs both businesses may act for both, each in its own scope.
    const both = new PgAffiliateProductStore(content, w.both.owner);
    assert.ok((await both.list(w.a)).ok && (await both.list(w.b)).ok);

    // --- Sessions: missing, junk, short, expired, revoked, another person's, a viewer, a worker, a mismatched user ---
    const refusedCtx: readonly [string, { workspace: string; user?: string | null; kind?: string }, Buffer | null][] = [
      ['missing', ctxA, null], ['junk', ctxA, randomBytes(32)], ['short', ctxA, randomBytes(5)], ['long', ctxA, randomBytes(64)], ['empty', ctxA, Buffer.alloc(0)],
      ['expired', ctxA, hash(w.expiredA.token)], ['revoked', ctxA, hash(w.revokedA.token)], ['other person', ctxA, hB], ['other person as themselves', ctxB, hB],
      ['viewer', { workspace: w.a, user: w.viewerA.id }, hash(w.viewerA.token)], ['worker', { workspace: w.a, user: null, kind: 'worker' }, hA],
      ['worker without session', { workspace: w.a, user: null, kind: 'worker' }, null], ['webhook', { workspace: w.a, user: null, kind: 'webhook' }, hA],
      ['wrong user in context', { workspace: w.a, user: w.ownerB.id }, hA], ['no user in context', { workspace: w.a, user: null }, hA],
    ];
    for (const [label, ctx, sessionHash] of refusedCtx) {
      for (const [fn, action, input] of [['affiliate_product_command', 'list', {}], ['affiliate_programme_command', 'get', { programme: 'amazon_uk' }],
        ['affiliate_report_command', 'list', {}], ['affiliate_product_command', 'retire', { commandId: randomUUID(), productId, expectedRevision: 3 }]] as const) {
        const answer = await direct(content, ctx, fn, w.a, sessionHash, action, input);
        assert.equal(answer.code, '42501', `${label}: ${fn} ${action}`);
      }
    }
    // Through the store: an expired, revoked or another person's session is refused before anything runs.
    for (const owner of [w.expiredA.owner, w.revokedA.owner, { ...w.ownerA.owner, sessionToken: w.ownerB.token }, w.viewerA.owner]) {
      forbidden(await new PgAffiliateProductStore(content, owner).list(w.a) as never);
    }

    // --- Every login role: no direct table access; EXECUTE on the three commands for r72_content_command only ---
    const loginRoles = (await admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname LIKE 'r72\\_%' AND rolname<>current_user ORDER BY rolname`)).rows.map(r => r.rolname);
    assert.ok(loginRoles.length >= 20 && loginRoles.includes('r72_content_command') && loginRoles.includes('r72_web') && loginRoles.includes('r72_worker'));
    const executable: Record<string, string[]> = {};
    for (const role of loginRoles) {
      const pool = await login(admin, role, 1);
      pools.push(pool);
      for (const table of TABLES) {
        for (const statement of [`SELECT * FROM app.${table}`, `INSERT INTO app.${table}(workspace_id) VALUES('${w.a}')`, `UPDATE app.${table} SET workspace_id=workspace_id`,
          `DELETE FROM app.${table}`, `TRUNCATE app.${table}`]) {
          await assert.rejects(pool.query(statement), (e: { code?: string }) => e.code === '42501', `${role}: ${statement}`);
        }
      }
      const can = await ownerQuery<{ fn: string }>(admin, `SELECT replace(p.oid::regprocedure::text,'app_private.','') AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='app_private' AND p.proname LIKE 'affiliate\\_%' AND p.proname NOT LIKE 'affiliate\\_compliance%' AND has_function_privilege($1,p.oid,'EXECUTE') ORDER BY 1`, [role]);
      executable[role] = can.map(r => r.fn.replace(/ /gu, ''));
      if (role !== 'r72_content_command') {
        for (const fn of ['affiliate_product_command', 'affiliate_report_command', 'affiliate_programme_command']) {
          await assert.rejects(pool.query(`SELECT app_private.${fn}($1,$2,'list','{"programme":"amazon_uk"}'::jsonb)`, [w.a, hA]), (e: { code?: string }) => e.code === '42501', `${role}: ${fn}`);
        }
      }
      for (const helper of ['affiliate_owner($1,$2)', 'affiliate_settings_json($1,\'amazon_uk\')']) {
        await assert.rejects(pool.query(`SELECT app_private.${helper}`, helper.includes('$2') ? [w.a, hA] : [w.a]), (e: { code?: string }) => e.code === '42501', `${role}: ${helper}`);
      }
    }
    for (const role of loginRoles) assert.deepEqual(executable[role], role === 'r72_content_command' ? [...COMMANDS].sort() : [], role);
    console.log(`AFFILIATE-LOGIN-ROLES ${JSON.stringify(loginRoles)}`);
    // The definer holds exactly SELECT and INSERT on its four tables; nobody else holds any table privilege but r72_owner.
    const grants = await ownerQuery<{ g: string; t: string; p: string }>(admin, `SELECT grantee AS g,table_name AS t,string_agg(privilege_type,',' ORDER BY privilege_type) AS p
      FROM information_schema.role_table_grants WHERE table_schema='app' AND table_name LIKE 'affiliate\\_%' AND grantee<>'r72_owner' GROUP BY 1,2 ORDER BY 1,2`);
    assert.deepEqual(grants, TABLES.slice().sort().map(t => ({ g: 'r72_affiliate_definer', t, p: 'INSERT,SELECT' })));
    const role = await ownerQuery<Record<string, unknown>>(admin, `SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreaterole,
      (SELECT string_agg(pg_get_userbyid(member),',') FROM pg_auth_members WHERE roleid='r72_affiliate_definer'::regrole) AS members,
      (SELECT string_agg(pg_get_userbyid(roleid),',' ORDER BY pg_get_userbyid(roleid)) FROM pg_auth_members WHERE member='r72_affiliate_definer'::regrole) AS member_of
      FROM pg_roles WHERE rolname='r72_affiliate_definer'`);
    assert.equal(role[0]!.rolcanlogin, false);
    assert.equal(role[0]!.rolinherit, false);
    assert.equal(role[0]!.rolsuper, false);
    assert.equal(role[0]!.rolbypassrls, false);
    assert.equal(role[0]!.member_of, null, 'the definer is a member of nothing');
    assert.ok(String(role[0]!.members).split(',').every(m => m === 'r72_owner' || m === process.env.TEST_DATABASE_URL!.split('//')[1]!.split(':')[0]), String(role[0]!.members));

    // --- Append-only: not even the table owner may update, delete or truncate ---
    for (const table of TABLES) {
      for (const statement of [`UPDATE app.${table} SET workspace_id=workspace_id`, `DELETE FROM app.${table}`, `TRUNCATE app.${table} CASCADE`]) {
        await assert.rejects(ownerQuery(admin, statement), (e: { code?: string; message?: string }) => e.code === '42501' && /append-only/u.test(e.message ?? ''), `${table}: ${statement}`);
      }
    }

    // --- The 500-product cap, decided under the business's lock, and the 200-report cap ---
    const client = await content.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_id',$1,true),set_config('app.workspace_id',$2,true),set_config('app.actor_kind','user',true),set_config('app.request_id','aff-cap',true)`,
        [w.ownerA.id, w.a]);
      for (let i = 0; i < 500; i++) {
        await client.query(`SELECT app_private.affiliate_product_command($1,$2,'add',$3::jsonb)`, [w.a, hA, JSON.stringify({ commandId: randomUUID(), productId: randomUUID(), product: product(undefined, `Product ${i}`) })]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const over = await storeA.add({ workspaceId: w.a, details: { programme: 'amazon_uk', link: PAGE, productName: 'One too many', ownerUsed: false } });
    assert.equal(!over.ok && over.kind === 'refused' && over.reason, 'product_cap');
    const now = await storeA.list(w.a);
    assert.ok(now.ok);
    assert.equal(now.value.filter(p => p.status === 'active').length, 500, 'the earlier retired product does not count');
    const victim = now.value.find(p => p.status === 'active')!;
    assert.ok((await storeA.retire({ workspaceId: w.a, productId: victim.productId, expectedRevision: victim.revision })).ok);
    assert.ok((await storeA.add({ workspaceId: w.a, details: { programme: 'amazon_uk', link: PAGE, productName: 'Room again', ownerUsed: false } })).ok, 'stopping one makes room');
    const full = await storeA.add({ workspaceId: w.a, details: { programme: 'amazon_uk', link: PAGE, productName: 'Over again', ownerUsed: false } });
    assert.equal(!full.ok && full.kind === 'refused' && full.reason, 'product_cap');
    // Business B is not affected by A's cap.
    assert.ok((await storeB.add({ workspaceId: w.b, details: { programme: 'amazon_uk', link: PAGE, productName: 'B two', ownerUsed: false } })).ok);
    // Reports: up to 200 per business.
    const existing = Number((await ownerQuery<{ n: string }>(admin, 'SELECT count(*) AS n FROM app.affiliate_report_imports WHERE workspace_id=$1', [w.a]))[0]!.n);
    for (let i = existing; i < 200; i++) {
      const answer = await direct(content, ctxA, 'affiliate_report_command', w.a, hA, 'save', saveInput(randomUUID(), body.payload, createHash('sha256').update(`r${i}`).digest('hex')));
      assert.ok(answer.value, `report ${i}: ${answer.code}`);
    }
    assert.deepEqual(await direct(content, ctxA, 'affiliate_report_command', w.a, hA, 'save', saveInput(randomUUID(), body.payload, 'd'.repeat(64))), { code: '54000', detail: 'affiliate_report_cap' });
    const capped = await reportsA.save({ workspaceId: w.a, month: '2026-12', originalText: `${text}extra-21\t1\t0\t0\t${POUND}0.01\n` });
    assert.equal(!capped.ok && capped.kind === 'refused' && capped.reason, 'report_cap');
  } finally {
    for (const pool of pools) await pool.end().catch(() => undefined);
    await admin.end();
  }
});
