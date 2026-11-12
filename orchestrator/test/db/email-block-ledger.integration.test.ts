/**
 * The durable email block ledger (0153) on a disposable PostgreSQL with the real roles: what the table and its
 * definer functions allow, the scope rule for Martin Howard Property (hard bounce or spam report: every email;
 * unsubscribe: marketing only, until a fresh sign-up), and the Postmark webhook writing it before the brand's own
 * stop. Postmark is a stand-in; nothing real is called. Addresses are synthetic (example.invalid).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expectPostgresError, openTestDatabase, ownerQuery, testDatabaseSkipReason } from './database-helper.js';
import { loginRole } from './webinar-harness.js';
import { createPostmarkBounceWebhook, decideRecipient, EmailBounceService, PgEmailBlockLedger } from '../../src/email-bounces/index.js';
import { MhpEmailHealth } from '../../src/mhp/email-health.js';
import { PgMhpGrowthService } from '../../src/mhp/growth-service.js';
import { MHP_MARKETING_WORKSPACE_ID as MHP } from '../../src/mhp/marketing-workspace-service.js';

const skip = testDatabaseSkipReason();
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', OTHER = '0b151000-0000-4000-8000-000000000002';
const SECRET = 'ledger-proof-webhook-secret-0123456789';
const DAY = 86_400_000;

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
      assert.deepEqual(await ledger.decide(MHP, address('DEAD').replace('DEAD', 'dead').toUpperCase(), purpose), { blocked: true, reason: 'hard_bounce', reallowed: false }, 'addresses compare case-blind');
      assert.deepEqual(await ledger.decide(MHP, address('spam'), purpose), { blocked: true, reason: 'spam_complaint', reallowed: false });
    }
    assert.deepEqual(await ledger.decide(MHP, address('left'), 'marketing'), { blocked: true, reason: 'unsubscribed', reallowed: false });
    assert.deepEqual(await ledger.decide(MHP, address('left'), 'service'), { blocked: false, reallowed: false });
    assert.deepEqual(await ledger.decide(PP, address('dead'), 'service'), { blocked: false, reallowed: false }, 'one brand never blocks another');

    // A provider re-subscribe lifts only an unsubscribe; nothing lifts a hard bounce or spam report, not even the owner role by hand.
    assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address('dead'), eventId: null, at: Date.now() }), 0);
    assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address('spam'), eventId: null, at: Date.now() }), 0);
    assert.equal(await ledger.lift({ workspaceId: MHP, sourceKey: 'mhp', email: address('left'), eventId: 'subscription:on', at: Date.now() - DAY }), 1);
    assert.deepEqual(await ledger.decide(MHP, address('left'), 'marketing'), { blocked: false, reallowed: false });
    await expectPostgresError(ownerQuery(admin, 'UPDATE app_private.email_address_blocks SET lifted_at=now() WHERE email=$1', [address('dead')]), '23514');
    await expectPostgresError(ownerQuery(admin, "UPDATE app_private.email_address_blocks SET scope='marketing' WHERE email=$1", [address('spam')]), '23514');
    // A newer unsubscribe blocks again; one older than the re-subscribe does not.
    assert.equal(await put('left', 'unsubscribed', 'subscription:older', Date.now() - 2 * DAY + 1000), 'exists');
    assert.equal((await ledger.decide(MHP, address('left'), 'marketing'))!.blocked, false);
    assert.equal(await put('left', 'unsubscribed', 'subscription:newer', Date.now() - 1000), 'renewed');
    assert.equal((await ledger.decide(MHP, address('left'), 'marketing'))!.blocked, true);

    // The sweep's list write: idempotent, counted, pinned.
    const list = [{ email: address('l1'), reason: 'hard_bounce' as const, at }, { email: address('l2'), reason: 'unsubscribed' as const, at }];
    assert.equal(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'outbound', rows: list }), 2);
    assert.equal(await ledger.recordList({ workspaceId: MHP, sourceKey: 'mhp', stream: 'outbound', rows: list }), 0);
    const rows = (await ledger.rows(MHP))!.filter(r => r.email.endsWith(`-${run}@example.invalid`));
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
    assert.deepEqual(columns, ['id', 'workspace_id', 'source_key', 'email', 'reason', 'scope', 'provider', 'provider_event_id', 'stream', 'occurred_at', 'recorded_at', 'updated_at', 'lifted_at', 'lifted_event_id']);
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
