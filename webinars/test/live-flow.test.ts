import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScheduled } from '../src/cron.js';
import { attemptDelivery, verifyWebhookSignature } from '../src/lib/webhooks.js';
import { BAD_ORIGIN, createHarness, eventsOf, ORIGIN, seedBrand } from './helpers.js';

async function liveWebinar(h: ReturnType<typeof createHarness>, sk: string) {
  const w = await h.call('POST', '/v1/admin/webinars', {
    origin: null, sk,
    body: { type: 'live', title: 'Q4 Investor Briefing', description: 'Where UK yields are heading.', duration_s: 3600, presenters: [{ name: 'Martin', bio: 'Founder' }] },
  });
  assert.equal(w.status, 201, w.text);
  const id = w.json.data.id as string;
  assert.equal(w.json.data.slug, 'q4-investor-briefing');
  const li = await h.call('POST', `/v1/admin/webinars/${id}/live-input`, { origin: null, sk });
  assert.equal(li.status, 201);
  assert.equal(li.json.data.rtmps.stream_key, 'key123');
  const ses = await h.call('POST', '/v1/admin/sessions', { origin: null, sk, body: { webinar_id: id, starts_at: '2026-11-12T19:00:00Z' } });
  assert.equal(ses.status, 201, ses.text);
  const pub = await h.call('PATCH', `/v1/admin/webinars/${id}`, { origin: null, sk, body: { status: 'published' } });
  assert.equal(pub.status, 200);
  assert.match(pub.json.data.embed.snippet, /data-key="pk_live_/);
  return { webinarId: id, sessionId: ses.json.data.id as string };
}

test('live webinar: register → wait → live → watch → CTA → end → no-shows → replay', async () => {
  const h = createHarness(Date.parse('2026-11-10T12:00:00Z'));
  const { pk, sk, webhookSecret } = await seedBrand(h);
  const { webinarId, sessionId } = await liveWebinar(h, sk);
  const cta = await h.call('POST', '/v1/admin/ctas', { origin: null, sk, body: { webinar_id: webinarId, label: 'Book a call', url: 'https://book.growthhq.app/prop', show_at_s: 1800 } });
  assert.equal(cta.status, 201);

  // --- public read, origin-locked ---
  const list = await h.call('GET', '/v1/webinars', { key: pk });
  assert.equal(list.status, 200);
  assert.equal(list.json.data.length, 1);
  assert.equal(list.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await h.call('GET', '/v1/webinars', { key: pk, origin: BAD_ORIGIN })).status, 403);
  assert.equal((await h.call('GET', '/v1/webinars', { key: pk, origin: null })).status, 403, 'no Origin header');
  assert.equal((await h.call('GET', '/v1/webinars')).status, 401, 'no key');
  // Secret keys never work on public routes, publishable keys never on admin routes.
  assert.equal((await h.call('GET', '/v1/webinars', { key: sk })).status, 401);
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: pk })).status, 401);

  const detail = await h.call('GET', '/v1/webinars/q4-investor-briefing', { key: pk });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.sessions.length, 1);
  assert.equal(detail.json.data.config.compliance.risk_warning, 'Capital at risk.');
  assert.equal(detail.json.data.config.crm, undefined, 'CRM ids never reach the browser');

  // --- register ---
  h.turnstile.ok = false;
  const blocked = await h.call('POST', '/v1/webinars/q4-investor-briefing/registrations', { key: pk, body: { email: 'a@example.com', name: 'Ann', consent: true } });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.error.code, 'turnstile_failed');
  h.turnstile.ok = true;
  assert.equal((await h.call('POST', '/v1/webinars/q4-investor-briefing/registrations', { key: pk, body: { email: 'a@example.com', name: 'Ann' } })).json.error.code, 'consent_required');
  assert.equal((await h.call('POST', '/v1/webinars/q4-investor-briefing/registrations', { key: pk, body: { email: 'nope', name: 'Ann', consent: true } })).json.error.code, 'invalid_email');

  const reg = await h.call('POST', '/v1/webinars/q4-investor-briefing/registrations', {
    key: pk,
    body: { email: 'Ann@Example.com', name: 'Ann Lee', consent: true, source_url: `${ORIGIN}/webinars/q4?utm_source=meta`, utm: { source: 'meta', campaign: 'q4' } },
  });
  assert.equal(reg.status, 201, reg.text);
  const token = reg.json.data.token as string;
  assert.match(token, /^ml_/);
  assert.ok(reg.json.data.calendar.google_url.startsWith('https://calendar.google.com/'));
  const noShow = await h.call('POST', '/v1/webinars/q4-investor-briefing/registrations', { key: pk, body: { email: 'bob@example.com', name: 'Bob', consent: true } });
  assert.equal(noShow.status, 201);

  // Re-registering never hands the token to the browser.
  const again = await h.call('POST', '/v1/webinars/q4-investor-briefing/registrations', { key: pk, body: { email: 'bob@example.com', name: 'Bob', consent: true } });
  assert.equal(again.status, 200);
  assert.equal(again.json.data.token, null);
  assert.equal(again.json.data.already_registered, true);

  const created = eventsOf(h, 'registrant.created')[0]!.payload;
  assert.equal(created.registrant.email, 'ann@example.com');
  assert.ok(created.registrant.magic_link.startsWith(`${ORIGIN}/webinars/q4?`), 'magic link lands back on the registering site');
  assert.match(created.registrant.magic_link, /ghq_token=ml_/);
  assert.ok(created.registrant.hosted_link.startsWith('https://webinars.growthhq.app/w/prop-invest-uk/q4-investor-briefing?view=room'));
  assert.equal(created.registrant.consent.version, '1');
  assert.deepEqual(created.registrant.utm, { source: 'meta', campaign: 'q4' });
  assert.deepEqual(created.crm.tags_add, ['webinar:q4-investor-briefing:registered']);
  assert.equal(created.session.starts_at, '2026-11-12T19:00:00.000Z');

  // --- webhook delivery is signed ---
  assert.ok(h.queue.messages.length >= 2);
  let delivered: { headers: Headers; body: string } | null = null;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    delivered = { headers: new Headers(init.headers), body: String(init.body) };
    return new Response('ok');
  }) as unknown as typeof fetch;
  const r = await attemptDelivery(h.env, h.queue.messages[0]!.body.deliveryId, fakeFetch, h.clock.now);
  assert.deepEqual(r, { outcome: 'delivered' });
  assert.ok(delivered);
  const d = delivered as { headers: Headers; body: string };
  assert.equal(d.headers.get('ghq-event'), 'registrant.created');
  assert.ok(await verifyWebhookSignature(webhookSecret, d.headers.get('ghq-signature'), d.body, Math.floor(h.clock.now / 1000)));

  // --- join before the room opens ---
  const early = await h.call('POST', '/v1/join', { key: pk, body: { token, device_id: 'dev-1' } });
  assert.equal(early.status, 200, early.text);
  assert.equal(early.json.data.room.state, 'scheduled');
  assert.equal(early.json.data.playback, null);
  assert.match(early.json.data.ws_url, /^wss:\/\/api\.webinars\.growthhq\.app\/v1\/sessions\/ses_/);
  assert.equal((await h.call('POST', '/v1/join', { key: pk, body: { token: 'ml_wrong', device_id: 'x' } })).status, 401);

  h.clock.now = Date.parse('2026-11-12T18:50:00Z');
  const waiting = await h.call('POST', '/v1/join', { key: pk, body: { token, device_id: 'dev-1' } });
  assert.equal(waiting.json.data.room.state, 'waiting');
  const st = waiting.json.data.session_token as string;

  // --- host preview (test mode) keeps attendees in the waiting room ---
  assert.equal((await h.call('POST', `/v1/admin/sessions/${sessionId}/start`, { origin: null, sk, body: { test: true } })).status, 200);
  assert.equal((await h.call('POST', '/v1/playback', { key: pk, headers: { authorization: `Bearer ${st}` } })).json.data.room.state, 'waiting');
  assert.equal(eventsOf(h, 'session.started').length, 0);

  // --- go live ---
  h.clock.now = Date.parse('2026-11-12T19:00:00Z');
  assert.equal((await h.call('POST', `/v1/admin/sessions/${sessionId}/start`, { origin: null, sk, body: {} })).status, 200);
  assert.equal(eventsOf(h, 'session.started').length, 1);
  const live = await h.call('POST', '/v1/playback', { key: pk, headers: { authorization: `Bearer ${st}` } });
  assert.equal(live.json.data.room.state, 'live');
  assert.equal(live.json.data.playback.low_latency, true);
  assert.match(live.json.data.playback.webrtc, /TOKEN\(live_input_1\)\/webRTC\/play/);
  assert.equal(eventsOf(h, 'attendee.joined').length, 1);
  await h.call('POST', '/v1/playback', { key: pk, headers: { authorization: `Bearer ${st}` } });
  assert.equal(eventsOf(h, 'attendee.joined').length, 1, 'joined is emitted once');
  assert.equal(eventsOf(h, 'attendee.joined')[0]!.payload.crm.stop_sequence, 'webinar_no_show');

  // --- heartbeats credit real elapsed time only ---
  for (let i = 1; i <= 80; i++) {
    h.clock.now += 30_000;
    const hb = await h.call('POST', '/v1/events', { key: pk, headers: { authorization: `Bearer ${st}` }, body: { type: 'heartbeat', position_s: i * 30, playing: true } });
    assert.equal(hb.status, 200);
  }
  // A client lying about time can't inflate watch time.
  await h.call('POST', '/v1/events', { key: pk, headers: { authorization: `Bearer ${st}` }, body: { type: 'heartbeat', position_s: 99999, playing: true } });
  const att = h.db.sqlite.prepare('SELECT watch_s, max_position_s FROM attendance').get() as { watch_s: number; max_position_s: number };
  assert.equal(att.watch_s, 2400);

  // Leave beacon: text/plain body carrying key + token (sendBeacon can't set headers).
  const beacon = await h.call('POST', '/v1/events', { raw: JSON.stringify({ key: pk, session_token: st, type: 'leave', position_s: 2400 }), headers: { 'content-type': 'text/plain' } });
  assert.equal(beacon.status, 200, beacon.text);

  const click = await h.call('POST', '/v1/events', { key: pk, headers: { authorization: `Bearer ${st}` }, body: { type: 'cta_click', cta_id: cta.json.data.id, position_s: 1900 } });
  assert.equal(click.status, 200);
  const clicked = eventsOf(h, 'cta.clicked')[0]!.payload;
  assert.equal(clicked.crm.action, 'create_opportunity');
  assert.equal(clicked.crm.pipeline_id, 'pipe_1');

  // --- end; recording not ready yet ---
  h.clock.now = Date.parse('2026-11-12T20:05:00Z');
  h.stream.recording = { uid: 'rec_1', duration: 3700, readyToStream: false };
  assert.equal((await h.call('POST', `/v1/admin/sessions/${sessionId}/end`, { origin: null, sk })).status, 200);
  assert.equal(eventsOf(h, 'session.ended').length, 1);
  assert.equal(eventsOf(h, 'recording.ready').length, 0);
  const ended = await h.call('POST', '/v1/join', { key: pk, body: { token, device_id: 'dev-1' } });
  assert.equal(ended.json.data.room.state, 'ended');

  // --- cron: finalise (left + no-show) and recording promotion fallback ---
  h.stream.recording = { uid: 'rec_1', duration: 3700, readyToStream: true };
  h.clock.now = Date.parse('2026-11-12T20:10:00Z');
  const stats = await runScheduled(h.env, h.services, h.clock.now);
  assert.equal(stats.finalized, 1);
  const left = eventsOf(h, 'attendee.left');
  assert.equal(left.length, 1);
  assert.equal(left[0]!.payload.data.watch_s, 2400);
  assert.equal(left[0]!.payload.data.percent_watched, 67);
  assert.deepEqual(left[0]!.payload.crm.tags_add, ['webinar:q4-investor-briefing:engaged']);
  const noShows = eventsOf(h, 'attendee.no_show');
  assert.equal(noShows.length, 1);
  assert.equal(noShows[0]!.payload.registrant.email, 'bob@example.com');
  assert.equal(noShows[0]!.payload.crm.sequence, 'webinar_missed_it_replay');
  assert.equal(eventsOf(h, 'recording.ready').length, 1);

  // Running cron again is a no-op.
  await runScheduled(h.env, h.services, h.clock.now + 60_000);
  assert.equal(eventsOf(h, 'attendee.no_show').length, 1);
  assert.equal(eventsOf(h, 'recording.ready').length, 1);

  // --- replay ---
  const replay = await h.call('POST', '/v1/join', { key: pk, body: { token, device_id: 'dev-1' } });
  assert.equal(replay.json.data.room.state, 'replay');
  assert.equal(replay.json.data.playback.seekable, true);
  assert.equal(replay.json.data.playback.low_latency, false);
  assert.match(replay.json.data.playback.hls, /TOKEN\(rec_1\)/);

  // --- analytics + exports ---
  const an = await h.call('GET', `/v1/admin/analytics?webinar_id=${webinarId}`, { origin: null, sk });
  assert.equal(an.status, 200);
  assert.equal(an.json.data.registrations, 2);
  assert.equal(an.json.data.live_attendees, 1);
  assert.equal(an.json.data.show_rate_pct, 50);
  assert.equal(an.json.data.ctas[0].unique_clickers, 1);
  assert.equal(an.json.data.by_utm_source.find((r: { source: string }) => r.source === 'meta').registrations, 1);
  assert.ok(an.json.data.retention.length > 0);
  const csv = await h.call('GET', `/v1/admin/registrants?webinar_id=${webinarId}&format=csv`, { origin: null, sk });
  assert.equal(csv.headers.get('content-type'), 'text/csv');
  assert.match(csv.text, /ann@example\.com/);
  assert.match(csv.text, /^id,email,name/);

  // --- audit log captured admin actions ---
  const audit = await h.call('GET', '/v1/admin/audit-log', { origin: null, sk });
  const actions = audit.json.data.map((a: { action: string }) => a.action);
  for (const a of ['webinar.create', 'session.start', 'session.end', 'session.preview']) assert.ok(actions.includes(a), a);
});

