import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { accessCookie, accessCookieName, issueAccessToken, readAccessToken } from '../src/webinars/access.js';
import { loadWebinarConfig, publicOriginFor } from '../src/webinars/config.js';
import { composeMessage, deliveryDecision } from '../src/webinars/messages.js';
import { computeRoomState, utcToLocalInput, zonedToUtc } from '../src/webinars/schedule.js';
import { CloudflareStreamClient, liveConnection, verifyStreamWebhook, StreamError } from '../src/webinars/stream.js';
import { DEFAULT_SETTINGS, readSettings, toEvent, type WebinarEvent, type WebinarSettings } from '../src/webinars/types.js';
import { PgWebinarService } from '../src/webinars/service.js';

const UID_A = 'a'.repeat(32);
const UID_B = 'b'.repeat(32);
const WS = '11111111-1111-4111-8111-111111111111';
const REG = '22222222-2222-4222-8222-222222222222';

function event(over: Partial<Record<keyof WebinarEvent, unknown>> & { settings?: Partial<WebinarSettings> } = {}): WebinarEvent {
  const { settings, ...rest } = over;
  return toEvent({
    workspaceId: WS, id: '33333333-3333-4333-8333-333333333333', publicKey: 'briefing-abc123', kind: 'live', status: 'published',
    title: 'Briefing', summary: '', presenterName: 'Sam', presenterTitle: '', timezone: 'Europe/London',
    startsAt: '2026-11-25T19:00:00.000Z', durationMinutes: 60, capacity: null,
    settings: { ...DEFAULT_SETTINGS, ...settings }, scheduleVersion: 1,
    videoUid: null, videoState: 'none', videoDurationSeconds: null,
    liveInputUid: UID_A, liveState: 'idle', liveCheckedAt: null,
    sessionState: 'scheduled', sessionStartedAt: null, sessionEndedAt: null,
    recordingUid: null, recordingState: 'none', recordingDurationSeconds: null, ctaRevealedAt: null,
    ...rest,
  });
}

const at = (iso: string) => Date.parse(iso);
const room = (e: WebinarEvent, iso: string, providerConfigured = true) => computeRoomState({ event: e, nowMs: at(iso), providerConfigured });

// ── Time handling ──────────────────────────────────────────────────────────

test('wall-clock start times convert to UTC across DST boundaries in the brand timezone', () => {
  assert.equal(zonedToUtc('2026-11-25T19:00', 'Europe/London')?.toISOString(), '2026-11-25T19:00:00.000Z', 'GMT');
  assert.equal(zonedToUtc('2026-07-01T19:00', 'Europe/London')?.toISOString(), '2026-07-01T18:00:00.000Z', 'BST');
  assert.equal(zonedToUtc('2026-07-01T19:00', 'America/New_York')?.toISOString(), '2026-07-01T23:00:00.000Z', 'EDT');
  // Spring-forward gap (01:30 does not exist on 29 March 2026 in London) rolls forward past it.
  assert.equal(zonedToUtc('2026-03-29T01:30', 'Europe/London')?.toISOString(), '2026-03-29T01:30:00.000Z');
  // Ambiguous autumn hour takes the first (summer-time) occurrence.
  assert.equal(zonedToUtc('2026-10-25T01:30', 'Europe/London')?.toISOString(), '2026-10-25T00:30:00.000Z');
  assert.equal(zonedToUtc('2026-13-01T10:00', 'Europe/London'), null);
  assert.equal(zonedToUtc('2026-11-25T19:00', 'Mars/Olympus'), null);
  assert.equal(zonedToUtc('25/11/2026 19:00', 'Europe/London'), null);
  assert.equal(utcToLocalInput('2026-07-01T18:00:00.000Z', 'Europe/London'), '2026-07-01T19:00');
});

// ── Room state machine ────────────────────────────────────────────────────

