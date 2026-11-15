/**
 * Migration 0155 ("Connect email") on a disposable PostgreSQL with the real roles: only an active owner of the
 * Property Predator organisation who can manage its workspace, with it selected, may connect; any other workspace is
 * refused by the pin; other database roles cannot call the functions or read the tables; the read for the page never
 * returns a sealed value; both event tables are append-only; the email rules gate begin; the protection groundwork
 * columns have their defaults and CHECKs. Postmark is not involved. All people and values are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { EMAIL_TERMS_VERSION, EmailConnectionForbiddenError, EmailConnectionVault, PgEmailConnectionStore } from '../../src/email-connections/index.js';

const skip = testDatabaseSkipReason();
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', OTHER_WS = '0b155000-0000-4000-8000-000000000002', PP_SECOND = '0b155000-0000-4000-8000-000000000003';
const DOMAIN = 'mail.pp-connect-proof.co.uk';
const FORM = { domain: DOMAIN, fromName: 'Property Predator', fromAddress: `hello@${DOMAIN}`, replyTo: 'team@pp-connect-proof.co.uk' };
const SECRET = 'whsec-integration-proof-0123456789-abcdef';

type Admin = Awaited<ReturnType<typeof openTestDatabase>>;
async function session(admin: Admin, user: string, workspace: string): Promise<string> {
  const token = `email-connect-${randomUUID()}${randomUUID()}`;
  await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
    [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, workspace]);
  return token;
}

test('0155 on real roles: the eligible owner only, pinned to Property Predator, sealed values never in the page read, append-only events, rules before begin', { skip, timeout: 180_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command'), web = await loginRole(admin, 'r72_web'), content = await loginRole(admin, 'r72_content_command');
  const extraPools: pg.Pool[] = [];
  try {
    await resetIdentityTables(admin);
    // A clean slate (0156's tables first, when the database has them).
    for (const table of ['email_send_events', 'email_protection_alerts', 'email_sending_controls', 'email_account_events', 'email_protection_events', 'email_connection_events', 'email_connections']) {
      await ownerQuery(admin, `DELETE FROM app_private.${table}`).catch(() => undefined);
    }
    const org = randomUUID(), otherOrg = randomUUID();
    const owner = randomUUID(), admin2 = randomUUID(), billingOwner = randomUUID(), stranger = randomUUID();
    await ownerQuery(admin, `DO $s$ BEGIN
      PERFORM set_config('app.request_id','email-connect-fixture',true);
      INSERT INTO app.organizations(id,name,slug,kind) VALUES('${org}','Property Predator','pp-connect-proof','direct_customer'),('${otherOrg}','Other','other-connect-proof','direct_customer');
      INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${PP}','${org}','Property Predator Growth HQ','pp-connect-proof'),('${OTHER_WS}','${otherOrg}','Other','other-connect-proof'),
       ('${PP_SECOND}','${org}','PP second','pp-second-proof');
      INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES
       ('${owner}','owner-connect@pp-connect-proof.co.uk','Pat Owner','active',clock_timestamp()),
       ('${admin2}','admin-connect@pp-connect-proof.co.uk','Ada Admin','active',clock_timestamp()),
       ('${billingOwner}','viewer-connect@pp-connect-proof.co.uk','Vic Viewer','active',clock_timestamp()),
       ('${stranger}','stranger-connect@pp-connect-proof.co.uk','Sam Stranger','active',clock_timestamp());
      INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${org}','${owner}','owner','active'),('${org}','${admin2}','admin','active'),
       ('${org}','${billingOwner}','owner','active'),('${otherOrg}','${stranger}','owner','active');
      INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${PP}','${org}','${owner}','owner','active'),
       ('${PP}','${org}','${admin2}','admin','active'),('${PP}','${org}','${billingOwner}','viewer','active'),('${OTHER_WS}','${otherOrg}','${stranger}','owner','active'),
       ('${PP_SECOND}','${org}','${owner}','owner','active');
    END $s$`);
    const ownerToken = await session(admin, owner, PP), adminToken = await session(admin, admin2, PP), viewerToken = await session(admin, billingOwner, PP),
      strangerToken = await session(admin, stranger, OTHER_WS), ownerElsewhere = await session(admin, owner, PP_SECOND);
    // As production builds it: the run lock on a small pool of its own (one per business plus one).
    const connectionString = (identity as unknown as { options: { connectionString: string } }).options.connectionString;
    const lockPool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 300 });
    extraPools.push(lockPool);
    lockPool.on('error', () => undefined);
    const store = new PgEmailConnectionStore(identity, { lockPool });

    // Only the eligible owner: an org admin who is not an org owner, an org owner who cannot manage the workspace, another
    // business's owner, the owner with another workspace selected and a made-up session are all refused.
    for (const token of [adminToken, viewerToken, strangerToken, ownerElsewhere, 'not-a-session']) {
      await assert.rejects(store.state(token, PP), EmailConnectionForbiddenError);
      await assert.rejects(store.acceptTerms(token, PP, EMAIL_TERMS_VERSION), EmailConnectionForbiddenError);
    }
    // Another workspace is refused by the pin, even for its own owner.
    await assert.rejects(store.state(strangerToken, OTHER_WS), EmailConnectionForbiddenError);
    assert.deepEqual((await store.state(ownerToken, PP)).status, 'not_connected');

    // Rules first: begin is refused until the current version is agreed; agreeing twice keeps the first who and when.
    assert.equal(await store.begin(ownerToken, PP, FORM, EMAIL_TERMS_VERSION), 'terms_required');
    assert.equal(await store.acceptTerms(ownerToken, PP, EMAIL_TERMS_VERSION), 'accepted');
    const terms = (await store.state(ownerToken, PP)).terms!;
    assert.deepEqual([terms.version, terms.acceptedByName], [EMAIL_TERMS_VERSION, 'Pat Owner']);
    assert.equal(await store.acceptTerms(ownerToken, PP, EMAIL_TERMS_VERSION), 'already');
    assert.deepEqual((await store.state(ownerToken, PP)).terms, terms);
    assert.equal(await store.begin(ownerToken, PP, FORM, '2099-01-01'), 'terms_required', 'a newer rules version needs a new tick');
    await expectPostgresError(identity.query('SELECT app_private.email_connection_accept_terms($1,$2,$3)', [createHash('sha256').update(ownerToken).digest(), PP, 'v2']), '22023');

    // The groundwork columns and their defaults.
    const row = async () => (await ownerQuery<Record<string, unknown>>(admin, 'SELECT * FROM app_private.email_connections WHERE workspace_id=$1', [PP]))[0]!;
    const fresh = await row();
    assert.deepEqual([fresh.status, fresh.mode, fresh.protection_state, fresh.daily_cap, fresh.hourly_cap, fresh.protection_reason, fresh.protection_since, fresh.warmup_started_at,
      fresh.go_live_approved_by, fresh.go_live_approved_at, fresh.terms_version, fresh.terms_accepted_by], ['not_connected', 'off', 'ok', 50, 13, null, null, null, null, null, EMAIL_TERMS_VERSION, owner]);
    for (const [column, value] of [['protection_state', "'stopped'"], ['daily_cap', '-1'], ['hourly_cap', '-1'], ['mode', "'on'"], ['terms_accepted_by', 'NULL'], ['status', "'connected'"],
      ['go_live_approved_by', `'${owner}'`]] as const) {
      await expectPostgresError(ownerQuery(admin, `UPDATE app_private.email_connections SET ${column}=${value} WHERE workspace_id=$1`, [PP]), '23514');
    }
    await expectPostgresError(ownerQuery(admin, `INSERT INTO app_private.email_connections(workspace_id,status,created_by_user_id) VALUES($1,'not_connected',$2)`, [OTHER_WS, owner]), '23514');

    // The steps, as the service runs them.
    assert.equal(await store.begin(ownerToken, PP, FORM, EMAIL_TERMS_VERSION), 'started');
    assert.equal(await store.begin(ownerToken, PP, FORM, EMAIL_TERMS_VERSION), 'started', 'pressing again before the records exist is allowed');
    const vault = new EmailConnectionVault(Buffer.alloc(32, 5));
    await store.intend(ownerToken, PP, 'server');
    await store.saveSealed(ownerToken, PP, 'server_token', vault.seal(PP, 'server_token', 'srv-token-integration-0123456789'));
    await store.record(ownerToken, PP, 'server', 'created', { serverId: 4242 });
    await store.intend(ownerToken, PP, 'stream'); await store.record(ownerToken, PP, 'stream', 'created', { stream: 'broadcast' });
    await store.intend(ownerToken, PP, 'secret'); await store.saveSealed(ownerToken, PP, 'webhook_secret', vault.seal(PP, 'webhook_secret', SECRET));
    // The bounce handler sees the source as soon as the secret is saved (Postmark checks the webhook while it is created).
    const sources = await store.sources();
    assert.equal(sources!.length, 1);
    assert.equal(vault.open(PP, 'webhook_secret', sources![0]!.sealedWebhookSecret), SECRET);
    assert.equal(sources![0]!.serverId, '4242');
    await store.intend(ownerToken, PP, 'webhook'); await store.record(ownerToken, PP, 'webhook', 'created', { webhookId: 99 });
    await store.intend(ownerToken, PP, 'domain');
    const dns = { dkim: { host: `20261114pm._domainkey.${DOMAIN}`, value: 'k=rsa; p=PROOF', verified: false }, returnPath: { host: `pm-bounces.${DOMAIN}`, value: 'pm.mtasv.net', verified: false } };
    await store.record(ownerToken, PP, 'domain', 'created', { domainId: 777, dns });
    let state = await store.state(ownerToken, PP);
    assert.deepEqual([state.status, state.serverId, state.domainId, state.webhookId, state.stream, state.hasServerToken, state.hasWebhookSecret, state.domainAttempted],
      ['dns_pending', 4242, 777, 99, 'broadcast', true, true, true]);
    assert.deepEqual(state.dns, dns);
    // The page read never returns a sealed value; only the owner's own run (and the bounce handler) get them.
    const raw = (await identity.query('SELECT app_private.email_connection_state($1,$2) AS v', [createHash('sha256').update(ownerToken).digest(), PP])).rows[0].v;
    const stored = await row();
    assert.equal(Object.keys(raw).some(key => /sealed|^serverToken$|^webhookSecret$/iu.test(key)), false);
    for (const value of [stored.sealed_server_token, stored.sealed_webhook_secret]) assert.equal(JSON.stringify(raw).includes(String(value)), false, 'no sealed value in the page read');
    await assert.rejects(store.sealed(adminToken, PP), EmailConnectionForbiddenError);
    assert.ok((await store.sealed(ownerToken, PP)).serverToken);
    assert.equal(await store.begin(ownerToken, PP, FORM, EMAIL_TERMS_VERSION), 'already_connected');

    // Check: Postmark's flags only.
    assert.equal(await store.checked(ownerToken, PP, { ...dns, dkim: { ...dns.dkim, verified: true } }, true, false), 'partial');
    assert.equal(await store.checked(ownerToken, PP, { dkim: { ...dns.dkim, verified: true }, returnPath: { ...dns.returnPath, verified: true } }, true, true), 'verified');
    state = await store.state(ownerToken, PP);
    assert.equal(state.status, 'verified'); assert.ok(state.verifiedAt); assert.equal(state.mode, 'off');

    // Direct calls: other database roles have no EXECUTE; the owner role itself is refused unless the session user is the identity role.
    const hash = createHash('sha256').update(ownerToken).digest();
    for (const pool of [web, content]) {
      await expectPostgresError(pool.query('SELECT app_private.email_connection_state($1,$2)', [hash, PP]), '42501');
      await expectPostgresError(pool.query('SELECT app_private.email_connection_sources()'), '42501');
      await expectPostgresError(pool.query('SELECT app_private.email_connection_sealed($1,$2)', [hash, PP]), '42501');
      await expectPostgresError(pool.query('SELECT * FROM app_private.email_connections'), '42501');
      await expectPostgresError(pool.query('SELECT * FROM app_private.email_protection_events'), '42501');
    }
    await expectPostgresError(identity.query('SELECT * FROM app_private.email_connections'), '42501');
    await expectPostgresError(identity.query('SELECT * FROM app_private.email_connection_events'), '42501');
    await expectPostgresError(identity.query('SELECT app_private.email_connection_actor($1,$2)', [hash, PP]), '42501');
    await expectPostgresError(identity.query('SELECT app_private.email_connection_owner($1,$2)', [hash, PP]), '42501');
    await expectPostgresError(identity.query("SELECT app_private.email_connection_event($1,$2,'begin','x',NULL)", [PP, owner]), '42501');
    await assert.rejects(ownerQuery(admin, 'SELECT app_private.email_connection_sources()'), { code: '42501', message: /Email connection boundary required/ });
    await assert.rejects(ownerQuery(admin, 'SELECT app_private.email_connection_state($1,$2)', [hash, PP]), { code: '42501', message: /Email connection boundary required/ });

    // Append-only: as the definer, events can be added and read but never changed or removed.
    const events = await ownerQuery<{ step: string; outcome: string; domain: string | null }>(admin,
      'SELECT step,outcome,domain FROM app_private.email_connection_events WHERE workspace_id=$1 ORDER BY occurred_at,id', [PP]);
    assert.ok(events.length >= 15);
    assert.ok(events.every(e => e.domain === null || e.domain === DOMAIN), 'no address beyond the domain');
    const protection = await ownerQuery<{ kind: string; numbers: Record<string, number>; actor_kind: string; actor_user_id: string }>(admin,
      'SELECT kind,numbers,actor_kind,actor_user_id FROM app_private.email_protection_events WHERE workspace_id=$1 AND actor_user_id=$2', [PP, owner]);
    assert.deepEqual(protection.map(p => [p.kind, p.numbers, p.actor_kind, p.actor_user_id]), [['terms_accepted', { dailyCap: 50, hourlyCap: 13 }, 'user', owner]]);
    const privileges = await ownerQuery<{ t: string; p: string }>(admin, `SELECT c.relname AS t,string_agg(privilege_type,',' ORDER BY privilege_type) AS p
      FROM information_schema.role_table_grants g JOIN pg_class c ON c.relname=g.table_name WHERE g.grantee='r72_email_connection_definer' AND g.table_schema='app_private'
      GROUP BY c.relname ORDER BY 1`);
    // 0156 adds its own tables to this definer; these three keep exactly their 0155 table privileges.
    assert.deepEqual(privileges.filter(row => ['email_connection_events', 'email_connections', 'email_protection_events'].includes(row.t)),
      [{ t: 'email_connection_events', p: 'INSERT,SELECT' }, { t: 'email_connections', p: 'INSERT,SELECT' }, { t: 'email_protection_events', p: 'INSERT,SELECT' }]);
    await expectPostgresError(ownerQuery(admin, `INSERT INTO app_private.email_protection_events(workspace_id,kind,numbers,actor_kind) VALUES($1,'x','{"to":"a@b.co"}','system')`, [PP]), '23514');
    const definerColumns = await ownerQuery<{ c: string }>(admin, `SELECT column_name AS c FROM information_schema.column_privileges WHERE grantee='r72_email_connection_definer'
      AND table_name='email_connections' AND privilege_type='UPDATE' ORDER BY 1`);
    // 0155 granted no function the right to change the protection groundwork; 0156 grants exactly these (and never the keys).
    const at0156 = (await ownerQuery<{ v: boolean }>(admin, "SELECT to_regprocedure('app_private.email_sending_config(uuid)') IS NOT NULL AS v"))[0]!.v;
    for (const column of ['mode', 'test_recipients', 'protection_state', 'protection_reason', 'protection_since', 'daily_cap', 'hourly_cap', 'warmup_started_at', 'go_live_approved_by', 'go_live_approved_at']) {
      assert.equal(definerColumns.some(r => r.c === column), at0156, `${column}: writable only from 0156`);
    }
    for (const forbidden of ['workspace_id', 'created_by_user_id']) assert.equal(definerColumns.some(r => r.c === forbidden), false, forbidden);

    // Disconnect forgets both secrets and the webhook; the sources read then has nothing.
    await store.disconnect(ownerToken, PP);
    state = await store.state(ownerToken, PP);
    assert.deepEqual([state.status, state.webhookId, state.hasServerToken, state.hasWebhookSecret, state.serverId, state.domainId], ['disconnected', null, false, false, 4242, 777]);
    assert.deepEqual(await store.sources(), []);
    // Reconnecting keeps the domain id for re-adoption.
    assert.equal(await store.begin(ownerToken, PP, FORM, EMAIL_TERMS_VERSION), 'started');
    assert.equal((await store.state(ownerToken, PP)).domainId, 777);

    // One run per business across instances (another instance: its own store and lock pool).
    const otherPool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 300 });
    extraPools.push(otherPool);
    otherPool.on('error', () => undefined);
    const otherInstance = new PgEmailConnectionStore(identity, { lockPool: otherPool });
    const held = await store.lock(PP, 100);
    assert.ok(held && !held.lost());
    assert.equal(await otherInstance.lock(PP, 400), null, 'held elsewhere');
    // While the lock is held, the shared identity pool still answers (the run holds none of its connections).
    assert.equal((await store.state(ownerToken, PP)).status, 'creating');
    // The same lock pool full: a connect timeout is "still held", never a fault.
    const second = await store.lock('0b155000-0000-4000-8000-0000000000aa', 100);
    assert.ok(second);
    assert.equal(await store.lock('0b155000-0000-4000-8000-0000000000bb', 700), null);
    await second!.release();
    await held!.release();
    const again = await otherInstance.lock(PP, 300); assert.ok(again); await again!.release();
    // The lock's connection dropped mid-run (the server's idle-in-transaction timeout ends it): no unhandled 'error',
    // the lock reports itself lost, and a later run can take it.
    const shortPool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 300, options: '-c idle_in_transaction_session_timeout=800' });
    shortPool.on('error', () => undefined);
    extraPools.push(shortPool);
    const shortStore = new PgEmailConnectionStore(identity, { lockPool: shortPool });
    const doomed = await shortStore.lock(PP, 300);
    assert.ok(doomed);
    for (let i = 0; i < 60 && !doomed!.lost(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(doomed!.lost(), true, 'the dropped connection marks the lock lost');
    await doomed!.release();
    const after = await shortStore.lock(PP, 1_000); assert.ok(after && !after.lost()); await after!.release();
  } finally {
    await Promise.allSettled([identity.end(), web.end(), content.end(), ...extraPools.map(pool => pool.end())]);
    await admin.end();
  }
});
