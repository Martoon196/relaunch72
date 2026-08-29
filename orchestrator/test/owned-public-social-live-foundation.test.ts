import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  OwnedPublicSocialLiveError,
  createAyrshareOwnedLiveTransport,
  decryptOwnedProfileKey,
  encryptOwnedProfileKey,
  loadOwnedPublicSocialLiveRuntimeConfig,
  runOwnedPublicSocialLiveOnce,
  type AyrshareOwnedResult,
  type OwnedPublicSocialClaim,
  type OwnedPublicSocialJobMaterial,
  type OwnedPublicSocialLiveRepository,
} from '../src/public-social-outbound/owned-live-foundation.js';

const IDS = Object.freeze({
  workspace: '11111111-1111-4111-8111-111111111111',
  connection: '22222222-2222-4222-8222-222222222222',
  profile: '33333333-3333-4333-8333-333333333333',
  job: '44444444-4444-4444-8444-444444444444',
});
const KEY = Buffer.alloc(32, 7);
const LEASE = Buffer.alloc(32, 9);
const PROFILE_KEY = 'AYRSHARE-PROFILE-KEY-OWNED-001';
const TEXT = 'Owned Property Predator X proof.';
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

const ENVELOPE = encryptOwnedProfileKey({
  workspaceId: IDS.workspace,
  connectionId: IDS.connection,
  profileId: IDS.profile,
  profileKey: PROFILE_KEY,
  keyVersion: 'render-kms-v1',
  encryptionKey: KEY,
  iv: Buffer.alloc(12, 3),
});

test('profile key envelope is deterministic under fixed IV and bound to the exact tenant tuple', () => {
  assert.equal(decryptOwnedProfileKey({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    profileId: IDS.profile,
    envelope: ENVELOPE,
    encryptionKey: KEY,
    expectedKeyVersion: 'render-kms-v1',
  }), PROFILE_KEY);
  assert.throws(() => decryptOwnedProfileKey({
    workspaceId: IDS.workspace,
    connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    profileId: IDS.profile,
    envelope: ENVELOPE,
    encryptionKey: KEY,
    expectedKeyVersion: 'render-kms-v1',
  }), (error: unknown) => error instanceof OwnedPublicSocialLiveError
    && error.code === 'invalid_binding');
  assert.throws(() => decryptOwnedProfileKey({
    workspaceId: IDS.workspace,
    connectionId: IDS.connection,
    profileId: IDS.profile,
    envelope: { ...ENVELOPE, ciphertextBase64: Buffer.from('tampered').toString('base64') },
    encryptionKey: KEY,
    expectedKeyVersion: 'render-kms-v1',
  }), OwnedPublicSocialLiveError);
});

