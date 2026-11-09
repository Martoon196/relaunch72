/**
 * Native webinars over HTTP: the real portal and attendee routers on a
 * disposable PostgreSQL with the actual r72_content_command / r72_crm_command
 * roles. Cloudflare and Postmark are recording fakes at the HTTP boundary.
 *
 * Proves: menu entry and management for a permitted owner; a second brand on the
 * same implementation with isolated data; CSRF and same-origin enforcement;
 * host credentials never reach attendee HTML or JSON; access cookies are bound
 * to one webinar; Q&A and CTA controls; signed, replay-safe Stream webhooks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { PROFILES, WEBHOOK_SECRET, loginRole, seedBrand, startWebinarHttpHarness, syntheticConfig } from './webinar-harness.js';
import { portalCsrfToken } from '../../src/portal/session.js';

const skip = testDatabaseSkipReason();

class Browser {
  private readonly jar = new Map<string, string>();
  constructor(private readonly origin: string) {}
  async go(path: string, init: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body: string | undefined;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
    if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json); }
    if (body !== undefined && !('origin' in headers)) headers.origin = this.origin;
    const res = await fetch(new URL(path, this.origin), { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      const [k, v] = [pair!.slice(0, i), pair!.slice(i + 1)];
      if (v === '' || /Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return { status: res.status, location: res.headers.get('location'), setCookie: res.headers.getSetCookie(), headers: res.headers, text: await res.text() };
  }
  cookies() { return new Map(this.jar); }
}

const SECRETS = /synthetic-api-token|synthetic-postmark|key-[0-9a-f]{32}|rtmps:\/\/|srt:\/\/|streamKey|passphrase|"pp"/;

test('0144 native webinars over HTTP: menu, management, brand isolation, attendee room, Q&A, CTA and webhooks', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const content = await loginRole(admin, 'r72_content_command');
  const crmPool = await loginRole(admin, 'r72_crm_command');
  let harness: Awaited<ReturnType<typeof startWebinarHttpHarness>> | undefined;
  try {
    const alpha = await seedBrand(admin, 'Alpha', '#ed9c24');
    const bravo = await seedBrand(admin, 'Bravo', '#00e5cc');
    let clock = Date.parse('2026-11-20T12:00:00Z');
    harness = await startWebinarHttpHarness({
      contentPool: content, crmPool,
      users: {
        alpha: { identity: alpha.owner, profile: PROFILES.relaunch72 },
        'alpha-viewer': { identity: alpha.viewer, profile: PROFILES.relaunch72 },
        bravo: { identity: bravo.owner, profile: PROFILES.propertyPredator },
      },
      configFor: (origin) => syntheticConfig(alpha.ws, bravo.ws, origin),
      now: () => clock,
    });
    const h = harness;
    const csrf = (token: string) => portalCsrfToken(h.sessionSecret, token);

    // ── signed out: login redirect, never a page ──
    const anon = new Browser(h.origin);
    assert.deepEqual([(await anon.go('/portal/webinars')).status, (await anon.go('/portal/webinars')).location], [303, '/portal/login']);

    // ── owner: menu entry + list ──
    const owner = new Browser(h.origin);
    await owner.go('/preview/sign-in?as=alpha');
    const list = await owner.go('/portal/webinars');
    assert.equal(list.status, 200);
    assert.match(list.text, /<a class="nav-item" href="\/portal\/webinars" aria-current="page">.*Webinars<\/span><\/a>/s, 'Webinars is the current menu item');
    assert.match(list.text, /href="\/portal\/webinars\/new"/);
    assert.match(list.headers.get('content-security-policy') ?? '', /script-src 'self'/);

    // ── create: CSRF required ──
    const form = {
      kind: 'live', title: 'Alpha investor briefing', summary: 'Synthetic fixture.', presenterName: 'Sam Host', presenterTitle: 'Founder',
      timezone: 'Europe/London', startsLocal: '2026-11-25T19:00', durationMinutes: '60', capacity: '',
      reminders: '1440,60', replayEnabled: '1', replayDays: '14', roomOpens: '15', questionsEnabled: '1', questionsModerated: '1',
      ctaLabel: 'Book a call', ctaUrl: 'https://alpha.example.test/book', ctaMode: 'manual', serviceNotice: 'We use your details to run this webinar.',
    };
    assert.equal((await owner.go('/portal/webinars', { form })).status, 403, 'no CSRF token');
    assert.equal((await owner.go('/portal/webinars', { form: { ...form, _csrf: csrf(alpha.owner.sessionToken) }, headers: { origin: 'https://evil.example' } })).status, 403, 'cross-site');
    const created = await owner.go('/portal/webinars', { form: { ...form, _csrf: csrf(alpha.owner.sessionToken) } });
    assert.equal(created.status, 303);
    const id = /\/portal\/webinars\/([0-9a-f-]{36})\?/.exec(created.location ?? '')?.[1];
    assert.ok(id, created.location ?? 'no location');
    const detail = await owner.go(created.location!);
    assert.match(detail.text, /Webinar created as a private draft\./);
    assert.match(detail.text, /Alpha investor briefing/);
    assert.doesNotMatch(detail.text, /Public registration link/, 'a draft shows no public link');
    const publicKey = (await admin.query<{ public_key: string }>('SELECT public_key FROM app.webinar_events WHERE id = $1', [id])).rows[0]!.public_key;
    assert.equal((await anon.go(`/w/${publicKey}`)).status, 404, 'a draft is not public');

    // ── viewer and another brand cannot manage it ──
    const viewer = new Browser(h.origin);
    await viewer.go('/preview/sign-in?as=alpha-viewer');
    const viewerList = await viewer.go('/portal/webinars');
    assert.equal(viewerList.status, 403);
    assert.doesNotMatch(viewerList.text, /Alpha investor briefing/);
    const other = new Browser(h.origin);
    await other.go('/preview/sign-in?as=bravo');
    const otherList = await other.go('/portal/webinars');
    assert.equal(otherList.status, 200);
    assert.match(otherList.text, /PropertyPredator/, 'the second brand renders in its own shell');
    assert.doesNotMatch(otherList.text, /Alpha investor briefing/);
    const peek = await other.go(`/portal/webinars/${id}`);
    assert.equal(peek.status, 303);
    assert.doesNotMatch((await other.go(peek.location!)).text, /Alpha investor briefing/);
    assert.equal((await other.go(`/portal/webinars/${id}/status`, { form: { action: 'publish', _csrf: csrf(bravo.owner.sessionToken) } })).status, 303);
    assert.equal((await anon.go(`/w/${publicKey}`)).status, 404, "another brand's publish attempt changed nothing");

    // ── draft is not public; publishing makes it so ──
    assert.equal((await owner.go(`/portal/webinars/${id}/status`, { form: { action: 'publish', _csrf: csrf(alpha.owner.sessionToken) } })).status, 303);
    const reg = await anon.go(`/w/${publicKey}?utm_source=newsletter`);
    assert.equal(reg.status, 200);
    assert.match(reg.text, /Alpha Brand/);
    assert.match(reg.text, /name="utm_source" value="newsletter"/);
    assert.doesNotMatch(reg.text, SECRETS);

    // ── live input: credentials only on an explicit owner reveal ──
    assert.equal((await owner.go(`/portal/webinars/${id}/live-input`, { form: { _csrf: csrf(alpha.owner.sessionToken) } })).status, 303);
    const videoTab = await owner.go(`/portal/webinars/${id}/video`);
    assert.match(videoTab.text, /RTMPS/);
    assert.doesNotMatch(videoTab.text, /key-[0-9a-f]{32}/, 'the stream key is not printed by default');
    assert.match(videoTab.text, /WHIP|browser/i, 'browser broadcasting is explained, not offered');
    const reveal = await owner.go(`/portal/webinars/${id}/live-input/credentials`, { form: { _csrf: csrf(alpha.owner.sessionToken) } });
    assert.match(reveal.text, /key-[0-9a-f]{32}/);
    assert.equal(reveal.headers.get('cache-control'), 'no-store');
    assert.equal((await viewer.go(`/portal/webinars/${id}/live-input/credentials`, { form: { _csrf: csrf(alpha.viewer.sessionToken) } })).status, 303, 'viewer refused');

    // ── attendee registration: same-origin only, HttpOnly cookie, no token in the URL ──
    const ann = new Browser(h.origin);
    const regForm = { name: 'Ann', email: 'allowed@example.test', utm_source: 'newsletter' };
    assert.equal((await ann.go(`/w/${publicKey}/register`, { form: regForm, headers: { origin: 'https://evil.example' } })).status, 403);
    const registered = await ann.go(`/w/${publicKey}/register`, { form: regForm });
    assert.equal(registered.status, 303);
    assert.equal(registered.location, `/w/${publicKey}/registered`);
    assert.match(registered.setCookie.join('\n'), new RegExp(`Path=/w/${publicKey}; HttpOnly; SameSite=Lax`));
    const repeat = await new Browser(h.origin).go(`/w/${publicKey}/register`, { form: regForm });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.setCookie.length, 0, 'typing a registered address never grants that attendee access');
    assert.match(repeat.text, /already registered/);

    // ── room: honest waiting state, nothing secret ──
    const room = await ann.go(`/w/${publicKey}/room`);
    assert.equal(room.status, 200);
    assert.doesNotMatch(room.text, SECRETS);
    let state = JSON.parse((await ann.go(`/w/${publicKey}/state`)).text);
    assert.deepEqual([state.state, state.hlsUrl, state.cta], ['not_started', null, null]);
    assert.equal((await anon.go(`/w/${publicKey}/state`)).status, 401);
    assert.equal((await anon.go(`/w/${publicKey}/room`)).status, 401);

    // A cookie for one webinar opens nothing else: create Bravo's webinar and present Ann's cookie there.
    const bravoCreated = await other.go('/portal/webinars', { form: { ...form, title: 'Bravo briefing', _csrf: csrf(bravo.owner.sessionToken) } });
    const bravoId = /\/portal\/webinars\/([0-9a-f-]{36})\?/.exec(bravoCreated.location ?? '')![1]!;
    await other.go(`/portal/webinars/${bravoId}/status`, { form: { action: 'publish', _csrf: csrf(bravo.owner.sessionToken) } });
    const bravoKey = /\/w\/([a-z0-9-]+)/.exec((await other.go(`/portal/webinars/${bravoId}`)).text)?.[1];
    assert.ok(bravoKey, 'a published webinar shows its public link');
    const annCookie = [...ann.cookies()].find(([k]) => k.startsWith('wb_'))!;
    const replayed = await fetch(new URL(`/w/${bravoKey}/state`, h.origin), { headers: { cookie: `${(await import('../../src/webinars/access.js')).accessCookieName(bravoKey)}=${annCookie[1]}` } });
    assert.equal(replayed.status, 401, "Ann's token does not open Bravo's webinar even under Bravo's cookie name");

    // ── go live: rehearsal first, then the owner opens the session ──
    clock = Date.parse('2026-11-25T18:55:00Z');
    const liveUid = [...h.cf.liveInputs.keys()][0]!;
    h.cf.liveInputs.get(liveUid)!.status = 'connected';
    const hostState = JSON.parse((await owner.go(`/portal/webinars/${id}/host/state`)).text);
    assert.equal(hostState.roomState, 'host_connecting');
    assert.equal(JSON.parse((await ann.go(`/w/${publicKey}/state`)).text).state, 'host_connecting');
    clock = Date.parse('2026-11-25T19:00:00Z');
    assert.equal((await owner.go(`/portal/webinars/${id}/session`, { form: { action: 'start', _csrf: csrf(alpha.owner.sessionToken) } })).status, 303);
    state = JSON.parse((await ann.go(`/w/${publicKey}/state`)).text);
    assert.equal(state.state, 'live');
    assert.match(state.hlsUrl, /^https:\/\/customer-synthetic01\.cloudflarestream\.com\/[\w-]+\.[\w-]+\.[\w-]+\/manifest\/video\.m3u8$/);
    assert.ok(!state.hlsUrl.includes(liveUid), 'playback is by signed token, not the raw live input id');
    assert.doesNotMatch(JSON.stringify(state), SECRETS);
    assert.equal(state.cta, null, 'a manual CTA is withheld until revealed');

    // ── signals: a page load is not attendance ──
    assert.equal(JSON.parse((await ann.go(`/w/${publicKey}/signal`, { json: { kind: 'player_started', mode: 'live' } })).text).recorded, true);
    assert.equal((await ann.go(`/w/${publicKey}/signal`, { json: { kind: 'player_started', mode: 'live' }, headers: { origin: 'https://evil.example' } })).status, 403);

    // ── Q&A: moderated ──
    assert.equal((await ann.go(`/w/${publicKey}/questions`, { json: { body: 'Is the replay available?' } })).status, 200);
    const questionsTab = await owner.go(`/portal/webinars/${id}/questions`);
    const qid = /\/questions\/([0-9a-f-]{36})"/.exec(questionsTab.text)?.[1];
    assert.ok(qid);
    const bob = new Browser(h.origin);
    await bob.go(`/w/${publicKey}/register`, { form: { name: 'Bob', email: 'bob@example.test' } });
    assert.deepEqual(JSON.parse((await bob.go(`/w/${publicKey}/questions`)).text).questions, [], 'pending questions stay private');
    await owner.go(`/portal/webinars/${id}/questions/${qid}`, { form: { action: 'answer', answer: 'Yes, for 14 days.', _csrf: csrf(alpha.owner.sessionToken) } });
    assert.deepEqual(JSON.parse((await bob.go(`/w/${publicKey}/questions`)).text).questions.map((q: { body: string; answer: string }) => [q.body, q.answer]),
      [['Is the replay available?', 'Yes, for 14 days.']]);

    // ── CTA: host reveal ──
    await owner.go(`/portal/webinars/${id}/cta`, { form: { action: 'reveal', _csrf: csrf(alpha.owner.sessionToken) } });
    state = JSON.parse((await ann.go(`/w/${publicKey}/state`)).text);
    assert.deepEqual(state.cta, { label: 'Book a call', url: 'https://alpha.example.test/book', body: '', atSeconds: null, visible: true });
    assert.equal(JSON.parse((await ann.go(`/w/${publicKey}/signal`, { json: { kind: 'cta_clicked', mode: 'live' } })).text).recorded, true);

    // ── end → recording via a signed, replay-safe webhook → replay ──
    clock = Date.parse('2026-11-25T20:01:00Z');
    await owner.go(`/portal/webinars/${id}/session`, { form: { action: 'end', _csrf: csrf(alpha.owner.sessionToken) } });
    assert.equal(JSON.parse((await ann.go(`/w/${publicKey}/state`)).text).state, 'processing');
    const rec = randomUUID().replace(/-/g, '');
    const payload = Buffer.from(JSON.stringify({ uid: rec, liveInput: liveUid, readyToStream: true, status: { state: 'ready' }, duration: 3600 }));
    const time = String(Math.floor(clock / 1000));
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${time}.`).update(payload).digest('hex');
    const hook = (signature: string) => fetch(new URL('/api/webinars/stream-webhook', h.origin), { method: 'POST', headers: { 'webhook-signature': signature, 'content-type': 'application/json' }, body: payload });
    assert.equal((await hook(`time=${time},sig1=${'0'.repeat(64)}`)).status, 401);
    const first = await hook(`time=${time},sig1=${sig}`);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { outcome: string }).outcome, 'applied');
    assert.equal((await (await hook(`time=${time},sig1=${sig}`)).json() as { outcome: string }).outcome, 'replayed');
    state = JSON.parse((await ann.go(`/w/${publicKey}/state`)).text);
    assert.deepEqual([state.state, state.seekable], ['replay', true]);

    // ── results keep provenance apart ──
    const results = await owner.go(`/portal/webinars/${id}/results`);
    assert.equal(results.status, 200);
    assert.match(results.text, /Opened the room/);
    assert.match(results.text, /Started the player/);
    const csv = await owner.go(`/portal/webinars/${id}/people.csv`);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.text, /Opened room \(page visit\),Started player/);
    assert.equal((await other.go(`/portal/webinars/${id}/people.csv`)).status, 303, "another brand cannot export Alpha's registrants");
  } finally {
    await harness?.close();
    await content.end();
    await crmPool.end();
    await admin.end();
  }
});
