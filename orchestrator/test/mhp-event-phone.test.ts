import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMhpMount } from '../src/mhp/mount.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';
import { MHP_EVENT_PHONE_CONSENT_TEXT, mhpEventAccessSha, mhpEventJoinNonce, mhpEventJoinSha, normalizeMhpEventMobile,
  PgMhpEventPhonePublic, type MhpEventPhoneStatus } from '../src/mhp/event-phone-service.js';
import { createMhpTransactionalMailer } from '../src/mhp/transactional-mail.js';
import { TwilioMessagingHttpAdapter } from '../src/providers/twilio-messaging-http-adapter.js';
import { PgTwilioSmsWebhookRepository } from '../src/sms-live-pg/webhook-repository.js';
import { loadTwilioSmsWorkerConfig } from '../src/workers/twilio-sms-live/runner.js';
import { readFile } from 'node:fs/promises';

const HOST = 'app.martinhowardproperty.co.uk', ORIGIN = `https://${HOST}`, SECRET = 'synthetic-mhp-event-phone-router-secret-at-least-32';
const ROUTE = '/webinar/phone-reminders';
const MHP = '2789228d-55a6-4688-b1e8-2f70abca990b';

test('consent copy is byte-identical to the 0131 SQL text and the join/link digests are domain-bound', async () => {
  const sql = await readFile(new URL('../src/db/migrations/0131_mhp_event_phone_programme.sql', import.meta.url), 'utf8');
  assert.ok(sql.includes(`'${MHP_EVENT_PHONE_CONSENT_TEXT}'`));
  assert.match(MHP_EVENT_PHONE_CONSENT_TEXT, /only about this webinar, not other marketing/u);
  const nonce = mhpEventJoinNonce();
  assert.match(nonce, /^[a-z2-7]{26}$/u);
  assert.deepEqual(mhpEventJoinSha(nonce.toUpperCase()), mhpEventJoinSha(nonce));
  assert.deepEqual(mhpEventJoinSha(nonce), createHash('sha256').update(`mhp.event-phone.join/v1:${nonce}`).digest());
  assert.notDeepEqual(mhpEventAccessSha(nonce), mhpEventJoinSha(nonce));
});

test('only UK mobiles normalise to E.164', () => {
  assert.equal(normalizeMhpEventMobile('07700 900123'), '+447700900123');
  assert.equal(normalizeMhpEventMobile('+44 7700 900123'), '+447700900123');
  assert.equal(normalizeMhpEventMobile('447700900123'), '+447700900123');
  for (const bad of ['01632 960000', '+15551234567', '0770090012', 'JOIN', '']) assert.equal(normalizeMhpEventMobile(bad), null);
});

test('event link email is a separate transactional method bound to the exact reminder path', async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const mailer = createMhpTransactionalMailer({ MHP_TRANSACTIONAL_PROVIDER: 'postmark', MHP_POSTMARK_SERVER_TOKEN: 'synthetic', MHP_POSTMARK_FROM: 'martin@propinvestuk.co.uk' },
    (async (url: string | URL | Request, init?: RequestInit) => { sent.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Response('{}', { status: 200 }); }) as typeof fetch);
  const token = 'A'.repeat(43);
  await mailer.sendEventPhoneLink!('person@example.invalid', `${ORIGIN}${ROUTE}/open?t=${token}`, '2026-11-04T19:30:00Z');
  assert.equal(sent.length, 1); assert.equal(sent[0]!.body.Tag, 'mhp-event-reminder');
  assert.match(String(sent[0]!.body.TextBody), /expires in 15 minutes and works once/u);
  await assert.rejects(mailer.sendEventPhoneLink!('person@example.invalid', `${ORIGIN}/portal/auth/verify?t=${token}`, '2026-11-04T19:30:00Z'));
  await assert.rejects(mailer.sendEventPhoneLink!('person@example.invalid', `https://evil.example${ROUTE}/open?t=${token}`, '2026-11-04T19:30:00Z'));
});

