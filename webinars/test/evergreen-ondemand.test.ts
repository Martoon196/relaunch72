import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScheduled } from '../src/cron.js';
import { attemptDelivery, RETRY_SCHEDULE_S } from '../src/lib/webhooks.js';
import { createHarness, eventsOf, seedBrand } from './helpers.js';

test('evergreen: slot picker → late join lands mid-stream, labelled scheduled replay, no seeking', async () => {
  const h = createHarness(Date.parse('2026-11-09T10:00:00Z')); // Monday
  const { pk, sk } = await seedBrand(h);
  const w = await h.call('POST', '/v1/admin/webinars', { origin: null, sk, body: { type: 'evergreen', title: 'Passive Income Masterclass', duration_s: 2700, video_uid: 'vid_evergreen' } });
  assert.equal(w.status, 201);
  const id = w.json.data.id;
  const rule = await h.call('POST', '/v1/admin/slot-rules', { origin: null, sk, body: { webinar_id: id, kind: 'fixed', rule: { days: [2, 4], times: ['19:00'] }, timezone: 'Europe/London' } });
  assert.equal(rule.status, 201, rule.text);
  assert.equal(rule.json.data.next[0], '2026-11-10T19:00:00.000Z');
  assert.equal((await h.call('POST', '/v1/admin/slot-rules', { origin: null, sk, body: { webinar_id: id, kind: 'fixed', rule: {}, timezone: 'Mars/Olympus' } })).status, 400);
  await h.call('PATCH', `/v1/admin/webinars/${id}`, { origin: null, sk, body: { status: 'published' } });

  const detail = await h.call('GET', '/v1/webinars/passive-income-masterclass', { key: pk });
  assert.equal(detail.json.data.label, 'Scheduled replay');
  assert.deepEqual(detail.json.data.slots.slice(0, 2), ['2026-11-10T19:00:00.000Z', '2026-11-12T19:00:00.000Z']);

  const bad = await h.call('POST', '/v1/webinars/passive-income-masterclass/registrations', { key: pk, body: { email: 'x@example.com', name: 'X', consent: true, slot: '2026-11-10T19:30:00.000Z' } });
  assert.equal(bad.json.error.code, 'invalid_slot');
  const reg = await h.call('POST', '/v1/webinars/passive-income-masterclass/registrations', { key: pk, body: { email: 'eve@example.com', name: 'Eve', consent: true, slot: '2026-11-10T19:00:00.000Z' } });
  assert.equal(reg.status, 201, reg.text);
  await h.call('POST', '/v1/webinars/passive-income-masterclass/registrations', { key: pk, body: { email: 'noshow@example.com', name: 'No', consent: true, slot: '2026-11-10T19:00:00.000Z' } });
  assert.equal((h.db.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'evergreen'").get() as { n: number }).n, 1, 'one session per slot');

  // Cron opens the slot.
  h.clock.now = Date.parse('2026-11-10T19:00:30Z');
  const s1 = await runScheduled(h.env, h.services, h.clock.now);
  assert.equal(s1.evergreen_started, 1);

  h.clock.now = Date.parse('2026-11-10T19:10:00Z');
  const join = await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: 'd1' } });
  assert.equal(join.status, 200, join.text);
  const room = join.json.data.room;
  assert.equal(room.state, 'live');
  assert.equal(room.label, 'Scheduled replay', 'never labelled live');
  assert.equal(join.json.data.playback.offset_s, 600);
  assert.equal(join.json.data.playback.seekable, false);
  assert.equal(join.json.data.playback.webrtc, null);

  // Slot ends → cron ends + finalises.
  h.clock.now = Date.parse('2026-11-10T19:50:00Z');
  const s2 = await runScheduled(h.env, h.services, h.clock.now);
  assert.equal(s2.evergreen_ended, 1);
  h.clock.now = Date.parse('2026-11-10T19:53:00Z');
  await runScheduled(h.env, h.services, h.clock.now);
  assert.equal(eventsOf(h, 'attendee.left').length, 1);
  assert.equal(eventsOf(h, 'attendee.no_show').length, 1);
  assert.equal(eventsOf(h, 'attendee.no_show')[0]!.payload.registrant.email, 'noshow@example.com');

  // Afterwards the same link gives a seekable replay tracked on the on-demand session.
  const after = await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: 'd1' } });
  assert.equal(after.json.data.room.state, 'replay');
  assert.equal(after.json.data.playback.seekable, true);
  assert.equal(after.json.data.session.kind, 'evergreen');
  assert.notEqual(after.json.data.room.attendance_session_id, join.json.data.session.id);
});