test('live room states follow server time and host actions, never a fake countdown or fake live badge', () => {
  const e = event();
  assert.equal(room(e, '2026-11-25T18:00:00Z').state, 'not_started');
  assert.equal(room(e, '2026-11-25T18:50:00Z').state, 'waiting');
  assert.equal(room(event({ liveState: 'connected' }), '2026-11-25T18:55:00Z').state, 'host_connecting', 'an encoder alone is a rehearsal');
  const live = room(event({ sessionState: 'live', liveState: 'connected' }), '2026-11-25T19:05:00Z');
  assert.deepEqual([live.state, live.label, live.playUid, live.seekable], ['live', 'Live', UID_A, false]);
  assert.equal(room(event({ sessionState: 'live', liveState: 'reconnecting' }), '2026-11-25T19:10:00Z').state, 'interrupted');
  assert.equal(room(event({ sessionState: 'ended', sessionEndedAt: '2026-11-25T20:00:00Z', recordingState: 'processing' }), '2026-11-25T20:01:00Z').state, 'processing');
  const replay = room(event({ sessionState: 'ended', sessionEndedAt: '2026-11-25T20:00:00Z', recordingState: 'ready', recordingUid: UID_B,
    settings: { replay: { enabled: true, availableDays: 7 } } }), '2026-11-26T10:00:00Z');
  assert.deepEqual([replay.state, replay.playUid, replay.seekable, replay.replayUntil], ['replay', UID_B, true, '2026-12-02T20:00:00.000Z']);
  assert.equal(room(event({ sessionState: 'ended', sessionEndedAt: '2026-11-25T20:00:00Z', recordingState: 'ready', recordingUid: UID_B,
    settings: { replay: { enabled: true, availableDays: 7 } } }), '2026-12-03T10:00:00Z').state, 'replay_expired');
  assert.equal(room(event({ sessionState: 'ended', recordingState: 'not_recorded' }), '2026-11-25T21:00:00Z').state, 'ended');
  assert.equal(room(event({ sessionState: 'ended', recordingState: 'ready', recordingUid: UID_B, settings: { replay: { enabled: false, availableDays: null } } }), '2026-11-25T21:00:00Z').state, 'ended');
  assert.equal(room(e, '2026-11-26T01:00:00Z').state, 'ended', 'a session that never started does not wait forever');
  assert.equal(room(event({ status: 'cancelled' }), '2026-11-25T19:05:00Z').state, 'cancelled');
  assert.equal(room(event({ sessionState: 'live', liveState: 'connected' }), '2026-11-25T19:05:00Z', false).state, 'unavailable', 'provider not configured');
});

test('scheduled recordings are labelled as recordings and locked to the scheduled playhead', () => {
  const e = event({ kind: 'scheduled_recording', liveInputUid: null, videoUid: UID_B, videoState: 'ready', videoDurationSeconds: 1800 });
  const playing = room(e, '2026-11-25T19:10:00Z');
  assert.equal(playing.state, 'scheduled_playing');
  assert.equal(playing.label, 'Scheduled presentation of a recording');
  assert.doesNotMatch(playing.label, /\blive\b/i);
  assert.equal(playing.offsetSeconds, 600);
  assert.equal(playing.seekable, false);
  assert.equal(room(e, '2026-11-25T19:31:00Z').state, 'replay');
  assert.equal(room(event({ kind: 'scheduled_recording', videoState: 'processing' }), '2026-11-25T19:10:00Z').state, 'unavailable');
  const onDemand = room(event({ kind: 'on_demand', startsAt: null, videoUid: UID_B, videoState: 'ready' }), '2026-11-25T19:10:00Z');
  assert.deepEqual([onDemand.state, onDemand.label, onDemand.seekable], ['on_demand', 'On-demand recording', true]);
});

// ── Attendee access ───────────────────────────────────────────────────────

