/** Actual-role recovery regressions; Cloudflare/mailer are fixtures, never live providers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openTestDatabase, testDatabaseSkipReason } from './database-helper.js';
import { fakeCloudflare, loginRole, recordingMailer, seedBrand, syntheticConfig } from './webinar-harness.js';
import { PgWebinarService } from '../../src/webinars/service.js';
import { CloudflareStreamClient } from '../../src/webinars/stream.js';
import { DEFAULT_SETTINGS, readSettings } from '../../src/webinars/types.js';
import { WebinarWorker } from '../../src/webinars/worker.js';

test('native webinar recovery: thrown dispatch cannot resend; polling upgrades an early recording without a webhook',
  { skip: testDatabaseSkipReason(), timeout: 300_000 }, async () => {
    const admin = await openTestDatabase();
    const content = await loginRole(admin, 'r72_content_command');
    try {
      const brand = await seedBrand(admin, 'Recovery');
      const config = syntheticConfig(brand.ws, null, 'https://app.example.test');
      const cf = fakeCloudflare();
      const stream = new CloudflareStreamClient(config.stream!, cf.fetch);
      let clock = Date.parse('2026-11-20T12:00:00Z');
      const svc = new PgWebinarService({ pool: content, config, stream, now: () => clock });
      const create = async (title: string) => {
        const id = await svc.create(brand.owner, randomUUID(), {
          kind: 'live', title, summary: 'Synthetic recovery fixture', presenterName: 'Test Host', presenterTitle: '',
          timezone: 'Europe/London', startsLocal: '2026-11-26T19:00', durationMinutes: 60, capacity: null,
          settings: readSettings({ ...DEFAULT_SETTINGS, reminderOffsetsMinutes: [] }),
        });
        await svc.setStatus(brand.owner, randomUUID(), id, 'publish');
        return { id, event: (await svc.get(brand.owner, randomUUID(), id)).event };
      };
      const emailEvent = await create('Dispatch exception fixture');
      const registration = await svc.register(emailEvent.event.publicKey, {
        email: 'allowed@example.test', name: 'Owner fixture', answers: {}, marketing: false, consent: {}, attribution: {},
      });
      let calls = 0;
      const throwing = new WebinarWorker({ pool: content, config, stream: null, now: () => clock,
        mailer: { send: async () => { calls++; throw new Error('Simulated failure after request handoff'); } } });
      await throwing.workspace(brand.ws);
      await throwing.workspace(brand.ws);
      assert.equal(calls, 1, 'an uncertain dispatch must not be requeued by the outer exception handler');
      clock += 3 * 60_000;
      await throwing.workspace(brand.ws);
      const message = await admin.query("SELECT state FROM app.webinar_jobs WHERE registration_id=$1 AND purpose='confirmation'", [registration.registrationId]);
      assert.equal(message.rows[0]?.state, 'unknown');
      assert.equal(calls, 1, 'reaping an uncertain call does not resend it');

      const live = await create('Polling recording fixture');
      await svc.provisionLiveInput(brand.owner, randomUUID(), live.id);
      const bound = (await svc.get(brand.owner, randomUUID(), live.id)).event;
      cf.liveInputs.get(bound.liveInputUid!)!.status = 'connected';
      clock = Date.parse('2026-11-26T18:55:00Z');
      await svc.refreshLive(brand.owner, randomUUID(), live.id);
      await svc.startSession(brand.owner, randomUUID(), live.id);
      clock += 5 * 60_000;
      await svc.endSession(brand.owner, randomUUID(), live.id);
      const recording = (uid: string, duration: number) => ({ uid, readyToStream: true, status: { state: 'ready' },
        duration, liveInput: bound.liveInputUid, created: new Date(clock).toISOString() });
      const short = randomUUID().replace(/-/g, '');
      cf.videos.set(short, recording(short, 20));
      // Ending a session schedules the first reconciliation one minute later.
      clock += 61_000;
      const poller = new WebinarWorker({ pool: content, config: { ...config, emailMode: 'off' }, stream,
        mailer: recordingMailer(), now: () => clock });
      await poller.workspace(brand.ws);
      assert.equal((await svc.get(brand.owner, randomUUID(), live.id)).event.recordingUid, short);
      const longer = randomUUID().replace(/-/g, '');
      cf.videos.set(longer, recording(longer, 290));
      clock += 61_000;
      await poller.workspace(brand.ws);
      const replay = (await svc.get(brand.owner, randomUUID(), live.id)).event;
      assert.equal(replay.recordingUid, longer, 'the longer replay must appear through polling alone');
      assert.equal(replay.recordingDurationSeconds, 290);
    } finally {
      await content.end();
      await admin.end();
    }
  });
