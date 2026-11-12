import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import {
  LeadRelayCrmFeed, MAX_ROW_FAILURES, composeLeadRelayCrmFeed, interpretLeadRelayEvent, leadRelayLeadKey,
  loadLeadRelayCrmFeedConfig, whenLabel, type LeadRelayCrmFeedConfig,
} from '../src/integrations/leadrelay/crm-feed.js';
import { LEADRELAY_FEED_USER_AGENT, LeadRelayFeedError, createLeadRelayFeedClient } from '../src/integrations/leadrelay/crm-feed-client.js';
import type { CopyableLead, EnquiryOutcome, LeadRelayCrmWriter, TimelineEvent, TimelineOutcome } from '../src/integrations/leadrelay/crm-feed-writer.js';
import { GroupHqInboxCrmService, InboxCrmError, type InboxCrmConfig } from '../src/integrations/group-hq-crm/inbox.js';
import type { CrmTransactionRunner } from '../src/crm-pg/types.js';

const ID = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const KEY = 'lr_' + 'k'.repeat(45);
const SCOPE = { label: 'Property Predator', workspaceId: ID('1'), organizationId: ID('2'), ownerUserId: ID('3'), pipelineId: ID('4'), stageId: ID('5'), actorEmails: ['owner@example.test'] };
const INBOX: InboxCrmConfig = { secret: 'inbox-secret-' + 'x'.repeat(32), scopes: { pp: SCOPE } };
const LR_WS = 'aaaaaaaa-0000-4000-8000-000000000001';
const T0 = Date.parse('2026-11-12T10:00:00Z');

// ------------------------------------------------------------------------------------------- fake LeadRelay

type Mode = 'ok' | 'down' | '401' | '403' | 'malformed' | 'hang' | 'lead-malformed';
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
function fakeLeadRelay() {
  const state = {
    mode: 'ok' as Mode, rows: [] as Record<string, unknown>[], leads: {} as Record<string, Record<string, unknown>>,
    acked: new Set<string>(), seen: [] as Seen[], failAckOnce: new Set<string>(), delayMs: 0,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => setTimeout(() => {
      state.seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
      if (state.mode === 'hang') return;
      if (state.mode === 'down') return send(503, { detail: 'unavailable' });
      if (state.mode === '401') return send(401, { detail: 'Invalid API key' });
      if (state.mode === '403') return send(403, { detail: 'Missing scope: lead.read' });
      if (req.headers.origin) return send(403, { detail: 'API keys are server-to-server only' });
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { detail: 'Invalid API key' });
      if (req.method === 'GET' && req.url === '/api/outbox?limit=200') {
        if (state.mode === 'malformed') return send(200, { not: 'a list' });
        return send(200, state.rows.filter(r => !state.acked.has(String(r.id))).slice(0, 200));
      }
      const lead = /^\/api\/leads\/([^/]+)$/u.exec(req.url!);
      if (req.method === 'GET' && lead) {
        if (state.mode === 'lead-malformed') return send(200, '{"lead": 7}');
        const found = state.leads[lead[1]!];
        return found ? send(200, { lead: found, activities: [{ summary: 'Secret activity text' }], jobs: [], consent_receipts: [], bookings: [] }) : send(404, { detail: 'Not found' });
      }
      const ack = /^\/api\/outbox\/([^/]+)\/ack$/u.exec(req.url!);
      if (req.method === 'POST' && ack) {
        if (!state.rows.some(r => r.id === ack[1])) return send(404, { detail: 'Not found' });
        if (state.failAckOnce.delete(ack[1]!)) return send(500, { detail: 'temporary' });
        state.acked.add(ack[1]!); return send(200, { ok: true });
      }
      send(404, { detail: 'Not found' });
    }, state.delayMs));
  });
  return { state, server, async listen() { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; },
    close() { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); } };
}

const eventId = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const leadId = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, kind: string, lead: number | null, payload: Record<string, unknown> = {}, at = T0 / 1000 + n) =>
  ({ id: eventId(n), workspace_id: LR_WS, lead_id: lead === null ? null : leadId(lead), kind, payload: { lead_id: lead === null ? null : leadId(lead), ...payload }, created_at: at, delivered_at: null });
const person = (n: number, extra: Record<string, unknown> = {}) => ({ id: leadId(n), workspace_id: LR_WS, name: `Person Name${n}`, email: `person${n}@private.example`,
  phone: `+4477009${String(n).padStart(5, '0')}`, company: 'Acme Lettings', source: 'website_chat', status: 'new', is_demo: false,
  custom: { message: 'I want to sell my flat in Leeds' }, created_at: T0 / 1000, updated_at: T0 / 1000, ...extra });

// ------------------------------------------------------------------------------------------- fake CRM writer

function fakeWriter() {
  const leads = new Map<string, { contactId: string; outcome: string; phone: string | null }>();
  const events = new Set<string>();
  const state = { enquiries: [] as { leadKey: string; lead: CopyableLead }[], timeline: [] as TimelineEvent[], suppressions: [] as string[],
    twoContacts: new Set<string>(), failLeads: new Map<string, number>(), contactsWithOpenDeal: new Set<string>() };
  const writer: LeadRelayCrmWriter = {
    async copyEnquiry(input): Promise<EnquiryOutcome> {
      const fail = state.failLeads.get(input.leadKey) ?? 0;
      if (fail > 0) { state.failLeads.set(input.leadKey, fail - 1); const e = new Error('connection terminated: person1@private.example'); (e as { code?: string }).code = '08006'; throw e; }
      const known = leads.get(input.leadKey);
      if (known) return known.outcome === 'needs_owner' ? { outcome: 'needs_owner', reason: 'two_contacts', replayed: true } : { outcome: known.outcome as 'created', contactId: known.contactId, replayed: true };
      state.enquiries.push(input);
      if (state.twoContacts.has(input.leadKey)) { leads.set(input.leadKey, { contactId: '', outcome: 'needs_owner', phone: null }); return { outcome: 'needs_owner', reason: 'two_contacts', replayed: false }; }
      const contactId = ID(String(leads.size % 9 + 1));
      leads.set(input.leadKey, { contactId, outcome: 'created', phone: input.lead.phone });
      return { outcome: 'created', contactId, replayed: false };
    },
    async recordTimeline(input): Promise<TimelineOutcome> {
      const mapping = leads.get(input.leadKey);
      if (mapping?.outcome === 'needs_owner') return { outcome: 'enquiry_needs_owner', replayed: false };
      if (!mapping) return { outcome: 'not_copied', replayed: false };
      if (events.has(input.eventKey)) return { outcome: 'written', contactId: mapping.contactId, doNotCall: null, replayed: true };
      events.add(input.eventKey); state.timeline.push(input);
      if (input.doNotCall && mapping.phone) state.suppressions.push(input.leadRelayEventId);
      return { outcome: 'written', contactId: mapping.contactId, doNotCall: input.doNotCall ? (mapping.phone ? 'recorded' : 'no_number') : null, replayed: false };
    },
  };
  return { writer, state };
}

