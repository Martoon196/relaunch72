/**
 * The durable email block ledger (0153) on a disposable PostgreSQL with the real roles: what the table and its
 * definer functions allow, the scope rule for Martin Howard Property (hard bounce or spam report: every email;
 * unsubscribe: marketing only, until a fresh sign-up), and the Postmark webhook writing it before the brand's own
 * stop. Postmark is a stand-in; nothing real is called. Addresses are synthetic (example.invalid).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expectPostgresError, openTestDatabase, ownerQuery, resetIdentityTables, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { createPostmarkBounceWebhook, decideRecipient, EmailBounceService, PgEmailBlockLedger } from '../../src/email-bounces/index.js';
import { MhpEmailHealth } from '../../src/mhp/email-health.js';
import { PgMhpGrowthService } from '../../src/mhp/growth-service.js';
import { MHP_MARKETING_WORKSPACE_ID as MHP } from '../../src/mhp/marketing-workspace-service.js';

const skip = testDatabaseSkipReason();
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', OTHER = '0b151000-0000-4000-8000-000000000002';
const SECRET = 'ledger-proof-webhook-secret-0123456789';
const DAY = 86_400_000;

/** A minimal MHP brand workspace with its marketing owner, an org member who is not the owner, and their MHP sessions (synthetic). */
async function mhpOwnerFixture(admin: Awaited<ReturnType<typeof openTestDatabase>>) {
    // A minimal MHP brand workspace with its marketing owner and an MHP session (synthetic).
    await resetIdentityTables(admin);
    const org = 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8', owner = randomUUID(), stranger = randomUUID();
    const token = `mhp-owner-${randomUUID()}`, strangerToken = `mhp-stranger-${randomUUID()}`;
    await ownerQuery(admin, `DO $s$ BEGIN
      PERFORM set_config('app.user_id','${owner}',true); PERFORM set_config('app.request_id','ledger-owner-fixture',true);
      INSERT INTO app.organizations(id,name,slug,kind) VALUES('${org}','Martin Howard Property','mhp-ledger-proof','direct_customer');
      INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${MHP}','${org}','MHP brand marketing','mhp-brand-marketing');
      INSERT INTO app.users(id,email,display_name,status,email_verified_at) VALUES('${owner}','martin.howard1984@gmail.com','Synthetic owner','active',clock_timestamp()),
       ('${stranger}','stranger-ledger@example.invalid','Stranger','active',clock_timestamp());
      INSERT INTO app_private.investor_programme_admins(user_id) VALUES('${owner}');
      INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${org}','${owner}','owner','active'),('${org}','${stranger}','billing','active');
      INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${MHP}','${org}','${owner}','owner','active'),('${MHP}','${org}','${stranger}','viewer','active');
    END $s$`);
    for (const [user, t] of [[owner, token], [stranger, strangerToken]] as const) {
      await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,expires_at,product_audience)
        VALUES($1,$2,$3,$4,now()+interval '1 hour','martin_howard_property')`, [createHash('sha256').update(t).digest(), createHash('sha256').update(`csrf${t}`).digest(), user, MHP]);
    }
    return { org, owner, stranger, token, strangerToken };
}

test('email block ledger on real roles: pinned, idempotent, scoped by reason, never lifted for a bounce or spam report, and behind the identity command role only', { skip, timeout: 120_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command'), web = await loginRole(admin, 'r72_web');
  try {
    const run = randomUUID().slice(0, 8), address = (name: string) => `${name}-${run}@example.invalid`;
    const ledger = new PgEmailBlockLedger(identity);
    const at = Date.now() - 2 * DAY;
    const put = (name: string, reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed', eventId: string | null, when = at, workspaceId = MHP) =>
      ledger.record({ workspaceId, sourceKey: 'mhp', email: address(name), reason, eventId, stream: 'broadcast', at: when });
    assert.equal(await put('dead', 'hard_bounce', `bounce:1-${run}`), 'recorded');
    assert.equal(await put('dead', 'hard_bounce', `bounce:1-${run}`), 'exists', 'a webhook replay writes nothing');
    assert.equal(await put('dead', 'hard_bounce', `bounce:2-${run}`, at + DAY), 'exists', 'a second bounce keeps the first time');
    assert.equal(await put('spam', 'spam_complaint', `bounce:3-${run}`), 'recorded');
    assert.equal(await put('left', 'unsubscribed', null), 'recorded');
    const row = async (name: string) => (await ownerQuery<{ reason: string; scope: string; provider: string; provider_event_id: string | null; occurred_at: Date; lifted_at: Date | null }>(admin,
      'SELECT reason,scope,provider,provider_event_id,occurred_at,lifted_at FROM app_private.email_address_blocks WHERE email=$1 ORDER BY reason', [address(name)]));
    assert.deepEqual((await row('dead')).map(r => [r.reason, r.scope, r.provider, r.provider_event_id, r.occurred_at.getTime()]), [['hard_bounce', 'all', 'postmark', `bounce:1-${run}`, at]]);
    assert.deepEqual((await row('spam')).map(r => [r.reason, r.scope]), [['spam_complaint', 'all']]);
    assert.deepEqual((await row('left')).map(r => [r.reason, r.scope]), [['unsubscribe', 'marketing']]);
    for (const purpose of ['marketing', 'service'] as const) {
      assert.deepEqual(await ledger.decide(MHP, address('DEAD').replace('DEAD', 'dead').toUpperCase(), purpose), { blocked: true, reason: 'hard_bounce', reallowed: false, cleared: {} }, 'addresses compare case-blind');
      assert.deepEqual(await ledger.decide(MHP, address('spam'), purpose), { blocked: true, reason: 'spam_complaint', reallowed: false, cleared: {} });
    }
    assert.deepEqual(await ledger.decide(MHP, address('left'), 'marketing'), { blocked: true, reason: 'unsubscribed', reallowed: false, cleared: {} });
    assert.deepEqual(await ledger.decide(MHP, address('left'), 'service'), { blocked: false, reallowed: false, cleared: {} });
    assert.deepEqual(await ledger.decide(PP, address('dead'), 'service'), { blocked: false, reallowed: false, cleared: {} }, 'one brand never blocks another');

    // A provider re-subscribe lifts only an unsubscribe; nothing lifts a hard bounce or spam report, not even the owner role by hand.
    assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address('dead'), eventId: null, at: Date.now() }), 0);
    assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address('spam'), eventId: null, at: Date.now() }), 0);
    assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address('left'), eventId: 'subscription:on', at: Date.now() - DAY }), 1);
    assert.equal((await ledger.decide(MHP, address('left'), 'marketing'))!.blocked, false);
    await expectPostgresError(ownerQuery(admin, 'UPDATE app_private.email_address_blocks SET lifted_at=now() WHERE email=$1', [address('dead')]), '23514');
    await expectPostgresError(ownerQuery(admin, "UPDATE app_private.email_address_blocks SET scope='marketing' WHERE email=$1", [address('spam')]), '23514');
    // A newer unsubscribe blocks again; one older than the re-subscribe does not.
    assert.equal(await put('left', 'unsubscribed', 'subscription:older', Date.now() - 2 * DAY + 1000), 'exists');
    assert.equal((await ledger.decide(MHP, address('left'), 'marketing'))!.blocked, false);
    assert.equal(await put('left', 'unsubscribed', 'subscription:newer', Date.now() - 1000), 'renewed');
    assert.equal((await ledger.decide(MHP, address('left'), 'marketing'))!.blocked, true);

    // The sweep's list write: idempotent, counted, pinned.
    const list = [{ email: address('l1'), reason: 'hard_bounce' as const, at }, { email: address('l2'), reason: 'unsubscribed' as const, at }];
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'outbound', rows: list }), { added: 2, skipped: 0 });
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'outbound', rows: list }), { added: 0, skipped: 0 });
    const rows = (await ledger.rows(MHP))!.current.filter(r => r.email.endsWith(`-${run}@example.invalid`));
    assert.deepEqual(rows.map(r => [r.email.split('-')[0], r.reason, r.scope]).sort(), [['dead', 'hard_bounce', 'all'], ['l1', 'hard_bounce', 'all'], ['l2', 'unsubscribed', 'marketing'],
      ['left', 'unsubscribed', 'marketing'], ['spam', 'spam_complaint', 'all']]);

    // Only MHP and PP are kept; bad input is refused by the database too.
    await expectPostgresError(identity.query("SELECT app_private.email_block_record($1,'x',$2,'hard_bounce',NULL,NULL,now())", [OTHER, address('x')]), '22023');
    await expectPostgresError(identity.query("SELECT app_private.email_block_record($1,'mhp','not an address','hard_bounce',NULL,NULL,now())", [MHP]), '22023');
    await expectPostgresError(identity.query("SELECT app_private.email_block_record($1,'mhp',$2,'manual',NULL,NULL,now())", [MHP, address('x')]), '22023');
    await expectPostgresError(identity.query("SELECT app_private.email_block_decide($1,$2,'anything')", [MHP, address('x')]), '22023');
    // Table-blind roles: the identity command calls functions only; the web role cannot even do that.
    await expectPostgresError(identity.query('SELECT * FROM app_private.email_address_blocks'), '42501');
    await expectPostgresError(identity.query('SELECT app_private.email_block_put($1,$2,$3,$4,$5,$6,$7,now())', [MHP, 'mhp', address('x'), 'hard_bounce', 'postmark', null, null]), '42501');
    await expectPostgresError(web.query("SELECT app_private.email_block_decide($1,$2,'marketing')", [MHP, address('dead')]), '42501');
    await expectPostgresError(web.query('SELECT * FROM app_private.email_address_blocks'), '42501');
    // Nothing about the message is stored: the columns are the address, reason, scope, provider, event id, stream and times.
    const columns = (await ownerQuery<{ column_name: string }>(admin, "SELECT column_name FROM information_schema.columns WHERE table_schema='app_private' AND table_name='email_address_blocks' ORDER BY ordinal_position")).map(c => c.column_name);
    assert.deepEqual(columns, ['id', 'workspace_id', 'source_key', 'email', 'reason', 'scope', 'provider', 'provider_event_id', 'stream', 'occurred_at', 'recorded_at', 'updated_at', 'lifted_at', 'lifted_event_id', 'lifted_by_user_id', 'lift_note']);
  } finally {
    await identity.end(); await web.end(); await admin.end();
  }
});

test('MHP scope rule end to end: the webhook writes the true reason durably; after a restart a bounce or spam report refuses every email, an unsubscribe refuses marketing until a fresh sign-up', { skip, timeout: 120_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command');
  try {
    const run = randomUUID().slice(0, 8), address = (name: string) => `${name}-${run}@example.invalid`;
    const growth = new PgMhpGrowthService(identity, identity, { campaign: `ledger-proof-${run}`, startsAt: new Date(Date.now() + 3 * DAY).toISOString() });
    const signup = (email: string) => growth.capture({ email, firstName: 'Sam', level: null, consent: true, kind: 'webinar', label: 'Webinar', module: null,
      link: 'https://martinhowardproperty.co.uk/webinar/' }, null);
    const people = { dead: await signup(address('dead')), spam: await signup(address('spam')), left: await signup(address('left')) };
    const source = { key: 'mhp', workspaceId: MHP, token: null, webhookSecret: SECRET, serverId: null, streams: new Map([['broadcast', 'marketing' as const], ['outbound', 'service' as const]]) };
    const service = new EmailBounceService({ config: { blockers: [], sources: [source] }, ledger: new PgEmailBlockLedger(identity) });
    const health = new MhpEmailHealth({ bounces: service, growth });
    service.setEffects(MHP, health.effects());
    const webhook = createPostmarkBounceWebhook({ service });
    const post = async (body: unknown) => {
      const captured = { status: 0, body: '' };
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/provider-webhooks/postmark/mhp',
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`mhp:${SECRET}`).toString('base64')}` }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
      const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
      await webhook.handle(req, res, new URL(req.url!, 'https://app.martinhowardproperty.co.uk'));
      return captured;
    };
    // Reported now, after the sign-ups above.
    await new Promise(resolve => setTimeout(resolve, 20));
    const earlier = new Date().toISOString();
    assert.equal((await post({ RecordType: 'Bounce', MessageStream: 'broadcast', ID: Number(`77${Date.now() % 1e9}`), Type: 'HardBounce', TypeCode: 1, Email: address('dead'), BouncedAt: earlier,
      Inactive: true, ServerID: 1, Metadata: { send: 's1', prospect: people.dead.prospectId } })).status, 200);
    assert.equal((await post({ RecordType: 'SpamComplaint', MessageStream: 'broadcast', ID: Number(`78${Date.now() % 1e9}`), Type: 'SpamComplaint', TypeCode: 100001, Email: address('spam'), BouncedAt: earlier,
      Inactive: true, ServerID: 1, Metadata: { send: 's2', prospect: people.spam.prospectId } })).status, 200);
    assert.equal((await post({ RecordType: 'SubscriptionChange', MessageStream: 'broadcast', Recipient: address('left'), ChangedAt: earlier, SuppressSending: true,
      SuppressionReason: 'ManualSuppression', ServerID: 1, Metadata: { send: 's3', prospect: people.left.prospectId } })).status, 200);
    const durable = await ownerQuery<{ email: string; reason: string; scope: string; provider_event_id: string }>(admin,
      "SELECT email,reason,scope,provider_event_id FROM app_private.email_address_blocks WHERE email LIKE $1 ORDER BY email", [`%-${run}@example.invalid`]);
    assert.deepEqual(durable.map(r => [r.email.split('-')[0], r.reason, r.scope]), [['dead', 'hard_bounce', 'all'], ['left', 'unsubscribe', 'marketing'], ['spam', 'spam_complaint', 'all']]);
    assert.ok(durable.every(r => !r.provider_event_id.includes('@')), 'no event id repeats the address');

    // A restart: a new process with nothing in memory still refuses, from the ledger.
    const restarted = new EmailBounceService({ config: { blockers: [], sources: [source] }, ledger: new PgEmailBlockLedger(identity) });
    const ask = (name: string, purpose: 'marketing' | 'service') => decideRecipient(restarted.guard, MHP, address(name), purpose);
    assert.deepEqual(await ask('dead', 'service'), { blocked: true, reason: 'hard_bounce' });
    assert.deepEqual(await ask('spam', 'service'), { blocked: true, reason: 'spam_complaint' }, 'a spam report stops even a webinar confirmation');
    assert.deepEqual(await ask('left', 'marketing'), { blocked: true, reason: 'unsubscribed' });
    assert.deepEqual(await ask('left', 'service'), { blocked: false }, 'an unsubscribe leaves the email they asked for');
    // Signing up again (MHP's "signed up since": a sign-up after the unsubscribe) re-allows marketing; it never re-allows a bounce or spam report.
    for (const name of ['dead', 'spam', 'left']) await signup(address(name));
    assert.deepEqual(await ask('left', 'marketing'), { blocked: false });
    assert.deepEqual(await ask('dead', 'marketing'), { blocked: true, reason: 'hard_bounce' });
    assert.deepEqual(await ask('spam', 'marketing'), { blocked: true, reason: 'spam_complaint' });
    // The owner view, loaded from the ledger after the restart, shows what is stopped and leaves out the re-allowed unsubscribe.
    await restarted.refreshLedger(MHP);
    const mine = restarted.registry.snapshot(MHP).blocked.filter(b => b.email.endsWith(`-${run}@example.invalid`));
    assert.deepEqual(mine.map(b => [b.email.split('-')[0], b.reason, b.allEmail]).sort(), [['dead', 'hard_bounce', true], ['spam', 'spam_complaint', true]]);
  } finally {
    await identity.end(); await admin.end();
  }
});

