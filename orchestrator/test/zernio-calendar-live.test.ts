import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadZernioCalendarRuntimeConfig,
  runZernioCalendarLiveOnce,
  ZernioCalendarLiveError,
  type ZernioCalendarClaim,
  type ZernioCalendarJobMaterial,
  type ZernioCalendarRepository,
  type ZernioCalendarSettlement,
} from '../src/public-social-outbound/zernio-calendar-live.js';
import { ZernioPostingError } from '../src/public-social-outbound/zernio-posting-client.js';

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const CONNECTION_ID = '00000000-0000-4000-8000-000000000002';
const BINDING_ID = '00000000-0000-4000-8000-000000000003';
const ACCOUNT_RECORD_ID = '00000000-0000-4000-8000-000000000004';
const JOB_ID = '00000000-0000-4000-8000-000000000005';
const ACCOUNT_ID = '6a95e99a77555aae01643ae2';
const ACCOUNT_SHA256 = 'efff87437248e73a0ef52699ae0ab60df78232e260292db862f546725c990580';
const TEXT = 'One postcode. One answer.';
const TEXT_SHA256 = '56d56fbdef8f68a3626efdd5a3b1b4c5ab6e4ca183f8ff149a2c8bb137aade54';
const LEASE = Buffer.alloc(32, 7);

const claim: ZernioCalendarClaim = Object.freeze({
  workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID,
  bindingId: BINDING_ID, accountRecordId: ACCOUNT_RECORD_ID,
  jobId: JOB_ID, leaseVersion: 1, attemptKind: 'publish', network: 'instagram',
});

const material: ZernioCalendarJobMaterial = Object.freeze({
  ...claim, providerAccountIdSha256: ACCOUNT_SHA256,
  operationTag: 'calendar:proof', text: TEXT, textSha256: TEXT_SHA256,
  scheduledFor: '2026-09-02T10:00:00.000Z', providerPostId: null,
  media: Object.freeze([Object.freeze({
    storageKey: 'approved/proof.png',
    blobSha256: '1'.repeat(64), mimeType: 'image/png',
  })]),
});

function activeConfig() {
  return loadZernioCalendarRuntimeConfig({
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'zernio_live',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'zernio',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'instagram',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false',
  });
}

function repository(input: Readonly<{
  selected?: ZernioCalendarClaim | null;
  loaded?: ZernioCalendarJobMaterial;
  calling?: boolean;
  settled: ZernioCalendarSettlement[];
}>): ZernioCalendarRepository {
  return Object.freeze({
    async claimOne() { return input.selected === undefined ? claim : input.selected; },
    async loadClaimed() { return input.loaded ?? material; },
    async markCalling() { return input.calling ?? true; },
    async settle(value: ZernioCalendarClaim & Readonly<{
      leaseToken: Buffer;
      result: ZernioCalendarSettlement;
    }>) { input.settled.push(value.result); },
  });
}

test('calendar is the clock and one approved Instagram job publishes now through Zernio', async () => {
  const settled: ZernioCalendarSettlement[] = [];
  let request: unknown;
  const result = await runZernioCalendarLiveOnce({
    config: activeConfig(),
    accountBindings: [{ network: 'instagram', providerAccountId: ACCOUNT_ID }],
    repository: repository({ settled }), leaseToken: LEASE,
    mediaResolver: { async resolve() { return ['https://media.propertypredator.com/approved/proof.png']; } },
    posting: {
      async publishDue(value) {
        request = value;
        return Object.freeze({
          providerPostId: '65f1c0a9e2b5af0012ab34cd', status: 'published' as const,
          platforms: Object.freeze([Object.freeze({
            network: 'instagram' as const, accountId: ACCOUNT_ID,
            status: 'published' as const,
            platformPostUrl: 'https://www.instagram.com/p/property-predator-proof/',
          })]),
          responseSha256: '2'.repeat(64), idempotentReplay: false,
        });
      },
      async reconcile() { throw new Error('not used'); },
    },
    now: () => new Date('2026-09-02T10:00:01.000Z'),
  });
  assert.equal(result, 'published_or_pending');
  assert.deepEqual(request, {
    requestId: JOB_ID, content: TEXT,
    targets: [{ network: 'instagram', accountId: ACCOUNT_ID }],
    mediaItems: [{ type: 'image', url: 'https://media.propertypredator.com/approved/proof.png' }],
  });
  assert.equal(settled[0]?.state, 'published');
  assert.equal(settled[0]?.safeCode, 'zernio_published');
});