const onConfig = (baseUrl: string): LeadRelayCrmFeedConfig => ({ state: 'on', key: KEY, workspaceId: LR_WS, baseUrl, brand: 'pp',
  scope: { workspaceId: SCOPE.workspaceId, ownerUserId: SCOPE.ownerUserId, pipelineId: SCOPE.pipelineId, stageId: SCOPE.stageId } });
async function harness(options: { now?: () => number; timeoutMs?: number } = {}) {
  const lr = fakeLeadRelay(); const base = await lr.listen();
  const crm = fakeWriter(); const lines: string[] = [];
  const client = createLeadRelayFeedClient({ baseUrl: base, key: KEY, request: http.request, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const feed = new LeadRelayCrmFeed(onConfig(base), { client, writer: crm.writer, log: l => lines.push(l), ...(options.now ? { now: options.now } : {}) });
  return { lr, crm, feed, lines, base };
}

// ------------------------------------------------------------------------------------------- settings

test('the feed is off unless LEADRELAY_CRM_FEED is exactly "enabled", and bad settings stay off without throwing', () => {
  const good = { LEADRELAY_CRM_FEED: 'enabled', LEADRELAY_CRM_FEED_KEY: KEY, LEADRELAY_CRM_FEED_WORKSPACE_ID: LR_WS, LEADRELAY_CRM_FEED_BRAND: 'pp' };
  assert.deepEqual(loadLeadRelayCrmFeedConfig({}, INBOX), { state: 'off' });
  for (const value of ['true', 'Enabled', ' enabled', 'on', '1', '']) assert.deepEqual(loadLeadRelayCrmFeedConfig({ ...good, LEADRELAY_CRM_FEED: value }, INBOX), { state: 'off' });
  const on = loadLeadRelayCrmFeedConfig(good, INBOX);
  assert.deepEqual(on, { state: 'on', key: KEY, workspaceId: LR_WS, baseUrl: 'https://leadrelay-live.onrender.com', brand: 'pp',
    scope: { workspaceId: SCOPE.workspaceId, ownerUserId: SCOPE.ownerUserId, pipelineId: SCOPE.pipelineId, stageId: SCOPE.stageId } });
  assert.equal((loadLeadRelayCrmFeedConfig({ ...good, LEADRELAY_CRM_FEED_BASE_URL: 'https://lr.example.test/' }, INBOX) as { baseUrl: string }).baseUrl, 'https://lr.example.test');
  const invalid: Record<string, string | undefined>[] = [
    { LEADRELAY_CRM_FEED_KEY: undefined }, { LEADRELAY_CRM_FEED_KEY: 'short' }, { LEADRELAY_CRM_FEED_KEY: 'x'.repeat(30) + ' ' + 'y'.repeat(30) },
    { LEADRELAY_CRM_FEED_BASE_URL: 'http://leadrelay-live.onrender.com' }, { LEADRELAY_CRM_FEED_BASE_URL: 'https://leadrelay-live.onrender.com/api' },
    { LEADRELAY_CRM_FEED_BASE_URL: 'https://user:pw@leadrelay-live.onrender.com' }, { LEADRELAY_CRM_FEED_BASE_URL: 'not a url' },
    { LEADRELAY_CRM_FEED_BRAND: undefined }, { LEADRELAY_CRM_FEED_BRAND: 'mhp' },
    { LEADRELAY_CRM_FEED_WORKSPACE_ID: undefined }, { LEADRELAY_CRM_FEED_WORKSPACE_ID: '../other' }, { LEADRELAY_CRM_FEED_WORKSPACE_ID: 'x'.repeat(65) },
  ];
  for (const change of invalid) {
    const config = loadLeadRelayCrmFeedConfig({ ...good, ...change }, INBOX);
    assert.equal(config.state, 'invalid', JSON.stringify(change));
    assert.doesNotMatch((config as { problem: string }).problem, new RegExp(KEY));
  }
  assert.equal(loadLeadRelayCrmFeedConfig(good, undefined).state, 'invalid');
  assert.equal(loadLeadRelayCrmFeedConfig(good, { ...INBOX, scopes: { kp: SCOPE } }).state, 'invalid');
});

test('composing with bad settings logs one plain line, starts nothing and never throws', async () => {
  const lines: string[] = [];
  const runner: CrmTransactionRunner = { async run() { throw new Error('no database writes expected'); } };
  const bad = composeLeadRelayCrmFeed({ env: { LEADRELAY_CRM_FEED: 'enabled', LEADRELAY_CRM_FEED_KEY: 'short', LEADRELAY_CRM_FEED_BRAND: 'pp' }, inbox: INBOX, runner, log: l => lines.push(l) });
  assert.equal(lines.length, 1); assert.match(lines[0]!, /^LeadRelay CRM feed is off: LEADRELAY_CRM_FEED_KEY/u);
  const stop = bad.start(10); stop();
  assert.equal(bad.status('pp').problem, 'settings_incomplete');
  assert.equal(bad.status('pp').summary, 'LeadRelay is switched on but its settings are incomplete, so its enquiries are not reaching the CRM.');
  const off = composeLeadRelayCrmFeed({ env: {}, inbox: INBOX, runner, log: l => lines.push(l) });
  assert.equal(lines.length, 1, 'switched off is silent');
  assert.equal(off.status('pp').summary, 'LeadRelay is not connected yet, so its enquiries are not reaching the CRM.');
  assert.equal(off.status('pp').switchedOn, false);
  const noDb = composeLeadRelayCrmFeed({ env: { LEADRELAY_CRM_FEED: 'enabled', LEADRELAY_CRM_FEED_KEY: KEY, LEADRELAY_CRM_FEED_WORKSPACE_ID: LR_WS, LEADRELAY_CRM_FEED_BRAND: 'pp' }, inbox: INBOX, runner: undefined, log: l => lines.push(l) });
  assert.equal(noDb.config.state, 'invalid'); assert.equal(lines.length, 2);
  // A throwing environment read is contained too.
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => composeLeadRelayCrmFeed({ env: hostile, inbox: INBOX, runner, log: () => undefined }));
});

test('switched off, the feed sends no request at all', async () => {
  const lr = fakeLeadRelay(); await lr.listen();
  const { writer } = fakeWriter();
  const feed = new LeadRelayCrmFeed({ state: 'off' }, { writer });
  await feed.runOnce(); feed.start(5)();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(lr.state.seen.length, 0);
  await lr.close();
});

// ------------------------------------------------------------------------------------------- happy path and every branch

test('one run copies enquiries and call results, records a calls-only stop, skips and ignores the rest, and acks each row after its write', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1), [leadId(3)]: person(3, { is_demo: true }), [leadId(4)]: person(4, { email: 'not-an-email', phone: '12' }),
      [leadId(6)]: person(6, { phone: null, source: 'Brevo Form!' }) };
    h.lr.state.rows = [
      row(9, 'call.provider_outcome', 1, { job_id: 'j', call_id: 'c', outcome: 'opt_out', summary: 'Caller said: stop calling me, Person Name1' }),
      row(1, 'lead.created', 1, { source: 'website_chat', is_demo: false }),
      row(2, 'lead.created', 2, { source: 'website_chat', is_demo: true }),
      row(3, 'lead.created', 3, { source: 'website_chat', is_demo: false }),
      row(4, 'lead.created', 4, { source: 'website_chat', is_demo: false }),
      row(5, 'lead.created', 5, { source: 'website_chat', is_demo: false }),
      row(6, 'lead.created', 6, { source: 'Brevo Form!', is_demo: false }),
      row(7, 'call.provider_outcome', 1, { job_id: 'j', call_id: 'c', outcome: 'no_answer', summary: 'Voicemail transcript text' }),
      row(8, 'call.outcome', 4, { job_id: 'j', outcome: 'answered', summary: '' }),
      row(10, 'lead.status', 1, { status: 'unsubscribed' }),
      row(11, 'lead.status', 1, { status: 'paused' }),
      row(12, 'meeting.booked', 6, { booking_ref: 'b1', starts_at: Date.parse('2026-11-14T10:30:00Z') / 1000 }),
      row(13, 'job.completed', 1, { job_id: 'j', channel: 'call', step: 0 }),
      row(14, 'mystery.new_kind', null, { anything: 'Person Name1' }),
      row(17, 'privacy.erased', null, { erased_lead_id: leadId(6) }),
      row(18, 'call.outcome', 6, { job_id: 'j', outcome: 'opt_out', summary: '' }),
    ];
    await h.feed.runOnce();
    // Every request is one of the three allowed, carries the key, a fixed User-Agent and no Origin, cookie or body.
    for (const seen of h.lr.state.seen) {
      assert.ok((seen.method === 'GET' && (seen.url === '/api/outbox?limit=200' || /^\/api\/leads\/[0-9a-f-]{36}$/u.test(seen.url)))
        || (seen.method === 'POST' && /^\/api\/outbox\/[0-9a-f-]{36}\/ack$/u.test(seen.url)), `${seen.method} ${seen.url}`);
      assert.equal(seen.headers.origin, undefined); assert.equal(seen.headers.cookie, undefined); assert.equal(seen.body, '');
      assert.equal(seen.headers['user-agent'], LEADRELAY_FEED_USER_AGENT); assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
    }
    // Leads are fetched only for real enquiries; never for a demo flagged in the event itself.
    const fetched = h.lr.state.seen.filter(s => s.url.startsWith('/api/leads/')).map(s => s.url.slice(11)).sort();
    assert.deepEqual(fetched, [leadId(1), leadId(3), leadId(4), leadId(5), leadId(6)]);
    // Oldest first: the opt-out (event 9) is processed after the enquiry (event 1) it depends on.
    assert.deepEqual(h.crm.state.enquiries.map(e => e.leadKey), [leadRelayLeadKey(LR_WS, leadId(1)), leadRelayLeadKey(LR_WS, leadId(6))]);
    assert.deepEqual(h.crm.state.enquiries[0]!.lead, { displayName: 'Person Name1', companyName: 'Acme Lettings', email: 'person1@private.example',
      phone: '+447700900001', source: 'leadrelay:website_chat' });
    assert.equal(h.crm.state.enquiries[1]!.lead.source, 'leadrelay:brevo-form');
    assert.deepEqual(h.crm.state.timeline.map(t => [t.activityType, t.subject, t.doNotCall]), [
      ['leadrelay.call_result', 'AI call: no answer (12 Nov 2026)', false],
      ['leadrelay.do_not_call', 'Asked not to be called (AI call on 12 Nov 2026)', true],
      ['leadrelay.note', 'Unsubscribed in LeadRelay (12 Nov 2026). LeadRelay will not contact them.', false],
      ['leadrelay.note', 'Meeting booked through LeadRelay for 10:30 on 14 Nov 2026', false],
      ['leadrelay.note', "LeadRelay deleted this person's details (12 Nov 2026). Nothing in this CRM was changed.", false],
      ['leadrelay.do_not_call', 'Asked not to be called (AI call on 12 Nov 2026)', true],
    ]);
    assert.ok(h.crm.state.timeline.every(t => t.body === null && !JSON.stringify(t).includes('transcript') && !JSON.stringify(t).includes('stop calling')));
    // The stop goes to the writer as a calls-only request; lead 6 has no phone, so it needs the owner instead.
    assert.deepEqual(h.crm.state.suppressions, [eventId(9)]);
    assert.equal(h.lr.state.acked.size, 16);
    const status = h.feed.status('pp');
    assert.deepEqual(status.today, { enquiriesCopied: 2, callResultsCopied: 3, doNotCallRecorded: 1, skipped: 5, alreadyOptedOutInLeadRelay: 0, needsTheOwner: 1 });
    assert.equal(status.problem, null); assert.equal(status.switchedOn, true);
    assert.ok(status.lastSucceededAt && status.lastAnsweredAt);
    assert.match(status.summary, /^LeadRelay is connected\. 2 enquiries and 3 call results copied to the CRM since the last restart at \d\d:\d\d\./u);
    assert.match(status.summary, /1 do-not-call request from LeadRelay was recorded as do not call in this CRM\. Texts, WhatsApp and email are not affected\./u);
    assert.match(status.summary, /1 do-not-call request could not be recorded because the number LeadRelay called is not on the CRM contact\. Please check it\./u);
    assert.doesNotMatch(status.summary, /blocked|people|at their request|unchanged/u);
    assert.doesNotMatch(status.summary, /AI calls/u, 'the feed cannot know whether AI calls are switched off, so it never says so');
    assert.deepEqual(status.needsTheOwner.map(i => [i.leadRelayLeadId, i.reason]), [[leadId(6), 'number_not_on_contact']]);
    // Nothing personal, no free text and no key in any log line.
    assert.ok(h.lines.length > 0);
    for (const line of h.lines) assert.doesNotMatch(line, /Person Name|private\.example|\+447700|Leeds|transcript|stop calling|Acme|lr_kkkk|Secret activity/u);
  } finally { await h.lr.close(); }
});

