import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, eventsOf, seedBrand, type FakeSocket, type Harness } from './helpers.js';

async function setup(settings: Record<string, unknown> = {}) {
  const h = createHarness(Date.parse('2026-11-12T19:00:00Z'));
  const seeded = await seedBrand(h, { settings });
  const { pk, sk } = seeded;
  const w = await h.call('POST', '/v1/admin/webinars', { origin: null, sk, body: { type: 'live', title: 'Room Test', duration_s: 3600 } });
  const webinarId = w.json.data.id as string;
  await h.call('POST', `/v1/admin/webinars/${webinarId}/live-input`, { origin: null, sk });
  const s = await h.call('POST', '/v1/admin/sessions', { origin: null, sk, body: { webinar_id: webinarId, starts_at: '2026-11-12T19:00:00Z' } });
  const sessionId = s.json.data.id as string;
  await h.call('PATCH', `/v1/admin/webinars/${webinarId}`, { origin: null, sk, body: { status: 'published' } });
  await h.call('POST', `/v1/admin/sessions/${sessionId}/start`, { origin: null, sk, body: {} });
  return { h, ...seeded, webinarId, sessionId };
}

async function attendee(h: Harness, pk: string, email: string, device = 'dev') {
  const reg = await h.call('POST', '/v1/webinars/room-test/registrations', { key: pk, body: { email, name: email.split('@')[0], consent: true } });
  const join = await h.call('POST', '/v1/join', { key: pk, body: { token: reg.json.data.token, device_id: device } });
  return { token: reg.json.data.token as string, st: join.json.data.session_token as string, rid: reg.json.data.registrant_id as string, sid: join.json.data.session.id as string };
}

async function connect(h: Harness, pk: string, sid: string, token: string, origin?: string): Promise<{ status: number; sock: FakeSocket | null }> {
  const res = await h.call('GET', `/v1/sessions/${sid}/live?key=${pk}&token=${encodeURIComponent(token)}`, { headers: { upgrade: 'websocket' }, origin });
  return { status: res.status, sock: res.status === 200 ? h.rooms.lastSocket : null };
}

async function hostToken(h: Harness, sk: string, sid: string, role = 'host') {
  const r = await h.call('POST', `/v1/admin/sessions/${sid}/host-token`, { origin: null, sk, body: { role, name: role === 'host' ? 'Martin' : 'Mod' } });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.data.console_url, /\/frame\/console#/);
  return r.json.data.token as string;
}

const send = async (h: Harness, sid: string, sock: FakeSocket, msg: Record<string, unknown>) => {
  await h.rooms.room(sid).room.webSocketMessage(sock as unknown as WebSocket, JSON.stringify(msg));
};

test('websocket auth: key + origin + token required, bound to the session', async () => {
  const { h, pk, sessionId } = await setup();
  const a = await attendee(h, pk, 'ann@example.com');
  assert.equal((await connect(h, pk, sessionId, a.st, 'https://evil.example')).status, 403);
  assert.equal((await connect(h, pk, sessionId, 'forged')).status, 401);
  assert.equal((await connect(h, pk, 'ses_other', a.st)).status, 403);
  const ok = await connect(h, pk, sessionId, a.st);
  assert.equal(ok.status, 200);
  const hello = ok.sock!.last('hello') as { status: string; you: { role: string } };
  assert.equal(hello.status, 'live');
  assert.equal(hello.you.role, 'attendee');
});

