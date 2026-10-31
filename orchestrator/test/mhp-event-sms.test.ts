import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import { requestDatabaseContext } from '../src/db/rls.js';
import { MHP_EVENT_SMS_CONSENT_TEXT, MHP_EVENT_SMS_CONSENT_VERSION, MhpEventSmsOwnerService, PgMhpEventSmsPublicService,
  assertMhpEventSmsBoundaryReady, normaliseEmail, normaliseUkMobile, type MhpEventSmsOwnerDependencies, type MhpEventSmsPublic,
  type MhpEventSmsSendResult, type MhpEventSmsSnapshot } from '../src/mhp/event-sms-service.js';
import { marketingWorkspacePage } from '../src/mhp/marketing-workspace-view.js';
import { ids, identity, review, token, now } from './helpers/mhp-owner-email-fixture.js';

const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SECRET = 'synthetic-mhp-event-sms-router-secret-at-least-32';
const BODY = 'Martin Howard Property: the webinar starts at 7:30pm. Watch https://martinhowardproperty.co.uk/webinar/live/ Reply STOP to opt out.';
const canonical = JSON.stringify({ bodyText: BODY, schema: 'growthhq.sms-draft/v1' });
const contentSha = createHash('sha256').update(canonical).digest('hex');
const batchSha = 'c'.repeat(64);

test('UK mobile and email normalisation accepts real typing and refuses everything else', () => {
  for (const raw of ['07700 900123', '+44 7700 900123', '+44 (0)7700 900123', '447700900123', '0044 7700-900123']) {
    assert.equal(normaliseUkMobile(raw), '+447700900123', raw);
  }
  for (const raw of ['01632 960123', '+33 6 12 34 56 78', '0770090012', '07700 9001234', 'call me', '+447700900123; DROP']) {
    assert.equal(normaliseUkMobile(raw), null, raw);
  }
  assert.equal(normaliseEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(normaliseEmail('no-at-sign'), null);
  assert.equal(normaliseEmail(`${'a'.repeat(250)}@x.io`), null);
});

test('public opt-in sends the exact consent digest, refuses without consent and maps database refusals', async () => {
  const calls: unknown[][] = [];
  let failure: { code: string } | null = null;
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push([sql, values]);
    if (failure) throw failure;
    return sql.includes('optin_confirm') ? { rows: [{ value: 'verified' }] } : { rows: [{ value: { optinId: ids.item } }] };
  } };
  const service = new PgMhpEventSmsPublicService(pool as never, 'webinar-2026-11-04');
  const source = Buffer.alloc(32, 7);
  await assert.rejects(service.request({ email: 'a@example.com', phone: '07700900123', consented: false, requestKey: ids.command }, source), { status: 400 });
  await assert.rejects(service.request({ email: 'a@example.com', phone: '01632960123', consented: true, requestKey: ids.command }, source), { status: 400 });
  await assert.rejects(service.request({ email: 'a@example.com', phone: '07700900123', consented: true, requestKey: ids.command }, null), { status: 400 });
  assert.equal(calls.length, 0, 'nothing reaches the database without consent, a mobile and a source');
  assert.equal(await service.request({ email: ' A@Example.com', phone: '07700 900123', consented: true, requestKey: ids.command }, source), ids.item);
  const values = calls[0]![1] as unknown[];
  assert.deepEqual(values.slice(0, 4), ['a@example.com', '+447700900123', 'webinar-2026-11-04', MHP_EVENT_SMS_CONSENT_VERSION]);
  assert.deepEqual(values[4], createHash('sha256').update(MHP_EVENT_SMS_CONSENT_TEXT).digest());
  assert.equal(await service.confirm(ids.item, '123456'), 'verified');
  await assert.rejects(service.confirm(ids.item, '12345'), { status: 400 });
  failure = { code: '54000' };
  await assert.rejects(service.request({ email: 'a@example.com', phone: '07700900123', consented: true, requestKey: ids.command }, source), { status: 429 });
  failure = { code: 'XX000' };
  await assert.rejects(service.confirm(ids.item, '123456'), { status: 503 });
});