test('just-in-time evergreen: instant join from the thank-you state', async () => {
  const h = createHarness(Date.parse('2026-11-09T10:07:00Z'));
  const { pk, sk } = await seedBrand(h);
  const w = await h.call('POST', '/v1/admin/webinars', { origin: null, sk, body: { type: 'evergreen', title: 'JIT', duration_s: 1800, video_uid: 'v' } });
  await h.call('POST', '/v1/admin/slot-rules', { origin: null, sk, body: { webinar_id: w.json.data.id, kind: 'just_in_time', rule: { every_minutes: 15 } } });
  await h.call('PATCH', `/v1/admin/webinars/${w.json.data.id}`, { origin: null, sk, body: { status: 'published' } });
  const d = await h.call('GET', '/v1/webinars/jit', { key: pk });
  assert.equal(d.json.data.slots[0], '2026-11-09T10:15:00.000Z');
  const reg = await h.call('POST', '/v1/webinars/jit/registrations', { key: pk, body: { email: 'j@example.com', name: 'J', consent: true, slot: d.json.data.slots[0] } });
  assert.equal(reg.status, 201);
  const join = await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: 'd' } });
  assert.equal(join.json.data.room.state, 'waiting', 'room opens 15 min early');
});

test('on-demand: publish needs a video; replay expiry per registrant', async () => {
  const h = createHarness(Date.parse('2026-11-09T10:00:00Z'));
  const { pk, sk } = await seedBrand(h, { settings: { defaults: { replay_expiry_days: 7 } } });
  const w = await h.call('POST', '/v1/admin/webinars', { origin: null, sk, body: { type: 'on_demand', title: 'Deal Analysis 101', duration_s: 1200 } });
  const id = w.json.data.id;
  assert.equal((await h.call('PATCH', `/v1/admin/webinars/${id}`, { origin: null, sk, body: { status: 'published' } })).status, 400);
  const up = await h.call('POST', `/v1/admin/webinars/${id}/video`, { origin: null, sk, body: {} });
  assert.equal(up.status, 201);
  assert.equal(up.json.data.upload_url, 'https://upload.cloudflarestream.com/abc');
  assert.equal((await h.call('PATCH', `/v1/admin/webinars/${id}`, { origin: null, sk, body: { status: 'published' } })).status, 200);

  const list = await h.call('GET', '/v1/webinars?view=on_demand', { key: pk });
  assert.equal(list.json.data.length, 1);
  assert.equal((await h.call('GET', '/v1/webinars?view=upcoming', { key: pk })).json.data.length, 0);

  const reg = await h.call('POST', '/v1/webinars/deal-analysis-101/registrations', { key: pk, body: { email: 'o@example.com', name: 'O', consent: true } });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.data.calendar, null, 'no calendar file for on-demand');
  const join = await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: 'd' } });
  assert.equal(join.json.data.room.state, 'on_demand');
  assert.equal(join.json.data.playback.seekable, true);
  assert.equal(join.json.data.room.access_expires_at, '2026-11-16T10:00:00.000Z');
  const st = join.json.data.session_token;

  // Viewer wanders off without a leave beacon → cron emits attendee.left once.
  h.clock.now += 30_000;
  await h.call('POST', '/v1/events', { key: pk, headers: { authorization: `Bearer ${st}` }, body: { type: 'heartbeat', position_s: 30, playing: true } });
  h.clock.now += 11 * 60_000;
  await runScheduled(h.env, h.services, h.clock.now);
  assert.equal(eventsOf(h, 'attendee.left').length, 1);
  await runScheduled(h.env, h.services, h.clock.now + 60_000);
  assert.equal(eventsOf(h, 'attendee.left').length, 1);

  h.clock.now = Date.parse('2026-11-17T00:00:00Z');
  const expired = await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: 'd' } });
  assert.equal(expired.status, 410);
});