test('access tokens are bound to one webinar key and version, and the cookie is HttpOnly and path-scoped', () => {
  const secret = 's'.repeat(40);
  const token = issueAccessToken(secret, 'briefing-abc123', { registrationId: REG, version: 1 });
  assert.deepEqual(readAccessToken(secret, 'briefing-abc123', token), { registrationId: REG, version: 1 });
  assert.equal(readAccessToken(secret, 'other-webinar', token), null, 'another webinar or brand');
  assert.equal(readAccessToken('t'.repeat(40), 'briefing-abc123', token), null, 'another deployment secret');
  assert.equal(readAccessToken(secret, 'briefing-abc123', token.replace(`${REG}.1.`, `${REG}.2.`)), null, 'version is signed');
  assert.equal(readAccessToken(secret, 'briefing-abc123', `${token}x`), null);
  assert.equal(readAccessToken(secret, 'briefing-abc123', null), null);
  const cookie = accessCookie('briefing-abc123', token, true);
  assert.match(cookie, new RegExp(`^${accessCookieName('briefing-abc123')}=`));
  assert.match(cookie, /; Path=\/w\/briefing-abc123; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.notEqual(accessCookieName('briefing-abc123'), accessCookieName('other-webinar'));
});

// ── Configuration ─────────────────────────────────────────────────────────

test('missing Cloudflare configuration produces name-only blockers and never echoes values', () => {
  const empty = loadWebinarConfig({});
  assert.equal(empty.stream, null);
  assert.equal(empty.streamBlockers.length, 5);
  assert.ok(empty.streamBlockers.every((b) => /^CLOUDFLARE_[A-Z_]+ /.test(b)));
  assert.equal(empty.emailMode, 'off');
  assert.equal(empty.accessSecret, null);
  const secretValue = 'super-secret-token-value-that-must-not-leak';
  const bad = loadWebinarConfig({ CLOUDFLARE_ACCOUNT_ID: 'not-an-id', CLOUDFLARE_STREAM_API_TOKEN: secretValue, CLOUDFLARE_STREAM_SIGNING_JWK: secretValue,
    WEBINAR_EMAIL_SENDERS: JSON.stringify([{ workspaceId: WS, from: 'A <a@example.test>', tokenEnv: 'MISSING_TOKEN' }]) });
  const text = JSON.stringify([bad.streamBlockers, bad.senderBlockers]);
  assert.doesNotMatch(text, /super-secret/);
  assert.match(text, /CLOUDFLARE_STREAM_SIGNING_JWK is not a valid RSA private JWK/);
  assert.match(text, /names MISSING_TOKEN, which is not set/);
  assert.equal(loadWebinarConfig({ WEBINAR_ACCESS_SECRET: 'short' }).accessSecret, null, 'a weak access secret is refused');
});

test('brand senders and origins are per workspace; a brand without a sender is held, not sent from another brand', () => {
  const other = '44444444-4444-4444-8444-444444444444';
  const config = loadWebinarConfig({
    WEBINAR_EMAIL_MODE: 'test', WEBINAR_EMAIL_TEST_RECIPIENTS: 'ok@example.test',
    WEBINAR_EMAIL_SENDERS: JSON.stringify([{ workspaceId: WS, from: 'Alpha <events@alpha.example.test>', tokenEnv: 'ALPHA_TOKEN' }]),
    ALPHA_TOKEN: 'x', WEBINAR_PUBLIC_ORIGIN: 'https://app.example.test',
    WEBINAR_WORKSPACE_ORIGINS: JSON.stringify({ [other]: 'https://app.bravo.example.test', bad: 'https://x.test' }),
  });
  assert.equal(deliveryDecision(config, WS, 'ok@example.test').kind, 'send');
  assert.equal(deliveryDecision(config, WS, 'someone@example.test').kind, 'block', 'test mode allow-list');
  assert.equal(deliveryDecision(config, other, 'ok@example.test').kind, 'hold', 'no fallback to another brand sender');
  assert.equal(deliveryDecision(loadWebinarConfig({}), WS, 'ok@example.test').kind, 'hold', 'email off by default');
  assert.equal(publicOriginFor(config, other), 'https://app.bravo.example.test');
  assert.equal(publicOriginFor(config, WS), 'https://app.example.test');
});

test('messages label recordings honestly and keep the attendee link private', () => {
  const brand = { workspaceName: 'Alpha', productName: 'Alpha Brand', primaryColor: null, accentColor: null, supportEmail: null };
  const base = { brand, recipientName: 'Ann Lee', roomUrl: 'https://app.example.test/w/k/room?t=x', calendarUrl: null, reminderOffsetMinutes: 60 };
  const reminder = composeMessage('reminder', { ...base, event: event({ kind: 'scheduled_recording' }) });
  assert.match(reminder.subject, /^Starting in one hour: Briefing$/);
  assert.match(reminder.text, /recorded presentation/);
  const link = composeMessage('access_link', { ...base, event: event() });
  assert.doesNotMatch(link.text, /no longer work/);
  const cancelled = composeMessage('cancellation', { ...base, event: event() });
  assert.doesNotMatch(cancelled.html, /room\?t=/, 'a cancellation has no room link');
  const xss = composeMessage('confirmation', { ...base, event: event({ title: '<script>x</script>' }) });
  assert.doesNotMatch(xss.html, /<script>x/);
});

test('settings are sanitised: unsafe CTA URLs and out-of-range reminders are dropped', () => {
  const s = readSettings({ cta: { label: 'Go', url: 'javascript:alert(1)', mode: 'manual' }, reminderOffsetsMinutes: [60, -5, 999999, 60, 'x'] });
  assert.equal(s.cta, null);
  assert.deepEqual(s.reminderOffsetsMinutes, [60]);
  assert.equal(readSettings({ cta: { label: 'Book', url: 'https://example.test/book', mode: 'timed', atSeconds: 600 } }).cta?.mode, 'timed');
  assert.deepEqual(readSettings('not json'), readSettings({}));
});

// ── Cloudflare Stream adapter ─────────────────────────────────────────────

function streamClient(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: { url: URL; init: RequestInit }[] = [];
  const client = new CloudflareStreamClient({
    accountId: 'f'.repeat(32), apiToken: 'synthetic-api-token', customerCode: 'synthetic01', signingKeyId: 'kid1',
    signingJwk: privateKey.export({ format: 'jwk' }) as JsonWebKey, webhookSecret: 'whsec',
  }, (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch);
  return { client, calls, publicKey };
}

test('live inputs are created with automatic recording, signed URLs and our origins only', async () => {
  const { client, calls } = streamClient(() => Response.json({ success: true, result: {
    uid: UID_A, rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: 'k' }, srt: { url: 'srt://live.cloudflare.com:778', streamId: 's', passphrase: 'p' } } }));
  const creds = await client.createLiveInput({ webinarJob: 'job-1' }, ['app.example.test'], 365);
  assert.equal(creds.uid, UID_A);
  assert.equal(calls[0]!.url.pathname, `/client/v4/accounts/${'f'.repeat(32)}/stream/live_inputs`);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer synthetic-api-token');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    meta: { webinarJob: 'job-1' }, deleteRecordingAfterDays: 365,
    recording: { mode: 'automatic', requireSignedURLs: true, allowedOrigins: ['app.example.test'], timeoutSeconds: 0, hideLiveViewerCount: true },
  });
});

