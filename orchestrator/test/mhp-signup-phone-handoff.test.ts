import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { createMhpMount } from '../src/mhp/mount.js';
import { PgMhpEventPhonePublic, mhpEventCapabilitySha, MHP_EVENT_PHONE_HINT_COOKIE, mhpEventPhoneHintCookie,
  openMhpEventPhoneHint, sealMhpEventPhoneHint } from '../src/mhp/event-phone-service.js';
import { MhpCommerceError } from '../src/mhp/commerce-service.js';
import { portalCsrfToken } from '../src/portal/session.js';
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
  const calls = { captured: 0, handoffs: 0, stories: 0, choices: [] as { phone: string; consented: boolean }[] };
  const portal = { kind: 'postgres', secure: true, sessionSecret: 'synthetic-signup-phone-secret-at-least32',
    abuseHashSecret: 'synthetic-signup-phone-abuse-secret-at-least32',
    productProfile: MARTIN_HOWARD_PROPERTY_PROFILE, now: () => now, auth: { resolve: async () => null },
    requestContext: () => ({ requestId: '55555555-5555-4555-8555-555555555555', sourceHash: source, requestHash: Buffer.alloc(32, 1) }),
    abuse: { admit: async () => ({ allowed: true }), complete: async () => {} } } as unknown as PostgresPortalDeps;
  const reminders = { senderNumber: '+447861935832', requestLink: async () => {}, open: async (token: string) => token === 'T'.repeat(43) ? { capability: 'C'.repeat(43) } : { reason: 'invalid' as const },
    status: async (cap: string) => cap === 'C'.repeat(43) ? { ok: true as const, campaign: captured.campaign!, firstName: 'New', open: true,
      startsAt: '2026-11-04T19:30:00Z', consentText: 'Optional webinar texts only.', capabilityExpiresAt: '2026-11-01T12:15:00Z', sms: null } : null,
    choose: async (_cap: string, phone: string, consented: boolean) => {
      if (!consented) throw new MhpCommerceError(400, 'Tick the box to request the text reminder.');
      calls.choices.push({ phone, consented });
      return { nonce: 'a'.repeat(26), joinExpiresAt: '2026-11-01T12:10:00Z', alreadyVerified: false };
    }, withdraw: async () => false,
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

const HINT_SECRET = 'synthetic-signup-phone-secret-at-least32';
const CAPABILITY = 'C'.repeat(43);
function cookiesFrom(headers: Record<string,string>): string[] {
  const value: unknown = headers['set-cookie'];
  if (value === undefined) return [];
  assert.ok(typeof value === 'string' || Array.isArray(value));
  return (typeof value === 'string' ? [value] : value).map(String);
}
const hintValue = (headers: Record<string,string>): string => cookiesFrom(headers).find(value => value.startsWith(`${MHP_EVENT_PHONE_HINT_COOKIE}=`))?.split(';')[0]?.split('=')[1] ?? '';
const browserCookies = (hint: string): string => `__Host-mhp_event_phone=${CAPABILITY}; ${MHP_EVENT_PHONE_HINT_COOKIE}=${hint}`;

test('mobile convenience hint is opaque authenticated encryption bound to the capability and at most fifteen minutes', () => {
  const sealed = sealMhpEventPhoneHint(HINT_SECRET,CAPABILITY,'07700 900123',now,3600)!;
  assert.ok(sealed); assert.match(sealed,/^[A-Za-z0-9_-]+$/u);
  assert.doesNotMatch(sealed,/07700900123|447700900123/u);
  assert.equal(Buffer.from(sealed,'base64url').includes(Buffer.from('+447700900123')),false);
  assert.equal(openMhpEventPhoneHint(HINT_SECRET,CAPABILITY,sealed,now),'+447700900123');
  assert.equal(openMhpEventPhoneHint(HINT_SECRET,CAPABILITY,sealed,now+899_999),'+447700900123');
  for(const [secret,cap,value,clock] of [
    [HINT_SECRET,CAPABILITY,sealed,now+900_000], [HINT_SECRET,CAPABILITY,sealed,now-1],
    [HINT_SECRET,'D'.repeat(43),sealed,now], ['different-session-secret-at-least32',CAPABILITY,sealed,now],
    [HINT_SECRET,CAPABILITY,`${sealed[0]==='A'?'B':'A'}${sealed.slice(1)}`,now], [HINT_SECRET,CAPABILITY,sealed.slice(0,20),now],
  ] as const) assert.equal(openMhpEventPhoneHint(secret,cap,value,clock),null);
  for(const phone of ['', 'not-a-phone', '020 7946 0136', '"><script>']) assert.equal(sealMhpEventPhoneHint(HINT_SECRET,CAPABILITY,phone,now,900),null);
  const short = sealMhpEventPhoneHint(HINT_SECRET,CAPABILITY,'07700 900123',now,30)!;
  assert.equal(openMhpEventPhoneHint(HINT_SECRET,CAPABILITY,short,now+30_000),null);
  assert.match(mhpEventPhoneHintCookie(sealed,3600),/Max-Age=900; Secure; HttpOnly; SameSite=Strict$/u);
  assert.doesNotMatch(mhpEventPhoneHintCookie(sealed),/Domain=/u);
});

test('same-browser signup pre-fills an editable number but still requires explicit consent, CSRF and JOIN', async () => {
  const f=signupPhoneFixture();
  const signup=await f.request('POST','/api/mhp/subscribe',{...fields,PHONE:'07700 900123',OPT_IN:''});
  assert.equal(signup.status,303);assert.equal(cookiesFrom(signup.headers).length,2);
  const hint=hintValue(signup.headers);assert.ok(hint);
  assert.equal(signup.headers.location,`${ORIGIN}/webinar/phone-reminders/choose`);
  assert.doesNotMatch(JSON.stringify(signup.headers),/07700|447700900123/u);
  const cookie=browserCookies(hint);
  const chosen=await f.request('GET','/webinar/phone-reminders/choose',{}, {origin:ORIGIN,cookie});
  assert.equal(chosen.status,200);assert.equal(chosen.headers['cache-control'],'no-store');
  assert.match(chosen.body, /name="mobile"[^>]*value="\+447700900123"/u);
  assert.doesNotMatch(chosen.body, /name="mobile"[^>]*(?:readonly|disabled)|name="consent"[^>]*checked/u);
  const csrf=portalCsrfToken(HINT_SECRET,`mhp.event-phone:${CAPABILITY}`);
  const input={csrf,mobile:'07700 900456'};
  assert.equal((await f.request('POST','/webinar/phone-reminders/choose',input,{origin:ORIGIN,cookie})).status,400);
  assert.equal((await f.request('POST','/webinar/phone-reminders/choose',{...input,csrf:'wrong',consent:'yes'},{origin:ORIGIN,cookie})).status,403);
  assert.equal((await f.request('POST','/webinar/phone-reminders/choose',{...input,consent:'yes'},{origin:SITE,cookie})).status,403);
  assert.equal(f.calls.choices.length,0);
  const sent=await f.request('POST','/webinar/phone-reminders/choose',{...input,consent:'yes'},{origin:ORIGIN,cookie});
  assert.equal(sent.status,200);assert.match(sent.body,/Text JOIN|JOIN A{26}/u);
  assert.match(sent.body,/Reply STOP|Texting us proves the number is yours/u);
  assert.deepEqual(f.calls.choices,[{phone:'07700 900456',consented:true}]);
  assert.equal(sent.headers['set-cookie'],mhpEventPhoneHintCookie(null));
});

test('missing, expired, tampered and superseded hints are blank; fallback and email-link routes clear the hint', async () => {
  const f=signupPhoneFixture();
  const old=sealMhpEventPhoneHint(HINT_SECRET,'D'.repeat(43),'07700 900123',now,900)!;
  const expired=sealMhpEventPhoneHint(HINT_SECRET,CAPABILITY,'07700 900123',now-900_000,900)!;
  for(const hint of ['',old,expired,'tampered']){
    const page=await f.request('GET','/webinar/phone-reminders/choose',{}, {origin:ORIGIN,cookie:browserCookies(hint)});
    assert.equal(page.status,200);assert.match(page.body,/name="mobile"[^>]*value=""/u);
    if(hint)assert.equal(page.headers['set-cookie'],mhpEventPhoneHintCookie(null));
  }
  const current=sealMhpEventPhoneHint(HINT_SECRET,CAPABILITY,'07700 900123',now,900)!;
  for(const phone of ['', 'bad phone']){
    const signup=await f.request('POST','/api/mhp/subscribe',{...fields,PHONE:phone},{cookie:browserCookies(current)});
    assert.ok(cookiesFrom(signup.headers).includes(mhpEventPhoneHintCookie(null)));
  }
  for(const mode of ['denied','throws','off'] as const){
    const fallback=await signupPhoneFixture(mode).request('POST','/api/mhp/subscribe',{...fields,PHONE:'07700 900123'},{cookie:browserCookies(current)});
    assert.equal(fallback.headers.location,`${SITE}/thanks/?for=webinar`);
    assert.equal(fallback.headers['set-cookie'],mhpEventPhoneHintCookie(null));
  }
  const email=await f.request('GET',`/webinar/phone-reminders/open?t=${'T'.repeat(43)}`,{}, {origin:ORIGIN,cookie:browserCookies(current)});
  assert.equal(email.status,200);assert.equal(email.headers['set-cookie'],mhpEventPhoneHintCookie(null));
  const opened=await f.request('POST','/webinar/phone-reminders/open',{t:'T'.repeat(43)}, {origin:ORIGIN,cookie:browserCookies(current)});
  assert.equal(opened.status,303);assert.ok(cookiesFrom(opened.headers).includes(mhpEventPhoneHintCookie(null)));
});
