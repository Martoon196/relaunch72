/**
 * Migration 0157 (the founder's allow-list for "Connect email") on a disposable PostgreSQL with the real roles.
 *
 * 1. Property Predator is unchanged by 0157: the disposable database is reset and built to 0156 with the real runner,
 *    Property Predator's rows are made in a realistic live state in every 0155/0156 table (connected, approved, live,
 *    with sends, settled sends, bounces, a complaint, an unsubscribe, protection events and a pending alert), every
 *    Property Predator answer is recorded (every read, and a sequence of writes inside a rolled-back transaction),
 *    0157 is applied by the same runner, and every answer and every stored row is compared. The code's read while 0157
 *    is absent is exactly the static list.
 * 2. Allow, switch off and allow again; a second allowed business passes every 0155/0156 owner function, asks to go
 *    live and is approved, and is held with 'not_allowed' after it is switched off while its rows stay and its bounces
 *    are still recorded; a business never allowed is refused everywhere; the other-holder read; no direct table access
 *    for the app roles; no cross-business reads; the code's eligibility, store and bounce sources on the real database.
 * Postmark is not involved. All people and values are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { discoverMigrations, runMigrations } from '../../src/db/migrate.js';
import { EMAIL_ALLOWLIST_MIGRATION } from '../../src/db/email-allowlist-schema.js';
import { connectionSourceKey, databaseEligibility, EMAIL_CONNECT_BUSINESSES, EMAIL_TERMS_VERSION, EmailConnectionBounceSources, EmailConnectionForbiddenError,
  EmailConnectionNotAllowedError, EmailConnectionVault, PgEmailConnectAllowlist, PgEmailConnectionStore, staticEligibility, EmailConnectAllowlistForbiddenError,
  EmailConnectAllowlistService } from '../../src/email-connections/index.js';
import { EmailProtectionForbiddenError, EmailProtectionNotAllowedError, PgEmailProtectionStore } from '../../src/email-protection/index.js';
import { EmailBounceService } from '../../src/email-bounces/index.js';

const skip = testDatabaseSkipReason();
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97';
const OTHER_WS = '0b157000-0000-4000-8000-000000000002', SECOND = '0b157000-0000-4000-8000-000000000003', THIRD = '0b157000-0000-4000-8000-000000000004';
const hash = (token: string) => createHash('sha256').update(token).digest();
type Admin = Awaited<ReturnType<typeof openTestDatabase>>;

async function session(admin: Admin, user: string, workspace: string): Promise<string> {
  const token = `email-allow-${randomUUID()}${randomUUID()}`;
  await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 hours')`,
    [hash(token), hash(`csrf${token}`), user, workspace]);
  return token;
}

/** People and businesses: PP (owner, admin), OTHER (never allowed), SECOND and THIRD (the founder's own content businesses). */
async function seedPeople(admin: Admin) {
  const ppOrg = randomUUID(), otherOrg = randomUUID(), secondOrg = randomUUID();
  const owner = randomUUID(), admin2 = randomUUID(), founder = randomUUID(), stranger = randomUUID(), secondOwner = randomUUID();
  await ownerQuery(admin, `DO $s$ BEGIN
    PERFORM set_config('app.request_id','email-allowlist-fixture',true);
    INSERT INTO app.organizations(id,name,slug,kind) VALUES('${ppOrg}','Property Predator','pp-allow-proof','direct_customer'),
     ('${otherOrg}','Other','other-allow-proof','direct_customer'),('${secondOrg}','Second Co','second-allow-proof','direct_customer');
    INSERT INTO app.workspaces(id,organization_id,name,slug,timezone) VALUES('${PP}','${ppOrg}','Property Predator Growth HQ','pp-allow-proof','Europe/London'),
     ('${OTHER_WS}','${otherOrg}','Other','other-allow-proof','Europe/London'),('${SECOND}','${secondOrg}','Second Café & Co!','second-allow-proof','Europe/London'),
     ('${THIRD}','${secondOrg}','Third Business','third-allow-proof','Europe/London');
    INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES
     ('${owner}','owner-allow@pp-allow-proof.co.uk','Pat Owner','active',clock_timestamp()),
     ('${admin2}','admin-allow@pp-allow-proof.co.uk','Ada Admin','active',clock_timestamp()),
     ('${founder}','founder-allow@pp-allow-proof.co.uk','Fay Founder','active',clock_timestamp()),
     ('${stranger}','stranger-allow@other-allow-proof.co.uk','Sam Stranger','active',clock_timestamp()),
     ('${secondOwner}','owner-allow@second-allow-proof.co.uk','Sid Second','active',clock_timestamp());
    INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${ppOrg}','${owner}','owner','active'),('${ppOrg}','${admin2}','admin','active'),
     ('${otherOrg}','${stranger}','owner','active'),('${secondOrg}','${secondOwner}','owner','active'),('${secondOrg}','${founder}','admin','active');
    INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${PP}','${ppOrg}','${owner}','owner','active'),
     ('${PP}','${ppOrg}','${admin2}','admin','active'),('${OTHER_WS}','${otherOrg}','${stranger}','owner','active'),
     ('${SECOND}','${secondOrg}','${secondOwner}','owner','active'),('${SECOND}','${secondOrg}','${founder}','admin','active'),
     ('${THIRD}','${secondOrg}','${founder}','admin','active');
  END $s$`);
  await ownerQuery(admin, 'INSERT INTO app_private.seo_limit_operators(user_id) VALUES($1) ON CONFLICT DO NOTHING', [founder]);
  return { owner, admin2, founder, stranger, secondOwner, secondOrg, ownerToken: await session(admin, owner, PP), adminToken: await session(admin, admin2, PP),
    founderToken: await session(admin, founder, THIRD), strangerToken: await session(admin, stranger, OTHER_WS), secondToken: await session(admin, secondOwner, SECOND) };
}