test('provider errors are classified so uncertain calls are reconciled, not retried blindly', async () => {
  const timeout = streamClient(() => { throw new Error('socket hang up'); }).client;
  await assert.rejects(timeout.createLiveInput({}, [], null), (e: unknown) => e instanceof StreamError && e.status === null && e.retryable);
  const refused = streamClient(() => Response.json({ success: false, errors: [{ message: 'quota' }] }, { status: 403 })).client;
  await assert.rejects(refused.createLiveInput({}, [], null), (e: unknown) => e instanceof StreamError && e.status === 403 && !e.retryable && /quota/.test(e.message));
  assert.equal(await streamClient(() => Response.json({ success: false }, { status: 404 })).client.getVideo(UID_B), null);
  assert.throws(() => streamClient(() => Response.json({})).client.signPlayback('../etc', 0), StreamError);
});

test('tus direct uploads go straight to Cloudflare and only to a Cloudflare upload host', async () => {
  const ok = streamClient(() => new Response(null, { status: 201, headers: { location: `https://upload.cloudflarestream.com/tus/${UID_B}?tusv2=true`, 'stream-media-id': UID_B } }));
  const upload = await ok.client.createTusUpload(1024, { name: 'session.mp4', maxDurationSeconds: 3600, webinarId: 'w' });
  assert.equal(upload.uid, UID_B);
  assert.equal(ok.calls[0]!.url.search, '?direct_user=true');
  const headers = ok.calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['tus-resumable'], '1.0.0');
  assert.equal(headers['upload-length'], '1024');
  assert.match(headers['upload-metadata']!, /requiresignedurls/);
  const evil = streamClient(() => new Response(null, { status: 201, headers: { location: 'https://evil.example/upload', 'stream-media-id': UID_B } }));
  await assert.rejects(evil.client.createTusUpload(1024, { name: 'x', maxDurationSeconds: 60, webinarId: 'w' }), /unexpected upload host/);
  await assert.rejects(ok.client.createTusUpload(0, { name: 'x', maxDurationSeconds: 60, webinarId: 'w' }), /between 1 byte/);
});

