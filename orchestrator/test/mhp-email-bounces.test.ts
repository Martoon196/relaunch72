import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EmailBlockRegistry, EmailBounceService, EmailRecipientBlockedError, type EmailFact, type PostmarkBounceApi } from '../src/email-bounces/index.js';
import { createMhpMarketingSender, mhpMarketingConfig, startMhpMarketingDispatcher } from '../src/mhp/marketing-mail.js';
import { dispatchMhpOwnerEmails, type MhpOwnerEmailDispatch, type MhpOwnerEmailPrepared } from '../src/mhp/owner-email-dispatch.js';
import { dispatchMhpSequenceEmails, type MhpSequenceDispatch } from '../src/mhp/followup-sequence-dispatch.js';
import { emailHealthCard, emailHealthPage, emailHealthWarnings, MhpEmailHealth, mhpEmailBounceSourceDefault } from '../src/mhp/email-health.js';
import { MhpGrowthError, type MhpClaimedSend, type MhpRegistrantRecord } from '../src/mhp/growth-service.js';
import { MHP_MARKETING_WORKSPACE_ID as WS } from '../src/mhp/marketing-workspace-service.js';
import { createMhpMount } from '../src/mhp/mount.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { exact, ids, now } from './helpers/mhp-owner-email-fixture.js';

const secret = 'synthetic-unsubscribe-secret-at-least-32-characters';
const PP = 'd975ff66-336a-46c2-b36b-d7095a11af97', DAY = 86_400_000;
const fact = (over: Partial<EmailFact>): EmailFact => ({ sourceKey: 'mhp', stream: 'broadcast', id: 'bounce:1', kind: 'hard_bounce', email: 'gone@example.invalid', at: now - DAY, ...over });
function registryWith(...facts: Partial<EmailFact>[]): EmailBlockRegistry {
  const registry = new EmailBlockRegistry(() => now); registry.markReady();
  facts.forEach((item, index) => registry.record(WS, fact({ id: `bounce:${index}`, ...item })));
  return registry;
}
function transport(registry?: EmailBlockRegistry, workspaceId: string = WS) {
  const config = mhpMarketingConfig({ MHP_MARKETING_MODE: 'live', MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token', MHP_MARKETING_FROM: 'owner@example.invalid' })!;
  const bodies: Record<string, any>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ErrorCode: 0, MessageID: `pm-${bodies.length}` }), { status: 200 }); }) as typeof fetch;
  return { bodies, sender: createMhpMarketingSender(config, secret, fetcher, registry ? { guard: registry, workspaceId } : undefined) };
}
const claimed = (over: Partial<MhpClaimedSend> = {}): MhpClaimedSend => ({ id: ids.send, prospectId: ids.prospect, template: 'webinar_90days', campaign: 'webinar-proof',
  context: { label: 'Webinar', link: 'https://martinhowardproperty.co.uk/webinar/' }, email: 'gone@example.invalid', firstName: 'Sam', level: null, attempts: 1,
  expiresAt: new Date(now + DAY).toISOString(), ...over });

test('the one MHP sender refuses a blocked address before any provider call, by purpose and by workspace', async () => {
  const hard = transport(registryWith({ kind: 'hard_bounce' }));
  await assert.rejects(hard.sender.send(claimed()), (error: unknown) => error instanceof EmailRecipientBlockedError && error.reason === 'hard_bounce');
  await assert.rejects(hard.sender.send(claimed({ template: 'webinar_confirm', context: { emailPurpose: 'webinar_service' } })), EmailRecipientBlockedError,
    'a hard-bounced address does not even get the confirmation it asked for');
  assert.equal(hard.bodies.length, 0, 'Postmark was never called');
  await hard.sender.send(claimed({ email: 'fine@example.invalid' }));
  assert.equal(hard.bodies.length, 1, 'only the exact address is refused');

  const complained = transport(registryWith({ kind: 'spam_complaint' }));
  await assert.rejects(complained.sender.send(claimed()), (error: unknown) => error instanceof EmailRecipientBlockedError && error.reason === 'spam_complaint');
  await assert.rejects(complained.sender.send(claimed({ template: 'webinar_confirm', context: { emailPurpose: 'webinar_service' } })), EmailRecipientBlockedError,
    'a spam complaint stops every email from the brand, the confirmation included');
  assert.equal(complained.bodies.length, 0);

  // An unsubscribe stops marketing only: the confirmation they asked for still goes on the transactional stream.
  const left = transport(registryWith({ kind: 'unsubscribed' }));
  await assert.rejects(left.sender.send(claimed()), (error: unknown) => error instanceof EmailRecipientBlockedError && error.reason === 'unsubscribed');
  await left.sender.send(claimed({ template: 'webinar_confirm', context: { emailPurpose: 'webinar_service' } }));
  assert.deepEqual(left.bodies.map(b => b.MessageStream), ['outbound'], 'the event email they asked for still goes on the transactional stream');

  const unsubscribed = transport(registryWith({ kind: 'unsubscribed' }));
  await assert.rejects(unsubscribed.sender.sendRendered({ id: ids.send, email: 'GONE@example.invalid', tag: 'owner_sequence', prospectId: ids.prospect,
    rendered: { subject: 's', text: 't', html: '<p>t</p>', unsubscribe: 'https://app.martinhowardproperty.co.uk/email/unsubscribe?p=x' } }), EmailRecipientBlockedError);
  await unsubscribed.sender.sendRendered({ id: ids.send, email: 'gone@example.invalid', tag: 'owner_email_test', ownerTest: true,
    rendered: { subject: 's', text: 't', html: '<p>t</p>', unsubscribe: 'https://example.invalid/u' } });
  assert.equal(unsubscribed.bodies.length, 1, 'the owner\'s own test send is exempt');

  const otherBrand = transport(registryWith({ kind: 'hard_bounce' }), PP);
  await otherBrand.sender.send(claimed());
  assert.equal(otherBrand.bodies.length, 1, 'a block in one workspace never refuses another workspace\'s send');
  const unguarded = transport(); await unguarded.sender.send(claimed()); assert.equal(unguarded.bodies.length, 1);
});

