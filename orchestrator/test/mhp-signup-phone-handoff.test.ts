import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { createMhpMount } from '../src/mhp/mount.js';
import { PgMhpEventPhonePublic, mhpEventCapabilitySha } from '../src/mhp/event-phone-service.js';
import type { MhpCapturedSignup } from '../src/mhp/growth-service.js';
import type { PostgresPortalDeps } from '../src/portal/router.js';
import { MARTIN_HOWARD_PROPERTY_PROFILE } from '../src/portal/product-profile.js';

const ORIGIN = 'https://app.martinhowardproperty.co.uk', SITE = 'https://martinhowardproperty.co.uk';
const now = Date.parse('2026-11-01T12:00:00Z');
const captured: MhpCapturedSignup = { prospectId: '33333333-3333-4333-8333-333333333333', signupId: '44444444-4444-4444-8444-444444444444',
  campaign: 'webinar-2026-11-04', entryEventSequence: '12', queued: 5 };
const source = Buffer.alloc(32, 2);
const fields = { EMAIL: 'new@example.invalid', FIRSTNAME: 'New', OPT_IN: '1', CHEATSHEET: 'Webinar 4 November', CHEATSHEET_LINK: `${SITE}/webinar/` };

export function signupPhoneFixture(mode: 'ok' | 'denied' | 'throws' | 'off' = 'ok') {
  const calls = { captured: 0, handoffs: 0, stories: 0 };
  const portal = { kind: 'postgres', secure: true, sessionSecret: 'synthetic-signup-phone-secret-at-least32',
    abuseHashSecret: 'synthetic-signup-phone-abuse-secret-at-least32',
    productProfile: MARTIN_HOWARD_PROPERTY_PROFILE, now: () => now, auth: { resolve: async () => null },
    requestContext: () => ({ requestId: '55555555-5555-4555-8555-555555555555', sourceHash: source, requestHash: Buffer.alloc(32, 1) }),
    abuse: { admit: async () => ({ allowed: true }), complete: async () => {} } } as unknown as PostgresPortalDeps;
  const reminders = { senderNumber: '+447861935832', requestLink: async () => {}, open: async () => ({ reason: 'invalid' as const }),
    status: async (cap: string) => cap === 'C'.repeat(43) ? { ok: true as const, campaign: captured.campaign!, firstName: 'New', open: true,
      startsAt: '2026-11-04T19:30:00Z', consentText: 'Optional webinar texts only.', capabilityExpiresAt: '2026-11-01T12:15:00Z', sms: null } : null,
    choose: async () => ({ reason: 'session' }), withdraw: async () => false,
    fromSignup: async (result: MhpCapturedSignup, hash: Buffer | null, clock: number) => {
      calls.handoffs++; assert.deepEqual(result, captured); assert.deepEqual(hash, source); assert.equal(clock, now);
      assert.equal(calls.captured, 1, 'signup must be committed before optional handoff');
      if (mode === 'throws') throw new Error('dependency unavailable');
      return mode === 'denied' ? null : { capability: 'C'.repeat(43), maxAge: 900 };
    } } as unknown as PgMhpEventPhonePublic;
  const mount = createMhpMount({ portal, authMount: { handle: async () => false }, readiness: async () => [],
    hq: {} as never, commerce: {} as never,
    growth: { growth: { capture: async () => { calls.captured++; return captured; }, story: async () => { calls.stories++; }, unsubscribe: async () => {}, summary: async () => ({}) } as never,
      learning: {} as never, unsubscribeSecret: 'not-used', marketingMode: 'test' },
    ...(mode === 'off' ? {} : { eventPhone: { reminders, campaign: captured.campaign! } }) });
  async function request(method = 'POST', path = '/api/mhp/subscribe', input: Record<string, string> = fields, headers: Record<string, string> = {}) {
    const result = { status: 0, headers: {} as Record<string, string>, body: '' };
    const req = Object.assign(Readable.from([Buffer.from(new URLSearchParams(input).toString())]), { method, url: path,
      headers: { host: 'app.martinhowardproperty.co.uk', origin: SITE, 'content-type': 'application/x-www-form-urlencoded', ...headers } }) as unknown as IncomingMessage;
    const res = { writeHead(status: number, head: Record<string, string> = {}) { result.status = status; Object.assign(result.headers, head); },
      end(text = '') { result.body = text; } } as unknown as ServerResponse;
    await mount.handle(req, res); return result;
  }
  return { calls, request };
}