function ownerFixture(options: { replay?: boolean; approved?: boolean; body?: string } = {}) {
  const calls: string[] = [];
  const result: MhpEventSmsSendResult = { batchId: ids.send, commandId: ids.command, recipientCount: 2, segmentsTotal: 2,
    jobIds: [ids.lease, ids.proof], authorityExpiresAt: '2026-11-04T18:34:00.000Z', replayed: false };
  const snapshot: MhpEventSmsSnapshot = { campaign: 'webinar-2026-11-04', bindingReady: true, readyCount: 1, batchSha256: batchSha,
    daySegmentsUsed: 0, monthSegmentsUsed: 1, batches: [],
    recipients: [{ optinId: ids.item, email: 'r1@example.invalid', firstName: 'Ruth', phoneLast4: '0123', verifiedAt: '2026-11-01T10:00:00.000Z', status: 'ready' },
      { optinId: ids.version, email: 'r2@example.invalid', firstName: null, phoneLast4: '0456', verifiedAt: '2026-11-01T11:00:00.000Z', status: 'opted_out' }] };
  const dependencies: MhpEventSmsOwnerDependencies = {
    campaign: 'webinar-2026-11-04',
    marketingWorkspace: { snapshot: async given => ({ userId: given.userId, selectedWorkspaceId: given.workspaceId, personalWorkspaceId: ids.prospect,
      marketingWorkspaceId: identity.workspaceId, marketingSelected: given.workspaceId === identity.workspaceId }) },
    authorize: async (given, requestId) => requestDatabaseContext({ userId: given.userId, workspaceId: given.workspaceId, requestId,
      portalSessionTokenHash: createHash('sha256').update(given.sessionToken).digest() }),
    repository: {
      snapshot: async () => { calls.push('snapshot'); return snapshot; },
      send: async (_context, _identity, campaign, input, lookupOnly) => {
        calls.push(lookupOnly ? 'lookup' : 'send');
        assert.equal(campaign, 'webinar-2026-11-04'); assert.equal(input.batchSha256, batchSha);
        if (lookupOnly) return options.replay ? { ...result, replayed: true } : null;
        return result;
      },
    },
    messages: {
      choices: async () => [],
      review: async () => { calls.push('review'); return { review: { ...review, kind: 'other', contentSha256: contentSha, approvalStatus: options.approved === false ? 'pending' : 'approved', approvalStale: false,
        source: { system: 'mhp.owner-sms', itemId: `owner-sms:${ids.item}`, version: `edit:${ids.version}` } },
        channel: 'sms', payload: { schema: 'growthhq.sms-draft/v1', bodyText: options.body ?? BODY }, valid: true, local: null, manifestSha256: contentSha } as never; },
      publish: async () => { calls.push('publish'); },
    },
    observe: async () => { calls.push('observe'); },
  };
  return { service: new MhpEventSmsOwnerService(dependencies), calls, result, snapshot };
}
const sendInput = { commandId: ids.command, itemId: ids.item, versionId: ids.version, sha256: contentSha, batchSha256: batchSha, agreed: true };

test('owner send looks up history first, then reviews, refreshes the source once and sends once', async () => {
  const approved = ownerFixture();
  assert.equal((await approved.service.send(identity, ids.request, sendInput, now)).recipientCount, 2);
  assert.deepEqual(approved.calls, ['lookup', 'review', 'observe', 'send']);
  const unapproved = ownerFixture({ approved: false });
  await unapproved.service.send(identity, ids.request, sendInput, now);
  assert.deepEqual(unapproved.calls, ['lookup', 'review', 'publish', 'send'], 'publish performs its own refresh; no double observation');
  const replay = ownerFixture({ replay: true });
  assert.equal((await replay.service.send(identity, ids.request, sendInput, now)).replayed, true);
  assert.deepEqual(replay.calls, ['lookup'], 'a recorded batch is returned before any mutable work');
});