test('replaying the same rows writes nothing twice and counts nothing twice', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }), row(2, 'call.provider_outcome', 1, { outcome: 'answered' })];
    await h.feed.runOnce();
    h.lr.state.acked.clear(); // as if the acknowledgements were lost
    await h.feed.runOnce();
    assert.equal(h.crm.state.enquiries.length, 1); assert.equal(h.crm.state.timeline.length, 1);
    assert.deepEqual(h.feed.status('pp').today, { enquiriesCopied: 1, callResultsCopied: 1, doNotCallRecorded: 0, skipped: 0, alreadyOptedOutInLeadRelay: 0, needsTheOwner: 0 });
    assert.equal(h.lr.state.acked.size, 2);
  } finally { await h.lr.close(); }
});

test('an enquiry matching two CRM contacts writes nothing to them, is acknowledged and is reported for the owner', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.crm.state.twoContacts.add(leadRelayLeadKey(LR_WS, leadId(1)));
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }), row(2, 'call.provider_outcome', 1, { outcome: 'answered' })];
    await h.feed.runOnce();
    assert.equal(h.crm.state.timeline.length, 0);
    assert.equal(h.lr.state.acked.size, 2, 'the queue is not blocked');
    const status = h.feed.status('pp');
    assert.deepEqual(status.today, { enquiriesCopied: 0, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 0, alreadyOptedOutInLeadRelay: 0, needsTheOwner: 2 });
    assert.match(status.summary, /1 LeadRelay enquiry matches two CRM contacts and was not copied\./u);
    assert.match(status.summary, /1 LeadRelay update for enquiries that were not copied was not copied either\./u);
    assert.deepEqual(status.needsTheOwner.map(i => [i.leadRelayLeadId, i.reason]), [[leadId(1), 'update_enquiry_not_copied'], [leadId(1), 'two_contacts']]);
    const warned = h.lines.filter(l => l.includes('crm_feed.needs_owner"')).map(l => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(warned.map(w => [w.level, w.leadRelayLeadId, w.reason]), [['warn', leadId(1), 'two_contacts'], ['warn', leadId(1), 'update_enquiry_not_copied']]);
  } finally { await h.lr.close(); }
});

