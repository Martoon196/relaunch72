/**
 * Migration 0156 (sending through the stored connection, and sender protection) on a disposable PostgreSQL with the
 * real roles: who can change the mode, ask to go live, approve, lift, reinstate and release; the reservation against
 * caps, holds and the sample; counters idempotent on replays; the ladder only up (and slowed back to ok) for the
 * system, a second own pause within 90 days becomes off; protection events append-only; nothing reaches another
 * workspace; other database roles can call nothing. Postmark is not involved. All people and values are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { EMAIL_TERMS_VERSION, EmailConnectionVault, PgEmailConnectionStore } from '../../src/email-connections/index.js';
import { EmailProtectionForbiddenError, EmailProtectionInvalidError, EmailProtectionService, PgEmailProtectionStore } from '../../src/email-protection/index.js';

const skip = testDatabaseSkipReason();
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', OTHER_WS = '0b156000-0000-4000-8000-000000000002';
const DOMAIN = 'mail.pp-send-proof.co.uk';
const FORM = { domain: DOMAIN, fromName: 'Property Predator', fromAddress: `hello@${DOMAIN}`, replyTo: null };

type Admin = Awaited<ReturnType<typeof openTestDatabase>>;
async function session(admin: Admin, user: string, workspace: string): Promise<string> {
  const token = `email-send-${randomUUID()}${randomUUID()}`;
  await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
    [createHash('sha256').update(token).digest(), createHash('sha256').update(`csrf${token}`).digest(), user, workspace]);
  return token;
}

test('0156 on real roles: owner and founder commands, reservations, counters, the ladder\'s direction, append-only evidence, no leaks', { skip, timeout: 240_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command'), web = await loginRole(admin, 'r72_web'), content = await loginRole(admin, 'r72_content_command');
  try {
    await resetIdentityTables(admin);
    for (const table of ['email_send_events', 'email_protection_alerts', 'email_sending_controls', 'email_protection_events', 'email_connection_events', 'email_connections', 'email_account_events']) {
      await ownerQuery(admin, `DELETE FROM app_private.${table}`).catch(() => undefined);
    }
    await ownerQuery(admin, `UPDATE app_private.email_account_protection SET state='ok',reason=NULL,since=NULL,counted_since=NULL`);
    const org = randomUUID(), otherOrg = randomUUID();
    const owner = randomUUID(), admin2 = randomUUID(), founder = randomUUID(), stranger = randomUUID();
    await ownerQuery(admin, `DO $s$ BEGIN
      PERFORM set_config('app.request_id','email-send-fixture',true);
      INSERT INTO app.organizations(id,name,slug,kind) VALUES('${org}','Property Predator','pp-send-proof','direct_customer'),('${otherOrg}','Other','other-send-proof','direct_customer');
      INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${PP}','${org}','Property Predator Growth HQ','pp-send-proof'),('${OTHER_WS}','${otherOrg}','Other','other-send-proof');
      INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES
       ('${owner}','owner-send@pp-send-proof.co.uk','Pat Owner','active',clock_timestamp()),
       ('${admin2}','admin-send@pp-send-proof.co.uk','Ada Admin','active',clock_timestamp()),
       ('${founder}','founder-send@pp-send-proof.co.uk','Fay Founder','active',clock_timestamp()),
       ('${stranger}','stranger-send@pp-send-proof.co.uk','Sam Stranger','active',clock_timestamp());
      INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${org}','${owner}','owner','active'),('${org}','${admin2}','admin','active'),
       ('${otherOrg}','${stranger}','owner','active'),('${otherOrg}','${founder}','billing','active');
      INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${PP}','${org}','${owner}','owner','active'),
       ('${PP}','${org}','${admin2}','admin','active'),('${OTHER_WS}','${otherOrg}','${stranger}','owner','active'),('${OTHER_WS}','${otherOrg}','${founder}','viewer','active');
    END $s$`);
    await ownerQuery(admin, 'INSERT INTO app_private.seo_limit_operators(user_id) VALUES($1) ON CONFLICT DO NOTHING', [founder]);
    const ownerToken = await session(admin, owner, PP), adminToken = await session(admin, admin2, PP), founderToken = await session(admin, founder, OTHER_WS),
      strangerToken = await session(admin, stranger, OTHER_WS);
    const connections = new PgEmailConnectionStore(identity), store = new PgEmailProtectionStore(identity);
    const vault = new EmailConnectionVault(Buffer.alloc(32, 9));

    // Nothing is offered before a connection row exists; nobody but the owner reads the state.
    assert.equal(await store.sendingConfig(PP), null);
    for (const token of [adminToken, founderToken, strangerToken, 'not-a-session']) await assert.rejects(store.state(token, PP), EmailProtectionForbiddenError);

    // A verified connection, as release 1 makes it.
    assert.equal(await connections.acceptTerms(ownerToken, PP, EMAIL_TERMS_VERSION), 'accepted');
    assert.equal(await connections.begin(ownerToken, PP, FORM, EMAIL_TERMS_VERSION), 'started');
    await connections.intend(ownerToken, PP, 'server');
    await connections.saveSealed(ownerToken, PP, 'server_token', vault.seal(PP, 'server_token', 'srv-token-send-proof-0123456789'));
    await connections.record(ownerToken, PP, 'server', 'created', { serverId: 5151 });
    await connections.intend(ownerToken, PP, 'stream'); await connections.record(ownerToken, PP, 'stream', 'created', { stream: 'broadcast' });
    await connections.intend(ownerToken, PP, 'secret'); await connections.saveSealed(ownerToken, PP, 'webhook_secret', vault.seal(PP, 'webhook_secret', 'whsec-send-proof-0123456789-abcdef'));
    await connections.intend(ownerToken, PP, 'webhook'); await connections.record(ownerToken, PP, 'webhook', 'created', { webhookId: 77 });
    await connections.intend(ownerToken, PP, 'domain');
    const dns = { dkim: { host: `x._domainkey.${DOMAIN}`, value: 'k=rsa; p=X', verified: true }, returnPath: { host: `pm.${DOMAIN}`, value: 'pm.mtasv.net', verified: true } };
    await connections.record(ownerToken, PP, 'domain', 'created', { domainId: 888, dns });
    assert.equal(await connections.checked(ownerToken, PP, dns, true, true), 'verified');

    // The sender's read: the sealed token (opened in the application), and the default test list is the owner's own address.
    let config = (await store.sendingConfig(PP))!;
    assert.deepEqual([config.status, config.mode, config.protectionState, config.dailyCap, config.hourlyCap, config.testRecipients, config.businessName],
      ['verified', 'off', 'ok', 50, 13, ['owner-send@pp-send-proof.co.uk'], null]);
    assert.equal(vault.open(PP, 'server_token', config.sealedServerToken!), 'srv-token-send-proof-0123456789');
    const page = await store.state(ownerToken, PP);
    assert.equal(page.defaultTestEmail, 'owner-send@pp-send-proof.co.uk');
    assert.equal(JSON.stringify(page).includes(config.sealedServerToken!), false, 'the page read never carries a sealed value');

    // Go live, in order: the webhook, the footer, a test, then the founder.
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, false), 'needs_webhook');
    assert.equal(await store.command(ownerToken, PP, 'live', '2099-01-01', true), 'needs_terms');
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'needs_footer');
    await assert.rejects(store.details(ownerToken, PP, { businessName: 'Property Predator Ltd', postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: ['not an address'] }), EmailProtectionInvalidError);
    await assert.rejects(store.details(adminToken, PP, { businessName: 'X Ltd', postalAddress: '1 High Street, Leeds', testRecipients: [] }), EmailProtectionForbiddenError);
    await expectPostgresError(ownerQuery(admin, `INSERT INTO app_private.email_sending_controls(workspace_id,business_name) VALUES($1,'a@b')`, [PP]), '23514');
    await store.details(ownerToken, PP, { businessName: 'Property Predator Ltd', postalAddress: '1 High Street, Leeds LS1 1AA', testRecipients: ['Tester@pp-send-proof.co.uk'] });
    config = (await store.sendingConfig(PP))!;
    assert.deepEqual([config.businessName, config.postalAddress, config.testRecipients], ['Property Predator Ltd', '1 High Street, Leeds LS1 1AA', ['tester@pp-send-proof.co.uk']]);
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'needs_test');
    // A test: reserved, then accepted. A released test does not count as passed.
    assert.equal(await store.testReserve(ownerToken, PP, 'test:one'), 'ok');
    await store.testResult(ownerToken, PP, 'test:one', false);
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'needs_test');
    await assert.rejects(store.testReserve(adminToken, PP, 'test:x'), EmailProtectionForbiddenError);
    assert.equal(await store.testReserve(ownerToken, PP, 'test:two'), 'ok');
    await store.testResult(ownerToken, PP, 'test:two', true);
    assert.equal(await store.command(adminToken, PP, 'live', EMAIL_TERMS_VERSION, true).catch(e => e instanceof EmailProtectionForbiddenError), true);
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'requested');
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'already_requested');
    assert.equal((await store.sendingConfig(PP))!.mode, 'off', 'asking changes nothing until the founder approves');
    assert.equal(await store.reserve(PP, 'lease:early', 'live'), 'not_live');

    // Only the founder approves: the owner's own session, another business's owner and a made-up session are refused.
    let status = await store.founderView(founderToken);
    const pp = () => status.businesses.find(b => b.workspaceId === PP)!;
    assert.ok(pp().goLiveRequestedAt);
    for (const token of [ownerToken, adminToken, strangerToken, 'nope']) {
      await assert.rejects(store.founderView(token), EmailProtectionForbiddenError);
      await assert.rejects(store.founderAct(token, PP, 'approve', pp().rowVersion), EmailProtectionForbiddenError);
    }
    assert.equal(await store.founderAct(founderToken, PP, 'approve', pp().rowVersion - 1), 'stale', 'a stale page changes nothing');
    assert.equal(await store.founderAct(founderToken, PP, 'approve', pp().rowVersion), 'done');
    status = await store.founderView(founderToken);
    assert.equal(await store.founderAct(founderToken, PP, 'approve', pp().rowVersion), 'not_needed');
    config = (await store.sendingConfig(PP))!;
    assert.deepEqual([config.mode, config.sampleState, config.dailyCap, config.hourlyCap], ['live', 'sending', 50, 13]);
    // After the first approval the owner controls test and live.
    assert.equal(await store.command(ownerToken, PP, 'test', EMAIL_TERMS_VERSION, false), 'test');
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'live');

    // Reservations: the hourly cap at its exact number; a replay of a key adds nothing; a release frees the slot.
    for (let i = 0; i < 13; i++) assert.equal(await store.reserve(PP, `lease:h${i}`, 'live'), 'ok');
    assert.equal(await store.reserve(PP, 'lease:h13', 'live'), 'hourly_cap');
    assert.equal(await store.reserve(PP, 'lease:h0', 'live'), 'replayed', 'a replay adds nothing');
    await store.settle(PP, 'lease:h0', true); await store.settle(PP, 'lease:h1', false); await store.settle(PP, 'lease:h1', true);
    const sends = await ownerQuery<{ state: string; n: string }>(admin, `SELECT state,count(*) AS n FROM app_private.email_send_events WHERE workspace_id=$1 AND kind='send' AND purpose='live' GROUP BY state ORDER BY state`, [PP]);
    assert.deepEqual(sends.map(r => [r.state, Number(r.n)]), [['accepted', 1], ['released', 1], ['reserved', 11]], 'a released send cannot be accepted later');
    assert.equal(await store.reserve(PP, 'lease:h14', 'live'), 'ok', 'the released slot is free again');
    assert.equal(await store.reserve(PP, 'lease:h15', 'live'), 'hourly_cap');
    // The sample: at its 50th live send the rest waits.
    await ownerQuery(admin, `UPDATE app_private.email_connections SET daily_cap=500,hourly_cap=125 WHERE workspace_id=$1`, [PP]);
    for (let i = 15; i < 52; i++) assert.equal(await store.reserve(PP, `lease:h${i}`, 'live'), 'ok', `send ${i}`);
    assert.equal(await store.reserve(PP, 'lease:after', 'live'), 'sample_wait');
    assert.equal((await store.sendingConfig(PP))!.sampleState, 'waiting');
    assert.equal(await store.reserve(PP, 'test:mode', 'test'), 'ok', 'tests to the business\'s own list still go');

    // Counters: once per Postmark event id; another workspace is not counted at all.
    const now = Date.now();
    assert.equal(await store.count(PP, 'hard_bounce', 'bounce:1001', now), 'recorded');
    assert.equal(await store.count(PP, 'hard_bounce', 'bounce:1001', now), 'exists');
    assert.equal(await store.count(OTHER_WS, 'hard_bounce', 'bounce:1002', now), 'ignored');
    await expectPostgresError(identity.query('SELECT app_private.email_counter_record($1,$2,$3,now())', [PP, 'hard_bounce', 'a@b.co']), '22023');
    await expectPostgresError(identity.query('SELECT app_private.email_counter_record($1,$2,$3,now())', [PP, 'delivery', 'x']), '22023');

    // The ladder's direction is enforced in SQL, whatever the application asks; and the second own pause becomes off.
    const apply = (from: string, to: string, kind: string | null, cause: 'own' | 'account' | null = 'own', daily = 0, hourly = 0) => store.apply(PP, { from: from as never, to: to as never, kind, cause, reason: 'Proof.',
      numbers: { line: 'bounce_rate', count: 6, total: 120, limit: 4 }, daily, hourly, step: null, stepAt: null, sample: null });
    assert.equal(await apply('slowed', 'paused', 'paused'), 'stale', 'compare-and-set on the state read');
    assert.equal(await apply('ok', 'paused', 'paused'), 'paused');
    assert.equal(await store.reserve(PP, 'lease:paused', 'live'), 'paused');
    assert.equal(await apply('paused', 'ok', 'recovered'), 'refused', 'never down from paused by the system');
    assert.equal(await apply('paused', 'slowed', null), 'refused');
    assert.equal(await connections.state(ownerToken, PP).then(s => s.protection.state), 'paused');
    // The owner's own pause and resume never lift a protection pause.
    assert.equal(await store.command(ownerToken, PP, 'pause', EMAIL_TERMS_VERSION, false), 'paused');
    assert.equal(await store.command(ownerToken, PP, 'resume', EMAIL_TERMS_VERSION, false), 'resumed');
    assert.equal(await store.reserve(PP, 'lease:still', 'live'), 'paused');
    assert.equal(await store.command(ownerToken, PP, 'live', EMAIL_TERMS_VERSION, true), 'unchanged');
    // Only the founder lifts: the business restarts slowed, with a new sample and old events no longer counted.
    status = await store.founderView(founderToken);
    await assert.rejects(store.founderAct(ownerToken, PP, 'lift', pp().rowVersion), EmailProtectionForbiddenError);
    assert.equal(await store.founderAct(founderToken, PP, 'lift', pp().rowVersion), 'done');
    config = (await store.sendingConfig(PP))!;
    assert.deepEqual([config.protectionState, config.sampleState], ['slowed', 'sending']);
    const counts = (await store.numbers())!.businesses.find(b => b.workspaceId === PP)!;
    assert.deepEqual([counts.hard7, counts.sends7, counts.ownPauses90], [0, 0, 1], 'what came before the lift no longer counts; the pause is remembered');
    // A second own pause within 90 days: switched off, by the database itself.
    assert.equal(await apply('slowed', 'paused', 'paused'), 'off');
    assert.equal(await store.reserve(PP, 'lease:off', 'live'), 'off');
    assert.equal(await store.reserve(PP, 'test:off', 'test'), 'off', 'nothing but transactional email once off');
    assert.equal(await store.command(ownerToken, PP, 'test', EMAIL_TERMS_VERSION, false), 'switched_off');
    status = await store.founderView(founderToken);
    assert.equal(await store.founderAct(founderToken, PP, 'lift', pp().rowVersion), 'not_needed', 'off is reinstated, not lifted');
    assert.equal(await store.founderAct(founderToken, PP, 'reinstate', pp().rowVersion), 'done');
    assert.equal((await store.sendingConfig(PP))!.protectionState, 'slowed');
    // An account-triggered pause does not count towards the second-pause rule.
    assert.equal(await apply('slowed', 'paused', 'paused', 'account'), 'paused');
    status = await store.founderView(founderToken);
    assert.equal(await store.founderAct(founderToken, PP, 'lift', pp().rowVersion), 'done');
    assert.equal(await apply('slowed', 'ok', 'recovered', 'own', 2000, 500), 'refused', 'caps must be the ramp\'s for the step');
    assert.equal(await apply('slowed', 'ok', 'recovered', 'own', 50, 13), 'ok', 'slowed recovers by itself');

    // The account hold: every business's marketing, until the founder lifts it.
    assert.equal(await store.accountHold('Proof hold.', { line: 'account_bounce', count: 60, total: 1000, limit: 5 }), 'held');
    assert.equal(await store.accountHold('Again.', { line: 'account_bounce', count: 60, total: 1000, limit: 5 }), 'stale');
    assert.equal(await store.reserve(PP, 'lease:account', 'live'), 'account_held');
    status = await store.founderView(founderToken);
    await assert.rejects(store.founderAct(ownerToken, null, 'lift_account', status.account.rowVersion), EmailProtectionForbiddenError);
    assert.equal(await store.founderAct(founderToken, null, 'lift_account', status.account.rowVersion), 'done');

    // The evaluator on the real database: 5 hard bounces while the last 50 went out pause the business (no address anywhere).
    await ownerQuery(admin, `UPDATE app_private.email_sending_controls SET sample_state='passed' WHERE workspace_id=$1`, [PP]);
    await ownerQuery(admin, `UPDATE app_private.email_connections SET daily_cap=500,hourly_cap=125 WHERE workspace_id=$1`, [PP]);
    for (let i = 0; i < 10; i++) assert.equal(await store.reserve(PP, `lease:e${i}`, 'live'), 'ok');
    const service = new EmailProtectionService({ store });
    for (let i = 0; i < 4; i++) await service.count({ workspaceId: PP, kind: 'hard_bounce', key: `bounce:e${i}`, at: Date.now() });
    await service.settled();
    assert.equal((await store.sendingConfig(PP))!.protectionState, 'ok', 'one below the line');
    await service.count({ workspaceId: PP, kind: 'hard_bounce', key: 'bounce:e4', at: Date.now() });
    await service.count({ workspaceId: PP, kind: 'hard_bounce', key: 'bounce:e4', at: Date.now() });
    await service.settled();
    const after = (await store.sendingConfig(PP))!;
    assert.equal(after.protectionState, 'off', 'at the line: paused, and as the second own pause within 90 days, off');

    // Evidence: append-only, no address, and the alerts carry kinds and numbers only.
    const events = await ownerQuery<{ kind: string; numbers: Record<string, unknown>; actor_kind: string }>(admin,
      `SELECT kind,numbers,actor_kind FROM app_private.email_protection_events WHERE workspace_id=$1 ORDER BY occurred_at,id`, [PP]);
    const kinds = events.map(e => e.kind);
    for (const kind of ['details_saved', 'test_sent', 'go_live_requested', 'go_live_approved', 'mode_test', 'mode_live', 'paused', 'owner_paused', 'owner_resumed', 'lifted', 'switched_off', 'reinstated', 'recovered']) {
      assert.ok(kinds.includes(kind), kind);
    }
    assert.ok(events.every(e => !JSON.stringify(e.numbers).includes('@')));
    const last = events.at(-1)!;
    assert.deepEqual([last.kind, last.numbers.line, last.numbers.count, last.actor_kind], ['switched_off', 'hard_last50', 5, 'system']);
    const alerts = await store.claimAlerts(50);
    assert.ok(alerts.some(a => a.audience === 'founder' && a.kind === 'go_live_requested'));
    assert.ok(alerts.some(a => a.audience === 'owner' && a.kind === 'paused' && a.ownerEmails.includes('owner-send@pp-send-proof.co.uk')));
    assert.ok(alerts.some(a => a.audience === 'founder' && a.kind === 'account_held' && a.workspaceId === null));
    assert.ok(alerts.every(a => !JSON.stringify(a.numbers).includes('@')));
    assert.deepEqual(await store.claimAlerts(50), [], 'claimed alerts are not handed out twice');
    await store.alertDone(alerts[0]!.id, true);
    const privileges = await ownerQuery<{ t: string; p: string }>(admin, `SELECT c.relname AS t,string_agg(privilege_type,',' ORDER BY privilege_type) AS p
      FROM information_schema.role_table_grants g JOIN pg_class c ON c.relname=g.table_name WHERE g.grantee='r72_email_connection_definer' AND g.table_schema='app_private'
      GROUP BY c.relname ORDER BY 1`);
    assert.deepEqual(privileges, [{ t: 'email_account_events', p: 'INSERT,SELECT' }, { t: 'email_account_protection', p: 'SELECT' },
      { t: 'email_connection_events', p: 'INSERT,SELECT' }, { t: 'email_connections', p: 'INSERT,SELECT' }, { t: 'email_protection_alerts', p: 'INSERT,SELECT' },
      { t: 'email_protection_events', p: 'INSERT,SELECT' }, { t: 'email_send_events', p: 'DELETE,INSERT,SELECT' }, { t: 'email_sending_controls', p: 'INSERT,SELECT' }],
      'append-only evidence: no UPDATE of whole rows; only counter rows can be pruned');
    const sendColumns = await ownerQuery<{ c: string }>(admin, `SELECT column_name AS c FROM information_schema.column_privileges WHERE grantee='r72_email_connection_definer'
      AND table_name='email_send_events' AND privilege_type='UPDATE' ORDER BY 1`);
    assert.deepEqual(sendColumns.map(r => r.c), ['settled_at', 'state']);

    // Nothing leaks: another workspace is refused, and other database roles can call or read nothing.
    await assert.rejects(store.state(strangerToken, OTHER_WS), EmailProtectionForbiddenError);
    assert.equal(await store.reserve(OTHER_WS, 'lease:other', 'live'), 'not_connected');
    assert.equal(await store.sendingConfig(OTHER_WS), null);
    await expectPostgresError(ownerQuery(admin, `INSERT INTO app_private.email_send_events(workspace_id,kind,event_key,state,occurred_at) VALUES($1,'hard_bounce','k','fact',now())`, [OTHER_WS]), '23514');
    const hash = createHash('sha256').update(ownerToken).digest();
    for (const pool of [web, content]) {
      await expectPostgresError(pool.query('SELECT app_private.email_sending_state($1,$2)', [hash, PP]), '42501');
      await expectPostgresError(pool.query('SELECT app_private.email_send_reserve($1,$2,$3)', [PP, 'k', 'live']), '42501');
      await expectPostgresError(pool.query('SELECT app_private.email_protection_status()'), '42501');
      await expectPostgresError(pool.query('SELECT * FROM app_private.email_send_events'), '42501');
      await expectPostgresError(pool.query('SELECT * FROM app_private.email_sending_controls'), '42501');
    }
    for (const sql of ['SELECT * FROM app_private.email_send_events', 'SELECT * FROM app_private.email_protection_alerts', 'SELECT * FROM app_private.email_account_protection']) {
      await expectPostgresError(identity.query(sql), '42501');
    }
    await expectPostgresError(identity.query('SELECT app_private.email_protection_founder($1)', [hash]), '42501');
    await expectPostgresError(identity.query('SELECT app_private.email_protection_counts($1)', [PP]), '42501');
    await expectPostgresError(identity.query(`SELECT app_private.email_protection_note($1,'x','{}',NULL,false,false)`, [PP]), '42501');
    await assert.rejects(ownerQuery(admin, 'SELECT app_private.email_protection_status()'), { code: '42501', message: /Email connection boundary required/ });
  } finally {
    await Promise.allSettled([identity.end(), web.end(), content.end()]);
    await admin.end();
  }
});
