import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import { InactivePortalSessionError } from '../src/db/transaction.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import {
  createPgPortalBrandBrainService,
  PgPortalBrandBrainService,
  PgPortalBrandBrainWorkspaceAccessReader,
  type PgPortalBrandBrainDependencies,
} from '../src/portal/brand-brain-pg-service.js';
import type { PortalBrandBrainService } from '../src/portal/brand-brain-service.js';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
} from '../src/portal/product-profile.js';
import { buildPostgresPortalDeps } from '../src/portal/provision.js';

const SESSION = 'opaque-brand-brain-session';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const SNAPSHOT_AT = '2026-08-28T10:00:00.000Z';

function dependencies(
  overrides: Partial<PgPortalBrandBrainDependencies> = {},
): PgPortalBrandBrainDependencies {
  return {
    principalResolver: {
      resolve: async () => Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }),
    },
    accessReader: {
      load: async () => Object.freeze({
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Property Predator Growth HQ',
        snapshotAt: SNAPSHOT_AT,
        canManage: true,
      }),
    },
    readService: {
      latestSnapshot: async () => createPropertyPredatorBrandBrainFixture().brain,
    },
    ...overrides,
  };
}

test('PostgreSQL Brand Brain resolves one opaque session and projects metadata only', async () => {
  const contexts: DatabaseRequestContext[] = [];
  const service = new PgPortalBrandBrainService(dependencies({
    principalResolver: {
      async resolve(sessionToken) {
        assert.equal(sessionToken, SESSION);
        return Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID });
      },
    },
    accessReader: {
      async load(context) {
        contexts.push(context);
        return Object.freeze({
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Property Predator Growth HQ',
          snapshotAt: SNAPSHOT_AT,
          canManage: false,
        });
      },
    },
    readService: {
      async latestSnapshot(context) {
        contexts.push(context);
        const fixture = createPropertyPredatorBrandBrainFixture().brain;
        return {
          ...fixture,
          rawPrompt: 'DO-NOT-PROJECT-PROMPT',
          providerToken: 'DO-NOT-PROJECT-TOKEN',
          sources: [{
            ...fixture.sources[0]!,
            storageKey: 'DO-NOT-PROJECT-STORAGE-KEY',
          }],
          specialists: [{
            ...fixture.specialists[0]!,
            instructions: 'DO-NOT-PROJECT-INSTRUCTIONS',
          }],
        } as unknown as typeof fixture;
      },
    },
  }));

  const outcome = await service.snapshot({
    sessionToken: SESSION,
    requestId: 'brand-brain-request-1',
  });

  assert.equal(outcome.ok, true);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0], contexts[1], 'workspace and adapter reads share one resolved context');
  assert.equal(contexts[0]?.actorKind, 'user');
  assert.equal(contexts[0]?.userId, USER_ID);
  assert.equal(contexts[0]?.workspaceId, WORKSPACE_ID);
  assert.equal(contexts[0]?.requestId, 'brand-brain-request-1');
  assert.equal(
    contexts[0]?.portalSessionTokenHash?.toString('hex'),
    createHash('sha256').update(SESSION).digest('hex'),
  );
  if (!outcome.ok) return;
  assert.equal(outcome.snapshot.dataset, 'postgres_authoritative');
  assert.equal(outcome.snapshot.workspace.canManage, false);
  assert.equal(outcome.snapshot.brain.providerEffects, false);
  assert.equal(outcome.snapshot.externalProfiles.every((profile) => !profile.callable), true);
  assert.equal(outcome.snapshot.adaptedMethodPacks.length, 1);
  assert.equal(outcome.snapshot.adaptedMethodPacks[0]?.pack.handling.promptBodyAccess, 'forbidden');
  assert.equal(outcome.snapshot.adaptedMethodPacks[0]?.pack.handling.providerAccess, 'forbidden');
  const encoded = JSON.stringify(outcome.snapshot);
  assert.doesNotMatch(encoded, /DO-NOT-PROJECT/);
  assert.equal('generate' in service, false);
  assert.equal('activate' in service, false);
  assert.equal('publish' in service, false);
});