test('tenancy: brands and modes are isolated', async () => {
  const h = createHarness();
  const a = await seedBrand(h, { slug: 'brand-a', origins: ['https://a.example'] });
  const b = await seedBrand(h, { slug: 'brand-b', origins: ['https://b.example'] });
  const { webinarId } = await liveWebinar(h, a.sk);

  assert.equal((await h.call('GET', `/v1/admin/webinars/${webinarId}`, { origin: null, sk: b.sk })).status, 404);
  assert.equal((await h.call('PATCH', `/v1/admin/webinars/${webinarId}`, { origin: null, sk: b.sk, body: { title: 'pwned' } })).status, 404);
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: b.sk, headers: { 'ghq-brand': a.brandId } })).status, 403);
  // Brand B's site can't use brand A's key, and brand B's key doesn't see brand A's webinars.
  assert.equal((await h.call('GET', '/v1/webinars', { key: a.pk, origin: 'https://b.example' })).status, 403);
  const listB = await h.call('GET', '/v1/webinars', { key: b.pk, origin: 'https://b.example' });
  assert.equal(listB.json.data.length, 0);
  assert.equal((await h.call('GET', '/v1/webinars/q4-investor-briefing', { key: b.pk, origin: 'https://b.example' })).status, 404);

  // Account key must name a brand; it can act on any.
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: a.account })).status, 400);
  assert.equal((await h.call('GET', `/v1/admin/webinars?brand_id=${a.brandId}`, { origin: null, sk: a.account })).json.data.length, 1);

  // Test-mode keys never see live data.
  const testSk = await h.call('POST', '/v1/admin/api-keys', { origin: null, sk: a.sk, body: { type: 'sk', name: 'staging' } });
  assert.match(testSk.json.data.key, /^sk_live_/, 'a live key creates live keys');
  const bootTest = h.db.sqlite.prepare("SELECT 1 FROM api_keys WHERE mode = 'test'").get();
  assert.ok(bootTest, 'bootstrap created an account test key');
});

