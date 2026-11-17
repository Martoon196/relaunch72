import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { MhpOwnerEmailService, type MhpOwnerEmailRepository, type MhpOwnerEmailActionResult } from '../src/mhp/owner-email-service.js';
import type { MhpAudienceCandidate } from '../src/mhp/webinar-audience.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import { ids, identity, token, now as fixtureNow, local, review, snapshot } from './helpers/mhp-owner-email-fixture.js';
import { visibleText } from './helpers/mhp-sequence-safety-fixture.js';

// The owner email "Schedule remaining audience" path: one press used to queue the whole webinar list with no
// names. These tests run the real service and router over an in-memory repository that follows
// app_private.mhp_owner_email_queue_command (0127): schedule = eligible registrations without a row for this email.
const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SECRET = 'synthetic-owner-email-confirm-secret-at-least-32';
const BASE = '/hq/marketing/emails';
const prospect = (n: number) => `0e3a1000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, extra: Partial<MhpAudienceCandidate> = {}): MhpAudienceCandidate => ({ prospectId: prospect(n), email: `guest.${n}@example.invalid`, firstName: `Guest ${n}`,
  label: 'Before You Buy live webinar', registeredAt: null, marketingConsent: true, unsubscribed: false, signupConsentGiven: true, ...extra });
const eligible = (c: MhpAudienceCandidate) => c.marketingConsent && !c.unsubscribed && c.signupConsentGiven;
function world() {
  const w = { now: fixtureNow, candidates: [1, 2, 3, 4, 5, 6].map(n => person(n)).concat([person(7, { unsubscribed: true }), person(8, { marketingConsent: false })]),
    rows: new Map<string, 'pending' | 'held' | 'cancelled'>(), calls: [] as string[], receipts: new Map<string, MhpOwnerEmailActionResult>(), beforeQueue: null as null | (() => void) };
  const campaign = snapshot.database.campaign;
  const repository: MhpOwnerEmailRepository = {
    snapshot: async () => ({ ...snapshot.database, eligible: w.candidates.filter(eligible).length,
      ownerItems: w.rows.size ? [{ contentItemId: ids.item, total: w.rows.size, sent: 0, pending: [...w.rows.values()].filter(v => v === 'pending').length, held: [...w.rows.values()].filter(v => v === 'held').length,
        inFlight: 0, failed: 0, cancelled: [...w.rows.values()].filter(v => v === 'cancelled').length, dueAt: null, expiresAt: null, holdReason: null, lastFailure: null }] : [] }),
    local: async () => local,
    audienceCandidates: async (_i, c, after) => { assert.equal(c, campaign); const sorted = [...w.candidates].sort((a, b) => a.prospectId < b.prospectId ? -1 : 1).filter(x => after === null || x.prospectId > after);
      return { candidates: sorted.slice(0, 25), hasMore: sorted.length > 25, nextAfter: sorted.length > 25 ? sorted[24]!.prospectId : null }; },
    queue: async (_i, input) => {
      w.calls.push(input.action); const key = `${input.action}:${input.commandId}`; const prior = w.receipts.get(key); if (prior) return { ...prior, replayed: true };
      let changed = 0;
      if (input.action === 'schedule') { w.beforeQueue?.(); w.beforeQueue = null; for (const c of w.candidates.filter(eligible)) if (!w.rows.has(c.prospectId)) { w.rows.set(c.prospectId, 'pending'); changed++; } }
      else for (const [id, state] of w.rows) if (state !== 'cancelled') { if (input.action === 'cancel') w.rows.set(id, 'cancelled'); changed++; }
      const result = { action: input.action, contentItemId: ids.item, contentVersionId: input.versionId, changed, remaining: 0, inFlight: 0, replayed: false };
      w.receipts.set(key, result); return result;
    },
    testBegin: async () => ({ send: false, status: 'unknown' }), testFinish: async () => {},
  };
  const service = new MhpOwnerEmailService({
    marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true }) },
    repository, reader: { listCatalog: async () => snapshot.catalog, getExactReview: async () => ({ ...review, approvalStatus: 'approved' }) },
    adapter: {} as never, approvals: {} as never, adapterTransactions: {} as never, campaign, status: { mode: 'live', providerReady: true, testRecipientCount: 0, testEnabled: false }, testRecipient: null });
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE, portalBaseUrl: ORIGIN, now: () => w.now,
    crm: {} as PostgresPortalDeps['crm'], auth: { resolve: async (given: string) => given === token ? identity : null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  const mount = createMhpMount({ portal, ownerEmail: service, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw new Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} },
    marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true }), select: async () => { throw new Error('excluded'); } } });
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: HOST, cookie: `__Host-mhp_session=${token}`, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { out.status = status; for (const [k, v] of Object.entries(head)) out.headers[k.toLowerCase()] = v; }, setHeader() {}, end(text = '') { out.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return out;
  }
  const formFields = (html: string, action: string) => {
    const found = [...html.matchAll(/<form method="post" action="([^"]+)"[^>]*>(.*?)<\/form>/gsu)].find(m => m[1] === action); if (!found) throw new Error(`No form ${action}`);
    const fields = new URLSearchParams(); for (const i of found[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/gu)) fields.append(i[1]!, i[2]!.replace(/&amp;/gu, '&')); return fields;
  };
  return { w, service, request, formFields };
}
const DUE = '2026-11-01T09:30', EXPIRES = '2026-11-02T09:30';
const confirmPath = (kind: string, times = true) => `${BASE}?item=${ids.item}&version=${ids.version}&confirm=${kind}${times ? `&dueAt=${DUE}&expiresAt=${EXPIRES}` : ''}`;

test('owner email: the page no longer schedules in one press; it opens a confirmation naming everyone', async () => {
  const f = world();
  const html = (await f.request('GET', `${BASE}?item=${ids.item}&version=${ids.version}`)).body;
  assert.doesNotMatch(html, /action="\/hq\/marketing\/emails\/schedule"/u); assert.match(html, /<form method="get" action="\/hq\/marketing\/emails">.*name="confirm" value="schedule"/su);
  const confirm = await f.request('GET', confirmPath('schedule')); const text = visibleText(confirm.body);
  assert.equal(confirm.status, 200); assert.match(text, /You are about to email 6 people/u);
  assert.match(text, /Who: people who registered for “Before You Buy live webinar” and agreed to emails\./u);
  assert.match(text, /Email: “Hi \{\{FIRSTNAME\}\}”, sent Sun 1 Nov, 09:30 \(UK time\) ?\./u);
  for (let n = 1; n <= 6; n++) assert.match(confirm.body, new RegExp(`guest\\.${n}@example\\.invalid`, 'u'));
  assert.doesNotMatch(confirm.body, /guest\.7@|guest\.8@/u); assert.match(text, /1 person did not agree to emails/u); assert.match(text, /1 person unsubscribed/u);
  assert.match(text, /Yes, send to these 6 people/u); assert.match(confirm.body, /<button>Schedule for 6 people<\/button>/u);
  assert.deepEqual(f.w.calls, []);
});
test('owner email: ticking and pressing schedules exactly the people shown; then the result is on the page', async () => {
  const f = world(); const fields = f.formFields((await f.request('GET', confirmPath('schedule'))).body, `${BASE}/schedule`);
  const unticked = await f.request('POST', `${BASE}/schedule`, fields.toString()); assert.equal(unticked.status, 400); assert.deepEqual(f.w.calls, []);
  fields.set('confirm', 'yes'); const done = await f.request('POST', `${BASE}/schedule`, fields.toString());
  assert.equal(done.status, 303); assert.match(done.headers.location!, /#result$/u); assert.match(done.headers['set-cookie']!, /^mhp_owner_note=/u);
  assert.deepEqual(f.w.calls, ['schedule']); assert.equal(f.w.rows.size, 6);
  assert.match(visibleText((await f.request('GET', done.headers.location!)).body), /Scheduled for 6 people\. It goes 1 Nov 2026, 09:30 \(UK time\)\./u);
});
test('owner email: a changed list, a forged or tampered confirmation, or an old one schedules nobody', async () => {
  const f = world(); const fields = f.formFields((await f.request('GET', confirmPath('schedule'))).body, `${BASE}/schedule`); fields.set('confirm', 'yes');
  for (const [key, value] of [['count', '5'], ['digest', 'a'.repeat(64)], ['sig', 'f'.repeat(64)], ['dueAt', '2026-11-01T10:30'], ['versionId', '12600000-0000-4000-8000-000000000099']] as const) {
    const forged = new URLSearchParams(fields); forged.set(key, value); assert.equal((await f.request('POST', `${BASE}/schedule`, forged.toString())).status, 400, key);
  }
  f.w.candidates.push(person(9));
  const changed = await f.request('POST', `${BASE}/schedule`, fields.toString());
  assert.equal(changed.status, 409); assert.match(visibleText(changed.body), /The list changed, so nothing was scheduled.*When you looked, this was 6 people\. It is now 7 people\./su);
  assert.deepEqual(f.w.calls, []);
  f.w.now += 31 * 60_000; const fresh = f.formFields(changed.body, `${BASE}/schedule`); fresh.set('confirm', 'yes'); f.w.now += 31 * 60_000;
  const old = await f.request('POST', `${BASE}/schedule`, fresh.toString()); assert.equal(old.status, 409); assert.match(old.body, /more than 30 minutes old/u);
  assert.deepEqual(f.w.calls, []);
  // The public service queue refuses scheduling and replacing outright.
  await assert.rejects(f.service.queue(identity, ids.request, { action: 'schedule', commandId: ids.command, versionId: ids.version, dueAt: '2026-11-01T09:30:00.000Z', expiresAt: '2026-11-02T09:30:00.000Z' }), { status: 409 });
  await assert.rejects(f.service.queue(identity, ids.request, { action: 'replace', commandId: ids.command, versionId: ids.version, dueAt: '2026-11-01T09:30:00.000Z', expiresAt: '2026-11-02T09:30:00.000Z' }), { status: 409 });
});
test('owner email: never more than the page can check, and never a guess about who is left', async () => {
  const f = world(); f.w.candidates = Array.from({ length: 101 }, (_, i) => person(i + 1));
  assert.match(visibleText((await f.request('GET', confirmPath('schedule'))).body), /This list is longer than this page can safely check \(101 people\)\. Nothing was scheduled\./u);
  const g = world(); g.w.rows.set(prospect(1), 'pending');
  const refused = visibleText((await g.request('GET', confirmPath('schedule'))).body);
  assert.match(refused, /One person already has this email scheduled, sent or cancelled\. This page cannot yet tell exactly who is left/u); assert.doesNotMatch(refused, /Yes, send/u);
});
test('owner email: a person who signs up in the moment of the press is reported, not hidden', async () => {
  const f = world(); const fields = f.formFields((await f.request('GET', confirmPath('schedule'))).body, `${BASE}/schedule`); fields.set('confirm', 'yes');
  f.w.beforeQueue = () => f.w.candidates.push(person(20));
  const landed = visibleText((await f.request('GET', (await f.request('POST', `${BASE}/schedule`, fields.toString())).headers.location!)).body);
  assert.match(landed, /Scheduled for 6 people\..* 1 person not on your list was also scheduled, because they signed up at the same moment\./su);
});
test('owner email: replace confirms who is affected and needs the tick; cancel has a short confirmation', async () => {
  const f = world(); for (let n = 1; n <= 3; n++) f.w.rows.set(prospect(n), 'pending');
  const html = (await f.request('GET', `${BASE}?item=${ids.item}&version=${ids.version}`)).body;
  assert.doesNotMatch(html, /action="\/hq\/marketing\/emails\/(?:replace|cancel)"/u); assert.match(html, /confirm=cancel">Cancel unsent emails…/u);
  const replace = await f.request('GET', confirmPath('replace'));
  assert.match(visibleText(replace.body), /Change 3 unsent emails to this version and time\? Up to 3 people who already have this email scheduled and not yet sent will get “Hi \{\{FIRSTNAME\}\}” at Sun 1 Nov, 09:30 \(UK time\) instead\. Nobody new is added/u);
  const fields = f.formFields(replace.body, `${BASE}/replace`);
  assert.equal((await f.request('POST', `${BASE}/replace`, fields.toString())).status, 409); assert.deepEqual(f.w.calls, []);
  fields.set('confirm', 'yes'); const done = await f.request('POST', `${BASE}/replace`, fields.toString()); assert.equal(done.status, 303);
  assert.match(visibleText((await f.request('GET', done.headers.location!)).body), /Changed 3 unsent emails to this version and time\./u);
  const cancel = await f.request('GET', confirmPath('cancel', false)); assert.match(visibleText(cancel.body), /Cancel 3 unsent emails\? They will not be sent\./u);
  const cancelled = await f.request('POST', `${BASE}/cancel`, f.formFields(cancel.body, `${BASE}/cancel`).toString()); assert.equal(cancelled.status, 303);
  assert.ok([...f.w.rows.values()].every(v => v === 'cancelled')); assert.deepEqual(f.w.calls, ['replace', 'cancel']);
  // A forged cancel without the signed confirmation does nothing.
  const forged = new URLSearchParams({ csrf: portalCsrfToken(SECRET, token), commandId: ids.command, itemId: ids.item, versionId: ids.version });
  assert.equal((await f.request('POST', `${BASE}/cancel`, forged.toString())).status, 400);
});
test('owner email: each form has its own command id, and a note shows only on its own email', async () => {
  const f = world(); f.w.rows.set(prospect(1), 'pending');
  const html = (await f.request('GET', `${BASE}?item=${ids.item}&version=${ids.version}`)).body;
  const ids_ = [...html.matchAll(/name="commandId" value="([^"]+)"/gu)].map(m => m[1]); assert.ok(ids_.length >= 2); assert.equal(new Set(ids_).size, ids_.length);
  const cancel = await f.request('GET', confirmPath('cancel', false));
  const done = await f.request('POST', `${BASE}/cancel`, f.formFields(cancel.body, `${BASE}/cancel`).toString());
  const location = done.headers.location!, query = location.slice(location.indexOf('&note='), location.indexOf('#'));
  assert.doesNotMatch(visibleText((await f.request('GET', `${BASE}?item=${ids.item}&version=12600000-0000-4000-8000-000000000099${query}`)).body), /Cancelled/u);
  void MhpCommerceError;
});