test('a failing row stays unacknowledged, holds back only its own lead, and is set aside after repeated failures', async () => {
  let now = T0;
  const h = await harness({ now: () => now });
  try {
    h.lr.state.leads = { [leadId(1)]: person(1), [leadId(2)]: person(2) };
    h.crm.state.failLeads.set(leadRelayLeadKey(LR_WS, leadId(1)), 99);
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }), row(2, 'lead.created', 2, { is_demo: false }),
      row(3, 'call.provider_outcome', 1, { outcome: 'answered' }), row(4, 'call.provider_outcome', 2, { outcome: 'answered' })];
    await h.feed.runOnce();
    assert.deepEqual([...h.lr.state.acked].sort(), [eventId(2), eventId(4)]);
    assert.equal(h.crm.state.timeline.length, 1, 'the call result for the failed lead waits instead of being skipped');
    for (let i = 1; i < MAX_ROW_FAILURES; i++) { now += 60_000; await h.feed.runOnce(); }
    const before = h.lr.state.seen.filter(s => s.url === `/api/leads/${leadId(1)}`).length;
    now += 60_000; await h.feed.runOnce();
    assert.equal(h.lr.state.seen.filter(s => s.url === `/api/leads/${leadId(1)}`).length, before, 'held rows are not retried within the hour');
    const status = h.feed.status('pp');
    assert.equal(status.waitingAfterRepeatedFailures, 1);
    assert.match(status.summary, /1 LeadRelay update could not be copied after several tries and will be tried again within the hour\./u);
    assert.ok(h.lines.some(l => l.includes('crm_feed.row_failed"') && l.includes('"code":"08006"')));
    for (const line of h.lines) assert.doesNotMatch(line, /private\.example|connection terminated/u, 'error messages are never logged');
    // After the hour it is tried again and, once it succeeds, it and its waiting call result go through.
    h.crm.state.failLeads.clear(); now += 3_600_000; await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 4); assert.equal(h.feed.status('pp').waitingAfterRepeatedFailures, 0);
  } finally { await h.lr.close(); }
});