test('review fixes on real roles: owner undo of a wrong hard bounce (session-checked, evidenced, re-armed by a later bounce), spam never lifted, out-of-order re-subscribe, poison rows, list rows without a time', { skip, timeout: 120_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command');
  try {
    const { owner, token, strangerToken } = await mhpOwnerFixture(admin);
    const run = randomUUID().slice(0, 8), address = (name: string) => `${name}-${run}@example.invalid`;
    const ledger = new PgEmailBlockLedger(identity);
    const hour = 3_600_000, t0 = Date.now() - 5 * hour;
    const put = (name: string, reason: 'hard_bounce' | 'spam_complaint' | 'unsubscribed', eventId: string | null, at: number) =>
      ledger.record({ workspaceId: MHP, sourceKey: 'mhp', email: address(name), reason, eventId, stream: 'broadcast', at });

    // 1. Owner undo of a hard bounce, with evidence; only the brand's marketing owner may do it.
    assert.equal(await put('dead', 'hard_bounce', `bounce:d1-${run}`, t0), 'recorded');
    assert.equal(await put('spam', 'spam_complaint', `bounce:s1-${run}`, t0), 'recorded');
    await expectPostgresError(ledger.ownerLift({ sessionToken: strangerToken, workspaceId: MHP, email: address('dead'), note: 'Owner confirmed' }), '42501');
    await expectPostgresError(ledger.ownerLift({ sessionToken: 'not-a-session', workspaceId: MHP, email: address('dead'), note: 'Owner confirmed' }), '42501');
    await expectPostgresError(ledger.ownerLift({ sessionToken: token, workspaceId: PP, email: address('dead'), note: 'Owner confirmed' }), '42501');
    assert.deepEqual(await ledger.ownerLift({ sessionToken: token, workspaceId: MHP, email: address('DEAD').toLowerCase(), note: 'Owner confirmed' }), { lifted: 1, released: 0, spamComplaint: false, alreadyLifted: false });
    const lifted = (await ownerQuery<{ lifted_at: Date; lifted_by_user_id: string; lift_note: string }>(admin,
      "SELECT lifted_at,lifted_by_user_id,lift_note FROM app_private.email_address_blocks WHERE email=$1 AND reason='hard_bounce'", [address('dead')]))[0]!;
    assert.equal(lifted.lifted_by_user_id, owner); assert.equal(lifted.lift_note, 'Owner confirmed'); assert.ok(lifted.lifted_at instanceof Date);
    assert.deepEqual(await ledger.decide(MHP, address('dead'), 'service'), { blocked: false, reallowed: false, cleared: { hard_bounce: lifted.lifted_at.getTime() } });
    // The old bounce, replayed or re-listed with its old time, does not block again; a bounce after the lift does.
    assert.equal(await put('dead', 'hard_bounce', `bounce:d1-${run}`, t0), 'exists');
    assert.equal(await put('dead', 'hard_bounce', `bounce:d0-${run}`, t0 - hour), 'exists');
    assert.equal(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows: [{ email: address('dead'), reason: 'hard_bounce', at: null }] }).then(r => r!.added), 0);
    assert.equal((await ledger.decide(MHP, address('dead'), 'service'))!.blocked, false);
    assert.equal(await put('dead', 'hard_bounce', `bounce:d2-${run}`, Date.now()), 'renewed');
    assert.deepEqual(await ledger.decide(MHP, address('dead'), 'service'), { blocked: true, reason: 'hard_bounce', reallowed: false, cleared: {} });
    assert.deepEqual((await ownerQuery<{ lifted_by_user_id: string | null; lift_note: string | null }>(admin,
      "SELECT lifted_by_user_id,lift_note FROM app_private.email_address_blocks WHERE email=$1 AND reason='hard_bounce'", [address('dead')])), [{ lifted_by_user_id: null, lift_note: null }]);
    // A spam complaint is never lifted, by the owner or by hand.
    assert.deepEqual(await ledger.ownerLift({ sessionToken: token, workspaceId: MHP, email: address('spam'), note: 'Owner confirmed' }), { lifted: 0, released: 0, spamComplaint: true, alreadyLifted: false });
    assert.equal((await ledger.decide(MHP, address('spam'), 'service'))!.blocked, true);
    await expectPostgresError(ownerQuery(admin, "UPDATE app_private.email_address_blocks SET lifted_at=now(),lifted_by_user_id=$2,lift_note='x y z' WHERE email=$1", [address('spam'), owner]), '23514');
    await expectPostgresError(ownerQuery(admin, "UPDATE app_private.email_address_blocks SET lifted_at=now() WHERE email=$1", [address('dead')]), '23514'); // a hard bounce lift needs who and why

    // 2. Out-of-order: a re-subscribe that overtakes a retried older unsubscribe leaves a lifted marker. Both orders.
    const unsub = (name: string, at: number) => put(name, 'unsubscribed', `subscription:${name}-${at}`, at);
    const resub = (name: string, at: number) => ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address(name), eventId: `subscription:on-${name}-${at}`, at });
    assert.equal(await unsub('inorder', t0), 'recorded'); assert.equal(await resub('inorder', t0 + hour), 1);
    assert.equal(await resub('late', t0 + hour), 0); assert.equal(await unsub('late', t0), 'exists', 'the late older unsubscribe finds the marker');
    for (const name of ['inorder', 'late']) {
      assert.deepEqual(await ledger.decide(MHP, address(name), 'marketing'), { blocked: false, reallowed: false, cleared: { unsubscribed: t0 + hour } }, name);
      assert.equal(await unsub(name, t0 + 2 * hour), 'renewed', `${name}: a genuinely newer unsubscribe blocks again`);
      assert.equal((await ledger.decide(MHP, address(name), 'marketing'))!.blocked, true);
    }

    // 3. Poison rows: skipped and counted, never failing the rows around them or the next chunk.
    const rows = [{ email: address('p1'), reason: 'hard_bounce' as const, at: t0 }, { email: 'not an address', reason: 'hard_bounce' as const, at: t0 },
      { email: address('p2'), reason: 'unsubscribed' as const, at: t0 }];
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows }), { added: 2, skipped: 1 });
    assert.deepEqual(await identity.query("SELECT app_private.email_block_record_list($1,'mhp','broadcast',$2::jsonb) AS v",
      [MHP, JSON.stringify([{ email: address('p3'), reason: 'bogus', at: null }, 'x', { email: address('p4'), reason: 'hard_bounce', at: 'not a time' }, { email: address('p5'), reason: 'spam_complaint', at: null }])])
      .then(r => r.rows[0].v), { added: 1, skipped: 3 });
    const many = Array.from({ length: 1201 }, (_, i) => ({ email: i === 3 ? 'bad' : address(`m${i}`), reason: 'unsubscribed' as const, at: t0 }));
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows: many }), { added: 1200, skipped: 1 }, 'three chunks, one bad row');

    // 4. A list row without a time keeps its first-seen time; a later sign-up then re-allows marketing.
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows: [{ email: address('notime'), reason: 'unsubscribed', at: null }] }), { added: 1, skipped: 0 });
    const first = (await ownerQuery<{ occurred_at: Date }>(admin, 'SELECT occurred_at FROM app_private.email_address_blocks WHERE email=$1', [address('notime')]))[0]!.occurred_at;
    await new Promise(resolve => setTimeout(resolve, 30));
    const growth = new PgMhpGrowthService(identity, identity, { campaign: `ledger-notime-${run}`, startsAt: new Date(Date.now() + DAY).toISOString() });
    await growth.capture({ email: address('notime'), firstName: 'Sam', level: null, consent: true, kind: 'webinar', label: 'Webinar', module: null,
      link: 'https://martinhowardproperty.co.uk/webinar/' }, null);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows: [{ email: address('notime'), reason: 'unsubscribed', at: null }] }), { added: 0, skipped: 0 });
    assert.equal((await ownerQuery<{ occurred_at: Date }>(admin, 'SELECT occurred_at FROM app_private.email_address_blocks WHERE email=$1', [address('notime')]))[0]!.occurred_at.getTime(), first.getTime(),
      'the hourly read never renews a time it does not know');
    assert.equal((await ledger.decide(MHP, address('notime'), 'marketing'))!.blocked, false, 'so the sign-up since still re-allows marketing');
  } finally {
    await identity.end(); await admin.end();
  }
});