test('test-mode keys and live keys never see each other’s webinars', async () => {
  const h = createHarness();
  const { brandId, sk } = await seedBrand(h);
  const testAccount = h.db.sqlite.prepare("SELECT id FROM api_keys WHERE mode = 'test' AND brand_id IS NULL").get() as { id: string };
  assert.ok(testAccount);
  // Mint a brand test sk via a fresh account test key (bootstrap only reveals keys once, so create one directly).
  const { generateApiKey } = await import('../src/lib/auth.js');
  const { sha256Hex } = await import('../src/lib/crypto.js');
  const raw = generateApiKey('sk', 'test').raw;
  h.db.sqlite.prepare("INSERT INTO api_keys (id, brand_id, type, mode, prefix, hash, scopes, allowed_origins, created_at) VALUES ('k_t', ?, 'sk', 'test', ?, ?, '[\"*\"]', '[]', '2026-01-01')")
    .run(brandId, raw.slice(0, 12), await sha256Hex(raw));
  const pkTest = await h.call('POST', '/v1/admin/api-keys', { origin: null, sk: raw, body: { type: 'pk' } });
  assert.match(pkTest.json.data.key, /^pk_test_/);

  const liveW = await h.call('POST', '/v1/admin/webinars', { origin: null, sk, body: { type: 'on_demand', title: 'Live one', video_uid: 'v1' } });
  await h.call('PATCH', `/v1/admin/webinars/${liveW.json.data.id}`, { origin: null, sk, body: { status: 'published' } });
  const testW = await h.call('POST', '/v1/admin/webinars', { origin: null, sk: raw, body: { type: 'on_demand', title: 'Test one', video_uid: 'v2' } });
  await h.call('PATCH', `/v1/admin/webinars/${testW.json.data.id}`, { origin: null, sk: raw, body: { status: 'published' } });

  assert.equal((await h.call('GET', `/v1/admin/webinars/${liveW.json.data.id}`, { origin: null, sk: raw })).status, 404);
  assert.equal((await h.call('GET', `/v1/admin/webinars/${testW.json.data.id}`, { origin: null, sk })).status, 404);
  const tList = await h.call('GET', '/v1/webinars?view=on_demand', { key: pkTest.json.data.key });
  assert.deepEqual(tList.json.data.map((w: { title: string }) => w.title), ['Test one']);

  // Test-mode events only go to test-mode webhook endpoints (none here), so nothing is queued.
  const before = h.queue.messages.length;
  await h.call('POST', '/v1/webinars/test-one/registrations', { key: pkTest.json.data.key, body: { email: 't@example.com', name: 'T', consent: true } });
  assert.equal(h.queue.messages.length, before);
  assert.equal(eventsOf(h, 'registrant.created')[0]!.payload.mode, 'test');
});

test('webhook retries: exponential, then dead-lettered', async () => {
  const h = createHarness(Date.parse('2026-11-09T10:00:00Z'));
  const { pk, sk } = await seedBrand(h);
  const w = await h.call('POST', '/v1/admin/webinars', { origin: null, sk, body: { type: 'on_demand', title: 'Hooks', video_uid: 'v' } });
  await h.call('PATCH', `/v1/admin/webinars/${w.json.data.id}`, { origin: null, sk, body: { status: 'published' } });
  await h.call('POST', '/v1/webinars/hooks/registrations', { key: pk, body: { email: 'w@example.com', name: 'W', consent: true } });
  const id = h.queue.messages[0]!.body.deliveryId;
  const failing = (async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;

  const delays: number[] = [];
  for (let i = 0; i < RETRY_SCHEDULE_S.length; i++) {
    const r = await attemptDelivery(h.env, id, failing, h.clock.now);
    assert.equal(r.outcome, 'retry');
    if (r.outcome === 'retry') { delays.push(r.delaySeconds); h.clock.now += r.delaySeconds * 1000; }
  }
  assert.deepEqual(delays, RETRY_SCHEDULE_S);
  assert.ok(delays.reduce((a, b) => a + b, 0) >= 23 * 3600, 'retries span ~24h');
  assert.equal((await attemptDelivery(h.env, id, failing, h.clock.now)).outcome, 'dead');
  const row = h.db.sqlite.prepare('SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = ?').get(id) as { status: string; attempts: number; last_error: string };
  assert.equal(row.status, 'dead');
  assert.match(row.last_error, /HTTP 503/);

  // Dead deliveries can be replayed by an admin.
  const ep = h.db.sqlite.prepare('SELECT endpoint_id FROM webhook_deliveries WHERE id = ?').get(id) as { endpoint_id: string };
  const dead = await h.call('GET', `/v1/admin/webhook-endpoints/${ep.endpoint_id}/deliveries?status=dead`, { origin: null, sk });
  assert.equal(dead.json.data.length, 1);
});