async function clearEmailTables(admin: Admin): Promise<void> {
  for (const table of ['email_send_events', 'email_protection_alerts', 'email_sending_controls', 'email_account_events', 'email_protection_events', 'email_connection_events', 'email_connections']) {
    await ownerQuery(admin, `DELETE FROM app_private.${table}`).catch(() => undefined);
  }
  await ownerQuery(admin, `UPDATE app_private.email_account_protection SET state='ok',reason=NULL,since=NULL,counted_since=NULL`).catch(() => undefined);
}

/** The allow-list back to what 0157 seeds: Property Predator only, allowed. */
async function resetAllowlist(admin: Admin): Promise<void> {
  await ownerQuery(admin, `DELETE FROM app_private.email_connect_allowlist_events WHERE workspace_id<>$1`, [PP]);
  await ownerQuery(admin, `DELETE FROM app_private.email_connect_allowlist WHERE workspace_id<>$1`, [PP]);
  await ownerQuery(admin, `UPDATE app_private.email_connect_allowlist SET revoked_by=NULL,revoked_at=NULL,revoked_reason=NULL WHERE workspace_id=$1`, [PP]);
}

/** A business connected, verified, with footer and a passed test, as the 0155/0156 functions make it. */
async function connect(connections: PgEmailConnectionStore, store: PgEmailProtectionStore, vault: EmailConnectionVault, token: string, ws: string, domain: string, serverId: number) {
  assert.equal(await connections.acceptTerms(token, ws, EMAIL_TERMS_VERSION), 'accepted');
  assert.equal(await connections.begin(token, ws, { domain, fromName: 'Sender', fromAddress: `hello@${domain}`, replyTo: null }, EMAIL_TERMS_VERSION), 'started');
  await connections.intend(token, ws, 'server');
  await connections.saveSealed(token, ws, 'server_token', vault.seal(ws, 'server_token', `srv-token-${ws.slice(0, 8)}-0123456789`));
  await connections.record(token, ws, 'server', 'created', { serverId });
  await connections.intend(token, ws, 'stream'); await connections.record(token, ws, 'stream', 'created', { stream: 'broadcast' });
  await connections.intend(token, ws, 'secret'); await connections.saveSealed(token, ws, 'webhook_secret', vault.seal(ws, 'webhook_secret', `whsec-${ws.slice(0, 8)}-0123456789-abcdef`));
  await connections.intend(token, ws, 'webhook'); await connections.record(token, ws, 'webhook', 'created', { webhookId: serverId + 1 });
  await connections.intend(token, ws, 'domain');
  const dns = { dkim: { host: `x._domainkey.${domain}`, value: 'k=rsa; p=X', verified: true }, returnPath: { host: `pm.${domain}`, value: 'pm.mtasv.net', verified: true } };
  await connections.record(token, ws, 'domain', 'created', { domainId: serverId + 2, dns });
  assert.equal(await connections.checked(token, ws, dns, true, true), 'verified');
  await store.details(token, ws, { businessName: 'Business Ltd', postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: [`tester@${domain}`] });
  assert.equal(await store.testReserve(token, ws, `test:${ws.slice(0, 8)}`), 'ok');
  await store.testResult(token, ws, `test:${ws.slice(0, 8)}`, true);
}

async function prefixDirectory(count: number): Promise<string> {
  const prefix = (await discoverMigrations()).slice(0, count);
  const directory = await mkdtemp(path.join(tmpdir(), 'r72-allowlist-0156-'));
  await Promise.all(prefix.map(m => writeFile(path.join(directory, m.filename), m.sql, 'utf8')));
  return directory;
}