test('owner send refuses without agreement, a changed text, or a text without STOP', async () => {
  const f = ownerFixture();
  await assert.rejects(f.service.send(identity, ids.request, { ...sendInput, agreed: false }, now), { status: 400 });
  await assert.rejects(f.service.send(identity, ids.request, { ...sendInput, batchSha256: 'nope' }, now), { status: 400 });
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.service.send(identity, ids.request, { ...sendInput, sha256: 'd'.repeat(64) }, now), { status: 409 });
  assert.deepEqual(f.calls, ['lookup', 'review']);
  const noStop = ownerFixture({ body: 'Martin Howard Property: see you tonight.' });
  await assert.rejects(noStop.service.send(identity, ids.request, sendInput, now), { status: 409 });
  assert.ok(!noStop.calls.includes('send'));
  await assert.rejects(f.service.send({ ...identity, workspaceId: ids.prospect }, ids.request, sendInput, now), { status: 403 });
});

test('the boundary probe refuses a command role that can reach internal or public functions', async () => {
  await assert.doesNotReject(assertMhpEventSmsBoundaryReady({ query: async () => ({ rows: [{ ready: true }] }) } as never));
  await assert.rejects(assertMhpEventSmsBoundaryReady({ query: async () => ({ rows: [{ ready: false }] }) } as never), { status: 503 });
});

function mountFixture() {
  const state = { authenticated: true, requests: [] as unknown[], confirms: [] as string[], confirmResult: 'verified' as 'verified' | 'retry' | 'unavailable', sends: [] as unknown[] };
  const optins: MhpEventSmsPublic = {
    request: async (input, source) => { state.requests.push({ ...input, source }); return ids.item; },
    confirm: async (optinId, code) => { state.confirms.push(`${optinId}:${code}`); return state.confirmResult; },
  };
  const owner = ownerFixture();
  const ownerService = { snapshot: owner.service.snapshot.bind(owner.service),
    send: async (...args: Parameters<MhpEventSmsOwnerService['send']>) => { state.sends.push(args[2]); return owner.result; } };
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE,
    portalBaseUrl: ORIGIN, now: () => now, crm: {} as PostgresPortalDeps['crm'],
    auth: { resolve: async (given: string) => state.authenticated && given === token ? identity : null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: ids.request, requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  const mount = createMhpMount({ portal, eventSms: { optins, owner: ownerService }, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => ids.command },
    commerce: { billingEnabled: false, snapshot: async () => { throw Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} } });
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: HOST, cookie: `__Host-mhp_session=${token}`,
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { result.status = status; Object.assign(result.headers, head); },
      setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(text = '') { result.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  }
  return { state, request };
}
const enc = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

