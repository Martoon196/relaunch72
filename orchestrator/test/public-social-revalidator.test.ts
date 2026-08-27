import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { PublicSocialJitRevalidator } from '../src/workers/public-social-revalidator/dispatcher.js';
import type {
  PublicSocialRevalidationClaim,
  PublicSocialRevalidationLease,
} from '../src/workers/public-social-revalidator/queue.js';
import {
  loadPublicSocialRevalidatorConfig,
  redactedPublicSocialRevalidatorErrorClass,
  startPublicSocialRevalidatorRunner,
} from '../src/workers/public-social-revalidator/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const WORKER = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const INTENT = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const VERSION = '88888888-8888-4888-8888-888888888888';
const SOURCE_VERSION = '99999999-9999-4999-8999-999999999999';
const SOURCE_APPROVAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROOF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHA = '1'.repeat(64);

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL:
      'postgresql://r72_public_social_revalidator_command:secret@database.example/relaunch72?sslmode=require',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_ENVIRONMENT: 'test',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'false',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'true',
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com',
    PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID: 'growth-hq-revalidator',
    PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN: 'r'.repeat(48),
    ...overrides,
  };
}

function fakePool(): {
  readonly pool: Pick<Pool, 'query' | 'connect' | 'end'>;
  readonly endCalls: () => number;
} {
  let ends = 0;
  return {
    pool: {
      async query() { throw new Error('unexpected direct query'); },
      async connect() { throw new Error('unexpected connect'); },
      async end() { ends += 1; },
    } as unknown as Pick<Pool, 'query' | 'connect' | 'end'>,
    endCalls: () => ends,
  };
}

function lease(): PublicSocialRevalidationLease {
  return Object.freeze({ workerId: WORKER, token: Buffer.alloc(32, 7) });
}

function claimed(): PublicSocialRevalidationClaim {
  return Object.freeze({
    jobId: JOB,
    workspaceId: WORKSPACE,
    intentId: INTENT,
    leaseVersion: 1,
    desiredFor: '2026-08-27T12:05:00.000Z',
    contentItemId: ITEM,
    contentVersionId: VERSION,
    sourceSystem: 'propertypredator.company-content',
    sourceItemId: 'media:campaign-1',
    sourceVersion: '1',
    sourceResourceVersionId: SOURCE_VERSION,
    sourceApprovalId: SOURCE_APPROVAL,
    sourceApprovedAt: '2026-08-27T10:00:00.000Z',
    contentSha256: SHA,
    blobSha256: SHA,
    brandSha256: SHA,
    media: Object.freeze([]),
  });
}