/** test:db:reset (drops the app schemas and roles on the guarded disposable database), as its own process. */
async function resetDisposable(): Promise<void> {
  const child = spawn(process.execPath, ['--import', './test/windows-node24-shim.mjs', '--import', 'tsx', 'test/db/reset-disposable.ts'],
    { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  const [code] = await once(child, 'exit') as [number | null];
  assert.equal(code, 0, 'the disposable reset ran');
}

/**
 * An answer made comparable across the two runs: the 'now' a count carries is dropped, and a moment written during
 * this run (at or after `since`, the database clock when the run began) reads '<written now>'. Every stored moment
 * (before the run) is compared exactly.
 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const strip = (value: unknown, since: number): unknown => Array.isArray(value) ? value.map(item => strip(item, since))
  : typeof value === 'string' && ISO.test(value) && Date.parse(value) >= since ? '<written now>'
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'now').map(([key, item]) => [key, strip(item, since)])) : value;

async function answer(client: pg.Pool | pg.PoolClient, sql: string, values: unknown[], since: number): Promise<unknown> {
  try { return strip((await client.query(sql, values)).rows[0]?.value, since); }
  catch (error) { const e = error as { code?: string; message?: string; detail?: string }; return { error: e.code, message: e.message, detail: e.detail ?? null }; }
}

test('0157 applied to a database at 0156 with Property Predator live changes no Property Predator answer and no stored row', { skip, timeout: 600_000 }, async () => {
  let admin = await openTestDatabase();
  const pools: pg.Pool[] = [];
  try {
    // Build the database to exactly 0156 with the real runner (the reset drops the app schemas and roles).
    await resetDisposable();
    const before156 = await prefixDirectory(156);
    await runMigrations(admin, before156);
    const ledger = await ownerQuery<{ filename: string }>(admin, 'SELECT filename FROM app_private.schema_migrations ORDER BY filename DESC LIMIT 1');
    assert.equal(ledger[0]!.filename, '0156_email_sending_protection.sql');
    const identity = await loginRole(admin, 'r72_identity_command');
    pools.push(identity);
    await resetIdentityTables(admin);
    const p = await seedPeople(admin);
    const connections = new PgEmailConnectionStore(identity, { eligibility: staticEligibility }), store = new PgEmailProtectionStore(identity);
    const vault = new EmailConnectionVault(Buffer.alloc(32, 11));

    // The code's read while 0157 is absent: exactly the static list, one informational line.
    const lines: string[] = [];
    const absent = await databaseEligibility(new PgEmailConnectAllowlist(identity, { log: line => lines.push(line) }), { log: line => lines.push(line) });
    assert.equal(absent.fromDatabase, false);
    assert.deepEqual(absent.list(), EMAIL_CONNECT_BUSINESSES);
    await absent.refresh();
    assert.deepEqual(lines.map(line => JSON.parse(line).event), ['email.connections.allowlist_absent'], 'one informational line, once');

    // Property Predator live: connected, approved, live, with sends, bounces, a complaint, an unsubscribe and alerts.
    await connect(connections, store, vault, p.ownerToken, PP, 'mail.pp-allow-proof.co.uk', 6100);
    assert.equal(await store.command(p.ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested');
    const version = (await store.founderView(p.founderToken)).businesses.find(b => b.workspaceId === PP)!.rowVersion;
    assert.equal(await store.founderAct(p.founderToken, PP, 'approve', version), 'done');
    for (let i = 0; i < 6; i++) assert.equal(await store.reserve(PP, `lease:live-${i}`, 'live'), 'ok');
    for (let i = 0; i < 5; i++) await store.settle(PP, `lease:live-${i}`, i !== 4);
    const at = Date.now() - 60_000;
    for (const [kind, key] of [['hard_bounce', 'pm:b1'], ['soft_bounce', 'pm:b2'], ['complaint', 'pm:c1'], ['unsubscribe', 'pm:u1'], ['blocked', 'pm:k1']] as const) {
      assert.equal(await store.count(PP, kind, key, at), 'recorded');
    }
    assert.equal((await store.sendingConfig(PP))!.mode, 'live');

    const ownerHash = hash(p.ownerToken), founderHash = hash(p.founderToken), adminHash = hash(p.adminToken), strangerHash = hash(p.strangerToken);
    const reads: readonly [string, unknown[]][] = [
      ['SELECT app_private.email_connection_state($1,$2) AS value', [ownerHash, PP]],
      ['SELECT app_private.email_connection_sealed($1,$2) AS value', [ownerHash, PP]],
      ['SELECT app_private.email_connection_sources() AS value', []],
      ['SELECT app_private.email_sending_state($1,$2) AS value', [ownerHash, PP]],
      ['SELECT app_private.email_sending_config($1) AS value', [PP]],
      ['SELECT app_private.email_protection_numbers() AS value', []],
      ['SELECT app_private.email_protection_status() AS value', []],
      ['SELECT app_private.email_protection_founder_view($1) AS value', [founderHash]],
      ['SELECT app_private.email_connection_state($1,$2) AS value', [adminHash, PP]],
      ['SELECT app_private.email_sending_state($1,$2) AS value', [strangerHash, PP]],
      ['SELECT app_private.email_protection_founder_view($1) AS value', [ownerHash]],
    ];
    // Writes, each answer recorded, inside one transaction that is rolled back (so both runs start from the same rows).
    const writes = (version: number): readonly [string, unknown[]][] => [
      ['SELECT app_private.email_send_reserve($1,$2,$3) AS value', [PP, 'lease:probe-1', 'live']],
      ['SELECT app_private.email_send_reserve($1,$2,$3) AS value', [PP, 'lease:probe-1', 'live']],
      ['SELECT app_private.email_send_settle($1,$2,$3) AS value', [PP, 'lease:probe-1', true]],
      ['SELECT app_private.email_send_reserve($1,$2,$3) AS value', [PP, 'lease:live-5', 'live']],
      ['SELECT app_private.email_send_reserve($1,$2,$3) AS value', [PP, 'test:probe-t', 'test']],
      ['SELECT app_private.email_counter_record($1,$2,$3,$4) AS value', [PP, 'hard_bounce', 'pm:probe-b', new Date(at).toISOString()]],
      ['SELECT app_private.email_counter_record($1,$2,$3,$4) AS value', [PP, 'soft_bounce', 'pm:probe-b', new Date(at).toISOString()]],
      ['SELECT app_private.email_counter_record($1,$2,$3,$4) AS value', [OTHER_WS, 'soft_bounce', 'pm:other', new Date(at).toISOString()]],
      ['SELECT app_private.email_sending_command($1,$2,$3,$4,$5) AS value', [ownerHash, PP, 'pause', EMAIL_TERMS_VERSION, false]],
      ['SELECT app_private.email_send_reserve($1,$2,$3) AS value', [PP, 'lease:probe-2', 'live']],
      ['SELECT app_private.email_sending_command($1,$2,$3,$4,$5) AS value', [ownerHash, PP, 'resume', EMAIL_TERMS_VERSION, false]],
      ['SELECT app_private.email_sending_command($1,$2,$3,$4,$5) AS value', [ownerHash, PP, 'live', EMAIL_TERMS_VERSION, true]],
      ['SELECT app_private.email_sending_command($1,$2,$3,$4,$5) AS value', [adminHash, PP, 'live', EMAIL_TERMS_VERSION, true]],
      ['SELECT app_private.email_sending_test_reserve($1,$2,$3) AS value', [ownerHash, PP, 'test:probe-x']],
      ['SELECT app_private.email_sending_test_result($1,$2,$3,$4) AS value', [ownerHash, PP, 'test:probe-x', true]],
      ['SELECT app_private.email_protection_founder_act($1,$2,$3,$4) AS value', [founderHash, PP, 'approve', version]],
      ['SELECT app_private.email_protection_founder_act($1,$2,$3,$4) AS value', [founderHash, PP, 'lift', version - 1]],
      ['SELECT app_private.email_protection_apply($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12) AS value', [PP, 'slowed', 'paused', 'paused', 'own', 'x', '{}', 0, 0, null, null, null]],
      ['SELECT app_private.email_sending_details($1,$2,$3,$4,$5) AS value', [ownerHash, PP, 'Property Predator Ltd', '2 High Street, Leeds LS1 1AA', ['a@pp-allow-proof.co.uk']]],
      ['SELECT app_private.email_sending_config($1) AS value', [PP]],
      ['SELECT app_private.email_protection_alerts_claim($1) AS value', [10]],
      ['SELECT app_private.email_send_events_prune($1) AS value', [PP]],
      ['SELECT app_private.email_connection_accept_terms($1,$2,$3) AS value', [ownerHash, PP, EMAIL_TERMS_VERSION]],
      ['SELECT app_private.email_connection_begin($1,$2,$3,$4,$5,$6,$7) AS value', [ownerHash, PP, 'mail.pp-allow-proof.co.uk', 'PP', 'hello@mail.pp-allow-proof.co.uk', null, EMAIL_TERMS_VERSION]],
      ['SELECT app_private.email_connection_disconnect($1,$2)::text AS value', [ownerHash, PP]],
      ['SELECT app_private.email_connection_sources() AS value', []],
      ['SELECT app_private.email_connection_state($1,$2) AS value', [ownerHash, PP]],
    ];
    const rows = async () => {
      const out: Record<string, unknown> = {};
      for (const table of ['email_connections', 'email_connection_events', 'email_protection_events', 'email_sending_controls', 'email_send_events', 'email_protection_alerts',
        'email_account_protection', 'email_account_events']) {
        out[table] = (await ownerQuery<{ r: unknown }>(admin, `SELECT row_to_json(x) AS r FROM app_private.${table} x ORDER BY row_to_json(x)::text`)).map(r => r.r);
      }
      return out;
    };
    const record = async () => {
      const since = Date.parse((await ownerQuery<{ t: string }>(admin, `SELECT to_json(clock_timestamp())#>>'{}' AS t`))[0]!.t);
      const readAnswers: unknown[] = [];
      for (const [sql, values] of reads) readAnswers.push(await answer(identity, sql, values, since));
      const client = await identity.connect();
      const writeAnswers: unknown[] = [];
      try {
        await client.query('BEGIN');
        for (const [sql, values] of writes(version + 1)) {
          await client.query('SAVEPOINT probe');
          const result = await answer(client, sql, values, since);
          await client.query(typeof result === 'object' && result && 'error' in result ? 'ROLLBACK TO SAVEPOINT probe' : 'RELEASE SAVEPOINT probe');
          writeAnswers.push(result);
        }
      } finally { await client.query('ROLLBACK'); client.release(); }
      return { readAnswers, writeAnswers, rows: await rows() };
    };

    const before = await record();
    // A sanity check of the recording: the probe really exercised the live path.
    assert.deepEqual(before.writeAnswers.slice(0, 5), ['ok', 'replayed', 'accepted', 'replayed', 'ok']);
    assert.deepEqual(before.writeAnswers.slice(8, 12), ['paused', 'owner_paused', 'resumed', 'unchanged']);

    // 0157, by the same runner, on this live database (and nothing after it: later files are separate releases).
    const result = await runMigrations(admin, await prefixDirectory(157));
    assert.deepEqual(result.applied, [EMAIL_ALLOWLIST_MIGRATION]);
    const after = await record();
    assert.deepEqual(after.readAnswers, before.readAnswers, 'every Property Predator read answers exactly as before');
    assert.deepEqual(after.writeAnswers, before.writeAnswers, 'every Property Predator write answers exactly as before');
    assert.deepEqual(after.rows, before.rows, '0157 changed no stored row');

    // Property Predator's naming at Postmark: the database list gives exactly the facts the code used before.
    const present = await databaseEligibility(new PgEmailConnectAllowlist(identity));
    assert.equal(present.fromDatabase, true);
    assert.deepEqual(present.list(), EMAIL_CONNECT_BUSINESSES);
    assert.equal(present.business(PP)!.sourceKey, 'conn-d975ff66336a46c2b36bd7095a11af97');
    // Not a Property Predator answer: a business never allowed is now told apart from a non-owner (DETAIL only).
    const other = await answer(identity, 'SELECT app_private.email_connection_state($1,$2) AS value', [strangerHash, OTHER_WS], Date.now());
    assert.deepEqual(other, { error: '42501', message: 'Email is not switched on for this business', detail: 'email_connect_not_allowed' });
  } finally {
    for (const pool of pools) await pool.end().catch(() => undefined);
    await admin.end();
  }
  // Leave the database complete for the next test file.
  admin = await openTestDatabase();
  await admin.end();
});

test('0157 on real roles: allow, switch off, allow again; a second business end to end; refusals, the other-holder read and no direct access', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command'), web = await loginRole(admin, 'r72_web'), content = await loginRole(admin, 'r72_content_command');
  try {
    await resetIdentityTables(admin);
    await clearEmailTables(admin);
    await resetAllowlist(admin);
    const p = await seedPeople(admin);
    for (const ws of [PP, SECOND, THIRD]) {
      await ownerQuery(admin, `INSERT INTO app.seo_blog_brands(workspace_id,organization_id,created_by_user_id,settings) SELECT w.id,w.organization_id,$2,'{}'::jsonb FROM app.workspaces w WHERE w.id=$1`,
        [ws, p.founder]);
    }
    const allowlist = new PgEmailConnectAllowlist(identity);
    const eligibility = await databaseEligibility(allowlist);
    const connections = new PgEmailConnectionStore(identity, { eligibility }), store = new PgEmailProtectionStore(identity);
    const vault = new EmailConnectionVault(Buffer.alloc(32, 12));

    // Seeded: Property Predator only, by the name the code uses.
    assert.deepEqual(await allowlist.active(), [{ workspaceId: PP, name: 'Property Predator' }]);
    assert.equal(eligibility.fromDatabase, true);
    assert.deepEqual(eligibility.list(), EMAIL_CONNECT_BUSINESSES);

    // A business never allowed is refused everywhere: its owner, its rows, its sends.
    for (const ws of [SECOND, OTHER_WS]) {
      const token = ws === SECOND ? p.secondToken : p.strangerToken;
      await assert.rejects(connections.state(token, ws), EmailConnectionNotAllowedError);
      await assert.rejects(connections.acceptTerms(token, ws, EMAIL_TERMS_VERSION), EmailConnectionForbiddenError);
      await assert.rejects(store.state(token, ws), EmailProtectionNotAllowedError);
      assert.equal(await store.reserve(ws, 'lease:never', 'live'), 'not_connected');
      assert.equal(await store.count(ws, 'hard_bounce', 'pm:never', Date.now()), 'ignored');
      await expectPostgresError(ownerQuery(admin, `INSERT INTO app_private.email_connections(workspace_id,status,created_by_user_id) VALUES($1,'not_connected',$2)`, [ws, p.owner]), '23514');
      await expectPostgresError(ownerQuery(admin, `INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,state,occurred_at) VALUES($1,'hard_bounce','k','fact',now())`, [ws]), '23514');
      await expectPostgresError(ownerQuery(admin, `INSERT INTO app_private.email_protection_alerts(workspace_id,audience,kind) VALUES($1,'owner','x')`, [ws]), '23514');
    }
    await ownerQuery(admin, `INSERT INTO app_private.email_protection_alerts(audience,kind) VALUES('founder','account_test')`);
    await ownerQuery(admin, `DELETE FROM app_private.email_protection_alerts WHERE kind='account_test'`);

    // Only the founder sees and changes the list; candidates are the founder's own businesses not yet on it.
    for (const token of [p.ownerToken, p.secondToken, p.strangerToken, 'nope']) {
      await assert.rejects(allowlist.founderView(token), EmailConnectAllowlistForbiddenError);
      await assert.rejects(allowlist.allow(token, SECOND, null), EmailConnectAllowlistForbiddenError);
      await assert.rejects(allowlist.revoke(token, PP, 'x'), EmailConnectAllowlistForbiddenError);
    }
    let view = await allowlist.founderView(p.founderToken);
    assert.deepEqual(view.candidates.map(c => c.workspaceId).sort(), [SECOND, THIRD].sort(), 'PP is listed already; OTHER is not the founder\'s');
    assert.deepEqual(view.businesses.map(b => [b.workspaceId, b.name, b.hasConnection, b.revokedAt]), [[PP, 'Property Predator', false, null]]);
    assert.equal(await allowlist.allow(p.founderToken, randomUUID(), null), 'no_workspace');
    assert.equal(await allowlist.reallow(p.founderToken, SECOND, null), 'not_listed');
    assert.equal(await allowlist.revoke(p.founderToken, SECOND, 'x'), 'not_listed');
    assert.equal(await allowlist.allow(p.founderToken, SECOND, 'First other business'), 'allowed');
    assert.equal(await allowlist.allow(p.founderToken, SECOND, null), 'already_allowed');
    assert.equal(await allowlist.reallow(p.founderToken, SECOND, null), 'already_allowed');
    // The name at Postmark is the workspace name in plain ASCII.
    assert.deepEqual(await allowlist.active(), [{ workspaceId: SECOND, name: 'Second Caf & Co' }, { workspaceId: PP, name: 'Property Predator' }].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)));
    await eligibility.refresh();
    assert.equal(eligibility.business(SECOND)!.sourceKey, connectionSourceKey(SECOND));

    // The second business passes every 0155/0156 owner function, asks to go live and is approved.
    await connect(connections, store, vault, p.secondToken, SECOND, 'mail.second-allow-proof.co.uk', 7100);
    assert.equal((await connections.state(p.secondToken, SECOND)).status, 'verified');
    assert.ok((await connections.sealed(p.secondToken, SECOND)).serverToken);
    assert.deepEqual((await connections.sources())!.map(s => s.workspaceId), [SECOND]);
    assert.equal((await store.state(p.secondToken, SECOND)).testCurrent, true);
    assert.equal(await store.command(p.secondToken, SECOND, 'live', EMAIL_TERMS_VERSION, true), 'requested');
    let status = await store.founderView(p.founderToken);
    const second = () => status.businesses.find(b => b.workspaceId === SECOND)!;
    assert.ok(second().goLiveRequestedAt);
    assert.equal(await store.founderAct(p.founderToken, SECOND, 'approve', second().rowVersion), 'done');
    assert.equal((await store.sendingConfig(SECOND))!.mode, 'live');
    assert.equal(await store.reserve(SECOND, 'lease:s1', 'live'), 'ok');
    await store.settle(SECOND, 'lease:s1', true);
    assert.equal(await store.count(SECOND, 'hard_bounce', 'pm:s-b1', Date.now()), 'recorded');
    assert.ok((await store.numbers())!.businesses.some(b => b.workspaceId === SECOND));

    // No cross-business reads: each owner only their own.
    await assert.rejects(connections.state(p.secondToken, PP), EmailConnectionForbiddenError);
    await assert.rejects(connections.state(p.ownerToken, SECOND), EmailConnectionForbiddenError);
    await assert.rejects(store.state(p.ownerToken, SECOND), EmailProtectionForbiddenError);

    // The other-holder read: yes or no only, for an owner of an allowed business, about OTHER businesses' rows.
    await connect(connections, store, vault, p.ownerToken, PP, 'mail.pp-allow-proof.co.uk', 6100);
    assert.equal(await connections.otherConnectionHolds(p.ownerToken, PP, { id: null, name: 'mail.second-allow-proof.co.uk' }), true);
    assert.equal(await connections.otherConnectionHolds(p.ownerToken, PP, { id: 7102, name: 'unused-allow-proof.co.uk' }), true, 'by Postmark domain id');
    assert.equal(await connections.otherConnectionHolds(p.ownerToken, PP, { id: 9999, name: 'unused-allow-proof.co.uk' }), false);
    assert.equal(await connections.otherConnectionHolds(p.ownerToken, PP, { id: 6102, name: 'mail.pp-allow-proof.co.uk' }), false, 'its own row is not another business');
    assert.equal(await connections.otherConnectionHolds(p.secondToken, SECOND, { id: null, name: 'MAIL.PP-ALLOW-PROOF.CO.UK' }), true);
    await assert.rejects(connections.otherConnectionHolds(p.strangerToken, OTHER_WS, { id: null, name: 'mail.pp-allow-proof.co.uk' }), EmailConnectionForbiddenError);
    await assert.rejects(connections.otherConnectionHolds(p.adminToken, PP, { id: null, name: 'mail.second-allow-proof.co.uk' }), EmailConnectionForbiddenError);
    const raw = (await identity.query('SELECT app_private.email_connection_domain_held($1,$2,$3,$4) AS v', [hash(p.ownerToken), PP, null, 'mail.second-allow-proof.co.uk'])).rows[0].v;
    assert.equal(raw, true, 'a boolean: nothing else about the other business');

    // Switching off: a reason is required; then every send holds with 'not_allowed', and nothing is deleted.
    const counted = async (ws: string) => Number((await ownerQuery<{ n: string }>(admin, `SELECT (SELECT count(*) FROM app_private.email_send_events WHERE workspace_id=$1)
      +(SELECT count(*) FROM app_private.email_connection_events WHERE workspace_id=$1)+(SELECT count(*) FROM app_private.email_protection_events WHERE workspace_id=$1)
      +(SELECT count(*) FROM app_private.email_sending_controls WHERE workspace_id=$1)+(SELECT count(*) FROM app_private.email_connections WHERE workspace_id=$1) AS n`, [ws]))[0]!.n);
    const kept = await counted(SECOND);
    assert.equal(await allowlist.revoke(p.founderToken, SECOND, '   '), 'reason_required');
    await assert.rejects(allowlist.revoke(p.founderToken, SECOND, 'x'.repeat(301)), /Invalid input/u);
    assert.equal(await allowlist.revoke(p.founderToken, SECOND, 'Too many complaints from this list'), 'revoked');
    assert.equal(await allowlist.revoke(p.founderToken, SECOND, 'again'), 'already_revoked');
    assert.equal(await allowlist.allow(p.founderToken, SECOND, null), 'revoked', 'allowing a switched-off business again is a separate action');
    assert.equal(await counted(SECOND), kept, 'nothing is deleted');
    assert.equal(await store.reserve(SECOND, 'lease:s2', 'live'), 'not_allowed');
    assert.equal(await store.reserve(SECOND, 'lease:s1', 'live'), 'not_allowed', 'a replay of an earlier reservation holds too');
    assert.equal(await store.reserve(SECOND, 'test:s3', 'test'), 'not_allowed');
    await assert.rejects(store.testReserve(p.secondToken, SECOND, 'test:s4'), EmailProtectionNotAllowedError);
    await assert.rejects(store.command(p.secondToken, SECOND, 'live', EMAIL_TERMS_VERSION, true), EmailProtectionNotAllowedError);
    await assert.rejects(connections.state(p.secondToken, SECOND), EmailConnectionNotAllowedError);
    await assert.rejects(connections.begin(p.secondToken, SECOND, { domain: 'x-allow-proof.co.uk', fromName: 'X', fromAddress: 'a@x-allow-proof.co.uk', replyTo: null }, EMAIL_TERMS_VERSION), EmailConnectionNotAllowedError);
    status = await store.founderView(p.founderToken);
    assert.equal(await store.founderAct(p.founderToken, SECOND, 'approve', second().rowVersion), 'not_allowed', 'the founder cannot approve a switched-off business');
    // Its bounces are still recorded, and its stored row still feeds its bounce webhook.
    assert.equal(await store.count(SECOND, 'complaint', 'pm:s-c1', Date.now()), 'recorded');
    assert.equal(await store.count(SECOND, 'complaint', 'pm:s-c1', Date.now()), 'exists');
    assert.deepEqual((await connections.sources())!.map(s => s.workspaceId).sort(), [PP, SECOND].sort());
    // Property Predator is untouched by another business's switch-off.
    assert.equal(await store.reserve(PP, 'lease:pp-after', 'live'), 'not_live');
    view = await allowlist.founderView(p.founderToken);
    const off = view.businesses.find(b => b.workspaceId === SECOND)!;
    assert.deepEqual([off.revokedReason, off.revokedByName, off.hasConnection, off.status, off.mode], ['Too many complaints from this list', 'Fay Founder', true, 'verified', 'live']);
    assert.equal(view.businesses[view.businesses.length - 1]!.workspaceId, SECOND, 'switched-off businesses are listed last');

    // The code, on this database: the eligibility drops it at its next read; bounce sources keep following its row,
    // in this process and in one started now.
    await eligibility.refresh();
    assert.equal(eligibility.allowed(SECOND), false);
    for (const label of ['running', 'restarted']) {
      const list = label === 'running' ? eligibility : await databaseEligibility(new PgEmailConnectAllowlist(identity));
      assert.equal(list.allowed(SECOND), false, label);
      const bounces = new EmailBounceService({ config: { sources: [], blockers: [] }, apiFor: () => null });
      const sources = new EmailConnectionBounceSources({ store: connections, vault, service: bounces, eligibility: list,
        refreshEligibility: 'refresh' in list ? () => list.refresh() : undefined });
      await sources.refresh();
      assert.ok(bounces.dynamicSourceKeys().includes(connectionSourceKey(SECOND)), `${label}: the switched-off business's webhook is still answered`);
      assert.equal(sources.handles(connectionSourceKey(SECOND)), true);
    }

    // Allow again: recorded with who and when; sending goes on as it was.
    assert.equal(await allowlist.reallow(p.founderToken, SECOND, null), 'reallowed');
    assert.equal(await store.reserve(SECOND, 'lease:s5', 'live'), 'ok');
    const events = await ownerQuery<{ action: string; actor: string | null }>(admin, `SELECT action,actor_user_id AS actor FROM app_private.email_connect_allowlist_events
      WHERE workspace_id=$1 ORDER BY occurred_at,id`, [SECOND]);
    assert.deepEqual(events.map(e => [e.action, e.actor]), [['allowed', p.founder], ['revoked', p.founder], ['reallowed', p.founder]]);
    const row = (await ownerQuery<Record<string, unknown>>(admin, 'SELECT * FROM app_private.email_connect_allowlist WHERE workspace_id=$1', [SECOND]))[0]!;
    assert.deepEqual([row.revoked_at, row.revoked_by, row.revoked_reason, row.allowed_by, row.note, row.row_version], [null, null, null, p.founder, 'First other business', '3']);

    // Property Predator can be switched off like any other (the founder's call), and allowed again.
    assert.equal(await allowlist.revoke(p.founderToken, PP, 'Founder test of the switch'), 'revoked');
    assert.equal(await store.reserve(PP, 'lease:pp-off', 'live'), 'not_allowed');
    await assert.rejects(connections.state(p.ownerToken, PP), EmailConnectionNotAllowedError);
    assert.equal(await allowlist.reallow(p.founderToken, PP, null), 'reallowed');
    assert.equal((await connections.state(p.ownerToken, PP)).status, 'verified');

    // The founder service: actions, the plain answers, and this process reads the list again at once.
    const service = new EmailConnectAllowlistService({ store: allowlist, eligibility, founder: async identity => identity.sessionToken === p.founderToken });
    const founderIdentity = { sessionToken: p.founderToken, userId: p.founder, workspaceId: THIRD, userEmail: 'founder-allow@pp-allow-proof.co.uk' } as never;
    assert.equal((await service.act(founderIdentity, 'allow', THIRD, null)).ok, true);
    assert.equal(eligibility.allowed(THIRD), true, 'read again at once after a change');
    assert.equal((await service.act(founderIdentity, 'revoke', THIRD, '')).message, 'Say in a few words why email is being switched off, then press the button again.');
    assert.equal((await service.act({ ...(founderIdentity as object), sessionToken: p.ownerToken } as never, 'allow', THIRD, null)).message, 'Only the founder can do this.');

    // No direct table access for app roles; the definers hold exactly their own grants.
    for (const pool of [identity, web, content]) {
      await expectPostgresError(pool.query('SELECT * FROM app_private.email_connect_allowlist'), '42501');
      await expectPostgresError(pool.query('SELECT * FROM app_private.email_connect_allowlist_events'), '42501');
    }
    for (const pool of [web, content]) {
      for (const sql of ['SELECT app_private.email_connect_allowlist_active()', `SELECT app_private.email_connect_revoke('\\x00'::bytea,'${PP}','x')`,
        `SELECT app_private.email_connection_domain_held('\\x00'::bytea,'${PP}',1,'x')`]) await expectPostgresError(pool.query(sql), '42501');
    }
    for (const helper of ['email_connect_allowed', 'email_connect_workspace', 'email_connect_connection', 'email_connect_founder_businesses']) {
      await expectPostgresError(identity.query(`SELECT app_private.${helper}($1)`, [PP]), '42501');
    }
    await expectPostgresError(identity.query(`SELECT app_private.email_connect_founder_note($1,'x')`, [hash(p.founderToken)]), '42501');
    const grants = await ownerQuery<{ g: string; t: string; p: string }>(admin, `SELECT g.grantee AS g,g.table_name AS t,string_agg(g.privilege_type,',' ORDER BY g.privilege_type) AS p
      FROM information_schema.role_table_grants g WHERE g.table_schema='app_private' AND g.table_name LIKE 'email_connect_allowlist%' AND g.grantee NOT IN('r72_owner') GROUP BY 1,2 ORDER BY 1,2`);
    assert.deepEqual(grants, [{ g: 'r72_email_allowlist_definer', t: 'email_connect_allowlist', p: 'INSERT,SELECT' },
      { g: 'r72_email_allowlist_definer', t: 'email_connect_allowlist_events', p: 'INSERT,SELECT' }], 'append-only events; updates of named columns only');
    const columns = await ownerQuery<{ c: string }>(admin, `SELECT column_name AS c FROM information_schema.column_privileges WHERE table_schema='app_private'
      AND table_name='email_connect_allowlist' AND grantee='r72_email_allowlist_definer' AND privilege_type='UPDATE' ORDER BY 1`);
    assert.deepEqual(columns.map(c => c.c), ['allowed_at', 'allowed_by', 'note', 'revoked_at', 'revoked_by', 'revoked_reason', 'row_version', 'updated_at']);
    const forced = await ownerQuery<{ n: string }>(admin, `SELECT count(*) AS n FROM pg_class WHERE oid IN('app_private.email_connect_allowlist'::regclass,
      'app_private.email_connect_allowlist_events'::regclass) AND relrowsecurity AND relforcerowsecurity`);
    assert.equal(Number(forced[0]!.n), 2);
    const role = await ownerQuery<{ ok: boolean }>(admin, `SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolbypassrls AND NOT rolsuper AS ok FROM pg_roles WHERE rolname='r72_email_allowlist_definer'`);
    assert.equal(role[0]!.ok, true);
  } finally {
    await resetAllowlist(admin).catch(() => undefined);
    await clearEmailTables(admin).catch(() => undefined);
    for (const pool of [identity, web, content]) await pool.end().catch(() => undefined);
    await admin.end();
  }
});