test('native public-site signup sets secure host-only cookie and clean app redirect; existing choose consumes cookie only', async () => {
  const f = signupPhoneFixture(), result = await f.request();
  assert.equal(result.status, 303); assert.equal(result.headers.location, `${ORIGIN}/webinar/phone-reminders/choose`);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['set-cookie'], `__Host-mhp_event_phone=${'C'.repeat(43)}; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=Strict`);
  assert.doesNotMatch(result.headers.location!, /[?&#]|C{43}/u); assert.equal(result.body, '');
  const chosen = await f.request('GET', '/webinar/phone-reminders/choose', {}, { origin: ORIGIN, cookie: `__Host-mhp_event_phone=${'C'.repeat(43)}` });
  assert.equal(chosen.status, 200); assert.match(chosen.body, /name="csrf"/u); assert.match(chosen.body, /name="consent"/u);
  assert.equal((await f.request('GET', '/webinar/phone-reminders/choose', {}, { origin: ORIGIN })).status, 401);
});

test('returning/closed, unavailable and unconfigured handoffs preserve committed signup and static thanks/email fallback', async () => {
  for (const mode of ['denied', 'throws', 'off'] as const) {
    const f = signupPhoneFixture(mode), result = await f.request();
    assert.equal(result.status, 303); assert.equal(result.headers.location, `${SITE}/thanks/?for=webinar`);
    assert.equal(result.headers['set-cookie'], undefined); assert.equal(f.calls.captured, 1);
  }
});

test('cross-site and forged redirects are rejected or ignored; apex/www native forms remain accepted', async () => {
  for (const origin of ['https://evil.example', 'null', `${SITE}.evil.example`, '']) {
    const f = signupPhoneFixture(), result = await f.request('POST', '/api/mhp/subscribe', fields, { origin });
    assert.equal(result.status, 403); assert.equal(f.calls.captured, 0); assert.equal(f.calls.handoffs, 0);
  }
  const f = signupPhoneFixture(), result = await f.request('POST', '/api/mhp/subscribe', { ...fields, redirect: 'https://evil.example/' }, { origin: 'https://www.martinhowardproperty.co.uk' });
  assert.equal(result.headers.location, `${ORIGIN}/webinar/phone-reminders/choose`);
});

test('sheet/waitlist/honeypot keep exact old redirects and never mint phone authority', async () => {
  for (const [input, kind, count] of [
    [{ ...fields, CHEATSHEET: 'Sheet', CHEATSHEET_LINK: `${SITE}/cheat-sheets/01/` }, 'sheet', 1],
    [{ ...fields, CHEATSHEET: 'Waitlist', CHEATSHEET_LINK: `${SITE}/join/` }, 'waitlist', 1],
    [{ ...fields, email_address_check: 'bot' }, 'sheet', 0],
  ] as const) {
    const f = signupPhoneFixture(), result = await f.request('POST', '/api/mhp/subscribe', input);
    assert.equal(result.headers.location, `${SITE}/thanks/?for=${kind}`); assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(f.calls.captured, count); assert.equal(f.calls.handoffs, 0);
  }
});

test('testimonial POST keeps its own capture and static thanks redirect', async () => {
  const f = signupPhoneFixture(), result = await f.request('POST', '/api/mhp/story', {
    FORM: 'testimonial', NAME: 'Synthetic story', TOWN: 'Cardiff', EMAIL: 'story@example.invalid', DOOR: 'Source',
    WHAT_YOU_DID: 'Sent lawful sourcing letters and booked two viewings.', BEFORE: 'Stuck', WHAT_CHANGED: 'Confidence', NUMBER: '2 viewings',
    WHEN: '2026-10', PUBLISH_NAME: 'First name only', PUBLISH_DOOR: 'Yes', DO_NOT_SAY: '', CONSENT: '1',
  });
  assert.equal(result.status, 303); assert.equal(result.headers.location, `${SITE}/thanks/?for=story`);
  assert.equal(result.headers['set-cookie'], undefined); assert.equal(f.calls.stories, 1); assert.equal(f.calls.handoffs, 0);
});

test('restricted service accepts only exact trusted capture tuple, hashes random capability, never sends mail', async () => {
  let parameters: unknown[] = [], sql = '', emails = 0;
  const pool = { query: async (query: string, values: unknown[]) => { sql = query; parameters = values;
    return { rows: [{ value: { ok: true, expiresAt: '2026-11-01T12:15:00Z' } }] }; } };
  const service = new PgMhpEventPhonePublic(pool as never, { configured: true, sendEventPhoneLink: async () => { emails++; } }, '+447861935832');
  const result = await service.fromSignup(captured, source, now);
  assert.ok(result); assert.match(result.capability, /^[A-Za-z0-9_-]{43}$/u); assert.equal(result.maxAge, 900);
  assert.match(sql, /mhp_event_phone_from_signup\(\$1,\$2,\$3,\$4,\$5\)/u);
  assert.deepEqual(parameters, [captured.signupId, captured.prospectId, captured.campaign, mhpEventCapabilitySha(result.capability), source]);
  assert.equal(parameters.includes(result.capability), false); assert.equal(emails, 0);
  assert.equal(await service.fromSignup({ ...captured, signupId: 'untrusted' }, source, now), null);
  assert.equal(await service.fromSignup(captured, null, now), null);
});

test('restricted service denies unknown signup, expired returned authority and database errors without losing capture', async () => {
  for (const value of [{ ok: false }, { ok: true, expiresAt: '2026-11-01T11:59:59Z' }, { ok: true, expiresAt: 'invalid' }]) {
    const service = new PgMhpEventPhonePublic({ query: async () => ({ rows: [{ value }] }) } as never, { configured: false, sendEventPhoneLink: async () => {} }, '+447861935832');
    assert.equal(await service.fromSignup(captured, source, now), null);
  }
  const broken = new PgMhpEventPhonePublic({ query: async () => { throw Error('private DB detail'); } } as never, { configured: false, sendEventPhoneLink: async () => {} }, '+447861935832');
  assert.equal(await broken.fromSignup(captured, source, now), null);
});