test('JIT revalidator config is exact, bounded and rejects provider-shaped capability', () => {
  assert.deepEqual(loadPublicSocialRevalidatorConfig(environment()), {
    installationId: INSTALLATION,
    sourceOrigin: 'https://propertypredator.com',
    sourceClientId: 'growth-hq-revalidator',
    sourceReadToken: 'r'.repeat(48),
    sourceTimeoutMs: 8_000,
    allowLocalHttp: false,
    pollIntervalMs: 1_000,
  });
  assert.equal(loadPublicSocialRevalidatorConfig(environment({
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_POLL_MS: '250',
    PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS: '500',
  })).sourceTimeoutMs, 500);

  const refused: ReadonlyArray<readonly [string, NodeJS.ProcessEnv, RegExp]> = [
    ['live environment', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_ENVIRONMENT: 'live' }, /environment=test/],
    ['provider effects', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true' }, /exactly false/],
    ['missing effects flag', { PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: undefined }, /exactly false/],
    ['released pause', { PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false' }, /emergency pause/],
    ['missing command database', { DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL: undefined }, /DATABASE_PUBLIC_SOCIAL_REVALIDATOR_URL is required/],
    ['legacy content database', { DATABASE_CONTENT_ADAPTER_URL: 'postgresql://r72_content_adapter:secret@database.example/relaunch72' }, /outside its exact role/],
    ['generic database', { DATABASE_URL: 'postgresql://owner:secret@database.example/relaunch72' }, /outside its exact role/],
    ['worker database', { DATABASE_PUBLIC_SOCIAL_WORKER_URL: 'postgresql://r72_public_social_worker_command:secret@database.example/relaunch72' }, /outside its exact role/],
    ['bad installation', { PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: 'not-a-uuid' }, /must be a UUID/],
    ['configured actor', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_USER_ID: '22222222-2222-4222-8222-222222222222' }, /forbids a configured human actor/],
    ['lookalike source host', { PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com.evil.example' }, /exact propertypredator\.com origin/],
    ['source path smuggling', { PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com/elsewhere' }, /exact propertypredator\.com origin/],
    ['fast spin', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_POLL_MS: '99' }, /100 to 60000/],
    ['slow spin', { PROPERTY_PREDATOR_PUBLIC_SOCIAL_REVALIDATOR_POLL_MS: '60001' }, /100 to 60000/],
    ['short source timeout', { PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS: '99' }, /100 to 10000/],
    ['long source timeout', { PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS: '10001' }, /100 to 10000/],
    ['Meta token', { META_ACCESS_TOKEN: 'secret' }, /provider or unrelated credential/],
    ['contained Meta token', { META_ACCESS_TOKEN_BACKUP: 'secret' }, /provider or unrelated credential/],
    ['contained password', { LEGACY_PASSWORD_COPY: 'secret' }, /provider or unrelated credential/],
    ['Ayrshare key', { AYRSHARE_API_KEY: 'secret' }, /provider or unrelated credential/],
    ['Mailgun secret', { MAILGUN_API_KEY: 'secret' }, /provider or unrelated credential/],
    ['generic session secret', { SESSION_SECRET: 'secret' }, /provider or unrelated credential/],
    ['local HTTP in production', {
      NODE_ENV: 'production',
      PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP: 'true',
    }, /forbidden in production/],
  ];
  for (const [name, override, expected] of refused) {
    assert.throws(() => loadPublicSocialRevalidatorConfig(environment(override)), expected, name);
  }
});

test('runner owns one exact function-only pool, reuses one lease and advertises zero provider capability', async () => {
  const command = fakePool();
  const checked: unknown[] = [];
  const installations: unknown[] = [];
  const leaseTokens: Buffer[] = [];
  const output: string[] = [];
  let cycles = 0;
  const runtime = await startPublicSocialRevalidatorRunner({
    env: environment(),
    autoStart: false,
    createRevalidatorPool: () => command.pool,
    assertSchemaCurrent: async (pool) => { checked.push(pool); },
    assertInstallationReady: async (pool, installation) => {
      installations.push([pool, installation]);
    },
    createTransport: () => Object.freeze({
      async loadVersion() { throw new Error('transport should not be called by this runner test'); },
      async loadAsset() { throw new Error('transport should not be called by this runner test'); },
    }),
    createLease: lease,
    createRevalidator: () => ({ async runOnce(current) {
      leaseTokens.push(Buffer.from(current.token));
      cycles += 1;
      return cycles === 1
        ? { disposition: 'materialized', jobId: JOB, postId: POST,
          state: 'materialized', operationCount: 1 } as const
        : { disposition: 'idle', jobId: null, postId: null, state: null } as const;
    } }),
    writeReadiness: (line) => { output.push(line); },
  });

  assert.deepEqual(checked, [command.pool]);
  assert.deepEqual(installations, [
    [command.pool, INSTALLATION],
  ]);
  assert.deepEqual(runtime.readiness.databaseRoles, [
    'r72_public_social_revalidator_command',
  ]);
  assert.deepEqual(runtime.readiness.safety, {
    providerEffectsEnabled: false,
    emergencyPaused: true,
    sourceTransportReadOnly: true,
    systemProofsLeaseBound: true,
    liveProviderAdapterLoaded: false,
    externalPublishAttempted: false,
  });
  assert.deepEqual(JSON.parse(output[0]!), runtime.readiness);
  assert.equal((await runtime.runOnce()).disposition, 'materialized');
  assert.equal((await runtime.runOnce()).disposition, 'idle');
  assert.deepEqual(leaseTokens[0], leaseTokens[1]);

  const firstShutdown = runtime.shutdown();
  assert.equal(firstShutdown, runtime.shutdown());
  await firstShutdown;
  await runtime.stopped;
  assert.equal(command.endCalls(), 1);
  await assert.rejects(runtime.runOnce(), /is stopping/);
});

test('JIT dispatcher materializes verified evidence and records fail-closed retry state', async () => {
  const current = claimed();
  const calls: string[] = [];
  const successful = new PublicSocialJitRevalidator({
    queue: {
      async claim(currentLease) { assert.equal(currentLease, currentLease); calls.push('claim'); return current; },
      async fail() { throw new Error('unexpected fail'); },
      async completeAndMaterialize(_claim, _lease, attestations, proofId, postId) {
        calls.push('materialize');
        assert.equal(attestations.content.sourceResourceVersionId, SOURCE_VERSION);
        assert.equal(proofId, PROOF);
        assert.equal(postId, POST);
        return { proofId, postId, operationIds: [OPERATION], disposition: 'applied' };
      },
    },
    attestor: { async attest(_claim, currentLease) {
      calls.push('attest');
      assert.deepEqual(currentLease, lease());
      return {
        sourceCatalogSha256: '2'.repeat(64),
        checkedAt: '2026-08-27T12:00:00.000Z',
        expiresAt: '2026-08-27T12:15:00.000Z',
        content: {
          sourceResourceVersionId: SOURCE_VERSION,
          sourceApprovalId: SOURCE_APPROVAL,
          sourceApprovedAt: '2026-08-27T10:00:00.000Z',
        },
        media: [],
      };
    } },
    nextId: (() => {
      const ids = [PROOF, POST];
      return () => ids.shift()!;
    })(),
  });
  assert.deepEqual(await successful.runOnce(lease()), {
    disposition: 'materialized', jobId: JOB, postId: POST,
    state: 'materialized', operationCount: 1,
  });
  assert.deepEqual(calls, ['claim', 'attest', 'materialize']);

  let failCode: string | undefined;
  const refused = new PublicSocialJitRevalidator({
    queue: {
      async claim() { return current; },
      async fail(_claim, _lease, code, retryable) {
        failCode = code;
        assert.equal(retryable, true);
        return 'retry_wait';
      },
      async completeAndMaterialize() { throw new Error('unexpected materialization'); },
    },
    attestor: { async attest() { throw new Error('owned source digest changed'); } },
  });
  assert.deepEqual(await refused.runOnce(lease()), {
    disposition: 'retry_planned', jobId: JOB, postId: null, state: 'retry_wait',
  });
  assert.equal(failCode, 'revalidation.source_or_proof_failed');
});

test('JIT runtime composition imports no provider SDK, registry or public effect worker', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources = [
    '../src/workers/public-social-revalidator/runner.ts',
    '../src/workers/public-social-revalidator/dispatcher.ts',
    '../src/workers/public-social-revalidator/queue.ts',
    '../src/workers/public-social-revalidator/source-attestor.ts',
  ].map((relative) => fs.readFileSync(path.resolve(here, relative), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /from ['"][^'"]*(?:ayrshare|hootsuite|buffer|facebook|linkedin|tiktok|twitter|instagram|mailgun)[^'"]*['"]/iu);
  assert.doesNotMatch(sources, /providers\/registry|public-social-test-rail|test-provider/iu);
  assert.doesNotMatch(sources, /r72_content_adapter|DATABASE_CONTENT_ADAPTER_URL|actorUserId/iu);
  assert.doesNotMatch(sources, /company_content_source_attestations|append-source-attestation/iu);
  assert.doesNotMatch(sources, /\b(?:fetch|request|post|put|patch|delete)\s*\(/iu);
  assert.match(sources, /externalPublishAttempted: false/u);
});

test('revalidator errors reduce to fixed classes without leaking source or database detail', () => {
  assert.equal(redactedPublicSocialRevalidatorErrorClass(new TypeError('secret')), 'TypeError');
  assert.equal(redactedPublicSocialRevalidatorErrorClass(new Error('postgresql://user:secret@db/private')), 'Error');
  assert.equal(redactedPublicSocialRevalidatorErrorClass({ message: 'token=secret' }), 'Error');
});