test('a lead that cannot be read is retried, not acknowledged', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false })];
    h.lr.state.mode = 'lead-malformed';
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 0); assert.equal(h.crm.state.enquiries.length, 0);
    h.lr.state.mode = 'ok'; await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 1);
  } finally { await h.lr.close(); }
});

test('more than 200 waiting rows are worked through 200 at a time, oldest first', async () => {
  const h = await harness();
  try {
    h.lr.state.rows = Array.from({ length: 450 }, (_, i) => row(i + 1, 'job.completed', null, {}));
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 450);
    assert.equal(h.lr.state.seen.filter(s => s.url === '/api/outbox?limit=200').length, 3, '200 + 200 + 50');
    const acks = h.lr.state.seen.filter(s => s.method === 'POST').map(s => s.url);
    assert.deepEqual(acks, h.lr.state.rows.map(r => `/api/outbox/${r.id}/ack`));
    // A later run picks up whatever arrived since.
    h.lr.state.rows.push(...Array.from({ length: 250 }, (_, i) => row(1000 + i, 'job.completed', null, {})));
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 700);
  } finally { await h.lr.close(); }
});

// ------------------------------------------------------------------------------------------- LeadRelay trouble

test('when LeadRelay is down nothing is acknowledged and the owner is told plainly', async () => {
  let now = T0;
  const h = await harness({ now: () => now });
  try {
    h.lr.state.rows = [row(1, 'job.completed', null, {})];
    await h.feed.runOnce();
    h.lr.state.rows.push(row(2, 'job.completed', null, {}));
    now = T0 + 86_400_000;
    h.lr.state.mode = 'down';
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 1);
    const status = h.feed.status('pp');
    assert.equal(status.problem, 'no_answer');
    assert.equal(status.summary, `LeadRelay did not answer (last heard ${whenLabel(T0, now)}). Enquiries already copied are safe; new ones appear when it is back. Nothing was sent to anyone.`);
    assert.match(status.summary, /last heard 10:00 yesterday/u);
    await h.lr.close();
    now += 60_000; await h.feed.runOnce(); // connection refused
    assert.equal(h.feed.status('pp').problem, 'no_answer');
  } finally { await h.lr.close().catch(() => undefined); }
});

test('a refused key and a malformed answer each stop the run with their own plain sentence', async () => {
  const h = await harness();
  try {
    h.lr.state.rows = [row(1, 'job.completed', null, {})];
    for (const [mode, problem, sentence] of [['401', 'key_refused', /did not accept the read-and-acknowledge key/u], ['403', 'key_refused', /did not accept the read-and-acknowledge key/u],
      ['malformed', 'unexpected_answer', /LeadRelay's answers could not be read/u]] as const) {
      h.lr.state.mode = mode;
      await h.feed.runOnce();
      const status = h.feed.status('pp');
      assert.equal(status.problem, problem); assert.match(status.summary, sentence); assert.match(status.summary, /Nothing was sent to anyone\./u);
    }
    assert.equal(h.lr.state.acked.size, 0);
    h.lr.state.mode = 'ok'; await h.feed.runOnce();
    assert.equal(h.feed.status('pp').problem, null);
  } finally { await h.lr.close(); }
});

test('a lead read refused part-way stops the run without acknowledging the enquiry', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.lr.state.rows = [row(1, 'job.completed', null, {}), row(2, 'lead.created', 1, { is_demo: false })];
    const original = h.lr.server.listeners('request')[0] as http.RequestListener;
    h.lr.server.removeAllListeners('request');
    h.lr.server.on('request', (req, res) => {
      if (req.url?.startsWith('/api/leads/')) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"detail":"Missing scope: lead.read"}'); return; }
      original(req, res);
    });
    await h.feed.runOnce();
    assert.deepEqual([...h.lr.state.acked], [eventId(1)]);
    assert.equal(h.feed.status('pp').problem, 'key_refused');
  } finally { await h.lr.close(); }
});

test('a request that never answers times out as an outage', async () => {
  const h = await harness({ timeoutMs: 50 });
  try {
    h.lr.state.mode = 'hang';
    const started = Date.now();
    await h.feed.runOnce();
    assert.ok(Date.now() - started < 2_000);
    assert.equal(h.feed.status('pp').problem, 'no_answer');
  } finally { await h.lr.close(); }
});

test('the client refuses unsafe ids and maps statuses to plain categories', async () => {
  const lr = fakeLeadRelay(); const base = await lr.listen();
  try {
    const client = createLeadRelayFeedClient({ baseUrl: base, key: KEY, request: http.request });
    await assert.rejects(client.lead('../outbox'), (e: unknown) => e instanceof LeadRelayFeedError && e.kind === 'unexpected_answer');
    await assert.rejects(client.ack('a/b'), (e: unknown) => e instanceof LeadRelayFeedError);
    assert.equal(await client.lead(leadId(9)), null, 'an erased lead reads as absent');
    await client.ack(eventId(404)); // already gone: nothing waiting, nothing to do
    assert.equal(lr.state.seen.length, 2);
    const wrongKey = createLeadRelayFeedClient({ baseUrl: base, key: 'x'.repeat(40), request: http.request });
    await assert.rejects(wrongKey.outbox(), (e: unknown) => e instanceof LeadRelayFeedError && e.kind === 'unauthorised' && e.status === 401
      && !String(e.message).includes('x'.repeat(40)));
  } finally { await lr.close(); }
});

// ------------------------------------------------------------------------------------------- wording and timer