test('playback tokens are short-lived RS256 JWTs for one video, verifiable with the public key', () => {
  const { client, publicKey } = streamClient(() => Response.json({}));
  const now = Date.parse('2026-11-25T19:00:00Z');
  const { token, expiresAt } = client.signPlayback(UID_B, now, 3600);
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', kid: 'kid1', typ: 'JWT' });
  assert.deepEqual(payload, { sub: UID_B, kid: 'kid1', exp: now / 1000 + 3600, nbf: now / 1000 - 60 });
  assert.equal(expiresAt, '2026-11-25T20:00:00.000Z');
  assert.ok(cryptoVerify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url')));
  assert.equal(client.hlsUrl(token), `https://customer-synthetic01.cloudflarestream.com/${token}/manifest/video.m3u8`);
  assert.doesNotMatch(token, /synthetic-api-token/);
});

test('Stream webhooks need a fresh, exact HMAC signature', () => {
  const body = Buffer.from('{"uid":"x"}');
  const now = Date.parse('2026-11-25T19:00:00Z');
  const time = String(now / 1000);
  const sig = createHmac('sha256', 'whsec').update(`${time}.`).update(body).digest('hex');
  assert.equal(verifyStreamWebhook('whsec', `time=${time},sig1=${sig}`, body, now), true);
  assert.equal(verifyStreamWebhook('other', `time=${time},sig1=${sig}`, body, now), false);
  assert.equal(verifyStreamWebhook('whsec', `time=${time},sig1=${sig}`, Buffer.from('{"uid":"y"}'), now), false);
  assert.equal(verifyStreamWebhook('whsec', `time=${time},sig1=${sig}`, body, now + 301_000), false, 'outside the replay window');
  assert.equal(verifyStreamWebhook('whsec', undefined, body, now), false);
  assert.equal(verifyStreamWebhook('whsec', `sig1=${sig}`, body, now), false);
});

test('live connection states map conservatively', () => {
  assert.equal(liveConnection('connected'), 'connected');
  assert.equal(liveConnection('reconnecting'), 'reconnecting');
  assert.equal(liveConnection('client_disconnect'), 'disconnected');
  assert.equal(liveConnection(null), 'idle');
  assert.equal(liveConnection('something_new'), 'idle', 'an unknown status is never shown as live');
});

test('brand accents produce WCAG AA text and button colours, however bright the brand', async () => {
  const { accentPalette, contrast } = await import('../src/webinars/colour.js');
  for (const brand of ['#00e5cc', '#ed9c24', '#ffeb3b', '#0b7a75', '#101827', '#fff', 'not-a-colour']) {
    const p = accentPalette(brand);
    assert.ok(contrast(p.onAccent, p.accent) >= 4.5 || contrast(p.onAccent, p.accent) >= contrast(p.onAccent === '#ffffff' ? '#111827' : '#ffffff', p.accent), `${brand} button text`);
    assert.ok(contrast(p.textOnLight, '#ffffff') >= 4.5, `${brand} text on light`);
    assert.ok(contrast(p.textOnDark, '#161922') >= 4.5, `${brand} text on dark`);
  }
  assert.equal(accentPalette('#00e5cc').onAccent, '#111827', 'dark text on bright teal');
  assert.equal(accentPalette('#00e5cc').accent, '#00e5cc', 'the brand colour itself is unchanged');
});

test('attendee polls reuse one signed playback token until it nears expiry', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const stream = new CloudflareStreamClient({ accountId: 'f'.repeat(32), apiToken: 'synthetic', customerCode: 'synthetic01', signingKeyId: 'kid1',
    signingJwk: privateKey.export({ format: 'jwk' }) as JsonWebKey, webhookSecret: null }, (async () => Response.json({})) as typeof fetch);
  let clock = Date.parse('2026-11-25T19:05:00Z');
  const service = new PgWebinarService({ pool: {} as never, config: loadWebinarConfig({}), stream, now: () => clock });
  const live = event({ sessionState: 'live', liveState: 'connected' });
  const first = service.playback(live);
  clock += 5 * 60_000;
  const second = service.playback(live);
  assert.equal(second.hlsUrl, first.hlsUrl, 'five minutes later the same token is served');
  assert.equal(second.expiresAt, first.expiresAt);
  clock += 36 * 60_000; // 41 minutes in: fewer than 20 remain
  const third = service.playback(live);
  assert.notEqual(third.hlsUrl, first.hlsUrl, 'a fresh token once fewer than 20 minutes remain');
  assert.ok(Date.parse(third.expiresAt!) > Date.parse(first.expiresAt!));
  const other = service.playback(event({ sessionState: 'ended', sessionEndedAt: '2026-11-25T20:00:00Z', recordingState: 'ready', recordingUid: UID_B }));
  assert.notEqual(other.hlsUrl, third.hlsUrl, 'tokens are per video');
});