test('ValidityPeriod is sent only for an event deadline; the legacy request form is byte-identical', async () => {
  const forms: URLSearchParams[] = [];
  const adapter = new TwilioMessagingHttpAdapter({ accountSid: `AC${'1'.repeat(32)}`, apiKeySid: `SK${'2'.repeat(32)}`, apiKeySecret: 'restricted-test-secret-123456',
    messagingServiceSid: `MG${'3'.repeat(32)}`, now: () => new Date('2026-11-04T18:30:00Z'),
    fetch: (async (_url: unknown, init?: RequestInit) => { forms.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ sid: `SM${'4'.repeat(32)}`, num_segments: '1' }), { status: 201, headers: { 'content-type': 'application/json' } }); }) as typeof fetch });
  const digest = createHash('sha256').update('x').digest('hex');
  const context = { workspaceId: MHP, connectionId: '22222222-2222-4222-8222-222222222222', providerId: 'twilio_messaging' as const,
    operationId: '33333333-3333-4333-8333-333333333333', idempotencyKey: digest, correlationId: '44444444-4444-4444-8444-444444444444' };
  const request = { recipient: '+447700900123', body: 'Exact approved SMS.', expectedSegmentCount: 1, idempotencySha256: digest };
  await adapter.send(context, request);
  assert.deepEqual([...forms[0]!.keys()], ['To', 'MessagingServiceSid', 'Body']);
  await adapter.send(context, { ...request, providerExpiresAt: '2026-11-04T19:00:00.000Z' });
  assert.equal(forms[1]!.get('ValidityPeriod'), '1800');
  await assert.rejects(adapter.send(context, { ...request, providerExpiresAt: '2026-11-04T18:29:59.000Z' }), /deadline/u);
  assert.equal(forms.length, 2);
});

test('webhook routes MHP inbound through the 0131 wrapper only when enabled, in READ COMMITTED', async () => {
  const queries: string[] = [];
  const pool = { connect: async () => ({ query: async (sql: string) => { queries.push(sql);
    return { rows: sql.includes('mhp_record_event_sms_inbound') ? [{ outcome: 'event_joined' }] : sql.includes('record_sms_live_inbound_projection') ? [{ outcome: 'applied' }] : [] }; },
    release: () => undefined }) };
  const event = { kind: 'inbound' as const, externalEventId: `inbound:SM${'a'.repeat(32)}`, providerMessageId: `SM${'a'.repeat(32)}`, normalizedSender: '447700900123',
    senderSha256: createHash('sha256').update('447700900123').digest('hex'), body: 'JOIN abc', bodySha256: createHash('sha256').update('JOIN abc').digest('hex'), optEvidence: null };
  const input = { event, payloadSha256: 'b'.repeat(64), signatureSha256: 'c'.repeat(64), occurredAt: '2026-11-01T00:00:00.000Z', projection: 'conversion_inbox_and_lead360' as const };
  const enabled = new PgTwilioSmsWebhookRepository({ commandPool: pool as never, workspaceId: MHP, providerConnectionId: '22222222-2222-4222-8222-222222222222', mhpEventPhone: true });
  assert.equal(await enabled.recordInbound(input as never), 'applied');
  assert.ok(queries.some(q => /BEGIN ISOLATION LEVEL READ COMMITTED/u.test(q)) && queries.some(q => q.includes('mhp_record_event_sms_inbound')));
  queries.length = 0;
  const other = new PgTwilioSmsWebhookRepository({ commandPool: pool as never, workspaceId: '11111111-1111-4111-8111-111111111111', providerConnectionId: '22222222-2222-4222-8222-222222222222', mhpEventPhone: true });
  assert.equal(other.eventPhone, false);
  await other.recordInbound(input as never);
  assert.ok(queries.some(q => q.includes('record_sms_live_inbound_projection')) && !queries.some(q => q.includes('mhp_record_event_sms_inbound')));
});

test('worker event mode is opt-in: a disabled worker never carries event reminders', () => {
  const base = { DATABASE_SMS_WORKER_URL: 'postgres://x', PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: '11111111-1111-4111-8111-111111111111' };
  const config = loadTwilioSmsWorkerConfig({ ...base, PROPERTY_PREDATOR_SMS_MHP_EVENT_MODE: 'enabled' } as NodeJS.ProcessEnv);
  assert.equal(config.mode, 'disabled'); assert.equal('mhpEventReminders' in config, false);
});

