import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverZernioCalendarRegistryTargets,
  startZernioCalendarLiveWorker,
  type ZernioCalendarRegistryTarget,
} from '../src/workers/zernio-calendar-live/runner.js';

const INSTALLATION = '11111111-1111-4111-8111-111111111111';
const PP_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const PP_CONNECTION = '33333333-3333-4333-8333-333333333333';
const BRAND_WORKSPACE = '44444444-4444-4444-8444-444444444444';
const BRAND_CONNECTION = '55555555-5555-4555-8555-555555555555';
const OTHER_WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OTHER_CONNECTION = '77777777-7777-4777-8777-777777777777';
const PP_INSTAGRAM = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PP_LINKEDIN = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const BRAND_LINKEDIN = 'cccccccccccccccccccccccc';
const OTHER_INSTAGRAM = 'dddddddddddddddddddddddd';
const OTHER_LINKEDIN = 'eeeeeeeeeeeeeeeeeeeeeeee';

function activeEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_OWNED_SOCIAL_WORKER_URL: 'postgresql://r72_owned_social_worker_command:secret@db.example/relaunch72?sslmode=require',
    PROPERTY_PREDATOR_DATABASE_INSTALLATION_ID: INSTALLATION,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_MODE: 'zernio_live',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_PROVIDER_ID: 'zernio',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_NETWORK: 'instagram_linkedin',
    PROPERTY_PREDATOR_PROVIDER_EFFECTS_ENABLED: 'true',
    PROPERTY_PREDATOR_SOCIAL_EMERGENCY_PAUSED: 'false',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_LIVE_WORKSPACE_ID: PP_WORKSPACE,
    PROPERTY_PREDATOR_ZERNIO_LIVE_CONNECTION_ID: PP_CONNECTION,
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_ORIGIN: 'https://hq.propertypredator.com',
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_SIGNING_KEY_BASE64URL: Buffer.alloc(32, 7).toString('base64url'),
    PROPERTY_PREDATOR_PUBLIC_SOCIAL_MEDIA_URL_TTL_SECONDS: '900',
    PROPERTY_PREDATOR_ZERNIO_INSTAGRAM_ACCOUNT_ID: PP_INSTAGRAM,
    PROPERTY_PREDATOR_ZERNIO_LINKEDIN_ACCOUNT_ID: PP_LINKEDIN,
    ZERNIO_API_KEY: 'zernio-owned-test-key',
  };
}

const targets: ZernioCalendarRegistryTarget[] = [
  { workspaceId: BRAND_WORKSPACE, connectionId: BRAND_CONNECTION, network: 'linkedin', providerAccountId: BRAND_LINKEDIN, dailyCap: 1, monthlyCap: 3 },
  { workspaceId: OTHER_WORKSPACE, connectionId: OTHER_CONNECTION, network: 'instagram', providerAccountId: OTHER_INSTAGRAM, dailyCap: 2, monthlyCap: 10 },
  { workspaceId: OTHER_WORKSPACE, connectionId: OTHER_CONNECTION, network: 'linkedin', providerAccountId: OTHER_LINKEDIN, dailyCap: 2, monthlyCap: 10 },
  // A registry row for PP's own workspace can never re-bind the pinned path.
  { workspaceId: PP_WORKSPACE, connectionId: PP_CONNECTION, network: 'linkedin', providerAccountId: 'ffffffffffffffffffffffff', dailyCap: 9, monthlyCap: 99 },
];

async function worker(overrides: Partial<Parameters<typeof startZernioCalendarLiveWorker>[0]> = {}) {
  const cycles: { workspaceId: string; connectionId: string; networks: readonly string[]; accounts: readonly string[]; result: 'idle' | 'published_or_pending' }[] = [];
  const postings: { accounts: readonly string[] }[] = [];
  const repositories: { workspaceId: string; connectionId: string }[] = [];
  const runtime = await startZernioCalendarLiveWorker({
    env: activeEnv(),
    autoStart: false,
    createPool: () => ({ query: async () => ({ rows: [] }), end: async () => undefined }) as never,
    assertSchemaCurrent: async () => undefined,
    assertInstallationReady: async () => undefined,
    assertBoundaryReady: async () => undefined,
    createRepository: (_pool, binding) => { repositories.push(binding); return binding as never; },
    createPosting: (input) => { postings.push({ accounts: input.accountBindings.map((b) => b.providerAccountId) }); return {} as never; },
    createMediaResolver: () => ({ resolve: async () => [] }),
    discoverRegistryTargets: async () => targets,
    randomToken: () => Buffer.alloc(32, 9),
    runCycle: async (input) => {
      const binding = input.repository as unknown as { workspaceId: string; connectionId: string };
      const result = binding.workspaceId === OTHER_WORKSPACE ? 'published_or_pending' : 'idle';
      cycles.push({ workspaceId: binding.workspaceId, connectionId: binding.connectionId, networks: input.config.networks, accounts: input.accountBindings.map((b) => b.providerAccountId), result });
      return result;
    },
    writeReadiness: () => undefined,
    ...overrides,
  });
  return { runtime, cycles, postings, repositories };
}

