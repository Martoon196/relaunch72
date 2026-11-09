/**
 * Native webinars on a disposable PostgreSQL (migration 0146) with the actual
 * r72_content_command and r72_crm_command roles. Cloudflare and Postmark are
 * replaced by recording fakes at the HTTP boundary: this proves application,
 * schema and RLS behaviour, not live Cloudflare acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { fakeCloudflare, loginRole, seedBrand } from './webinar-harness.js';
import { CrmCommandService, createPgCrmTransactionRunner } from '../../src/crm-pg/index.js';
import { issueAccessToken } from '../../src/webinars/access.js';
import { loadWebinarConfig } from '../../src/webinars/config.js';
import type { WebinarMailer } from '../../src/webinars/messages.js';
import { PgWebinarService, WebinarError } from '../../src/webinars/service.js';
import { CloudflareStreamClient } from '../../src/webinars/stream.js';
import { DEFAULT_SETTINGS, readSettings } from '../../src/webinars/types.js';
import { WebinarWorker } from '../../src/webinars/worker.js';

const skip = testDatabaseSkipReason();

test('0146 native webinars: brand isolation, registration, reminders, signals, Q&A, Stream lifecycle and CRM handoff on actual roles', { skip, timeout: 300_000 }, async () => {
  const admin = await openTestDatabase();
  const content = await loginRole(admin, 'r72_content_command');
  const crmPool = await loginRole(admin, 'r72_crm_command');
  try {
    const a = await seedBrand(admin, 'Alpha');
    const b = await seedBrand(admin, 'Bravo');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = privateKey.export({ format: 'jwk' });
    let clock = Date.parse('2026-11-20T12:00:00Z');
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_STREAM_API_TOKEN: 'synthetic-token', CLOUDFLARE_STREAM_CUSTOMER_CODE: 'synthetic01',
      CLOUDFLARE_STREAM_SIGNING_KEY_ID: 'kid-synthetic', CLOUDFLARE_STREAM_SIGNING_JWK: Buffer.from(JSON.stringify(jwk)).toString('base64'),
      CLOUDFLARE_STREAM_WEBHOOK_SECRET: 'synthetic-webhook-secret', WEBINAR_ACCESS_SECRET: 's'.repeat(40),
      WEBINAR_EMAIL_MODE: 'test', WEBINAR_EMAIL_TEST_RECIPIENTS: 'allowed@example.test',
      WEBINAR_EMAIL_SENDERS: JSON.stringify([{ workspaceId: a.ws, from: 'Alpha Brand <events@alpha.example.test>', tokenEnv: 'ALPHA_POSTMARK_TOKEN' }]),
      ALPHA_POSTMARK_TOKEN: 'synthetic-postmark', WEBINAR_PUBLIC_ORIGIN: 'https://app.example.test',
    };
    const config = loadWebinarConfig(env);
    assert.deepEqual(config.streamBlockers, []);
    const cf = fakeCloudflare();
    const stream = new CloudflareStreamClient(config.stream!, cf.fetch);
    const crm = { commands: new CrmCommandService({ transactionRunner: createPgCrmTransactionRunner(crmPool) }), pool: crmPool };
    const svc = new PgWebinarService({ pool: content, config, stream, crm, now: () => clock });
    const sent: { to: string; subject: string; from: string }[] = [];
    let mailOutcome: 'sent' | 'unknown' = 'sent';
    const mailer: WebinarMailer = { send: async (sender, to, message) => { sent.push({ to, subject: message.subject, from: sender.from }); return mailOutcome === 'sent' ? { outcome: 'sent', messageId: randomUUID() } : { outcome: 'unknown' }; } };
    const worker = new WebinarWorker({ pool: content, config, stream, mailer, now: () => clock });
    const req = () => randomUUID();
    const edit = (over: Partial<Parameters<PgWebinarService['create']>[2]> = {}) => ({
      kind: 'live' as const, title: 'Quarterly investor briefing', summary: 'Synthetic fixture.', presenterName: 'Sam Host', presenterTitle: 'Founder',
      timezone: 'Europe/London', startsLocal: '2026-11-25T19:00', durationMinutes: 60, capacity: 3,
      settings: readSettings({ ...DEFAULT_SETTINGS, reminderOffsetsMinutes: [1440, 60], cta: { label: 'Book a call', url: 'https://alpha.example.test/book', mode: 'manual' } }), ...over,
    });

    // ── management + isolation ──
    const id = await svc.create(a.owner, req(), edit());
    const created = await svc.get(a.owner, req(), id);
    assert.equal(created.event.startsAt, '2026-11-25T19:00:00.000Z', 'Europe/London winter time is UTC+0');
    await assert.rejects(svc.get(b.owner, req(), id), (e: unknown) => e instanceof WebinarError && e.status === 404, 'another brand cannot select it');
    assert.equal((await svc.list(b.owner, req())).webinars.length, 0);
    await assert.rejects(svc.list(a.viewer, req()), (e: unknown) => e instanceof WebinarError && e.status === 403, 'viewer role cannot manage');
    await assert.rejects(svc.setStatus(b.owner, req(), id, 'publish'), (e: unknown) => e instanceof WebinarError && e.status === 404);
    await svc.setStatus(a.owner, req(), id, 'publish');
    const pub = await svc.publicEvent(created.event.publicKey);
    assert.equal(pub?.brand.productName, 'Alpha Brand');

    // ── registration: idempotent per email, capacity, no token for repeats ──
    const key = created.event.publicKey;
    const consent = { serviceNotice: 'x', marketing: false, version: 'webinar-1' };
    const r1 = await svc.register(key, { email: 'Allowed@Example.test', name: 'Ann', answers: {}, marketing: false, consent, attribution: { utm_source: 'newsletter' } });
    assert.equal(r1.outcome, 'created');
    assert.ok(r1.token);
    const again = await svc.register(key, { email: 'allowed@example.test', name: 'Someone else', answers: {}, marketing: false, consent, attribution: {} });
    assert.deepEqual([again.outcome, again.token], ['existing', null], 'a repeat never hands over access');
    const r2 = await svc.register(key, { email: 'blocked@example.test', name: 'Bob', answers: {}, marketing: true, consent, attribution: {} });
    const r3 = await svc.register(key, { email: 'third@example.test', name: 'Cat', answers: {}, marketing: false, consent, attribution: {} });
    assert.equal(r3.outcome, 'created');
    assert.equal((await svc.register(key, { email: 'fourth@example.test', name: 'Dee', answers: {}, marketing: false, consent, attribution: {} })).outcome, 'full');
    const jobs = async () => (await admin.query("SELECT purpose, state, schedule_version, registration_id FROM app.webinar_jobs WHERE event_id = $1 AND kind = 'message' ORDER BY created_at, dedupe_key", [id])).rows;
    assert.equal((await jobs()).filter((j) => j.purpose === 'confirmation').length, 3, 'one confirmation per registration, none for the repeat');
    assert.equal((await jobs()).filter((j) => j.purpose === 'reminder').length, 6);
    await svc.requestAccessLink(key, 'allowed@example.test');
    await svc.requestAccessLink(key, 'allowed@example.test');
    await svc.requestAccessLink(key, 'nobody@example.test');
    assert.equal((await jobs()).filter((j) => j.purpose === 'access_link').length, 1, 'rate-limited, and unknown addresses enqueue nothing');

    // ── worker: test mode, brand sender, crash-safe sends ──
    await worker.tick();
    assert.ok(sent.every((s) => s.to === 'allowed@example.test' && s.from.includes('events@alpha')), 'test mode only reaches allow-listed recipients, from the brand sender');
    assert.ok(sent.length >= 2 && sent.some((s) => s.subject.startsWith("You're registered")));
    assert.ok((await jobs()).some((j) => j.state === 'blocked' && j.registration_id === r2.registrationId));

    // ── reschedule: stale reminders cancelled, new ones at v2, notices queued ──
    const v1 = await svc.get(a.owner, req(), id);
    const moved = await svc.update(a.owner, req(), id, v1.rowVersion, edit({ startsLocal: '2026-11-26T19:00' }));
    assert.equal(moved.rescheduled, true);
    const after = await jobs();
    assert.ok(after.filter((j) => j.purpose === 'reminder' && j.schedule_version === 1).every((j) => j.state === 'cancelled'));
    assert.equal(after.filter((j) => j.purpose === 'reminder' && j.schedule_version === 2 && j.state === 'queued').length, 6);
    assert.equal(after.filter((j) => j.purpose === 'reschedule').length, 3);

    // A send interrupted mid-call is 'unknown' and never resent.
    const crashJob = (await admin.query("SELECT id FROM app.webinar_jobs WHERE event_id = $1 AND purpose = 'reschedule' AND registration_id = $2", [id, r1.registrationId])).rows[0].id;
    await admin.query("UPDATE app.webinar_jobs SET state = 'calling', lease_until = $2 WHERE id = $1", [crashJob, new Date(clock - 1000).toISOString()]);
    const before = sent.length;
    await worker.tick();
    assert.equal((await admin.query('SELECT state FROM app.webinar_jobs WHERE id = $1', [crashJob])).rows[0].state, 'unknown');
    assert.equal(sent.slice(before).filter((s) => s.subject.startsWith('New time')).length, 0, 'the interrupted notice is not resent');

    // ── signals and questions ──
    const claim1 = { registrationId: r1.registrationId!, version: 1 };
    assert.equal(await svc.signal(key, claim1, 'player_started', 'live', null, null), true);
    assert.equal(await svc.signal(key, claim1, 'player_started', 'live', null, null), false, 'deduplicated');
    assert.equal(await svc.signal(key, claim1, 'watch_interval', 'live', 0, 30), true);
    assert.equal(await svc.signal(key, claim1, 'watch_interval', 'live', 30, 60), false, 'faster than real time');
    assert.equal(await svc.signal(key, claim1, 'watch_interval', 'live', 0, 500), false, 'oversized interval');
    assert.equal(await svc.signal(key, { ...claim1, version: 2 }, 'cta_clicked', 'live', null, null), false, 'wrong token version');
    const other = await svc.create(b.owner, req(), edit({ kind: 'on_demand', startsLocal: '', title: 'Bravo on demand' }));
    const otherKey = (await svc.get(b.owner, req(), other)).event.publicKey;
    assert.equal(await svc.attendee(otherKey, claim1), null, "a registration never opens another brand's webinar");
    assert.equal(await svc.ask(key, claim1, 'First question?'), 'accepted');
    const claim3 = { registrationId: r3.registrationId!, version: 1 };
    assert.deepEqual((await svc.publicQuestions(key, claim3)).map((q) => q.body), [], 'pending questions are private to the asker');
    assert.equal((await svc.publicQuestions(key, claim1))[0]?.status, 'pending');
    assert.equal(await svc.ask(key, claim1, 'Second?'), 'accepted');
    assert.equal(await svc.ask(key, claim1, 'Third?'), 'accepted');
    assert.equal(await svc.ask(key, claim1, 'Fourth?'), 'rate_limited');
    const qs = await svc.questions(a.owner, req(), id);
    await svc.moderate(a.owner, req(), id, qs.find((q) => q.body === 'First question?')!.id, 'answer', 'Synthetic answer.');
    assert.deepEqual((await svc.publicQuestions(key, claim3)).map((q) => [q.body, q.answer]), [['First question?', 'Synthetic answer.']]);
    await assert.rejects(svc.moderate(b.owner, req(), id, qs[0]!.id, 'dismiss', ''), (e: unknown) => e instanceof WebinarError && e.status === 404);

    // ── live input: uncertain create is reconciled, never duplicated ──
    cf.createFails = 'timeout';
    await svc.provisionLiveInput(a.owner, req(), id);
    assert.equal(await svc.provisionState(a.owner, req(), id), 'unknown');
    await assert.rejects(svc.provisionLiveInput(a.owner, req(), id), /may have created/);
    assert.match(await svc.reconcileLiveInput(a.owner, req(), id), /Found/);
    assert.equal(cf.liveInputs.size, 1, 'exactly one provider resource');
    const withInput = (await svc.get(a.owner, req(), id)).event;
    assert.equal(withInput.liveInputUid, [...cf.liveInputs.keys()][0]);
    const createCall = cf.calls.find((c) => c.method === 'POST' && c.path === '/live_inputs')!;
    assert.deepEqual((createCall.body as { recording: unknown }).recording, { mode: 'automatic', requireSignedURLs: true, allowedOrigins: ['app.example.test'], timeoutSeconds: 0, hideLiveViewerCount: true });

    // ── live session → recording → replay ──
    clock = Date.parse('2026-11-26T18:55:00Z');
    assert.equal(svc.playback((await svc.get(a.owner, req(), id)).event).room.state, 'waiting');
    cf.liveInputs.get(withInput.liveInputUid!)!.status = 'connected';
    await svc.refreshLive(a.owner, req(), id);
    assert.equal(svc.playback((await svc.get(a.owner, req(), id)).event).room.state, 'host_connecting', 'a connected encoder alone is a rehearsal');
    await svc.startSession(a.owner, req(), id);
    const livePb = svc.playback((await svc.get(a.owner, req(), id)).event);
    assert.equal(livePb.room.state, 'live');
    assert.match(livePb.hlsUrl!, /^https:\/\/customer-synthetic01\.cloudflarestream\.com\/[\w-]+\.[\w-]+\.[\w-]+\/manifest\/video\.m3u8$/);
    const rec = randomUUID().replace(/-/g, '');
    const receipt = createHash('sha256').update(`rec-${rec}`).digest();
    assert.equal(await svc.streamNotification(receipt, { uid: rec, liveInput: withInput.liveInputUid, state: 'ready', readyToStream: true, duration: 3500, errorReason: null }), 'deferred',
      'a mid-session recording fragment is not the replay');
    clock = Date.parse('2026-11-26T20:01:00Z');
    await svc.endSession(a.owner, req(), id);
    assert.equal(svc.playback((await svc.get(a.owner, req(), id)).event).room.state, 'processing');
    const receipt2 = createHash('sha256').update(`rec2-${rec}`).digest();
    assert.equal(await svc.streamNotification(receipt2, { uid: rec, liveInput: withInput.liveInputUid, state: 'ready', readyToStream: true, duration: 3500, errorReason: null }), 'applied');
    assert.equal(await svc.streamNotification(receipt2, { uid: rec, liveInput: withInput.liveInputUid, state: 'ready', readyToStream: true, duration: 3500, errorReason: null }), 'replayed');
    const ended = (await svc.get(a.owner, req(), id)).event;
    assert.equal(ended.recordingUid, rec);
    const replay = svc.playback(ended);
    assert.equal(replay.room.state, 'replay');
    assert.equal(replay.room.seekable, true);
    assert.equal((await jobs()).filter((j) => j.purpose === 'replay_available').length, 3);

    // ── uploads: direct creator upload bound to the event, readiness reconciled ──
    const od = await svc.create(a.owner, req(), edit({ kind: 'on_demand', startsLocal: '', title: 'Alpha on demand', capacity: null }));
    const upload = await svc.beginUpload(a.owner, req(), od, 250 * 1024 * 1024, 'session.mp4');
    assert.match(upload.uploadUrl, /^https:\/\/upload\.cloudflarestream\.com\//);
    const odEvent = (await svc.get(a.owner, req(), od)).event;
    assert.equal(odEvent.videoState, 'awaiting_upload');
    cf.videos.set(odEvent.videoUid!, { uid: odEvent.videoUid, readyToStream: true, status: { state: 'ready' }, duration: 1800 });
    clock += 5 * 60_000;
    await worker.tick();
    const odReady = (await svc.get(a.owner, req(), od)).event;
    assert.deepEqual([odReady.videoState, odReady.videoDurationSeconds], ['ready', 1800]);

    // ── CRM handoff through the existing lead command, idempotent ──
    const first = await svc.sendToCrm(a.owner, req(), id);
    assert.equal(first.linked, 3);
    assert.equal(first.remaining, 0);
    const contacts = await admin.query("SELECT count(*)::int AS n FROM app.contacts WHERE workspace_id = $1", [a.ws]);
    assert.equal(contacts.rows[0].n, 3);
    const second = await svc.sendToCrm(a.owner, req(), id);
    assert.deepEqual([second.linked, second.replayed, second.remaining], [0, 0, 0]);

    // ── results: provenance-separated ──
    const results = await svc.results(a.owner, req(), id);
    assert.equal(results.registered, 3);
    assert.equal(results.playerStarted, 1);
    assert.equal(results.totalObservedMinutes, 1);
    assert.equal(results.crmLinked, 3);
    assert.deepEqual(results.bySource.find((s) => s.source === 'newsletter'), { source: 'newsletter', registered: 1, playerStarted: 1 });

    // ── access token is bound to the event key ──
    const token = issueAccessToken(config.accessSecret!, key, claim1);
    assert.ok(token.startsWith(r1.registrationId!));

    // ── a longer recording for the same live input replaces a shorter fragment, never the reverse ──
    const longer = randomUUID().replace(/-/g, '');
    assert.equal(await svc.streamNotification(createHash('sha256').update(`rec-long-${longer}`).digest(), { uid: longer, liveInput: withInput.liveInputUid, state: 'ready', readyToStream: true, duration: 3550, errorReason: null }), 'applied');
    assert.equal((await svc.get(a.owner, req(), id)).event.recordingUid, longer, 'the longer recording became the replay');
    const shorter = randomUUID().replace(/-/g, '');
    assert.equal(await svc.streamNotification(createHash('sha256').update(`rec-short-${shorter}`).digest(), { uid: shorter, liveInput: withInput.liveInputUid, state: 'ready', readyToStream: true, duration: 120, errorReason: null }), 'applied');
    assert.equal((await svc.get(a.owner, req(), id)).event.recordingUid, longer, 'a shorter fragment does not displace it');
    assert.equal((await jobs()).filter((j) => j.purpose === 'replay_available').length, 3, 'replay notices are not re-queued by the replacement');

    // ── registering for the replay after the event still queues a sendable confirmation ──
    await admin.query('UPDATE app.webinar_events SET capacity = NULL WHERE id = $1', [id]);
    const late = await svc.register(key, { email: 'allowed@example.test'.replace('allowed', 'late-allowed'), name: 'Late Lou', answers: {}, marketing: true, consent, attribution: {} });
    assert.equal(late.outcome, 'created');
    const lateJob = (await admin.query("SELECT state, expires_at FROM app.webinar_jobs WHERE registration_id = $1 AND purpose = 'confirmation'", [late.registrationId])).rows[0];
    assert.equal(lateJob.state, 'queued');
    assert.ok(Date.parse(lateJob.expires_at.toISOString()) > clock + 24 * 3600_000, 'confirmation outlives the event end');
    await worker.tick();
    assert.equal((await admin.query("SELECT state FROM app.webinar_jobs WHERE registration_id = $1 AND purpose = 'confirmation'", [late.registrationId])).rows[0].state, 'blocked',
      'test mode blocks the unlisted recipient; it was not expired before it could be considered');

    // ── CRM handoff carries the explicit marketing opt-in and nothing more ──
    const crmAfter = await svc.sendToCrm(a.owner, req(), id);
    assert.equal(crmAfter.linked, 1);
    const consentRows = await admin.query(`SELECT r.marketing_consent, cp.consent_status FROM app.webinar_registrations r
      JOIN app.contact_points cp ON cp.workspace_id = r.workspace_id AND cp.contact_id = r.crm_contact_id AND cp.kind = 'email'
      WHERE r.event_id = $1 ORDER BY r.created_at`, [id]);
    assert.deepEqual(consentRows.rows.map((r) => [r.marketing_consent, r.consent_status]),
      [[false, 'unknown'], [true, 'opted_in'], [false, 'unknown'], [true, 'opted_in']], 'opt-in travels; anything else stays unknown');
  } finally {
    await content.end();
    await crmPool.end();
    await admin.end();
  }
});