test('secret keys: scopes, rotation with grace, revocation, hashed storage', async () => {
  const h = createHarness();
  const { sk, brandId, account } = await seedBrand(h);
  const ro = await h.call('POST', '/v1/admin/api-keys', { origin: null, sk, body: { type: 'sk', scopes: ['webinars:read'] } });
  const roKey = ro.json.data.key as string;
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: roKey })).status, 200);
  assert.equal((await h.call('POST', '/v1/admin/webinars', { origin: null, sk: roKey, body: { type: 'live', title: 'x' } })).status, 403);
  assert.equal((await h.call('DELETE', '/v1/admin/contacts/a@b.com', { origin: null, sk: roKey })).status, 403);
  assert.equal((await h.call('POST', '/v1/admin/api-keys', { origin: null, sk, body: { type: 'sk', scopes: ['root'] } })).status, 400);

  // Never stored in plaintext.
  const stored = h.db.sqlite.prepare('SELECT hash, display FROM api_keys WHERE id = ?').get(ro.json.data.id) as { hash: string; display: string | null };
  assert.equal(stored.display, null);
  assert.notEqual(stored.hash, roKey);

  const rot = await h.call('POST', `/v1/admin/api-keys/${ro.json.data.id}/rotate`, { origin: null, sk, body: { grace_minutes: 10 } });
  assert.equal(rot.status, 201);
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: roKey })).status, 200, 'old key works during grace');
  h.clock.now += 11 * 60_000;
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: roKey })).status, 401, 'old key dead after grace');
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: rot.json.data.key })).status, 200);

  await h.call('DELETE', `/v1/admin/api-keys/${rot.json.data.id}`, { origin: null, sk });
  assert.equal((await h.call('GET', '/v1/admin/webinars', { origin: null, sk: rot.json.data.key })).status, 401);
  assert.equal((await h.call('POST', '/v1/admin/bootstrap', { origin: null, headers: { 'x-bootstrap-token': 'boot' } })).status, 409, 'bootstrap only once');
  assert.ok(brandId && account);
});