test('event meanings never copy free text and unknown kinds are ignored', () => {
  const base = { id: eventId(1), workspaceId: LR_WS, leadId: leadId(1), createdAt: T0 / 1000 };
  const read = (kind: string, payload: Record<string, unknown>) => interpretLeadRelayEvent({ ...base, kind, payload });
  assert.equal(read('mystery', {}).type, 'ignore');
  for (const status of ['paused', 'active', 'new', 'booked', 'won']) assert.equal(read('lead.status', { status }).type, 'ignore');
  const replied = read('lead.replied', { summary: 'Call me on 07700 900123 about my flat' });
  assert.ok(replied.type === 'timeline' && !JSON.stringify(replied).includes('07700'));
  const labels = ['answered', 'no_answer', 'booked', 'interested', 'not_interested', 'failed', 'weird', undefined]
    .map(outcome => { const a = read('call.outcome', outcome ? { outcome } : {}); return a.type === 'timeline' ? a.event.subject : null; });
  assert.deepEqual(labels, ['AI call: answered (12 Nov 2026)', 'AI call: no answer (12 Nov 2026)', 'AI call: said they want to book (12 Nov 2026)',
    'AI call: interested (12 Nov 2026)', 'AI call: not interested (12 Nov 2026)', 'AI call: did not go through (12 Nov 2026)',
    'AI call: finished (12 Nov 2026)', 'AI call: finished (12 Nov 2026)']);
  assert.equal(whenLabel(Date.parse('2026-11-12T14:05:00Z'), Date.parse('2026-11-12T18:00:00Z')), '14:05 today');
  assert.equal(whenLabel(Date.parse('2026-07-01T13:05:00Z'), Date.parse('2026-07-02T09:00:00Z')), '14:05 yesterday');
  assert.equal(whenLabel(Date.parse('2026-11-03T14:05:00Z'), Date.parse('2026-11-12T09:00:00Z')), '14:05 on 3 Nov 2026');
});

test('counts reset at UK midnight and say "today" once the process has run since before midnight', async () => {
  let now = Date.parse('2026-11-11T22:00:00Z');
  const h = await harness({ now: () => now });
  try {
    h.lr.state.leads = { [leadId(1)]: person(1), [leadId(2)]: person(2) };
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false })];
    await h.feed.runOnce();
    assert.equal(h.feed.status('pp').today.enquiriesCopied, 1);
    now = Date.parse('2026-11-12T09:00:00Z');
    assert.equal(h.feed.status('pp').today.enquiriesCopied, 0);
    h.lr.state.rows.push(row(2, 'lead.created', 2, { is_demo: false }));
    await h.feed.runOnce();
    const status = h.feed.status('pp');
    assert.equal(status.today.enquiriesCopied, 1);
    assert.match(status.summary, /^LeadRelay is connected\. 1 enquiry and 0 call results copied to the CRM today\./u);
    assert.equal(status.countingSince, '2026-11-12T00:00:00.000Z');
    assert.equal(h.feed.status('mhp').problem, 'not_connected');
    assert.deepEqual(h.feed.status('mhp').today, { enquiriesCopied: 0, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 0, alreadyOptedOutInLeadRelay: 0, needsTheOwner: 0 });
  } finally { await h.lr.close(); }
});

test('before its first run the status says it is connecting; start runs at once and stop ends the timer', async () => {
  const h = await harness();
  try {
    assert.equal(h.feed.status('pp').problem, 'starting');
    assert.match(h.feed.status('pp').summary, /^LeadRelay is connecting\./u);
    const stop = h.feed.start(20);
    await new Promise(r => setTimeout(r, 90));
    stop();
    await new Promise(r => setTimeout(r, 30)); // let a read already in flight land
    const reads = h.lr.state.seen.length;
    assert.ok(reads >= 2, 'it ran at start and again on the timer');
    await new Promise(r => setTimeout(r, 80));
    assert.equal(h.lr.state.seen.length, reads, 'nothing runs after stop');
    assert.ok(h.lines.some(l => l.includes('"leadrelay.crm_feed.started"')));
  } finally { await h.lr.close(); }
});

// ------------------------------------------------------------------------------------------- Group HQ status action

test('Group HQ leadrelayFeedStatus is read only, checked like every other action, and plain English', async () => {
  const readPool = (allowed = true) => ({ connect: async () => ({ query: async (sql: string) => ({ rows: sql.includes('group-hq.inbox.scope') ? [{ allowed }] : [], rowCount: 1 }), release() {} }) }) as unknown as Pick<Pool, 'connect'>;
  let writes = 0;
  const runner: CrmTransactionRunner = { async run() { writes++; throw new Error('no CRM transaction expected'); } };
  const request = { action: 'leadrelayFeedStatus', actorEmail: 'owner@example.test', brand: 'pp', requestId: ID('6') };
  const off = await new GroupHqInboxCrmService(readPool(), runner, INBOX).execute(request) as Record<string, unknown>;
  assert.equal(off.summary, 'LeadRelay is not connected yet, so its enquiries are not reaching the CRM.');
  assert.equal(off.workspaceId, SCOPE.workspaceId); assert.equal(off.switchedOn, false);
  const h = await harness();
  try {
    h.lr.state.rows = [];
    await h.feed.runOnce();
    const service = new GroupHqInboxCrmService(readPool(), runner, INBOX, { leadrelayFeed: h.feed });
    const on = await service.execute(request) as Record<string, unknown>;
    assert.equal(on.switchedOn, true); assert.equal(on.problem, null);
    assert.match(String(on.summary), /^LeadRelay is connected\. 0 enquiries and 0 call results copied to the CRM/u);
    await assert.rejects(service.execute({ ...request, actorEmail: 'stranger@example.test' }), (e: unknown) => e instanceof InboxCrmError && e.status === 403);
    await assert.rejects(new GroupHqInboxCrmService(readPool(false), runner, INBOX, { leadrelayFeed: h.feed }).execute(request),
      (e: unknown) => e instanceof InboxCrmError && e.status === 403);
    assert.equal(writes, 0);
  } finally { await h.lr.close(); }
});

// ------------------------------------------------------------------------------------------- review fixes