test('fails before the provider call when the runtime account does not match database evidence', async () => {
  let called = false;
  await assert.rejects(
    runZernioCalendarLiveOnce({
      config: activeConfig(),
      accountBindings: [{ network: 'instagram', providerAccountId: '6a95e99a77555aae01643ae9' }],
      repository: repository({ settled: [] }), leaseToken: LEASE,
      mediaResolver: { async resolve() { return ['https://media.propertypredator.com/proof.png']; } },
      posting: {
        async publishDue() { called = true; throw new Error('must not run'); },
        async reconcile() { called = true; throw new Error('must not run'); },
      },
    }),
    (error: unknown) => error instanceof ZernioCalendarLiveError
      && error.code === 'invalid_binding',
  );
  assert.equal(called, false);
});

test('disabled posture rejects contradictory effects and a live cycle', async () => {
  assert.throws(() => loadZernioCalendarRuntimeConfig({
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'true',
  }), (error: unknown) => error instanceof ZernioCalendarLiveError
    && error.code === 'invalid_configuration');
  const disabled = loadZernioCalendarRuntimeConfig({
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'disabled',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'true',
  });
  await assert.rejects(runZernioCalendarLiveOnce({
    config: disabled,
    accountBindings: [{ network: 'instagram', providerAccountId: ACCOUNT_ID }],
    repository: repository({ settled: [] }), leaseToken: LEASE,
    mediaResolver: { async resolve() { return []; } },
    posting: {
      async publishDue() { throw new Error('not used'); },
      async reconcile() { throw new Error('not used'); },
    },
  }), (error: unknown) => error instanceof ZernioCalendarLiveError
    && error.code === 'disabled');
});

test('an ambiguous Zernio write is settled for reconciliation, never retried as a fresh post', async () => {
  const settled: ZernioCalendarSettlement[] = [];
  const result = await runZernioCalendarLiveOnce({
    config: activeConfig(),
    accountBindings: [{ network: 'instagram', providerAccountId: ACCOUNT_ID }],
    repository: repository({ settled }), leaseToken: LEASE,
    mediaResolver: { async resolve() { return ['https://media.propertypredator.com/proof.png']; } },
    posting: {
      async publishDue() {
        throw new ZernioPostingError('outcome_unknown');
      },
      async reconcile() { throw new Error('not used'); },
    },
  });
  assert.equal(result, 'failed_or_attention');
  assert.equal(settled[0]?.state, 'outcome_unknown');
  assert.equal(settled[0]?.safeCode, 'zernio_outcome_unknown');
});

test('a partial provider snapshot is held for attention instead of being retried as failed', async () => {
  const settled: ZernioCalendarSettlement[] = [];
  const result = await runZernioCalendarLiveOnce({
    config: activeConfig(),
    accountBindings: [{ network: 'instagram', providerAccountId: ACCOUNT_ID }],
    repository: repository({ settled }), leaseToken: LEASE,
    mediaResolver: { async resolve() { return ['https://media.propertypredator.com/proof.png']; } },
    posting: {
      async publishDue() {
        return Object.freeze({
          providerPostId: '65f1c0a9e2b5af0012ab34cd', status: 'partial' as const,
          platforms: Object.freeze([Object.freeze({
            network: 'instagram' as const, accountId: ACCOUNT_ID,
            status: 'published' as const,
            platformPostUrl: 'https://www.instagram.com/p/property-predator-proof/',
          })]),
          responseSha256: '3'.repeat(64), idempotentReplay: false,
        });
      },
      async reconcile() { throw new Error('not used'); },
    },
  });
  assert.equal(result, 'failed_or_attention');
  assert.equal(settled[0]?.state, 'outcome_unknown');
  assert.equal(settled[0]?.safeCode, 'zernio_partial');
});