test('registry brands dispatch after the pinned PP cycle, each under its own workspace, connection, networks and posting targets', async () => {
  const w = await worker();
  assert.equal(w.postings.length, 1, 'only PP\'s posting client exists before any cycle');
  assert.equal(await w.runtime.runOnce(), 'published_or_pending');
  assert.deepEqual(w.cycles.map((c) => [c.workspaceId, c.connectionId, [...c.networks], [...c.accounts], c.result]), [
    [PP_WORKSPACE, PP_CONNECTION, ['instagram', 'linkedin'], [PP_INSTAGRAM, PP_LINKEDIN], 'idle'],
    [BRAND_WORKSPACE, BRAND_CONNECTION, ['linkedin'], [BRAND_LINKEDIN], 'idle'],
    [OTHER_WORKSPACE, OTHER_CONNECTION, ['instagram', 'linkedin'], [OTHER_INSTAGRAM, OTHER_LINKEDIN], 'published_or_pending'],
  ], 'one operation per cycle overall; the PP workspace registry row was ignored');
  assert.deepEqual(w.postings.slice(1).map((p) => [...p.accounts]), [[BRAND_LINKEDIN], [OTHER_INSTAGRAM, OTHER_LINKEDIN]], 'brand posting clients only know that brand\'s accounts');
  assert.deepEqual(w.repositories.slice(1), [
    { workspaceId: BRAND_WORKSPACE, connectionId: BRAND_CONNECTION },
    { workspaceId: OTHER_WORKSPACE, connectionId: OTHER_CONNECTION },
  ]);
  await w.runtime.shutdown();
});

test('a non-idle PP cycle never reaches the registry, and an empty registry leaves the worker idle', async () => {
  const busy = await worker({ runCycle: async () => 'failed_or_attention' });
  assert.equal(await busy.runtime.runOnce(), 'failed_or_attention');
  assert.equal(busy.postings.length, 1, 'no brand posting client was composed');
  await busy.runtime.shutdown();
  const empty = await worker({ discoverRegistryTargets: async () => [] });
  assert.equal(await empty.runtime.runOnce(), 'idle');
  assert.equal(empty.cycles.length, 1);
  await empty.runtime.shutdown();
});

test('registry discovery validates every row from the definer function and reads under the worker actor only', async () => {
  const statements: { sql: string; context: string[] }[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      statements.push({ sql, context: Array.isArray(values) ? values.map(String) : [] });
      if (sql.includes('seo_blog_social_dispatch_targets')) {
        return { rows: [{ workspace_id: BRAND_WORKSPACE, provider_connection_id: BRAND_CONNECTION, network: 'linkedin', provider_account_id: BRAND_LINKEDIN, daily_cap: 1, monthly_cap: 3 }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { connect: async () => client } as never;
  assert.deepEqual(await discoverZernioCalendarRegistryTargets(pool), [
    { workspaceId: BRAND_WORKSPACE, connectionId: BRAND_CONNECTION, network: 'linkedin', providerAccountId: BRAND_LINKEDIN, dailyCap: 1, monthlyCap: 3 },
  ]);
  const settings = statements.find((s) => s.sql.includes('app.actor_kind') || s.context.includes('worker'));
  assert.ok(settings, 'the transaction installed a worker actor context');
  assert.ok(statements.some((s) => /READ ONLY/u.test(s.sql)), 'discovery is read-only');
  const bad = { connect: async () => ({ ...client, async query(sql: string) { return sql.includes('dispatch_targets') ? { rows: [{ workspace_id: BRAND_WORKSPACE, provider_connection_id: BRAND_CONNECTION, network: 'linkedin', provider_account_id: BRAND_LINKEDIN, daily_cap: 0, monthly_cap: 3 }] } : { rows: [] }; } }) } as never;
  await assert.rejects(discoverZernioCalendarRegistryTargets(bad), /registry target is invalid/);
});