test('a row that cannot be read is never acknowledged, holds back its own lead, and the owner is told LeadRelay could not be read', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1), [leadId(2)]: person(2) };
    h.lr.state.rows = [
      row(1, 'lead.created', 2, { is_demo: false }),
      { id: eventId(2), workspace_id: LR_WS, lead_id: leadId(1), kind: 'lead.created', payload: 'not an object', created_at: T0 / 1000 + 2, delivered_at: null },
      { id: '../../admin', lead_id: leadId(1), kind: 'lead.created', payload: {}, created_at: T0 / 1000 + 3 },
      row(4, 'call.provider_outcome', 1, { outcome: 'answered' }),
      row(5, 'job.completed', null, {}),
    ];
    await h.feed.runOnce();
    assert.deepEqual([...h.lr.state.acked].sort(), [eventId(1), eventId(5)]);
    assert.ok(!h.lr.state.seen.some(s => s.url.includes('admin') || s.url.includes(eventId(2)) || s.url.includes(eventId(4))));
    const status = h.feed.status('pp');
    assert.equal(status.problem, 'unexpected_answer');
    assert.doesNotMatch(status.summary, /connected/u);
    assert.match(status.summary, /^2 LeadRelay updates could not be read, so they were left waiting in LeadRelay and not copied\. Enquiries already copied are safe\. Nothing was sent to anyone\. So far: 1 enquiry/u);
    assert.equal(status.lastSucceededAt, null);
    assert.ok(h.lines.some(l => l.includes('crm_feed.row_failed') && l.includes(eventId(2)) && l.includes('"cause":"unreadable"')));
  } finally { await h.lr.close(); }
});

test('a do-not-call comes only from the call: the reconciliation opt-out (any unsubscribe) is a neutral note with no suppression', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }),
      row(2, 'call.provider_outcome', 1, { job_id: 'j', call_id: 'c', outcome: 'opt_out', provenance: 'retell_authenticated_get' }),
      row(3, 'call.provider_outcome', 1, { job_id: 'j', call_id: 'c', outcome: 'opt_out', summary: 'x' }),
      row(4, 'call.outcome', 1, { job_id: 'j', outcome: 'opt_out', summary: '' }),
      row(5, 'call.outcome', 1, { job_id: 'j', outcome: 'sang_a_song' })];
    await h.feed.runOnce();
    assert.deepEqual(h.crm.state.timeline.map(t => [t.leadRelayEventId, t.activityType, t.subject, t.doNotCall, t.metadata.outcome ?? null]), [
      [eventId(2), 'leadrelay.call_result', 'LeadRelay stopped contacting this person (12 Nov 2026)', false, null],
      [eventId(3), 'leadrelay.do_not_call', 'Asked not to be called (AI call on 12 Nov 2026)', true, 'opt_out'],
      [eventId(4), 'leadrelay.do_not_call', 'Asked not to be called (AI call on 12 Nov 2026)', true, 'opt_out'],
      [eventId(5), 'leadrelay.call_result', 'AI call: finished (12 Nov 2026)', false, null],
    ]);
    assert.deepEqual(h.crm.state.suppressions, [eventId(3), eventId(4)]);
    assert.equal(h.feed.status('pp').today.doNotCallRecorded, 2);
  } finally { await h.lr.close(); }
});

test('a do-not-call for an enquiry held for the owner is reported as needing the owner, never as skipped', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.crm.state.twoContacts.add(leadRelayLeadKey(LR_WS, leadId(1)));
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }), row(2, 'call.outcome', 1, { outcome: 'opt_out' })];
    await h.feed.runOnce();
    const status = h.feed.status('pp');
    assert.deepEqual(status.today, { enquiriesCopied: 0, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 0, alreadyOptedOutInLeadRelay: 0, needsTheOwner: 2 });
    assert.match(status.summary, /1 do-not-call request could not be recorded because the enquiry was not copied\. Please check it in LeadRelay\./u);
    assert.ok(h.lines.some(l => l.includes('crm_feed.needs_owner') && l.includes(leadId(1)) && l.includes('do_not_call_enquiry_not_copied')));
    assert.equal(h.lr.state.acked.size, 2);
  } finally { await h.lr.close(); }
});

test('someone who had already opted out in LeadRelay is not copied; other statuses are', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1, { status: 'unsubscribed' }), [leadId(2)]: person(2, { status: 'paused' }), [leadId(3)]: person(3, { status: 'unsubscribed', is_demo: true }) };
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }), row(2, 'lead.created', 2, { is_demo: false }), row(3, 'lead.created', 3, { is_demo: false })];
    await h.feed.runOnce();
    assert.deepEqual(h.crm.state.enquiries.map(e => e.leadKey), [leadRelayLeadKey(LR_WS, leadId(2))]);
    const status = h.feed.status('pp');
    assert.deepEqual(status.today, { enquiriesCopied: 1, callResultsCopied: 0, doNotCallRecorded: 0, skipped: 2, alreadyOptedOutInLeadRelay: 1, needsTheOwner: 0 });
    assert.match(status.summary, /1 LeadRelay enquiry was not copied because the person had already opted out in LeadRelay\./u);
    assert.equal(h.lr.state.acked.size, 3);
  } finally { await h.lr.close(); }
});

test('rows or leads from another LeadRelay workspace are refused, nothing is acknowledged, and the owner is told', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.lr.state.rows = [row(1, 'job.completed', null, {}), { ...row(2, 'lead.created', 1, { is_demo: false }), workspace_id: 'dddddddd-0000-4000-8000-000000000009' }];
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 0); assert.equal(h.crm.state.enquiries.length, 0);
    assert.ok(!h.lr.state.seen.some(s => s.url.startsWith('/api/leads/')));
    let status = h.feed.status('pp');
    assert.equal(status.problem, 'wrong_business');
    assert.equal(status.sentences[0], 'This LeadRelay key belongs to a different business, so nothing was copied.');
    // The rows are this workspace's but LeadRelay returns a lead from another one: still refused, not acknowledged.
    h.lr.state.rows = [row(3, 'lead.created', 1, { is_demo: false })];
    h.lr.state.leads[leadId(1)] = person(1, { workspace_id: 'dddddddd-0000-4000-8000-000000000009' });
    await h.feed.runOnce();
    status = h.feed.status('pp');
    assert.equal(status.problem, 'wrong_business'); assert.equal(h.lr.state.acked.size, 0); assert.equal(h.crm.state.enquiries.length, 0);
  } finally { await h.lr.close(); }
});