test('every email carries the prospect it was addressed to, except the owner notice about someone else\'s application', async () => {
  const t = transport(registryWith());
  await t.sender.send(claimed({ email: 'sam@example.invalid' }));
  assert.deepEqual(t.bodies[0]!.Metadata, { send: ids.send, prospect: ids.prospect });
  await t.sender.sendRendered({ id: ids.send, email: 'sam@example.invalid', tag: 'owner_followup', prospectId: 'not-a-uuid',
    rendered: { subject: 's', text: 't', html: '<p>t</p>', unsubscribe: 'https://example.invalid/u' } });
  assert.deepEqual(t.bodies[1]!.Metadata, { send: ids.send });
  const application = { id: ids.item, name: 'Sam', email: 'sam@example.invalid', phone: null, location: 'Leeds', experience: 'None yet', door: 'Refer', hours: '5',
    objective: 'o', obstacle: 'o', support: 's', discuss: true, marketingConsent: false, source: 'site', status: 'new', createdAt: new Date(now).toISOString() };
  await t.sender.send(claimed({ template: 'application_notify', email: 'martin.howard1984@gmail.com', application } as Partial<MhpClaimedSend>));
  assert.deepEqual(t.bodies[2]!.Metadata, { send: ids.send }, 'a bounce of the owner\'s own inbox can never stop the applicant');
});

test('built-in sign-up emails: a refused address stops that person for good and is settled as not sent', async () => {
  const calls: string[] = []; let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; });
  const t = transport(registryWith({ kind: 'hard_bounce' }, { kind: 'hard_bounce', email: 'martin.howard1984@gmail.com' }));
  const batch = [claimed(), claimed({ id: ids.request, prospectId: ids.user, email: 'fine@example.invalid' }),
    claimed({ id: ids.item, prospectId: ids.version, template: 'application_notify', email: 'martin.howard1984@gmail.com' })];
  let claims = 0;
  const stop = startMhpMarketingDispatcher({ claim: async () => (claims++ === 0 ? batch : []),
    settle: async (id, accepted) => { calls.push(`settle ${id} ${accepted}`); if (calls.filter(c => c.startsWith('settle')).length === 3) finished(); } },
    t.sender, { testRecipients: null }, { intervalMs: 60_000, onBlocked: async prospectId => { calls.push(`stop ${prospectId}`); } });
  await done; stop();
  assert.deepEqual(calls, [`stop ${ids.prospect}`, `settle ${ids.send} false`, `settle ${ids.request} true`, `settle ${ids.item} false`],
    'the owner notice was refused too, but the applicant was not stopped for it');
  assert.deepEqual(t.bodies.map(b => b.To), ['fine@example.invalid']);
});

const lease = { id: ids.send, leaseId: ids.lease, leaseUntil: new Date(now + 120_000).toISOString() };
const prepared: MhpOwnerEmailPrepared = { ...lease, proofId: ids.proof, prospectId: ids.prospect, email: 'gone@example.invalid', firstName: 'Sam',
  context: { label: 'Webinar', link: 'https://martinhowardproperty.co.uk/webinar/' }, exact: { ...exact, approvalDecisionId: ids.approval } };

test('owner emails: a refused address is stopped and settled as a definite non-send, never retried through the provider', async () => {
  const calls: string[] = [];
  const queue: MhpOwnerEmailDispatch = { claim: async () => [lease], prepare: async () => prepared, settle: async (_lease, accepted) => { calls.push(`settle ${accepted}`); } };
  const t = transport(registryWith({ kind: 'hard_bounce' }));
  const result = await dispatchMhpOwnerEmails({ queue, sender: t.sender, unsubscribeSecret: secret, testRecipients: null, now: () => now,
    onBlocked: async prospectId => { calls.push(`stop ${prospectId}`); } });
  assert.deepEqual(result, { sent: 0, failed: 1 }); assert.deepEqual(calls, [`stop ${ids.prospect}`, 'settle false']); assert.equal(t.bodies.length, 0);
  const failing = await dispatchMhpOwnerEmails({ queue, sender: t.sender, unsubscribeSecret: secret, testRecipients: null, now: () => now,
    onBlocked: async () => { throw new Error('database unavailable'); } });
  assert.deepEqual(failing, { sent: 0, failed: 1 }, 'a failed stop never turns into a send');
  assert.equal(t.bodies.length, 0);
});