test('runtime defaults dark and rejects every partial live switch combination', () => {
  assert.deepEqual(loadOwnedPublicSocialLiveRuntimeConfig({}), {
    executionMode: 'disabled', providerEffectsEnabled: false, emergencyPaused: true,
    providerId: 'ayrshare', network: 'x', maximumOperationsPerCycle: 1,
    dailyPublishCap: 1, monthlyPublishCap: 3,
  });
  for (const env of [
    { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' },
    { PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false' },
    { PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'owned_profile_live' },
    {
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'owned_profile_live',
      PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
      PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false',
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'ayrshare',
    },
  ]) assert.throws(() => loadOwnedPublicSocialLiveRuntimeConfig(env), OwnedPublicSocialLiveError);
});

test('bounded live transport exists only behind both switches and uses exact Ayrshare request contract', async () => {
  assert.throws(() => createAyrshareOwnedLiveTransport({
    fetch: async () => new Response(),
    secrets: { apiKey: 'api-key-12345678', xOAuth1ApiKey: 'x-key-12345678', xOAuth1ApiSecret: 'x-secret-12345678' },
    providerEffectsEnabled: true,
    emergencyPaused: true as false,
  }), OwnedPublicSocialLiveError);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = createAyrshareOwnedLiveTransport({
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        status: 'success', id: 'owned_proof_1',
        postIds: [{ status: 'success', id: 'x_post_1', platform: 'twitter' }],
      }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
    secrets: { apiKey: 'api-key-12345678', xOAuth1ApiKey: 'x-key-12345678', xOAuth1ApiSecret: 'x-secret-12345678' },
    providerEffectsEnabled: true,
    emergencyPaused: false,
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  });
  const result = await transport.publish({
    workspaceId: IDS.workspace, connectionId: IDS.connection, profileId: IDS.profile,
    profileKey: PROFILE_KEY, operationTag: 'pp-owned-proof-1',
    idempotencyKey: digest('one-operation'), text: TEXT, scheduledFor: null,
  });
  assert.equal(result.state, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.ayrshare.com/api/post');
  assert.equal(calls[0]?.init.redirect, 'error');
  assert.equal((calls[0]?.init.headers as Record<string, string>)['Profile-Key'], PROFILE_KEY);
  assert.match(String(calls[0]?.init.body), /"platforms":\["twitter"\]/u);
});

test('live transport rejects a simulator-shaped postIds object instead of treating it as proof', async () => {
  const transport = createAyrshareOwnedLiveTransport({
    fetch: async () => new Response(JSON.stringify({
      status: 'success', id: 'owned_proof_1', postIds: { twitter: 'x_post_1' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    secrets: { apiKey: 'api-key-12345678', xOAuth1ApiKey: 'x-key-12345678', xOAuth1ApiSecret: 'x-secret-12345678' },
    providerEffectsEnabled: true,
    emergencyPaused: false,
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  });
  const result = await transport.publish({
    workspaceId: IDS.workspace, connectionId: IDS.connection, profileId: IDS.profile,
    profileKey: PROFILE_KEY, operationTag: 'pp-owned-proof-1',
    idempotencyKey: digest('one-operation'), text: TEXT, scheduledFor: null,
  });
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.safeCode, 'ayrshare_acceptance_unproven');
});

test('scheduled acceptance compares UTC instants and reconciliation uses the documented history route', async () => {
  const calls: string[] = [];
  const transport = createAyrshareOwnedLiveTransport({
    fetch: async (input) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith('/api/post')
        ? new Response(JSON.stringify({
          status: 'scheduled', id: 'owned_proof_2', scheduleDate: '2026-08-30T10:00:00Z',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({
          status: 'success', id: 'owned_proof_2', post: TEXT, notes: 'pp-owned-proof-2',
          platforms: ['twitter'],
          postIds: [{ status: 'success', id: 'x_post_2', platform: 'twitter' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    secrets: { apiKey: 'api-key-12345678', xOAuth1ApiKey: 'x-key-12345678', xOAuth1ApiSecret: 'x-secret-12345678' },
    providerEffectsEnabled: true,
    emergencyPaused: false,
    now: () => new Date('2026-08-29T10:00:00.000Z'),
  });
  const scheduled = await transport.publish({
    workspaceId: IDS.workspace, connectionId: IDS.connection, profileId: IDS.profile,
    profileKey: PROFILE_KEY, operationTag: 'pp-owned-proof-2',
    idempotencyKey: digest('scheduled-operation'), text: TEXT,
    scheduledFor: '2026-08-30T10:00:00.000Z',
  });
  assert.equal(scheduled.state, 'accepted');
  const reconciled = await transport.reconcile({
    workspaceId: IDS.workspace, connectionId: IDS.connection, profileId: IDS.profile,
    profileKey: PROFILE_KEY, externalId: 'owned_proof_2', textSha256: digest(TEXT),
    operationTag: 'pp-owned-proof-2',
  });
  assert.equal(reconciled.state, 'published');
  assert.deepEqual(calls, [
    'https://api.ayrshare.com/api/post',
    'https://api.ayrshare.com/api/history/owned_proof_2',
  ]);
});

class MemoryRepository implements OwnedPublicSocialLiveRepository {
  readonly claim: OwnedPublicSocialClaim = Object.freeze({
    workspaceId: IDS.workspace, connectionId: IDS.connection, profileId: IDS.profile,
    jobId: IDS.job, leaseVersion: 1, attemptKind: 'publish',
  });
  calling = false;
  result: AyrshareOwnedResult | null = null;

  async claimOne(): Promise<OwnedPublicSocialClaim> { return this.claim; }
  async loadClaimed(): Promise<OwnedPublicSocialJobMaterial> {
    return Object.freeze({
      ...this.claim, envelope: ENVELOPE, operationTag: 'pp-owned-proof-1',
      idempotencyKey: digest('operation'), text: TEXT, textSha256: digest(TEXT),
      scheduledFor: null, externalId: null,
    });
  }
  async markCalling(): Promise<boolean> { this.calling = true; return true; }
  async settle(input: OwnedPublicSocialClaim & Readonly<{
    leaseToken: Buffer; result: AyrshareOwnedResult;
  }>): Promise<void> { this.result = input.result; }
}

test('one worker cycle marks the durable calling fence before the only provider invocation', async () => {
  const order: string[] = [];
  const repository = new MemoryRepository();
  const originalMark = repository.markCalling.bind(repository);
  repository.markCalling = async () => { order.push('calling'); return originalMark(); };
  const transport = {
    contract: 'propertypredator.owned-public-social-live/v1' as const,
    providerId: 'ayrshare' as const,
    executionMode: 'owned_profile_live' as const,
    async publish() {
      order.push('publish');
      assert.equal(repository.calling, true);
      return Object.freeze({
        state: 'accepted' as const, externalId: 'owned_1', receiptSha256: digest('receipt'),
        occurredAt: '2026-08-29T10:00:00.000Z', safeCode: 'ayrshare_accepted',
      });
    },
    async reconcile(): Promise<never> { throw new Error('not expected'); },
  };
  const result = await runOwnedPublicSocialLiveOnce({
    config: loadOwnedPublicSocialLiveRuntimeConfig({
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'owned_profile_live',
      PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
      PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false',
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'ayrshare',
      PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'x',
    }),
    repository, transport, encryptionKey: KEY, encryptionKeyVersion: 'render-kms-v1',
    leaseToken: LEASE,
  });
  assert.equal(result, 'published_or_pending');
  assert.deepEqual(order, ['calling', 'publish']);
  assert.equal(repository.result?.state, 'accepted');
});