test('a full page of held rows says new enquiries are blocked, not connected', async () => {
  let now = T0;
  const h = await harness({ now: () => now });
  try {
    h.lr.state.rows = Array.from({ length: 200 }, (_, i) => row(i + 1, 'lead.created', i + 1, { is_demo: false }));
    h.lr.state.rows.push(row(500, 'job.completed', null, {}));
    h.lr.state.leads = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [leadId(i + 1), person(i + 1)]));
    for (let i = 1; i <= 200; i++) h.crm.state.failLeads.set(leadRelayLeadKey(LR_WS, leadId(i)), 99);
    for (let run = 0; run < MAX_ROW_FAILURES; run++) { await h.feed.runOnce(); now += 60_000; }
    const status = h.feed.status('pp');
    assert.equal(status.problem, 'blocked');
    assert.match(status.summary, /^New LeadRelay enquiries are waiting behind updates that could not be copied after several tries\./u);
    assert.doesNotMatch(status.summary, /connected/u);
    assert.equal(h.lr.state.acked.size, 0, 'the 201st row is never reached while 200 are held');
  } finally { await h.lr.close(); }
});

test('a failing row is tried at most once per run even when the run reads several pages', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.crm.state.failLeads.set(leadRelayLeadKey(LR_WS, leadId(1)), 99);
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }), ...Array.from({ length: 249 }, (_, i) => row(i + 2, 'job.completed', null, {}))];
    await h.feed.runOnce();
    assert.equal(h.lr.state.seen.filter(s => s.url === `/api/leads/${leadId(1)}`).length, 1);
    assert.equal(h.lr.state.seen.filter(s => s.url === '/api/outbox?limit=200').length, 2);
    assert.equal(h.lr.state.acked.size, 249);
    assert.equal(h.lines.filter(l => l.includes('crm_feed.row_failed')).length, 1);
    // Once it is gone from LeadRelay its failure record is forgotten.
    h.lr.state.rows = h.lr.state.rows.slice(1); await h.feed.runOnce();
    assert.equal(h.feed.status('pp').waitingAfterRepeatedFailures, 0);
  } finally { await h.lr.close(); }
});

test('an acknowledgement that fails after the write committed is retried, and nothing is written or counted twice', async () => {
  const h = await harness();
  try {
    h.lr.state.leads = { [leadId(1)]: person(1) };
    h.lr.state.rows = [row(1, 'lead.created', 1, { is_demo: false }), row(2, 'job.completed', null, {})];
    h.lr.state.failAckOnce.add(eventId(1));
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 0); assert.equal(h.feed.status('pp').problem, 'no_answer');
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, 2); assert.equal(h.crm.state.enquiries.length, 1);
    assert.equal(h.feed.status('pp').today.enquiriesCopied, 1);
  } finally { await h.lr.close(); }
});

test('stopping during a run stops before the next row', async () => {
  const h = await harness();
  try {
    h.lr.state.delayMs = 15;
    h.lr.state.rows = Array.from({ length: 50 }, (_, i) => row(i + 1, 'job.completed', null, {}));
    const stop = h.feed.start(60_000);
    await new Promise(r => setTimeout(r, 120));
    stop();
    await new Promise(r => setTimeout(r, 60));
    const acked = h.lr.state.acked.size;
    assert.ok(acked > 0 && acked < 50, `stopped part-way (${acked})`);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(h.lr.state.acked.size, acked);
    await h.feed.runOnce();
    assert.equal(h.lr.state.acked.size, acked, 'a stopped feed does not run again');
  } finally { await h.lr.close(); }
});

test('an unexpected error inside a run is caught, logged safely and the timer carries on', async () => {
  let calls = 0;
  const client = { async outbox() { calls++; throw new TypeError('boom with person1@private.example'); }, async lead() { return null; }, async ack() {} };
  const lines: string[] = [];
  const feed = new LeadRelayCrmFeed(onConfig('https://lr.example.test'), { client, writer: fakeWriter().writer, log: l => lines.push(l) });
  const unhandled: unknown[] = []; const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await feed.runOnce();
    const stop = feed.start(10, { retryMs: 10, maxRetryMs: 10 });
    await new Promise(r => setTimeout(r, 80));
    stop();
    assert.ok(calls >= 3, 'the timer kept running');
    assert.equal(unhandled.length, 0);
    assert.ok(lines.some(l => l.includes('crm_feed.run_failed')));
    for (const line of lines) assert.doesNotMatch(line, /private\.example|boom/u);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('the client never follows a redirect, refuses an oversized answer and survives a request function that throws', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/outbox?limit=200') { res.writeHead(302, { location: 'https://evil.example.test/api/outbox' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('['.padEnd(2_100_000, ' ') + ']');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    let requests = 0; server.on('request', () => { requests++; });
    const client = createLeadRelayFeedClient({ baseUrl: base, key: KEY, request: http.request });
    await assert.rejects(client.outbox(), (e: unknown) => e instanceof LeadRelayFeedError && e.kind === 'unexpected_answer' && e.status === 302);
    assert.equal(requests, 1);
    await assert.rejects(client.lead(leadId(1)), (e: unknown) => e instanceof LeadRelayFeedError && e.kind === 'unexpected_answer');
    const throwing = createLeadRelayFeedClient({ baseUrl: base, key: KEY, request: () => { throw new Error('synchronous failure'); } });
    await assert.rejects(throwing.outbox(), (e: unknown) => e instanceof LeadRelayFeedError && e.kind === 'unreachable');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
