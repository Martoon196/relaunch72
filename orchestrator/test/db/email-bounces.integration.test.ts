/**
 * Bounce and complaint handling against a disposable PostgreSQL with the actual
 * login roles. Nothing here adds SQL: it proves the existing capabilities
 * (the unsubscribe function on r72_identity_command, the webinar job states on
 * r72_content_command) do what the new handler relies on. Postmark is a
 * recording stand-in; no network is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openTestDatabase, ownerQuery, testDatabaseSkipReason } from './database-helper.js';
import { loginRole, seedBrand } from './webinar-harness.js';
import { createPostmarkBounceWebhook, EmailBlockRegistry, EmailBounceService } from '../../src/email-bounces/index.js';
import { MhpEmailHealth } from '../../src/mhp/email-health.js';
import { PgMhpGrowthService } from '../../src/mhp/growth-service.js';
import { createMhpMarketingSender, mhpMarketingConfig, startMhpMarketingDispatcher } from '../../src/mhp/marketing-mail.js';
import { MHP_MARKETING_WORKSPACE_ID as MHP } from '../../src/mhp/marketing-workspace-service.js';
import { loadWebinarConfig } from '../../src/webinars/config.js';
import type { WebinarMailer } from '../../src/webinars/messages.js';
import { PgWebinarService } from '../../src/webinars/service.js';
import { DEFAULT_SETTINGS, readSettings } from '../../src/webinars/types.js';
import { WebinarWorker } from '../../src/webinars/worker.js';

const skip = testDatabaseSkipReason();
const SECRET = 'bounce-proof-webhook-secret-0123456789';
const DAY = 86_400_000;

test('MHP sign-up emails on real roles: a bounced or complained address is refused everything and stopped by the existing unsubscribe capability, a marketing-only block leaves the email they asked for, and only email is touched', { skip, timeout: 120_000 }, async () => {
  const admin = await openTestDatabase();
  const identity = await loginRole(admin, 'r72_identity_command');
  try {
    const run = randomUUID().slice(0, 8), address = (name: string) => `${name}-${run}@example.invalid`;
    const start = Date.now() + 3 * DAY, campaign = `webinar-proof-${run}`;
    const growth = new PgMhpGrowthService(identity, identity, { campaign, startsAt: new Date(start).toISOString() });
    const signup = (email: string, consent: boolean) => growth.capture({ email, firstName: 'Sam', level: null, consent, kind: 'webinar', label: 'Webinar',
      module: null, link: 'https://martinhowardproperty.co.uk/webinar/' }, null);
    const people = { gone: await signup(address('gone'), true), cross: await signup(address('cross'), true), fine: await signup(address('fine'), true),
      crossService: await signup(address('cross-service'), false), deadService: await signup(address('dead-service'), false),
      // Unsubscribed at Postmark; signed up for this webinar without ticking the marketing box: the confirmation still goes.
      leftService: await signup(address('left-service'), false),
      // Their mailbox was full three times this month; they have just signed up, box ticked, for this webinar.
      full: await signup(address('full'), true) };
    const before = async (table: string) => Number((await ownerQuery<{ n: string }>(admin, `SELECT count(*) AS n FROM ${table}`))[0]!.n);
    const otherChannels = { consent: await before('app.communication_consent_events'), suppression: await before('app.communication_suppression_events') };

    const bounces = new EmailBounceService({ config: { blockers: [], sources: [{ key: 'mhp', workspaceId: MHP, token: null, webhookSecret: SECRET, serverId: null,
      streams: new Map([['broadcast', 'marketing'], ['outbound', 'service']]) }] } });
    const health = new MhpEmailHealth({ bounces, growth });
    bounces.setEffects(MHP, health.effects());
    const block = (email: string, kind: 'hard_bounce' | 'spam_complaint', id: string) =>
      bounces.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id, kind, email, at: Date.now() - 60_000 });
    block(address('gone'), 'hard_bounce', 'bounce:1'); block(address('cross'), 'spam_complaint', 'bounce:2');
    block(address('cross-service'), 'spam_complaint', 'bounce:3'); block(address('dead-service'), 'hard_bounce', 'bounce:4');
    bounces.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: 'subscription:left', kind: 'unsubscribed', email: address('left-service'), at: Date.now() - 60_000 }, false);
    for (const n of [5, 6, 7]) bounces.registry.record(MHP, { sourceKey: 'mhp', stream: 'broadcast', id: `bounce:${n}`, kind: 'soft_bounce', email: address('full'), at: Date.now() - n * DAY });
    assert.deepEqual(bounces.registry.decide(MHP, address('full'), 'marketing'), { blocked: true, reason: 'repeated_soft_bounce' });

    const bodies: { To: string; MessageStream: string; Metadata: Record<string, string> }[] = [];
    const config = mhpMarketingConfig({ MHP_MARKETING_MODE: 'live', MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token', MHP_MARKETING_FROM: 'owner@example.invalid' })!;
    const sender = createMhpMarketingSender(config, 'synthetic-unsubscribe-secret-at-least-32-characters', (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ErrorCode: 0, MessageID: `pm-${bodies.length}` }), { status: 200 });
    }) as typeof fetch, { guard: bounces.registry, workspaceId: MHP });
    const mine = Object.values(people).map(person => person.prospectId);
    // Only this run's rows: the disposable database may hold other proofs' prospects.
    const scoped = { claim: async (limit: number, seconds: number) => growth.claim(limit, seconds, Object.keys(people).map(key => address(key.replace(/[A-Z]/gu, c => `-${c.toLowerCase()}`)))),
      settle: (id: string, accepted: boolean, reference: string | null) => growth.settle(id, accepted, reference) };
    // One pass of the real dispatcher. It reports nothing when there was nothing to do, so the pass is
    // followed through its own claim and settle calls instead of its telemetry.
    const sweep = () => new Promise<{ sent: number; failed: number }>(resolve => {
      let claimedCount = 0, settled = 0, drained = false, sent = 0, failed = 0;
      const finish = (): void => { if (drained && settled === claimedCount) { stop(); resolve({ sent, failed }); } };
      const stop = startMhpMarketingDispatcher({
        claim: async (limit: number, seconds: number) => { const batch = await scoped.claim(limit, seconds); claimedCount += batch.length;
          if (batch.length < 25) { drained = true; if (batch.length === 0) setImmediate(finish); } return batch; },
        settle: async (id: string, accepted: boolean, reference: string | null) => { await scoped.settle(id, accepted, reference); settled++; if (accepted) sent++; else failed++; finish(); },
      }, sender, { testRecipients: null }, { intervalMs: 3_600_000, onBlocked: health.onBlocked });
    });
    assert.deepEqual(await sweep(), { sent: 2, failed: 5 });
    assert.deepEqual(bodies.map(b => [b.To, b.MessageStream]).sort(), [[address('fine'), 'broadcast'], [address('left-service'), 'outbound']],
      'the healthy address got its email; an unsubscriber still got the confirmation they asked for; the dead and complained addresses got nothing at all, and the soft-bounced address no marketing');
    assert.equal(bodies.find(b => b.To === address('fine'))!.Metadata.prospect, people.fine.prospectId);

    const prospects = async () => new Map((await ownerQuery<{ id: string; unsubscribed: boolean; marketing_consent: boolean }>(admin,
      'SELECT id, unsubscribed_at IS NOT NULL AS unsubscribed, marketing_consent FROM app_private.mhp_prospects WHERE id = ANY($1::uuid[])', [mine])).map(row => [row.id, row]));
    const sends = async (prospectId: string) => ownerQuery<{ template_key: string; sent: boolean; cancelled: boolean; purpose: string }>(admin,
      `SELECT template_key, sent_at IS NOT NULL AS sent, cancelled_at IS NOT NULL AS cancelled, builtin_purpose AS purpose
       FROM app_private.mhp_marketing_sends WHERE prospect_id = $1 AND delivery_channel = 'email' ORDER BY template_key`, [prospectId]);
    let state = await prospects();
    for (const key of ['gone', 'deadService', 'cross', 'crossService'] as const) {
      assert.deepEqual([state.get(people[key].prospectId)!.unsubscribed, state.get(people[key].prospectId)!.marketing_consent], [true, false], `${key} is stopped in the contact list`);
      const rows = await sends(people[key].prospectId);
      assert.ok(rows.length >= 2 && rows.every(row => !row.sent && row.cancelled), `${key}: every queued email, including the later ones, is cancelled`);
    }
    // Blocked from marketing only. The stop is the unsubscribe capability, which would cancel the reminders queued beside
    // the refused confirmation; a refused marketing email must never set it off.
    for (const key of ['full'] as const) {
      assert.deepEqual([state.get(people[key].prospectId)!.unsubscribed, state.get(people[key].prospectId)!.marketing_consent], [false, true], `${key} is not stopped by a refused marketing email`);
      const rows = await sends(people[key].prospectId);
      assert.ok(rows.every(row => !row.sent), `${key}: nothing marketing was sent`);
      const reminders = rows.filter(row => row.purpose === 'webinar_service');
      assert.ok(reminders.length >= 1 && reminders.every(row => !row.cancelled), `${key}: the webinar reminders they asked for are still queued`);
    }
    assert.equal(state.get(people.fine.prospectId)!.unsubscribed, false);
    assert.equal(state.get(people.leftService.prospectId)!.unsubscribed, false, 'an unsubscribe alone never cancels an event email the person asked for');
    assert.ok((await sends(people.fine.prospectId)).some(row => !row.sent && !row.cancelled), 'the healthy person keeps their later emails');

    // A fresh sign-up with a ticked box clears the old unsubscribe, but the address is still on Postmark's list: refused again, stopped again.
    const nextWebinar = new PgMhpGrowthService(identity, identity, { campaign: `${campaign}-next`, startsAt: new Date(start + 7 * DAY).toISOString() });
    await nextWebinar.capture({ email: address('gone'), firstName: 'Sam', level: null, consent: true, kind: 'webinar', label: 'Next webinar', module: null,
      link: 'https://martinhowardproperty.co.uk/webinar/' }, null);
    assert.equal((await prospects()).get(people.gone.prospectId)!.unsubscribed, false);
    const again = await sweep();
    assert.deepEqual(again, { sent: 0, failed: 1 });
    assert.equal((await prospects()).get(people.gone.prospectId)!.unsubscribed, true);
    assert.equal(bodies.filter(b => b.To === address('gone')).length, 0, 'never emailed, however many times they are re-added');

    // The real webhook: Postmark reports a bounce for the message we just sent; our own metadata names the person.
    const webhook = createPostmarkBounceWebhook({ service: bounces });
    const post = async (body: unknown, authorization = `Basic ${Buffer.from(`mhp:${SECRET}`).toString('base64')}`) => {
      const captured = { status: 0, body: '' };
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/provider-webhooks/postmark/mhp',
        headers: { 'content-type': 'application/json', authorization }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
      const res = { writeHead(status: number) { captured.status = status; }, end(text = '') { captured.body = String(text); } } as unknown as ServerResponse;
      await webhook.handle(req, res, new URL(req.url!, 'https://app.martinhowardproperty.co.uk'));
      return captured;
    };
    const event = { RecordType: 'Bounce', MessageStream: 'broadcast', ID: 990001, Type: 'HardBounce', TypeCode: 1, Email: address('fine'), BouncedAt: new Date().toISOString(),
      Inactive: true, ServerID: 1, Metadata: bodies.find(b => b.To === address('fine'))!.Metadata };
    assert.equal((await post(event, 'Basic bm9wZTpub3Bl')).status, 401);
    assert.equal((await prospects()).get(people.fine.prospectId)!.unsubscribed, false, 'an unauthenticated call changes nothing');
    assert.equal((await post(event)).status, 200);
    state = await prospects();
    assert.deepEqual([state.get(people.fine.prospectId)!.unsubscribed, state.get(people.fine.prospectId)!.marketing_consent], [true, false]);
    assert.ok((await sends(people.fine.prospectId)).every(row => row.sent || row.cancelled), 'nothing further is queued for them');
    assert.match((await post(event)).body, /"replayed":true/u);

    // A fourth soft bounce, reported for our own message: counted, still refused for marketing, and the person's record is not touched.
    const softBounce = { RecordType: 'Bounce', MessageStream: 'outbound', ID: 990002, Type: 'SoftBounce', TypeCode: 4096, Email: address('full'), BouncedAt: new Date().toISOString(),
      Inactive: false, ServerID: 1, Metadata: { send: 'send-x', prospect: people.full.prospectId } };
    assert.match((await post(softBounce)).body, /"outcome":"soft_bounce","replayed":false,"blocked":true/u);
    state = await prospects();
    assert.deepEqual([state.get(people.full.prospectId)!.unsubscribed, state.get(people.full.prospectId)!.marketing_consent], [false, true], 'a temporary block never rewrites the contact record');
    assert.ok((await sends(people.full.prospectId)).some(row => row.purpose === 'webinar_service' && !row.cancelled));
    // A spam report is final in itself: it is recorded the moment Postmark reports it, exactly as the unsubscribe link would be.
    const complaint = { RecordType: 'SpamComplaint', MessageStream: 'broadcast', ID: 990003, Type: 'SpamComplaint', TypeCode: 100001, Email: address('cross'), BouncedAt: new Date().toISOString(),
      Inactive: true, ServerID: 1, Metadata: { send: 'send-y', prospect: people.cross.prospectId } };
    assert.equal((await post(complaint)).status, 200);
    state = await prospects();
    assert.deepEqual([state.get(people.cross.prospectId)!.unsubscribed, state.get(people.cross.prospectId)!.marketing_consent], [true, false]);
    assert.deepEqual(await sweep(), { sent: 0, failed: 0 }, 'nothing is left to send to anyone who bounced or complained');

    assert.deepEqual({ consent: await before('app.communication_consent_events'), suppression: await before('app.communication_suppression_events') }, otherChannels,
      'email only: no text or WhatsApp permission record was written or changed');
    assert.equal(Number((await ownerQuery<{ n: string }>(admin, `SELECT count(*) AS n FROM app_private.mhp_marketing_sends WHERE prospect_id = ANY($1::uuid[]) AND delivery_channel <> 'email'`, [mine]))[0]!.n), 0);
  } finally {
    await identity.end(); await admin.end();
  }
});

test('native webinar emails on real roles: a hard-bounced or complained address is not emailed again, an unsubscribe does not stop a requested event email, and another brand is untouched', { skip, timeout: 120_000 }, async () => {
  const admin = await openTestDatabase();
  const content = await loginRole(admin, 'r72_content_command');
  try {
    const a = await seedBrand(admin, 'BounceAlpha'), b = await seedBrand(admin, 'BounceBravo');
    const clock = Date.parse('2026-11-20T12:00:00Z');
    const config = loadWebinarConfig({ WEBINAR_ACCESS_SECRET: 's'.repeat(40), WEBINAR_EMAIL_MODE: 'live', WEBINAR_PUBLIC_ORIGIN: 'https://app.example.test',
      WEBINAR_EMAIL_SENDERS: JSON.stringify([{ workspaceId: a.ws, from: 'Alpha <events@alpha.example.test>', tokenEnv: 'ALPHA_TOKEN' }, { workspaceId: b.ws, from: 'Bravo <events@bravo.example.test>', tokenEnv: 'BRAVO_TOKEN' }]),
      ALPHA_TOKEN: 'synthetic-alpha', BRAVO_TOKEN: 'synthetic-bravo' });
    const svc = new PgWebinarService({ pool: content, config, stream: null, now: () => clock });
    const sent: { to: string; from: string }[] = [];
    const mailer: WebinarMailer = { send: async (sender, to) => { sent.push({ to, from: sender.from }); return { outcome: 'sent', messageId: randomUUID() }; } };
    const registry = new EmailBlockRegistry(() => clock); registry.markReady();
    registry.record(a.ws, { sourceKey: 'alpha', stream: 'broadcast', id: 'bounce:1', kind: 'hard_bounce', email: 'gone@example.test', at: clock - DAY });
    registry.record(a.ws, { sourceKey: 'alpha', stream: 'broadcast', id: 'bounce:2', kind: 'spam_complaint', email: 'cross@example.test', at: clock - DAY });
    registry.record(a.ws, { sourceKey: 'alpha', stream: 'broadcast', id: 'subscription:3', kind: 'unsubscribed', email: 'left@example.test', at: clock - DAY }, false);
    const worker = new WebinarWorker({ pool: content, config, stream: null, mailer, recipients: registry, now: () => clock });
    const consent = { serviceNotice: 'x', marketing: false, version: 'webinar-1' };
    const publish = async (brand: typeof a) => {
      // Automatic CRM handoff is off so this proof leaves nothing for a neighbouring proof's worker to pick up.
      const id = await svc.create(brand.owner, randomUUID(), { kind: 'live', title: 'Bounce proof', summary: 'Synthetic.', presenterName: 'Sam Host', presenterTitle: 'Founder',
        timezone: 'Europe/London', startsLocal: '2026-11-25T19:00', durationMinutes: 60, capacity: 10,
        settings: readSettings({ ...DEFAULT_SETTINGS, reminderOffsetsMinutes: [], crmAutoHandoff: false }) });
      await svc.setStatus(brand.owner, randomUUID(), id, 'publish');
      const key = (await svc.get(brand.owner, randomUUID(), id)).event.publicKey;
      for (const email of ['Gone@Example.test', 'cross@example.test', 'fine@example.test', 'left@example.test']) {
        assert.equal((await svc.register(key, { email, name: 'Pat', answers: {}, marketing: false, consent, attribution: {} })).outcome, 'created');
      }
      return id;
    };
    const alpha = await publish(a), bravo = await publish(b);
    await worker.tick();
    const to = (from: string) => sent.filter(s => s.from.includes(from)).map(s => s.to).sort();
    assert.deepEqual(to('alpha'), ['fine@example.test', 'left@example.test'], 'the hard-bounced and complained addresses are skipped; the unsubscriber still gets the confirmation they asked for');
    assert.deepEqual(to('bravo'), ['cross@example.test', 'fine@example.test', 'gone@example.test', 'left@example.test'], 'a block in one brand never touches another brand');
    const jobs = async (event: string) => (await admin.query<{ email: string; state: string; detail: string | null }>(
      `SELECT r.email, j.state, j.detail FROM app.webinar_jobs j JOIN app.webinar_registrations r ON r.id = j.registration_id
       WHERE j.event_id = $1 AND j.kind = 'message' AND j.purpose = 'confirmation' ORDER BY r.email`, [event])).rows;
    assert.deepEqual((await jobs(alpha)).map(j => [j.email, j.state]), [['cross@example.test', 'blocked'], ['fine@example.test', 'done'], ['gone@example.test', 'blocked'], ['left@example.test', 'done']]);
    assert.match((await jobs(alpha))[2]!.detail!, /earlier email to this address bounced/u);
    assert.ok((await jobs(bravo)).every(j => j.state === 'done'));
    const before = sent.length; await worker.tick();
    assert.equal(sent.length, before, 'a blocked job is final: it is not retried on the next pass');
  } finally {
    await content.end(); await admin.end();
  }
});