test('chat fans out; moderated questions only reach the asker and staff until approved', async () => {
  const { h, pk, sk, sessionId } = await setup();
  const a = await attendee(h, pk, 'ann@example.com');
  const b = await attendee(h, pk, 'bob@example.com');
  const sa = (await connect(h, pk, sessionId, a.st)).sock!;
  const sb = (await connect(h, pk, sessionId, b.st)).sock!;
  const host = (await connect(h, pk, sessionId, await hostToken(h, sk, sessionId))).sock!;

  await send(h, sessionId, sa, { type: 'chat', body: 'Hello from Ann' });
  assert.equal((sb.last('message') as { message: { body: string } }).message.body, 'Hello from Ann');
  assert.equal((host.last('message') as { message: { author_name: string } }).message.author_name, 'ann');

  // Rate limit.
  await send(h, sessionId, sa, { type: 'chat', body: 'spam' });
  assert.equal((sa.last('error') as { code: string }).code, 'slow_down');

  h.clock.now += 5000;
  const beforeB = sb.ofType('message').length;
  await send(h, sessionId, sa, { type: 'question', body: 'What yield should I target?' });
  const q = (host.last('message') as { message: { id: string; status: string } }).message;
  assert.equal(q.status, 'pending');
  assert.equal((sa.last('message') as { message: { id: string } }).message.id, q.id, 'asker sees their own pending question');
  assert.equal(sb.ofType('message').length, beforeB, 'other attendees do not');
  assert.equal(eventsOf(h, 'question.asked').length, 1);
  assert.equal(eventsOf(h, 'question.asked')[0]!.payload.crm.action, 'add_note');

  // Host approves over the socket, then answers.
  await send(h, sessionId, host, { type: 'moderate', message_id: q.id, op: 'approve' });
  assert.equal((sb.last('message_update') as { message: { id: string } }).message.id, q.id);
  await send(h, sessionId, host, { type: 'answer', message_id: q.id, body: '6–8% gross in the North West.' });
  const ans = sb.last('message') as { message: { kind: string; parent_id: string; author_name: string } };
  assert.equal(ans.message.kind, 'answer');
  assert.equal(ans.message.parent_id, q.id);
  assert.equal(ans.message.author_name, 'Martin');

  // Pin and hide.
  await send(h, sessionId, host, { type: 'moderate', message_id: q.id, op: 'pin' });
  assert.equal((sb.last('message_update') as { message: { status: string } }).message.status, 'pinned');
  await send(h, sessionId, host, { type: 'moderate', message_id: q.id, op: 'hide' });
  assert.equal((sb.last('message_removed') as { id: string }).id, q.id);

  // Attendees can't moderate.
  const n = sb.sent.length;
  await send(h, sessionId, sb, { type: 'moderate', message_id: q.id, op: 'show' });
  assert.equal(sb.sent.length, n);

  // Late joiner gets the history that's visible to them.
  const c = await attendee(h, pk, 'cat@example.com');
  const sc = (await connect(h, pk, sessionId, c.st)).sock!;
  const hello = sc.last('hello') as { messages: { body: string }[]; viewers: number };
  assert.deepEqual(hello.messages.map((m) => m.body), ['Hello from Ann'], 'hidden question and its answer are not replayed');

  // Alarm flushes everything to D1.
  await h.rooms.room(sessionId).room.alarm();
  const rows = h.db.sqlite.prepare('SELECT kind, status FROM messages ORDER BY created_at').all() as { kind: string; status: string }[];
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.status}`), ['chat:visible', 'question:hidden', 'answer:visible']);
  assert.equal((sc.last('viewers') as { count: number }).count, 3);

  // REST moderation path (Growth HQ console) stays in sync with the room.
  const qid = q.id;
  const patch = await h.call('PATCH', `/v1/admin/messages/${qid}`, { origin: null, sk, body: { status: 'visible' } });
  assert.equal(patch.status, 200, patch.text);
  assert.equal((sc.last('message_update') as { message: { id: string } }).message.id, qid);
});

test('CTA and poll pushes; one vote per registrant; moderators cannot push', async () => {
  const { h, pk, sk, sessionId, webinarId } = await setup();
  const cta = await h.call('POST', '/v1/admin/ctas', { origin: null, sk, body: { webinar_id: webinarId, label: 'Book a call', url: 'https://book.example/x', push_mode: 'manual' } });
  const poll = await h.call('POST', '/v1/admin/polls', { origin: null, sk, body: { webinar_id: webinarId, question: 'Budget?', options: ['<£50k', '£50k–£150k', '£150k+'], crm_field: 'investment_budget_band' } });
  assert.equal(poll.status, 201);
  const a = await attendee(h, pk, 'ann@example.com');
  const sa = (await connect(h, pk, sessionId, a.st)).sock!;

  assert.equal((await h.call('POST', `/v1/admin/sessions/${sessionId}/push-cta`, { origin: null, sk, body: { cta_id: cta.json.data.id } })).status, 200);
  assert.equal((sa.last('cta') as { cta: { label: string } }).cta.label, 'Book a call');
  await h.call('POST', `/v1/admin/sessions/${sessionId}/push-cta`, { origin: null, sk, body: { cta_id: null } });
  assert.equal((sa.last('cta') as { cta: null }).cta, null);

  await h.call('POST', `/v1/admin/sessions/${sessionId}/push-poll`, { origin: null, sk, body: { poll_id: poll.json.data.id, show_results: true } });
  assert.equal((sa.last('poll') as { poll: { question: string } }).poll.question, 'Budget?');
  await send(h, sessionId, sa, { type: 'vote', poll_id: poll.json.data.id, option: 'nonsense' });
  assert.equal((sa.last('error') as { code: string }).code, 'invalid_option');
  await send(h, sessionId, sa, { type: 'vote', poll_id: poll.json.data.id, option: '£150k+' });
  await send(h, sessionId, sa, { type: 'vote', poll_id: poll.json.data.id, option: '<£50k' });
  assert.equal((sa.last('voted') as { counted: boolean }).counted, false, 'second vote ignored');
  assert.deepEqual((sa.last('poll_results') as { results: Record<string, number> }).results, { '£150k+': 1 });
  const ans = eventsOf(h, 'poll.answered');
  assert.equal(ans.length, 1);
  assert.deepEqual(ans[0]!.payload.crm.custom_field, { key: 'investment_budget_band', value: '£150k+' });
  const results = await h.call('GET', `/v1/admin/polls/${poll.json.data.id}/results`, { origin: null, sk });
  assert.equal(results.json.data.results['£150k+'], 1);
  assert.equal(results.json.data.total, 1);

  const mod = (await connect(h, pk, sessionId, await hostToken(h, sk, sessionId, 'moderator'))).sock!;
  await send(h, sessionId, mod, { type: 'push_cta', cta: { id: 'x', label: 'Spam', url: 'https://x' } });
  assert.equal((mod.last('error') as { code: string }).code, 'host_only');
});

test('ban hides messages and blocks rejoin; one device per registrant when enabled', async () => {
  const { h, pk, sk, sessionId } = await setup({ defaults: { one_device_per_registrant: true } });
  const a = await attendee(h, pk, 'troll@example.com', 'phone');
  const phone = (await connect(h, pk, sessionId, a.st)).sock!;
  // Same registrant, second device → first is kicked.
  const join2 = await h.call('POST', '/v1/join', { key: pk, body: { token: a.token, device_id: 'laptop' } });
  const laptop = (await connect(h, pk, sessionId, join2.json.data.session_token)).sock!;
  assert.equal(phone.closed?.code, 4001);
  assert.equal(phone.last('replaced')?.type, 'replaced');
  assert.equal(laptop.closed, null);

  const b = await attendee(h, pk, 'nice@example.com');
  const sb = (await connect(h, pk, sessionId, b.st)).sock!;
  await send(h, sessionId, laptop, { type: 'chat', body: 'buy my course' });
  const msgId = (sb.last('message') as { message: { id: string } }).message.id;

  const ban = await h.call('PATCH', `/v1/admin/registrants/${a.rid}`, { origin: null, sk, body: { banned: true } });
  assert.equal(ban.status, 200);
  assert.equal((laptop.closed as { code?: number } | null)?.code, 4003);
  assert.equal((sb.last('message_removed') as { id: string }).id, msgId);
  assert.equal((await connect(h, pk, sessionId, join2.json.data.session_token)).status, 403);
  assert.equal((await h.call('POST', '/v1/join', { key: pk, body: { token: a.token, device_id: 'x' } })).status, 403);
});

test('session end is broadcast; chat closes', async () => {
  const { h, pk, sk, sessionId } = await setup();
  const a = await attendee(h, pk, 'ann@example.com');
  const sa = (await connect(h, pk, sessionId, a.st)).sock!;
  h.stream.recording = null;
  await h.call('POST', `/v1/admin/sessions/${sessionId}/end`, { origin: null, sk });
  assert.equal((sa.last('session_status') as { status: string }).status, 'ended');
  await send(h, sessionId, sa, { type: 'chat', body: 'still there?' });
  assert.equal((sa.last('error') as { code: string }).code, 'ended');
});

test('GDPR erasure purges the live room cache too', async () => {
  const { h, pk, sk, sessionId } = await setup();
  const a = await attendee(h, pk, 'gone@example.com');
  const sa = (await connect(h, pk, sessionId, a.st)).sock!;
  await send(h, sessionId, sa, { type: 'chat', body: 'my secret' });
  await h.call('DELETE', '/v1/admin/contacts/gone@example.com', { origin: null, sk });
  const state = h.rooms.room(sessionId).state;
  const left = [...state.data.values()].filter((v) => typeof v === 'object' && v && (v as { body?: string }).body === 'my secret');
  assert.equal(left.length, 0);
  // Nothing to flush back into D1 either.
  await h.rooms.room(sessionId).room.alarm();
  assert.equal((h.db.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, 0);
});