test('sequences: a refused address ends as a definite rejection that stops the person, not an unknown the owner must untangle', async () => {
  const calls: string[] = [];
  const queue: MhpSequenceDispatch = { claim: async () => [lease], prepare: async () => { calls.push('prepare'); return prepared; },
    settle: async (_lease, accepted, reference) => { calls.push(`settle ${accepted} ${reference}`); }, unknown: async () => { calls.push('unknown'); } };
  const t = transport(registryWith({ kind: 'hard_bounce' }));
  const result = await dispatchMhpSequenceEmails({ queue, sender: t.sender, unsubscribeSecret: secret, testRecipients: null, now: () => now,
    onBlocked: async prospectId => { calls.push(`stop ${prospectId}`); } });
  assert.deepEqual(result, { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(calls, ['prepare', `stop ${ids.prospect}`, 'settle false null']); assert.equal(t.bodies.length, 0);
  const lost: string[] = [];
  const broken: MhpSequenceDispatch = { ...queue, settle: async () => { lost.push('settle'); throw new Error('database unavailable'); }, unknown: async () => { lost.push('unknown'); } };
  await dispatchMhpSequenceEmails({ queue: broken, sender: t.sender, unsubscribeSecret: secret, testRecipients: null, now: () => now });
  assert.deepEqual(lost, ['settle', 'unknown'], 'if even the rejection cannot be saved, the existing unknown fence still holds the run');
  const open = transport(registryWith());
  const sent = await dispatchMhpSequenceEmails({ queue: { ...queue, settle: async (_l, accepted) => { assert.equal(accepted, true); } }, sender: open.sender,
    unsubscribeSecret: secret, testRecipients: null, now: () => now });
  assert.deepEqual(sent, { sent: 1, failed: 0, unknown: 0 }); assert.deepEqual(open.bodies[0]!.Metadata, { send: ids.send, prospect: ids.prospect });
});

test('Postmark 406 (inactive recipient) in a sequence is a definite non-send, never the unknown hold, and never stops the person', async () => {
  const calls: string[] = [];
  const queue: MhpSequenceDispatch = { claim: async () => [lease], prepare: async () => prepared,
    settle: async (_lease, accepted, reference) => { calls.push(`settle ${accepted} ${reference}`); }, unknown: async () => { calls.push('unknown'); } };
  const config = mhpMarketingConfig({ MHP_MARKETING_MODE: 'live', MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token', MHP_MARKETING_FROM: 'owner@example.invalid' })!;
  const sender = createMhpMarketingSender(config, secret, (async () => new Response(JSON.stringify({ ErrorCode: 406, Message: 'inactive' }), { status: 422 })) as unknown as typeof fetch);
  const result = await dispatchMhpSequenceEmails({ queue, sender, unsubscribeSecret: secret, testRecipients: null, now: () => now,
    onBlocked: async prospectId => { calls.push(`stop ${prospectId}`); } });
  assert.deepEqual(result, { sent: 0, failed: 1, unknown: 0 });
  assert.deepEqual(calls, ['settle false null']);
  // Before this fix any 4xx was a plain error: after the proof that is the unknown hold. A 500 still is.
  const unsure = createMhpMarketingSender(config, secret, (async () => new Response('', { status: 500 })) as unknown as typeof fetch);
  calls.length = 0;
  assert.deepEqual(await dispatchMhpSequenceEmails({ queue, sender: unsure, unsubscribeSecret: secret, testRecipients: null, now: () => now }), { sent: 0, failed: 0, unknown: 1 });
});

test('a marketing-only block refuses the marketing email but never stops the person from a send path: the webinar reminders they asked for stay queued', async () => {
  // Three soft bounces, an unsubscribe at Postmark: each blocks marketing only. The stop is the unsubscribe capability,
  // which cancels EVERYTHING queued for the person, so a refused marketing email must not trigger it. (A spam report
  // stops all email from the brand, so it is not a marketing-only block; see the sender test above.)
  const softs = [1, 2, 3].map(n => ({ kind: 'soft_bounce' as const, id: `bounce:s${n}`, at: now - n * DAY }));
  for (const facts of [softs, [{ kind: 'unsubscribed' as const }]]) {
    const registry = registryWith(...facts);
    assert.equal(registry.decide(WS, 'gone@example.invalid', 'marketing').blocked, true);
    const calls: string[] = [];
    const onBlocked = async (prospectId: string) => { calls.push(`stop ${prospectId}`); };

    // Built-in emails: the opted-in confirmation is a marketing email, the reminder beside it is one they asked for.
    const t = transport(registry); let finished!: () => void; const done = new Promise<void>(resolve => { finished = resolve; }); let claims = 0;
    const batch = [claimed({ template: 'webinar_confirm' }), claimed({ id: ids.request, template: 'webinar_confirm', context: { emailPurpose: 'webinar_service' } })];
    const stop = startMhpMarketingDispatcher({ claim: async () => (claims++ === 0 ? batch : []),
      settle: async (id, accepted) => { calls.push(`settle ${id} ${accepted}`); if (calls.filter(c => c.startsWith('settle')).length === 2) finished(); } },
      t.sender, { testRecipients: null }, { intervalMs: 60_000, onBlocked });
    await done; stop();
    assert.deepEqual(calls, [`settle ${ids.send} false`, `settle ${ids.request} true`], 'refused and recorded as not sent; the person is not stopped; the requested email still goes');
    assert.deepEqual(t.bodies.map(b => b.MessageStream), ['outbound']);

    // Owner emails and sequences: a definite, recorded non-send (the queue retries it and fails it by rule), never a stop and never an unknown.
    calls.length = 0;
    const owner: MhpOwnerEmailDispatch = { claim: async () => [lease], prepare: async () => prepared, settle: async (_lease, accepted) => { calls.push(`settle ${accepted}`); } };
    assert.deepEqual(await dispatchMhpOwnerEmails({ queue: owner, sender: t.sender, unsubscribeSecret: secret, testRecipients: null, now: () => now, onBlocked }), { sent: 0, failed: 1 });
    const sequence: MhpSequenceDispatch = { ...owner, unknown: async () => { calls.push('unknown'); } };
    assert.deepEqual(await dispatchMhpSequenceEmails({ queue: sequence, sender: t.sender, unsubscribeSecret: secret, testRecipients: null, now: () => now, onBlocked }),
      { sent: 0, failed: 1, unknown: 0 });
    assert.deepEqual(calls, ['settle false', 'settle false']); assert.equal(t.bodies.length, 1, 'Postmark was never called for the refused emails');
  }
});

const registrant = (over: Partial<MhpRegistrantRecord>): MhpRegistrantRecord => ({ id: ids.prospect, firstName: 'Sam', email: 'gone@example.invalid', phone: null, level: null,
  marketingConsent: true, unsubscribed: false, firstSeenAt: new Date(now).toISOString(), lastSignupAt: new Date(now).toISOString(), signups: ['Webinar'], webinar: true, applied: false, ...over });
function health(options: { registrants?: MhpRegistrantRecord[]; forbidden?: boolean; suppressed?: string[]; fail?: boolean; hang?: boolean;
  listed?: { email: string; kind: 'hard_bounce' | 'spam_complaint' | 'unsubscribed'; at: number }[] } = {}) {
  const stopped: string[] = []; let reads = 0;
  const api: PostmarkBounceApi = {
    suppressions: async stream => { reads++; if (options.fail) throw new Error('unavailable');
      if (options.hang) await new Promise(resolve => setTimeout(resolve, 400));
      if (options.listed) return stream === 'broadcast' ? options.listed : [];
      return stream === 'broadcast' ? (options.suppressed ?? ['gone@example.invalid', 'a@example.invalid', 'b@example.invalid']).map(email => ({ email, kind: 'hard_bounce' as const, at: now - 2 * DAY })) : []; },
    bounces: async () => ({ total: 0, received: 0, rows: [] }), totals: async stream => stream === 'broadcast' ? { sent: 30, bounced: (options.suppressed ?? [1, 2, 3]).length, complaints: 0 } : { sent: 70, bounced: 0, complaints: 0 } };
  const bounces = new EmailBounceService({ now: () => now, apiFor: () => api, config: { blockers: [], sources: [{ key: 'mhp', workspaceId: WS, token: 'synthetic-token',
    webhookSecret: 's'.repeat(32), serverId: null, streams: new Map([['broadcast', 'marketing'], ['outbound', 'service']]) }] } });
  const service = new MhpEmailHealth({ bounces, patienceMs: options.hang ? 20 : undefined, growth: {
    listRegistrants: async token => { assert.equal(token, 'session-token'); if (options.forbidden) throw new MhpGrowthError(403, 'Owner access is required for HQ.'); return options.registrants ?? []; },
    unsubscribe: async prospectId => { stopped.push(prospectId); return true; } } });
  return { service, bounces, stopped, reads: () => reads };
}

test('the owner check blocks the three addresses Postmark already lists and stops exactly those people, once', async () => {
  const f = health({ registrants: [registrant({}), registrant({ id: ids.user, email: 'A@example.invalid' }), registrant({ id: ids.item, email: 'b@example.invalid', unsubscribed: true }),
    registrant({ id: ids.version, email: 'fine@example.invalid' })] });
  assert.equal(f.service.configured, true); assert.equal(f.service.snapshot().blocked.length, 0, 'nothing typed in, nothing known yet');
  assert.deepEqual(await f.service.check('session-token'), { complete: true, blocked: 3, stopped: 2, contactListChecked: true });
  assert.deepEqual(f.stopped, [ids.prospect, ids.user], 'the already-stopped person and the healthy address are left alone');
  assert.deepEqual(f.service.snapshot().blocked.map(b => b.email), ['a@example.invalid', 'b@example.invalid', 'gone@example.invalid']);
  assert.deepEqual(f.service.snapshot().window, { days: 30, sent: 100, bounced: 3, complaints: 0, bounceRate: 0.03, complaintRate: 0 });
  const reads = f.reads(); await f.service.check('session-token'); assert.equal(f.reads(), reads, 'pressing again straight away does not re-read Postmark');
  const noAccess = health({ forbidden: true });
  assert.deepEqual(await noAccess.service.check('session-token'), { complete: true, blocked: 3, stopped: 0, contactListChecked: false });
  assert.equal(noAccess.bounces.registry.decide(WS, 'gone@example.invalid', 'marketing').blocked, true, 'sending is blocked whether or not the list could be updated');
  const down = health({ fail: true });
  assert.deepEqual(await down.service.check('session-token'), { complete: false, blocked: 0, stopped: 0, contactListChecked: true });
  const slow = health({ hang: true });
  assert.deepEqual(await slow.service.check('session-token'), { complete: false, blocked: 0, stopped: 0, contactListChecked: true },
    'a slow Postmark never holds the page past the server\'s request limit');
});

test('the owner check stops a dead or complained address always, an unsubscribe only if the person has not signed up again since, and a soft-bounce block never', async () => {
  const at = (days: number) => new Date(now - days * DAY).toISOString();
  const f = health({
    listed: [{ email: 'dead@example.invalid', kind: 'hard_bounce', at: now - 20 * DAY }, { email: 'cross@example.invalid', kind: 'spam_complaint', at: now - 20 * DAY },
      { email: 'back@example.invalid', kind: 'spam_complaint', at: now - 20 * DAY }, { email: 'left@example.invalid', kind: 'unsubscribed', at: now - 20 * DAY },
      { email: 'again@example.invalid', kind: 'unsubscribed', at: now - 20 * DAY }],
    registrants: [
      registrant({ id: ids.prospect, email: 'dead@example.invalid', lastSignupAt: at(1) }),
      registrant({ id: ids.user, email: 'cross@example.invalid', lastSignupAt: at(40) }),
      // Complained three weeks ago, registered for the next webinar yesterday: a spam report still stops every email.
      registrant({ id: ids.item, email: 'back@example.invalid', lastSignupAt: at(1) }),
      registrant({ id: ids.version, email: 'left@example.invalid', lastSignupAt: at(25) }),
      // Unsubscribed three weeks ago, registered for the next webinar yesterday: reminders are queued for them.
      registrant({ id: ids.command, email: 'again@example.invalid', lastSignupAt: at(1) }),
      registrant({ id: ids.request, email: 'full@example.invalid', lastSignupAt: at(40) })] });
  [1, 2, 3].forEach(n => f.bounces.registry.record(WS, fact({ id: `bounce:full${n}`, kind: 'soft_bounce', email: 'full@example.invalid', at: now - n * DAY })));
  assert.deepEqual(await f.service.check('session-token'), { complete: true, blocked: 6, stopped: 4, contactListChecked: true });
  assert.deepEqual(f.stopped, [ids.prospect, ids.user, ids.item, ids.version]);
  assert.equal(f.bounces.registry.decide(WS, 'back@example.invalid', 'service').blocked, true, 'a spam report refuses the emails they asked for too');
  for (const email of ['again@example.invalid', 'full@example.invalid']) {
    assert.equal(f.bounces.registry.decide(WS, email, 'marketing').blocked, true, 'their marketing email is still refused');
    assert.equal(f.bounces.registry.decide(WS, email, 'service').blocked, false, 'and the emails they asked for still go');
  }
});

test('the webhook effect stops the prospect named in our own message metadata and nothing else', async () => {
  const f = health();
  const effects = f.service.effects();
  await effects.onMarketingBlock({ email: 'gone@example.invalid', reason: 'hard_bounce', metadata: { send: 'x', prospect: ids.prospect } });
  await effects.onMarketingBlock({ email: 'gone@example.invalid', reason: 'hard_bounce', metadata: { send: 'x' } });
  await effects.onMarketingBlock({ email: 'gone@example.invalid', reason: 'hard_bounce', metadata: { prospect: 'not-a-uuid' } });
  assert.deepEqual(f.stopped, [ids.prospect]);
  // Defence in depth: the shared handler never passes a temporary reason, and MHP would not act on one if it did.
  await effects.onMarketingBlock({ email: 'gone@example.invalid', reason: 'repeated_soft_bounce' as never, metadata: { prospect: ids.user } });
  assert.deepEqual(f.stopped, [ids.prospect]);
  assert.deepEqual(mhpEmailBounceSourceDefault({ MHP_POSTMARK_BROADCAST_STREAM: 'news', MHP_POSTMARK_TRANSACTIONAL_STREAM: 'events' }),
    { key: 'mhp', workspaceId: WS, tokenEnv: 'MHP_POSTMARK_SERVER_TOKEN', webhookSecretEnv: 'MHP_POSTMARK_WEBHOOK_SECRET', marketingStreams: ['news'], serviceStreams: ['events', 'outbound'] });
  assert.deepEqual(mhpEmailBounceSourceDefault({}).serviceStreams, ['outbound']);
});

test('the owner page is plain English: counts, the 30-day rate, each blocked address with reason and date, and a warning past our own line', async () => {
  const f = health({ suppressed: ['gone@example.invalid', 'a@example.invalid', '<script>@example.invalid'] });
  await f.bounces.sweepWorkspace(WS);
  f.bounces.registry.record(WS, fact({ id: 'bounce:c', kind: 'spam_complaint', email: 'cross@example.invalid', stream: 'outbound', at: now - 3_600_000 }));
  const snapshot = f.service.snapshot();
  const html = emailHealthPage(snapshot, 'csrf-token', { complete: true, blocked: 4, stopped: 2, contactListChecked: true });
  assert.match(html, /<h1>Emails that bounced or complained<\/h1>/u);
  assert.match(html, /<strong>3<\/strong>addresses bounced/u); assert.match(html, /<strong>1<\/strong>person marked an email as spam/u);
  assert.match(html, /3 of 100 emails bounced \(3\.0%\)/u);
  assert.match(html, /gone@example\.invalid<\/td><td>The address does not work \(the email came straight back\)<\/td><td>29 Oct 2026<\/td><td>Marketing and event emails/u);
  assert.match(html, /cross@example\.invalid<\/td><td>They marked one of your emails as spam<\/td><td>30 Oct 2026<\/td><td>Marketing and event emails/u);
  assert.match(html, /role="alert"><strong>Warning\.<\/strong> 10\.0% of your marketing emails bounced in the last 30 days \(3 of 30\)\. We warn at 5\.0%, which is our own line\. Postmark expects bounces to stay under about 10\.0%/u);
  assert.match(html, /1 person marked your requested emails \(sign-in links, receipts and webinar emails\) as spam/u);
  assert.match(html, /<td>Requested emails \(sign-in links, receipts and webinar emails\)<\/td><td>70<\/td>/u, 'the row is named for everything its totals count');
  assert.match(html, /Postmark, the service that sends your emails\./u);
  // Without the durable list in this process: no button, and no claim that it is kept in our own records.
  assert.doesNotMatch(html, /This address works now|own records/u);
  assert.match(html, /reactivate it in Postmark and it leaves this list at the next check/u);
  assert.match(html, /Sign-in links and receipts still go\./u);
  assert.doesNotMatch(html, /no email at all|All email/u);
  const durableHtml = emailHealthPage(snapshot, 'csrf-token', undefined, { durable: true });
  assert.match(durableHtml, /also kept in your own records/u);
  assert.match(durableHtml, /press Reactivate for it in Postmark first/u);
  assert.equal((durableHtml.match(/This address works now<\/button>/g) ?? []).length, 3, 'one button per hard-bounced address');
  assert.doesNotMatch(durableHtml, /cross@example\.invalid<\/td><td>They marked one of your emails as spam<\/td><td>[^<]*<\/td><td>Marketing and event emails<form/u, 'never for a spam report');
  assert.match(durableHtml, /<form method="post" action="\/hq\/marketing\/email-health\/lift"><input type="hidden" name="csrf" value="csrf-token"><input type="hidden" name="email" value="gone@example\.invalid">/u);
  assert.match(emailHealthPage(snapshot, 'c', undefined, { durable: true, lift: { email: 'gone@example.invalid', outcome: 'lifted' } }),
    /We no longer block gone@example\.invalid for that bounce\. Now press Reactivate for this address in Postmark, or Postmark will still refuse it\. If we also stopped this person in your contacts, they stay stopped until they sign up again: we cannot tell whether the bounce caused that\./u);
  const say = (outcome: 'already_lifted' | 'spam' | 'not_blocked' | 'unavailable') => emailHealthPage(snapshot, 'c', undefined, { durable: true, lift: { email: 'gone@example.invalid', outcome } });
  assert.match(say('already_lifted'), /We had already stopped blocking gone@example\.invalid for that bounce\. If it is still listed here, Postmark still lists it: press Reactivate for this address in Postmark\./u);
  assert.match(say('spam'), /gone@example\.invalid stays blocked: they marked one of your emails as spam, and a spam report cannot be undone from this page\./u);
  assert.match(say('not_blocked'), /has no bounce recorded in your own records, so nothing changed/u);
  for (const outcome of ['already_lifted', 'spam', 'not_blocked', 'unavailable'] as const) assert.doesNotMatch(say(outcome), /We no longer block|was not blocked by a bounce/u, outcome);
  assert.match(html, /stays stopped, exactly as if they had unsubscribed, until they sign up again and tick the box themselves/u, 'reactivating at Postmark does not re-subscribe anyone');
  assert.match(html, /Only 100 emails went out in this period/u);
  assert.match(html, /2 people were newly stopped in your contacts/u);
  assert.match(html, /name="csrf" value="csrf-token"/u); assert.match(html, /Check with Postmark now/u); assert.match(html, /Texts and WhatsApp are not affected/u);
  assert.doesNotMatch(html, /<script>@/u); assert.match(html, /&lt;script&gt;@example\.invalid/u);
  assert.doesNotMatch(html.replace(/<style>.*?<\/style>/su, ''), /suppress|hard bounce|soft bounce|webhook|\bstream\b|broadcast|outbound/iu, 'no jargon');
  assert.equal(emailHealthWarnings(snapshot).length, 2);
  assert.match(emailHealthCard(snapshot), /4 addresses are blocked[^<]*In the last 30 days 3\.0% of your emails bounced\.<\/p><p role="alert">/u);
  const quiet = health({ suppressed: [] }); await quiet.bounces.sweepWorkspace(WS);
  const calm = emailHealthPage(quiet.service.snapshot(), 'c');
  assert.match(calm, /No blocked addresses\. Nothing has bounced or been reported\./u); assert.doesNotMatch(calm, /role="alert"/u);
  assert.match(emailHealthCard(quiet.service.snapshot()), /No addresses are blocked\./u);
  assert.match(emailHealthPage(quiet.service.snapshot(), 'c', { complete: true, blocked: 1, stopped: 0, contactListChecked: false }), /Your contact list was not updated from this sign-in/u);
});

const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SESSION_SECRET = 'mhp-bounce-synthetic-session-secret-at-least-32';
const TOKEN = Buffer.alloc(32, 7).toString('base64url'), PERSONAL = '12400000-0000-4000-8000-000000000002';
function routes(options: { selected?: string; owner?: boolean; configured?: boolean } = {}) {
  const selected = options.selected ?? WS, checks: string[] = [], lifts: string[] = [], selects: string[] = [];
  const f = health({ registrants: [registrant({})] });
  const portal = { kind: 'postgres', secure: true, sessionSecret: SESSION_SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE,
    portalBaseUrl: ORIGIN, now: () => now, auth: { resolve: async (token: string) => token === TOKEN ? { sessionToken: TOKEN, userId: ids.user, workspaceId: selected, userEmail: 'owner@example.invalid' } : null,
      login: async () => null, revoke: async () => {} }, abuseHashSecret: 'mhp-bounce-abuse-secret-at-least-32-characters',
    requestContext: () => ({ requestId: ids.command, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} },
  } as unknown as PostgresPortalDeps;
  const mount = createMhpMount({ portal, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw new Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} },
    marketingWorkspace: { snapshot: async () => { if (options.owner === false) throw new MhpCommerceError(403, 'Owner access to the MHP marketing workspace is required.');
      return { userId: ids.user, selectedWorkspaceId: selected, personalWorkspaceId: PERSONAL, marketingWorkspaceId: selected === WS ? WS : null, marketingSelected: selected === WS }; },
      select: async (_identity: unknown, action: string) => { selects.push(action); return { workspaceId: action === 'open' ? WS : PERSONAL, sessionToken: TOKEN, expiresAt: new Date(now + 3_600_000).toISOString() }; } },
    ...(options.configured === false ? {} : { emailHealth: { configured: true, durable: true, snapshot: () => f.service.snapshot(),
      check: async (token: string) => { checks.push(token); return f.service.check('session-token'); },
      lift: async (token: string, email: string) => { lifts.push(`${token} ${email}`); return { email, outcome: 'lifted' as const }; } } }) });
  async function request(method: string, url: string, body = '', headers: Record<string, string> = {}) {
    const captured = { status: 0, body: '', headers: {} as Record<string, string> };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers: { host: HOST, cookie: `__Host-mhp_session=${TOKEN}`,
      'content-type': 'application/x-www-form-urlencoded', ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, h = {}) { captured.status = status; Object.assign(captured.headers, h); },
      setHeader(key: string, value: string) { captured.headers[key.toLowerCase()] = value; }, end(text = '') { captured.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return captured;
  }
  const form = (csrf = portalCsrfToken(SESSION_SECRET, TOKEN)) => new URLSearchParams({ csrf }).toString();
  return { request, form, checks, lifts, selects, f };
}

test('marketing screen: the card and the page appear only inside the MHP brand workspace, and the check needs the owner\'s own form', async () => {
  const r = routes();
  const home = await r.request('GET', '/hq/marketing');
  assert.equal(home.status, 200); assert.match(home.body, /<h2>Emails that bounced or complained<\/h2><p>No addresses are blocked\./u);
  assert.match(home.body, /href="\/hq\/marketing\/email-health"/u);
  const page = await r.request('GET', '/hq/marketing/email-health');
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store'); assert.match(page.body, /Not checked with Postmark yet\./u);
  assert.equal((await r.request('POST', '/hq/marketing/email-health/check', r.form())).status, 403, 'no cross-site posts');
  assert.equal((await r.request('POST', '/hq/marketing/email-health/check', r.form('wrong'), { origin: ORIGIN })).status, 403);
  assert.equal((await r.request('GET', '/hq/marketing/email-health/check')).status, 405);
  assert.deepEqual(r.checks, []);
  const checked = await r.request('POST', '/hq/marketing/email-health/check', r.form(), { origin: ORIGIN });
  assert.equal(checked.status, 200); assert.deepEqual(r.checks, [TOKEN]);
  assert.match(checked.body, /Checked with Postmark\. 3 addresses are blocked\. 1 person was newly stopped in your contacts\./u);
  assert.match(checked.body, /gone@example\.invalid/u); assert.deepEqual(r.f.stopped, [ids.prospect]);

  const personal = routes({ selected: PERSONAL });
  assert.doesNotMatch((await personal.request('GET', '/hq/marketing')).body, /bounced or complained/u);
  const outside = await personal.request('GET', '/hq/marketing/email-health');
  assert.equal(outside.status, 200, 'a proper page, not a bare error');
  assert.doesNotMatch(outside.body, /@example\.invalid|This address works now/u, 'addresses are never shown outside the brand workspace');
  assert.match(outside.body, /<h1>Emails that bounced or complained<\/h1><p>This page shows the brand&#39;s own email addresses|<h1>Emails that bounced or complained<\/h1><p>This page shows the brand's own email addresses/u);
  assert.match(outside.body, /<form method="post" action="\/hq\/marketing\/open"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="commandId" value="[0-9a-f-]{36}"><input type="hidden" name="then" value="email-health"><button type="submit">Open marketing workspace<\/button><\/form>/u);
  assert.equal((await personal.request('POST', '/hq/marketing/email-health/check', personal.form(), { origin: ORIGIN })).status, 403);
  assert.equal((await routes({ owner: false }).request('GET', '/hq/marketing/email-health')).status, 403);
  assert.equal((await routes({ configured: false }).request('GET', '/hq/marketing/email-health')).status, 404);
  assert.doesNotMatch((await routes({ configured: false }).request('GET', '/hq/marketing')).body, /bounced or complained/u);
  const signedOut = await r.request('GET', '/hq/marketing/email-health', '', { cookie: '' });
  assert.deepEqual([signedOut.status, signedOut.headers.location], [303, '/portal/login?next=%2Fhq%2Fmarketing%2Femail-health']);
  assert.equal((await r.request('GET', '/hq/marketing', '', { cookie: '' })).headers.location, '/portal/login?next=%2Fhq%2Fmarketing');
  assert.equal((await r.request('POST', '/hq/marketing/email-health/check', r.form(), { cookie: '', origin: ORIGIN })).headers.location, '/portal/login', 'a form post is never carried');
});

test('"This address works now": the owner\'s own form (same origin, CSRF) in the brand workspace only, and a one-line confirmation', async () => {
  const r = routes();
  const body = (csrf = portalCsrfToken(SESSION_SECRET, TOKEN), email = 'gone@example.invalid') => new URLSearchParams({ csrf, email }).toString();
  assert.equal((await r.request('POST', '/hq/marketing/email-health/lift', body())).status, 403, 'no cross-site posts');
  assert.equal((await r.request('POST', '/hq/marketing/email-health/lift', body('wrong'), { origin: ORIGIN })).status, 403);
  assert.equal((await r.request('POST', '/hq/marketing/email-health/lift', r.form(), { origin: ORIGIN })).status, 400, 'the address is required');
  assert.equal((await r.request('GET', '/hq/marketing/email-health/lift')).status, 405);
  assert.deepEqual(r.lifts, []);
  const done = await r.request('POST', '/hq/marketing/email-health/lift', body(), { origin: ORIGIN });
  assert.equal(done.status, 200); assert.deepEqual(r.lifts, [`${TOKEN} gone@example.invalid`]);
  assert.match(done.body, /<p role="status" class="status">We no longer block gone@example\.invalid for that bounce\. Now press Reactivate for this address in Postmark/u);
  const personal = routes({ selected: PERSONAL });
  assert.equal((await personal.request('POST', '/hq/marketing/email-health/lift', body(), { origin: ORIGIN })).status, 403);
  assert.deepEqual(personal.lifts, []);
});

test('MhpEmailHealth.lift: lifts through the durable list with the owner session, reloads it, and reports a spam report honestly', async () => {
  const calls: string[] = [];
  const bounces = { hasWorkspace: () => true, durable: true,
    ownerLiftHardBounce: async (input: { sessionToken: string; email: string; note: string }) => { calls.push(`lift ${input.sessionToken} ${input.email} ${input.note}`);
      return input.email.startsWith('spam') ? { lifted: 1, released: 0, spamComplaint: true } : input.email.startsWith('none') ? { lifted: 0, released: 0, spamComplaint: false } : { lifted: 1, released: 0, spamComplaint: false }; },
    refreshLedger: async () => { calls.push('refresh'); } } as unknown as EmailBounceService;
  const health = new MhpEmailHealth({ bounces, growth: { listRegistrants: async () => [], unsubscribe: async () => true } });
  assert.equal(health.durable, true);
  assert.deepEqual(await health.lift('tok', ' Gone@Example.invalid '), { email: 'gone@example.invalid', outcome: 'lifted' });
  assert.deepEqual(calls, ['lift tok gone@example.invalid Owner confirmed in Growth HQ that this address works now', 'refresh']);
  assert.equal((await health.lift('tok', 'spam@example.invalid')).outcome, 'spam');
  assert.equal((await health.lift('tok', 'none@example.invalid')).outcome, 'not_blocked');
  const old = new MhpEmailHealth({ bounces: { ...bounces, ownerLiftHardBounce: async () => null } as unknown as EmailBounceService, growth: { listRegistrants: async () => [], unsubscribe: async () => true } });
  assert.equal((await old.lift('tok', 'gone@example.invalid')).outcome, 'unavailable');
});

test('Open marketing workspace: from the email health page it lands back there; elsewhere the enquiry board, as before; nothing else is accepted', async () => {
  const personal = routes({ selected: PERSONAL });
  const open = (extra: Record<string, string> = {}) => personal.request('POST', '/hq/marketing/open',
    new URLSearchParams({ csrf: portalCsrfToken(SESSION_SECRET, TOKEN), commandId: '12400000-0000-4000-8000-000000000099', ...extra }).toString(), { origin: ORIGIN });
  const back = await open({ then: 'email-health' });
  assert.deepEqual([back.status, back.headers.location], [303, '/hq/marketing/email-health']);
  const normal = await open();
  assert.deepEqual([normal.status, normal.headers.location], [303, '/portal/crm/opportunities']);
  for (const then of ['/hq/marketing/email-health', 'https://evil.invalid', '//evil.invalid', 'email-health ', 'Email-Health', '']) {
    assert.equal((await open({ then })).status, 400, JSON.stringify(then));
  }
  assert.deepEqual(personal.selects, ['open', 'open'], 'a refused value never opens anything');
});

test('a ledger fault spends no MHP attempt: built-in, owner and sequence sweeps claim nothing while the list cannot be read, and send after recovery', async () => {
  let down = true;
  const ledger = { covers: (ws: string) => ws === WS, status: () => 'available' as const,
    decide: async () => { if (down) throw new Error('connection reset'); return { blocked: false as const, reallowed: false, cleared: {} }; },
    record: async () => 'recorded' as const, recordList: async () => ({ added: 0, skipped: 0 }), lift: async () => 0, rows: async () => ({ current: [], lifted: [] }) };
  const bounces = new EmailBounceService({ config: { blockers: [], sources: [] }, ledger });
  const t = transport(); // the guard is replaced below with the durable one
  const config = mhpMarketingConfig({ MHP_MARKETING_MODE: 'live', MHP_POSTMARK_SERVER_TOKEN: 'synthetic-token', MHP_MARKETING_FROM: 'owner@example.invalid' })!;
  const bodies: unknown[] = [];
  const sender = createMhpMarketingSender(config, secret, (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ErrorCode: 0, MessageID: `pm-${bodies.length}` }), { status: 200 }); }) as typeof fetch, { guard: bounces.guard, workspaceId: WS });
  void t;
  // Owner emails and sequences.
  const calls: string[] = [];
  const owner: MhpOwnerEmailDispatch = { claim: async () => { calls.push('owner claim'); return [lease]; }, prepare: async () => prepared,
    settle: async (_l, accepted) => { calls.push(`owner settle ${accepted}`); } };
  const sequence: MhpSequenceDispatch = { claim: async () => { calls.push('sequence claim'); return [lease]; }, prepare: async () => prepared,
    settle: async (_l, accepted) => { calls.push(`sequence settle ${accepted}`); }, unknown: async () => { calls.push('unknown'); } };
  assert.deepEqual(await dispatchMhpOwnerEmails({ queue: owner, sender, unsubscribeSecret: secret, testRecipients: null, now: () => now }), { sent: 0, failed: 0 });
  assert.deepEqual(await dispatchMhpSequenceEmails({ queue: sequence, sender, unsubscribeSecret: secret, testRecipients: null, now: () => now }), { sent: 0, failed: 0, unknown: 0 });
  // Built-in emails through the real dispatcher.
  const logs: string[] = []; let claims = 0;
  const growth = { claim: async () => { claims++; return down ? [] : claims === 1 ? [] : [claimed({ email: 'fine@example.invalid' })]; },
    settle: async (_id: string, accepted: boolean) => { calls.push(`builtin settle ${accepted}`); } };
  const stopDown = startMhpMarketingDispatcher(growth, sender, { testRecipients: null }, { intervalMs: 3_600_000, log: line => logs.push(line) });
  for (let i = 0; i < 50 && logs.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  stopDown();
  assert.deepEqual(calls, [], 'nothing was claimed, so no attempt was spent');
  assert.equal(claims, 0);
  assert.match(logs[0]!, /"event":"mhp\.marketing\.sweep_skipped","level":"warn"/u); assert.doesNotMatch(logs[0]!, /@/u);
  // Recovery: the same work goes out.
  down = false;
  assert.deepEqual(await dispatchMhpOwnerEmails({ queue: owner, sender, unsubscribeSecret: secret, testRecipients: null, now: () => now }), { sent: 1, failed: 0 });
  assert.deepEqual(await dispatchMhpSequenceEmails({ queue: sequence, sender, unsubscribeSecret: secret, testRecipients: null, now: () => now }), { sent: 1, failed: 0, unknown: 0 });
  claims = 1;
  const stopUp = startMhpMarketingDispatcher(growth, sender, { testRecipients: null }, { intervalMs: 3_600_000, log: line => logs.push(line) });
  for (let i = 0; i < 50 && !(calls as string[]).includes('builtin settle true'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  stopUp();
  assert.deepEqual(calls, ['owner claim', 'owner settle true', 'sequence claim', 'sequence settle true', 'builtin settle true']);
  assert.equal(bodies.length, 3);
});