function publicFixture() {
  const state = { requested: [] as string[], opened: 0, chosen: [] as string[], status: null as MhpEventPhoneStatus | null };
  const reminders = {
    senderNumber: '+447861935832',
    requestLink: async (email: string) => { state.requested.push(email); },
    open: async (token: string) => { state.opened += 1; return token === 'G'.repeat(43) ? { capability: 'C'.repeat(43) } : { reason: 'used' as const }; },
    status: async (capability: string) => capability === 'C'.repeat(43) ? state.status : null,
    choose: async (_capability: string, phone: string, consented: boolean) => { state.chosen.push(`${phone}:${consented}`); return { nonce: 'abcdefghijklmnopqrstuvwxyz', joinExpiresAt: '2026-11-04T18:00:00Z', alreadyVerified: false }; },
    withdraw: async () => true,
  } as unknown as PgMhpEventPhonePublic;
  const portal = { kind: 'postgres', secure: true, sessionSecret: SECRET, sessionCookieName: '__Host-mhp_session', productProfile: MARTIN_HOWARD_PROPERTY_PROFILE,
    portalBaseUrl: ORIGIN, now: () => Date.parse('2026-11-01T00:00:00Z'), crm: {} as PostgresPortalDeps['crm'],
    auth: { resolve: async () => null, login: async () => null, revoke: async () => {} }, abuseHashSecret: SECRET,
    requestContext: () => ({ requestId: '33333333-3333-4333-8333-333333333333', requestHash: Buffer.alloc(32, 1), sourceHash: Buffer.alloc(32, 2) }),
    abuse: { admit: async () => ({ allowed: true, leaseHash: Buffer.alloc(32, 1), retryAfterSeconds: 0 }), complete: async () => {}, assertReady: async () => {}, close: async () => {} } } as PostgresPortalDeps;
  const mount = createMhpMount({ portal, eventPhone: { reminders, campaign: 'webinar-2026-11-04' }, authMount: { handle: async () => false }, readiness: async () => [],
    hq: { isOwner: async () => true, snapshot: async () => ({ people: [], products: [], grants: [] }), grant: async () => 'x' },
    commerce: { billingEnabled: false, snapshot: async () => { throw Error('excluded'); }, refund: async () => {}, billingPortal: async () => '', webhook: async () => {} } } as never);
  async function request(method: string, path: string, body = '', headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url: path, headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { result.status = status; Object.assign(result.headers, head); },
      setHeader(key: string, value: string) { result.headers[key.toLowerCase()] = value; }, end(text = '') { result.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  }
  return { state, request };
}

test('public flow: uniform email request, GET never consumes, explicit POST sets a host-only capability, consent is explicit', async () => {
  const f = publicFixture();
  let page = await f.request('GET', ROUTE);
  assert.equal(page.status, 200); assert.match(page.body, /Email me a link/u); assert.equal(page.headers['referrer-policy'], 'same-origin');
  page = await f.request('POST', ROUTE, 'email=person%40example.invalid');
  assert.equal(page.status, 200); assert.match(page.body, /If that email is registered/u);
  assert.equal((await f.request('POST', ROUTE, 'email=x%40example.invalid', { origin: 'https://evil.example' })).status, 403);
  page = await f.request('GET', `${ROUTE}/open?t=${'G'.repeat(43)}`);
  assert.equal(page.status, 200); assert.equal(f.state.opened, 0, 'GET must not consume the link');
  page = await f.request('POST', `${ROUTE}/open`, `t=${'G'.repeat(43)}`);
  assert.equal(page.status, 303);
  assert.match(page.headers['set-cookie']!, /^__Host-mhp_event_phone=C{43}; Path=\/; Max-Age=900; Secure; HttpOnly; SameSite=Strict$/u);
  const cookie = `__Host-mhp_event_phone=${'C'.repeat(43)}`;
  f.state.status = { ok: true, campaign: 'webinar-2026-11-04', firstName: 'Ana', open: true, startsAt: '2026-11-04T19:30:00Z', consentText: MHP_EVENT_PHONE_CONSENT_TEXT,
    capabilityExpiresAt: '2026-11-01T00:15:00Z', sms: null };
  page = await f.request('GET', `${ROUTE}/choose`, '', { cookie });
  assert.equal(page.status, 200); assert.ok(page.body.includes('only about this webinar'));
  const csrf = portalCsrfToken(SECRET, `mhp.event-phone:${'C'.repeat(43)}`);
  assert.equal((await f.request('POST', `${ROUTE}/choose`, 'csrf=wrong&mobile=07700900123&consent=yes', { cookie })).status, 403);
  page = await f.request('POST', `${ROUTE}/choose`, `csrf=${encodeURIComponent(csrf)}&mobile=07700900123&consent=yes`, { cookie });
  assert.equal(page.status, 200); assert.match(page.body, /JOIN ABCDEFGHIJKLMNOPQRSTUVWXYZ/u); assert.match(page.body, /\+447861935832/u);
  assert.deepEqual(f.state.chosen, ['07700900123:true']);
  assert.equal((await f.request('GET', `${ROUTE}/choose`)).status, 401, 'no capability cookie, no status');
});