test('actual Cloudflare nested live status and input-scoped recordings drive playback', async () => {
  for (const state of ['connected', 'reconnected', 'reconnecting', 'client_disconnect', 'failed_to_connect']) {
    assert.equal(liveConnection({ current: { state } }), liveConnection(state));
  }
  for (const status of [{}, { current: null }, { current: { state: 'new-unknown-state' } }, { connected: true }, []]) assert.equal(liveConnection(status), 'idle');
  const {client,calls}=streamClient(url => {
    if (url.pathname.endsWith('/live_inputs/'+UID_A)) return Response.json({success:true,result:{uid:UID_A,status:{current:{state:'connected'}},rtmps:{url:'rtmps://live.cloudflare.com:443/live/',streamKey:'synthetic-only-key'}}});
    assert.equal(url.pathname.endsWith('/live_inputs/'+UID_A+'/videos'),true);
    assert.equal(url.search,'');
    return Response.json({success:true,result:[{uid:UID_B,status:{state:'ready'},readyToStream:true,duration:120},
      {uid:'c'.repeat(32),liveInput:'d'.repeat(32),status:{state:'ready'},readyToStream:true,duration:999}]});
  });
  assert.equal((await client.getLiveInput(UID_A)).connection,'connected');
  const recordings=await client.recordingsFor(UID_A);
  assert.equal(recordings.length,1); assert.equal(recordings[0]!.liveInput,UID_A); assert.equal(recordings[0]!.uid,UID_B);
  assert.equal(calls.length,2);
});