test('PostgreSQL Brand Brain fails closed before reading metadata for invalid access', async () => {
  let accessReads = 0;
  let brainReads = 0;
  const unauthenticated = new PgPortalBrandBrainService(dependencies({
    principalResolver: { resolve: async () => null },
    accessReader: { load: async () => { accessReads += 1; return null; } },
    readService: { latestSnapshot: async () => { brainReads += 1; return null; } },
  }));
  assert.deepEqual(await unauthenticated.snapshot({ sessionToken: SESSION, requestId: 'request-2' }), {
    ok: false,
    kind: 'unauthenticated',
    message: 'This portal session is no longer active.',
  });
  assert.equal(accessReads, 0);
  assert.equal(brainReads, 0);

  const forbidden = new PgPortalBrandBrainService(dependencies({
    accessReader: { load: async () => null },
    readService: { latestSnapshot: async () => { brainReads += 1; return null; } },
  }));
  const forbiddenOutcome = await forbidden.snapshot({ sessionToken: SESSION, requestId: 'request-3' });
  assert.equal(forbiddenOutcome.ok, false);
  if (forbiddenOutcome.ok) return;
  assert.equal(forbiddenOutcome.kind, 'forbidden');
  assert.equal(brainReads, 0);
});

test('PostgreSQL Brand Brain maps empty, malformed and database failures without leaking detail', async () => {
  const empty = new PgPortalBrandBrainService(dependencies({
    readService: { latestSnapshot: async () => null },
  }));
  const emptyOutcome = await empty.snapshot({ sessionToken: SESSION, requestId: 'request-4' });
  assert.equal(emptyOutcome.ok, false);
  if (!emptyOutcome.ok) assert.equal(emptyOutcome.kind, 'not_found');

  const fixture = createPropertyPredatorBrandBrainFixture().brain;
  const malformed = new PgPortalBrandBrainService(dependencies({
    readService: {
      latestSnapshot: async () => ({
        ...fixture,
        providerEffects: true,
      } as unknown as typeof fixture),
    },
  }));
  const malformedOutcome = await malformed.snapshot({ sessionToken: SESSION, requestId: 'request-5' });
  assert.equal(malformedOutcome.ok, false);
  if (!malformedOutcome.ok) assert.equal(malformedOutcome.kind, 'invalid_snapshot');

  const inactive = new PgPortalBrandBrainService(dependencies({
    readService: { latestSnapshot: async () => { throw new InactivePortalSessionError(); } },
  }));
  const inactiveOutcome = await inactive.snapshot({ sessionToken: SESSION, requestId: 'request-6' });
  assert.equal(inactiveOutcome.ok, false);
  if (!inactiveOutcome.ok) assert.equal(inactiveOutcome.kind, 'unauthenticated');

  const denied = new PgPortalBrandBrainService(dependencies({
    readService: { latestSnapshot: async () => { throw { code: '42501', detail: 'private' }; } },
  }));
  const deniedOutcome = await denied.snapshot({ sessionToken: SESSION, requestId: 'request-7' });
  assert.equal(deniedOutcome.ok, false);
  if (!deniedOutcome.ok) {
    assert.equal(deniedOutcome.kind, 'forbidden');
    assert.doesNotMatch(deniedOutcome.message, /private/);
  }
});

test('Brand Brain workspace reader validates the exact RLS workspace projection', async () => {
  const contexts: DatabaseRequestContext[] = [];
  const reader = new PgPortalBrandBrainWorkspaceAccessReader({
    async run(context, operation, options) {
      contexts.push(context);
      assert.deepEqual(options, { readOnly: true });
      return operation({
        query: async () => ({
          rows: [{
            workspaceId: WORKSPACE_ID,
            workspaceName: 'Property Predator Growth HQ',
            snapshotAt: new Date(SNAPSHOT_AT),
            canManage: true,
          }],
          rowCount: 1,
        }),
      } as never);
    },
  });
  const context = {
    actorKind: 'user',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    requestId: 'request-8',
    portalSessionTokenHash: Buffer.alloc(32, 1),
  } as const;
  assert.deepEqual(await reader.load(context), {
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Property Predator Growth HQ',
    snapshotAt: SNAPSHOT_AT,
    canManage: true,
  });
  assert.deepEqual(contexts, [context]);
});