test('owner lift authorisation, re-arming by time, the re-subscribe race, lock-free unchanged list rows, and no re-stop on a replayed bounce (MHP, real roles)', { skip, timeout: 180_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command'), web = await loginRole(admin, 'r72_web');
  try {
    const { org, owner, token, strangerToken } = await mhpOwnerFixture(admin);
    const run = randomUUID().slice(0, 8), address = (name: string) => `${name}-${run}@example.invalid`;
    const ledger = new PgEmailBlockLedger(identity);
    const hour = 3_600_000, t0 = Date.now() - 5 * hour;
    const session = async (user: string, selected: string, expires: string, revoked = false) => {
      const t = `s-${randomUUID()}`;
      await ownerQuery(admin, `INSERT INTO app.user_sessions(token_hash,csrf_secret_hash,user_id,selected_workspace_id,created_at,last_seen_at,expires_at,product_audience,revoked_at)
        VALUES($1,$2,$3,$4,now()-interval '2 hours',now()-interval '2 hours',now()+$5::interval,'martin_howard_property',${revoked ? 'now()' : 'NULL'})`, [createHash('sha256').update(t).digest(), createHash('sha256').update(`c${t}`).digest(), user, selected, expires]);
      return t;
    };
    assert.equal(await ledger.record({ workspaceId: MHP, sourceKey: 'mhp', email: address('dead'), reason: 'hard_bounce', eventId: `bounce:a-${run}`, stream: 'broadcast', at: t0 }), 'recorded');
    const lift = (sessionToken: string, workspaceId = MHP) => ledger.ownerLift({ sessionToken, workspaceId, email: address('dead'), note: 'Owner confirmed' });
    // Authorisation: an expired or revoked owner session, an org member who is not the marketing owner, and a PP
    // manager with PP selected trying MHP are all refused; nothing is lifted.
    await expectPostgresError(lift(await session(owner, MHP, '-1 minute')), '42501');
    await expectPostgresError(lift(await session(owner, MHP, '1 hour', true)), '42501');
    await expectPostgresError(lift(strangerToken), '42501');
    const ppOrg = randomUUID();
    await ownerQuery(admin, `DO $s$ BEGIN
      INSERT INTO app.organizations(id,name,slug,kind) VALUES('${ppOrg}','Property Predator','pp-ledger-proof','direct_customer');
      INSERT INTO app.workspaces(id,organization_id,name,slug) VALUES('${PP}','${ppOrg}','PP','pp-ledger-proof-ws');
      INSERT INTO app.organization_memberships(organization_id,user_id,role,status) VALUES('${ppOrg}','${owner}','owner','active');
      INSERT INTO app.workspace_memberships(workspace_id,organization_id,user_id,role,status) VALUES('${PP}','${ppOrg}','${owner}','owner','active');
    END $s$`);
    const ppSession = await session(owner, PP, '1 hour');
    await expectPostgresError(lift(ppSession, MHP), '42501');
    assert.equal((await ledger.decide(MHP, address('dead'), 'service'))!.blocked, true, 'still blocked after every refused attempt');
    // Direct calls outside the boundary.
    await expectPostgresError(web.query('SELECT app_private.email_block_owner_lift($1,$2,$3,$4)', [createHash('sha256').update(token).digest(), MHP, address('dead'), 'Owner confirmed']), '42501');
    await expectPostgresError(identity.query("SELECT app_private.pp_followup_release_bounce($1,$2,'x y z')", [address('dead'), owner]), '42501');
    void org;

    // The owner lifts it; an audit row is kept.
    assert.deepEqual(await lift(token), { lifted: 1, released: 0, spamComplaint: false, alreadyLifted: false });
    const liftedAt = (await ownerQuery<{ lifted_at: Date }>(admin, "SELECT lifted_at FROM app_private.email_address_blocks WHERE email=$1 AND reason='hard_bounce'", [address('dead')]))[0]!.lifted_at;
    assert.deepEqual(await ownerQuery(admin, 'SELECT reason,lifted_by_user_id,note,crm_released FROM app_private.email_address_block_lifts WHERE email=$1', [address('dead')]),
      [{ reason: 'hard_bounce', lifted_by_user_id: owner, note: 'Owner confirmed', crm_released: 0 }]);
    assert.deepEqual(await lift(token), { lifted: 0, released: 0, spamComplaint: false, alreadyLifted: true }, 'a second press says it was already lifted');
    // A list row timed exactly at the lift does not re-arm; one timed after it does. The audit row survives the re-arm.
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows: [{ email: address('dead'), reason: 'hard_bounce', at: liftedAt.getTime() }] }), { added: 0, skipped: 0 });
    assert.equal((await ledger.decide(MHP, address('dead'), 'service'))!.blocked, false, 'equal times never re-arm');
    assert.deepEqual(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'broadcast', rows: [{ email: address('dead'), reason: 'hard_bounce', at: liftedAt.getTime() + 1000 }] }), { added: 0, skipped: 0 });
    assert.equal((await ledger.decide(MHP, address('dead'), 'service'))!.blocked, true, 'a list row timed after the lift re-arms');
    assert.equal((await ownerQuery(admin, 'SELECT 1 FROM app_private.email_address_block_lifts WHERE email=$1', [address('dead')])).length, 1, 'the trace of the lift stays');

    // The re-subscribe race: a newer unsubscribe written (not yet committed) while an older re-subscribe runs is never lifted.
    const a = await identity.connect(), b = await identity.connect();
    try {
      await a.query('BEGIN');
      await a.query("SELECT app_private.email_block_record($1,'mhp',$2,'unsubscribe','subscription:new',NULL,$3)", [MHP, address('race'), new Date(t0 + 2 * hour)]);
      const late = b.query("SELECT app_private.email_block_lift($1,'mhp',$2,'subscription:on',$3) AS n", [MHP, address('race'), new Date(t0 + hour)]);
      await new Promise(resolve => setTimeout(resolve, 300));
      await a.query('COMMIT');
      assert.equal((await late).rows[0].n, 0);
    } finally { a.release(); b.release(); }
    assert.equal((await ledger.decide(MHP, address('race'), 'marketing'))!.blocked, true, 'the newer unsubscribe still blocks');
    // The other interleaving: the older re-subscribe commits first; the newer unsubscribe then blocks again.
    assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address('race2'), eventId: 'subscription:on', at: t0 + hour }), 0);
    assert.equal(await ledger.record({ workspaceId: MHP, sourceKey: 'mhp', email: address('race2'), reason: 'unsubscribed', eventId: 'subscription:new', stream: null, at: t0 + 2 * hour }), 'renewed');
    assert.equal((await ledger.decide(MHP, address('race2'), 'marketing'))!.blocked, true);

    // An unchanged list row takes no row lock: it is not held up by another session locking that row.
    assert.equal(await ledger.record({ workspaceId: MHP, sourceKey: 'mhp', email: address('still'), reason: 'hard_bounce', eventId: `bounce:s-${run}`, stream: 'broadcast', at: t0 }), 'recorded');
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SET LOCAL ROLE r72_owner');
      await holder.query('SELECT 1 FROM app_private.email_address_blocks WHERE email=$1 FOR UPDATE', [address('still')]);
      const client = await identity.connect();
      try {
        await client.query("SET statement_timeout='3s'");
        const r = await client.query("SELECT app_private.email_block_record_list($1,'mhp','broadcast',$2::jsonb) AS v", [MHP, JSON.stringify([{ email: address('still'), reason: 'hard_bounce', at: new Date(t0).toISOString() }])]);
        assert.deepEqual(r.rows[0].v, { added: 0, skipped: 0 });
      } finally { await client.query('RESET statement_timeout').catch(() => undefined); client.release(); }
    } finally { await holder.query('ROLLBACK'); holder.release(); }

    // A replay of the ORIGINAL bounce after a lift does not re-stop the MHP person; a new bounce does.
    const growth = new PgMhpGrowthService(identity, identity, { campaign: `ledger-replay-${run}`, startsAt: new Date(Date.now() + DAY).toISOString() });
    const person = await growth.capture({ email: address('replay'), firstName: 'Sam', level: null, consent: true, kind: 'webinar', label: 'Webinar', module: null,
      link: 'https://martinhowardproperty.co.uk/webinar/' }, null);
    const source = { key: 'mhp', workspaceId: MHP, token: null, webhookSecret: SECRET, serverId: null, streams: new Map([['broadcast', 'marketing' as const]]) };
    const service = new EmailBounceService({ config: { blockers: [], sources: [source] }, ledger });
    const health = new MhpEmailHealth({ bounces: service, growth });
    let failOnce = true;
    const effects = health.effects();
    service.setEffects(MHP, { onMarketingBlock: async input => { if (failOnce) { failOnce = false; throw new Error('database unavailable'); } await effects.onMarketingBlock(input); } });
    const webhook = createPostmarkBounceWebhook({ service });
    const post = async (body: unknown) => {
      const captured = { status: 0 };
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/provider-webhooks/postmark/mhp',
        headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`mhp:${SECRET}`).toString('base64')}` }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
      const res = { writeHead(status: number) { captured.status = status; }, end() {} } as unknown as ServerResponse;
      await webhook.handle(req, res, new URL(req.url!, 'https://app.martinhowardproperty.co.uk'));
      return captured.status;
    };
    const stopped = async () => (await ownerQuery<{ u: boolean }>(admin, 'SELECT unsubscribed_at IS NOT NULL AS u FROM app_private.mhp_prospects WHERE id=$1', [person.prospectId]))[0]!.u;
    const original = { RecordType: 'Bounce', MessageStream: 'broadcast', ID: Number(`91${Date.now() % 1e9}`), Type: 'HardBounce', TypeCode: 1, Email: address('replay'),
      BouncedAt: new Date(Date.now() - 60_000).toISOString(), Inactive: true, ServerID: 1, Metadata: { send: 's', prospect: person.prospectId } };
    assert.equal(await post(original), 503, 'the durable write landed, the contact stop failed');
    assert.equal(await stopped(), false);
    assert.equal((await health.lift(token, address('replay'))).outcome, 'lifted');
    assert.equal(await post(original), 200, 'Postmark retries');
    assert.equal(await stopped(), false, 'the retried old bounce does not re-stop the person');
    assert.equal(await post({ ...original, ID: original.ID + 1, BouncedAt: new Date().toISOString() }), 200);
    assert.equal(await stopped(), true, 'a genuinely new bounce does');
    // With that hard bounce in place, a spam report whose stop failed once runs its stop on the retry.
    const calls: string[] = [];
    let failSpam = true;
    service.setEffects(MHP, { onMarketingBlock: async input => { calls.push(input.reason);
      if (input.reason === 'spam_complaint' && failSpam) { failSpam = false; throw new Error('database unavailable'); } await effects.onMarketingBlock(input); } });
    const spamEvent = { ...original, ID: original.ID + 2, RecordType: 'SpamComplaint', Type: 'SpamComplaint', BouncedAt: new Date().toISOString() };
    assert.equal(await post(spamEvent), 503);
    assert.equal(await post(spamEvent), 200);
    assert.deepEqual(calls, ['spam_complaint', 'spam_complaint']);
  } finally {
    await identity.end(); await web.end(); await admin.end();
  }
});