test('public page shows the exact consent wording and never asks for or reveals anything else', async () => {
  const f = mountFixture();
  const page = await f.request('GET', '/webinar/texts', '', { cookie: '' });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(MHP_EVENT_SMS_CONSENT_TEXT.replace(/'/gu, '&#39;')) || page.body.includes(MHP_EVENT_SMS_CONSENT_TEXT));
  assert.match(page.body, /name="consent" value="yes" required/u);
  assert.doesNotMatch(page.body, /checked/u, 'consent is never pre-ticked');
  assert.match(page.headers['content-security-policy'] ?? '', /default-src 'none'/u);
  assert.equal((await f.request('GET', '/webinar/texts?email=x', '', { cookie: '' })).status, 405);
});

test('public opt-in requires same origin, exact fields and an explicit tick, and answers registered and unknown emails alike', async () => {
  const f = mountFixture();
  const fields = { requestKey: ids.command, email: 'r1@example.invalid', mobile: '07700 900123', consent: 'yes' };
  assert.equal((await f.request('POST', '/webinar/texts', enc(fields), { origin: 'https://evil.example', cookie: '' })).status, 403);
  assert.equal((await f.request('POST', '/webinar/texts', enc({ ...fields, extra: '1' }), { cookie: '' })).status, 400);
  const unticked = await f.request('POST', '/webinar/texts', enc({ requestKey: ids.command, email: 'r1@example.invalid', mobile: '07700 900123' }), { cookie: '' });
  assert.equal(unticked.status, 400);
  assert.equal(f.state.requests.length, 0);
  const page = await f.request('POST', '/webinar/texts', enc(fields), { cookie: '' });
  assert.equal(page.status, 200);
  assert.match(page.body, /If that email is registered/u);
  assert.match(page.body, new RegExp(`name="optinId" value="${ids.item}"`, 'u'));
  assert.equal(f.state.requests.length, 1);
  assert.deepEqual((f.state.requests[0] as { source: Buffer }).source, Buffer.alloc(32, 2));
});

test('public confirmation never echoes the code and explains each outcome', async () => {
  const f = mountFixture();
  let page = await f.request('POST', '/webinar/texts/confirm', enc({ optinId: ids.item, code: '123456' }), { cookie: '' });
  assert.equal(page.status, 200); assert.match(page.body, /on the text list/u); assert.doesNotMatch(page.body, /123456/u);
  f.state.confirmResult = 'retry';
  page = await f.request('POST', '/webinar/texts/confirm', enc({ optinId: ids.item, code: '654321' }), { cookie: '' });
  assert.equal(page.status, 400); assert.match(page.body, /didn&#39;t match|didn't match/u); assert.doesNotMatch(page.body, /654321/u);
  f.state.confirmResult = 'unavailable';
  page = await f.request('POST', '/webinar/texts/confirm', enc({ optinId: ids.item, code: '111111' }), { cookie: '' });
  assert.equal(page.status, 400); assert.match(page.body, /expired/u);
});

test('owner page needs the owner session, shows every status and sends only with CSRF and same origin', async () => {
  const f = mountFixture();
  f.state.authenticated = false;
  assert.equal((await f.request('GET', '/hq/marketing/event-texts')).status, 303);
  f.state.authenticated = true;
  const page = await f.request('GET', `/hq/marketing/event-texts?item=${ids.item}&version=${ids.version}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /Replied STOP before, so never texted/u);
  assert.match(page.body, /Send to 1 person now/u);
  assert.match(page.body, new RegExp(`name="batchSha256" value="${batchSha}"`, 'u'));
  assert.doesNotMatch(page.body, /\+44/u, 'full numbers never appear on the page');
  const fields = { csrf: portalCsrfToken(SECRET, token), commandId: ids.command, itemId: ids.item, versionId: ids.version, sha256: contentSha, batchSha256: batchSha, agreed: 'yes' };
  assert.equal((await f.request('POST', '/hq/marketing/event-texts/send', enc({ ...fields, csrf: 'forged' }))).status, 403);
  assert.equal((await f.request('POST', '/hq/marketing/event-texts/send', enc(fields), { origin: 'https://evil.example' })).status, 403);
  assert.equal(f.state.sends.length, 0);
  const sent = await f.request('POST', '/hq/marketing/event-texts/send', enc(fields));
  assert.equal(sent.status, 200);
  assert.match(sent.body, /2 texts queued/u);
  assert.equal(f.state.sends.length, 1);
});

test('the marketing workspace links the owner page only when it is mounted', () => {
  const snapshot = { userId: ids.user, selectedWorkspaceId: identity.workspaceId, personalWorkspaceId: ids.prospect, marketingWorkspaceId: identity.workspaceId, marketingSelected: true };
  assert.match(marketingWorkspacePage(snapshot as never, 'csrf', ids.command, { enabled: true, eventSmsEnabled: true }), /\/hq\/marketing\/event-texts/u);
  assert.doesNotMatch(marketingWorkspacePage(snapshot as never, 'csrf', ids.command, { enabled: true }), /event-texts/u);
});