test('production factory keeps session/workspace reads on web and Brand Brain reads on adapter', async () => {
  const fixture = createPropertyPredatorBrandBrainFixture().brain;
  const webSql: string[] = [];
  const adapterSql: string[] = [];
  let webReleases = 0;
  let adapterReleases = 0;

  function transactionClient(kind: 'web' | 'adapter') {
    const statements = kind === 'web' ? webSql : adapterSql;
    return {
      async query(sql: string) {
        statements.push(sql);
        if (sql.startsWith('BEGIN ') || sql === 'COMMIT' || sql === 'ROLLBACK'
            || sql.includes("set_config('app.user_id'")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('database.lock-portal-session')) {
          return { rows: [{ active: true }], rowCount: 1 };
        }
        if (kind === 'web' && sql.includes('portal.brand-brain.workspace-access')) {
          return {
            rows: [{
              workspaceId: WORKSPACE_ID,
              workspaceName: 'Property Predator Growth HQ',
              snapshotAt: new Date(SNAPSHOT_AT),
              canManage: true,
            }],
            rowCount: 1,
          };
        }
        if (kind === 'adapter' && sql.includes('brand-brain.latest-snapshot-release')) {
          return {
            rows: [{
              sourceReleaseId: fixture.sourceReleaseId,
              manifestSha256: fixture.manifestSha256,
              runtimeBrandSha256: fixture.runtimeBrandSha256,
              sourceCount: 1,
              specialistCount: 1,
              artworkCount: fixture.artworkCount,
              quarantineCount: fixture.quarantineCount,
              recordedAt: fixture.recordedAt,
              sourceFresh: fixture.sourceFresh,
              evaluationPassed: fixture.evaluationPassed,
              activated: fixture.activated,
              visualPolicyConflict: fixture.visualPolicyConflict,
            }],
            rowCount: 1,
          };
        }
        if (kind === 'adapter' && sql.includes('brand-brain.latest-snapshot-sources')) {
          return { rows: [fixture.sources[0]], rowCount: 1 };
        }
        if (kind === 'adapter' && sql.includes('brand-brain.latest-snapshot-specialists')) {
          return { rows: [fixture.specialists[0]], rowCount: 1 };
        }
        if (kind === 'adapter' && sql.includes('brand-brain.latest-snapshot-reviews')) {
          return {
            rows: fixture.reviews.map((review) => ({
              id: review.decisionId,
              dimension: review.dimension,
              decision: review.decision,
            })),
            rowCount: fixture.reviews.length,
          };
        }
        throw new Error(`unexpected ${kind} query`);
      },
      release() {
        if (kind === 'web') webReleases += 1;
        else adapterReleases += 1;
      },
    };
  }

  const service = createPgPortalBrandBrainService({
    webPool: {
      query: async (sql: string) => {
        webSql.push(sql);
        assert.match(sql, /portal\.crm\.resolve-session/);
        return {
          rows: [{ user_id: USER_ID, selected_workspace_id: WORKSPACE_ID }],
          rowCount: 1,
        };
      },
      connect: async () => transactionClient('web') as never,
    } as never,
    adapterPool: {
      connect: async () => transactionClient('adapter') as never,
    } as never,
  });

  const outcome = await service.snapshot({ sessionToken: SESSION, requestId: 'request-9' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.snapshot.dataset, 'postgres_authoritative');
  assert.equal(outcome.snapshot.brain.sources.length, 1);
  assert.equal(outcome.snapshot.brain.specialists.length, 1);
  assert.equal(webSql.some((sql) => sql.includes('brand-brain.latest-snapshot')), false);
  assert.equal(adapterSql.some((sql) => sql.includes('portal.brand-brain.workspace-access')), false);
  assert.equal(adapterSql.some((sql) => sql.includes('brand-brain.latest-snapshot-release')), true);
  assert.equal(webReleases, 1);
  assert.equal(adapterReleases, 1);
});

test('portal composition mounts Brand Brain only for the Property Predator Growth profile', () => {
  const brandBrain: PortalBrandBrainService = {
    snapshot: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
  const common = {
    sessionSecret: 'brand-brain-session-secret',
    secure: false,
    auth: {},
    crm: {},
    brandBrain,
    abuse: {
      admit: async () => ({ allowed: true, retryAfterSeconds: 0, leaseHash: null }),
      complete: async () => undefined,
    },
    requestContext: () => null,
    abuseHashSecret: 'brand-brain-abuse-secret-that-is-distinct',
  };
  assert.throws(() => buildPostgresPortalDeps({
    ...common,
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  } as never), /forbidden outside property_predator_growth/);
  const exact = buildPostgresPortalDeps({
    ...common,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
  } as never);
  assert.equal(exact.brandBrain, brandBrain);
});