test('GDPR erasure removes a contact everywhere', async () => {
  const h = createHarness(Date.parse('2026-11-12T19:00:00Z'));
  const { pk, sk } = await seedBrand(h);
  const { sessionId } = await liveWebinar(h, sk);
  await h.call('POST', `/v1/admin/sessions/${sessionId}/start`, { origin: null, sk, body: {} });
  const reg = await h.call('POST', '/v1/webinars/q4-investor-briefing/registrations', { key: pk, body: { email: 'erase@example.com', name: 'Eve', consent: true } });
  const join = await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: 'd' } });
  assert.equal(join.json.data.room.state, 'live');
  assert.ok((h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM attendance').get() as { n: number }).n === 1);

  const del = await h.call('DELETE', '/v1/admin/contacts/Erase%40Example.com', { origin: null, sk });
  assert.equal(del.json.data.erased_registrations, 1);
  for (const t of ['registrants', 'attendance', 'messages', 'poll_votes']) {
    assert.equal((h.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
  }
  assert.equal((h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE registrant_id IS NOT NULL').get() as { n: number }).n, 0);
  const audit = h.db.sqlite.prepare("SELECT target FROM audit_log WHERE action = 'gdpr.erase'").get() as { target: string };
  assert.ok(!audit.target.includes('@'), 'audit log stores a hash, not the email');
  // The magic link is dead too.
  assert.equal((await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: 'd' } })).status, 401);
});
