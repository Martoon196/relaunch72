import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PropertyPredatorContentSyncStatus } from '../src/company-content-sync/index.js';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  loadPropertyPredatorContentSyncSourceConfig,
  PgPortalCompanyContentSyncCommandGuard,
  PgPortalCompanyContentSyncLock,
  PgPortalCompanyContentSyncService,
  type PortalCompanyContentSyncLock,
} from '../src/portal/company-content-sync-pg-service.js';
import {
  COMPANY_CONTENT_SYNC_ROUTE,
  companyContentSyncCommandToken,
  companyContentSyncNoticeFromQuery,
  InMemoryCompanyContentSyncReplayGuard,
  verifyCompanyContentSyncCommandToken,
} from '../src/portal/company-content-sync-actions.js';
import type {
  PortalCompanyContentSyncOutcome,
  PortalCompanyContentSyncService,
  PortalCompanyContentSyncSnapshot,
} from '../src/portal/company-content-sync-service.js';
import { renderCompanyContentSyncBody } from '../src/portal/company-content-sync-view.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  propertyPredatorContentSyncSourceForProfile,
} from '../src/portal/postgres-platform.js';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
} from '../src/portal/product-profile.js';
import { buildPostgresPortalDeps } from '../src/portal/provision.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';

const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000002';
const NOW = '2026-08-28T10:00:00.000Z';
const SECRET = 'company-content-sync-router-secret';
const SESSION = Buffer.alloc(32, 61).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;

const acquiredSyncLock: PortalCompanyContentSyncLock = {
  async run(_workspaceId, operation) {
    return Object.freeze({ acquired: true as const, value: await operation() });
  },
};

const acceptedCommandGuard = {
  async consume() { return 'accepted' as const; },
};

function status(overrides: Partial<PropertyPredatorContentSyncStatus> = {}): PropertyPredatorContentSyncStatus {
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    state: 'current',
    lastAttemptAt: NOW,
    lastSuccessAt: NOW,
    nextRetryAt: null,
    sourceCheckedAt: NOW,
    sourceExpiresAt: '2026-08-28T10:10:00.000Z',
    sourceFresh: true,
    sourceCatalogSha256: 'a'.repeat(64),
    sourceReleaseSha256: 'b'.repeat(64),
    brandBrainPackageSha256: 'c'.repeat(64),
    counts: Object.freeze({
      sourceItems: 4,
      importedVersions: 2,
      refreshedAttestations: 2,
      unchangedVersions: 0,
      verifiedArtworkBytes: 1,
      quarantinedItems: 0,
      reviewIncompleteItems: 0,
      blockedItems: 0,
    }),
    blockers: Object.freeze([]),
    canRetry: true,
    exactContentBytesPersisted: true,
    artworkBytesCopied: false,
    customerPrivateDataAccepted: false,
    affiliateContentAccepted: false,
    providerEffects: false,
    ...overrides,
  });
}

function portalSnapshot(
  overrides: Partial<PropertyPredatorContentSyncStatus> = {},
): PortalCompanyContentSyncSnapshot {
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: NOW,
      canManage: true,
    }),
    sync: status(overrides),
    dataset: 'postgres_authoritative' as const,
    providerEffects: false as const,
  });
}

const routerAuth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: USER_ID,
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const routerCrm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: NOW,
      canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: NOW,
      canWrite: true,
    },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function routerDeps(
  companyContentSync: PortalCompanyContentSyncService,
  overrides: Partial<PostgresPortalDeps> = {},
): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    now: () => Date.parse(NOW),
    requestId: () => 'company-content-sync-router-request',
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth: routerAuth,
    crm: routerCrm,
    companyContentSync,
    ...overrides,
  };
}

function routerService(input: Readonly<{
  snapshots?: unknown[];
  syncs?: unknown[];
  snapshotOutcome?: PortalCompanyContentSyncOutcome;
  syncOutcome?: PortalCompanyContentSyncOutcome;
}> = {}): PortalCompanyContentSyncService {
  const safe = Object.freeze({ ok: true as const, snapshot: portalSnapshot() });
  const consumed = new Set<string>();
  return {
    async snapshot(identity) {
      input.snapshots?.push(identity);
      return input.snapshotOutcome ?? safe;
    },
    async sync(identity) {
      if (consumed.has(identity.requestId)) {
        return Object.freeze({
          ok: false as const,
          kind: 'replayed' as const,
          message: 'That protected source-sync command was already consumed.',
        });
      }
      consumed.add(identity.requestId);
      input.syncs?.push(identity);
      return input.syncOutcome ?? safe;
    },
  };
}

function routerRequest(
  url: string,
  method = 'GET',
  cookie?: string,
  body = '',
  contentType = 'application/x-www-form-urlencoded',
) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = {
    ...(cookie ? { cookie } : {}),
    ...(body ? {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(body)),
    } : {}),
  };
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function routerResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string) { if (body) this.body = body; },
  };
}

async function routerCall(
  url: string,
  deps: PostgresPortalDeps,
  cookie?: string,
  method = 'GET',
  body = '',
  contentType = 'application/x-www-form-urlencoded',
) {
  const res = routerResponse();
  await handlePortal(
    routerRequest(url, method, cookie, body, contentType) as never,
    res as never,
    deps,
  );
  return res;
}

test('source config is optional only when wholly absent and exact when present', () => {
  assert.equal(loadPropertyPredatorContentSyncSourceConfig({}), undefined);
  assert.throws(() => loadPropertyPredatorContentSyncSourceConfig({
    PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS: '8000',
  }), /incomplete/);
  assert.throws(() => loadPropertyPredatorContentSyncSourceConfig({
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com',
  }), /incomplete/);
  assert.throws(() => loadPropertyPredatorContentSyncSourceConfig({
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com.evil.example',
    PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID: 'growth-hq',
    PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN: 'x'.repeat(48),
  }), /exact propertypredator\.com origin/);
  assert.throws(() => loadPropertyPredatorContentSyncSourceConfig({
    NODE_ENV: 'production',
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'http://127.0.0.1:3000',
    PROPERTY_PREDATOR_COMPANY_CONTENT_ALLOW_LOCAL_HTTP: 'true',
    PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID: 'growth-hq',
    PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN: 'x'.repeat(48),
  }), /forbidden in production/);
  assert.deepEqual(loadPropertyPredatorContentSyncSourceConfig({
    NODE_ENV: 'production',
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com',
    PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID: 'growth-hq',
    PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN: 'x'.repeat(48),
    PROPERTY_PREDATOR_COMPANY_CONTENT_TIMEOUT_MS: '9000',
  }), {
    sourceOrigin: 'https://propertypredator.com',
    sourceClientId: 'growth-hq',
    sourceReadToken: 'x'.repeat(48),
    sourceTimeoutMs: 9000,
    allowLocalHttp: false,
  });
});

test('source composition is forbidden outside the exact Property Predator Growth profile', () => {
  const source = {
    PROPERTY_PREDATOR_COMPANY_CONTENT_ORIGIN: 'https://propertypredator.com',
    PROPERTY_PREDATOR_COMPANY_CONTENT_CLIENT_ID: 'relaunch72',
    PROPERTY_PREDATOR_COMPANY_CONTENT_READ_TOKEN: 'x'.repeat(48),
  };
  assert.throws(() => propertyPredatorContentSyncSourceForProfile({
    ...source,
    PORTAL_PRODUCT_PROFILE: 'relaunch72',
  }), /forbidden outside property_predator_growth/);
  assert.equal(propertyPredatorContentSyncSourceForProfile({
    PORTAL_PRODUCT_PROFILE: 'relaunch72',
  }), undefined);
  assert.deepEqual(propertyPredatorContentSyncSourceForProfile({
    ...source,
    PORTAL_PRODUCT_PROFILE: 'property_predator_growth',
  }), {
    sourceOrigin: 'https://propertypredator.com',
    sourceClientId: 'relaunch72',
    sourceReadToken: 'x'.repeat(48),
    sourceTimeoutMs: 8000,
    allowLocalHttp: false,
  });
});

test('portal composition rejects an injected Source Sync service outside the branded profile', () => {
  const service = routerService();
  const common = {
    sessionSecret: SECRET,
    secure: false,
    auth: routerAuth,
    crm: routerCrm,
    companyContentSync: service,
    abuse: {
      admit: async () => ({ allowed: true, retryAfterSeconds: 0, leaseHash: null }),
      complete: async () => undefined,
    },
    requestContext: () => null,
    abuseHashSecret: 'portal-abuse-hash-secret-that-is-distinct',
  };
  assert.throws(() => buildPostgresPortalDeps({
    ...common,
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  } as never), /forbidden outside property_predator_growth/);
  const exact = buildPostgresPortalDeps({
    ...common,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
  } as never);
  assert.equal(exact.companyContentSync, service);
});

test('operator service consumes the active session before passing a session-free adapter context', async () => {
  const captured: DatabaseRequestContext[] = [];
  const guarded: DatabaseRequestContext[] = [];
  const service = new PgPortalCompanyContentSyncService({
    commandGuard: {
      async consume(context) {
        guarded.push(context);
        return 'accepted';
      },
    },
    syncLock: acquiredSyncLock,
    principalResolver: {
      async resolve(sessionToken) {
        assert.equal(sessionToken, 'opaque-session');
        return Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID });
      },
    },
    accessReader: {
      async load(context) {
        assert.equal(context.workspaceId, WORKSPACE_ID);
        return Object.freeze({
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Property Predator',
          snapshotAt: NOW,
          canManage: true,
        });
      },
    },
    coordinator: {
      snapshot() { throw new Error('unexpected snapshot'); },
      async sync(context) {
        captured.push(context);
        return status();
      },
    },
  });

  const result = await service.sync({ sessionToken: 'opaque-session', requestId: 'portal-sync-1' });
  assert.equal(result.ok, true);
  const exactContext = captured[0];
  assert.ok(exactContext);
  assert.equal(exactContext.actorKind, 'user');
  assert.equal(exactContext.workspaceId, WORKSPACE_ID);
  assert.equal(exactContext.userId, USER_ID);
  assert.equal(exactContext.requestId, 'portal-sync-1');
  assert.equal(exactContext.portalSessionTokenHash, undefined);
  assert.equal(guarded[0]?.portalSessionTokenHash?.length, 32);
  assert.notEqual(guarded[0]?.portalSessionTokenHash?.toString('utf8'), 'opaque-session');
  if (result.ok) {
    assert.equal(result.snapshot.providerEffects, false);
    assert.equal(result.snapshot.sync.artworkBytesCopied, false);
  }
});

test('durable command consumption blocks a replay after the source is withdrawn', async () => {
  const consumed = new Set<string>();
  let sourceReads = 0;
  let lockCalls = 0;
  const service = new PgPortalCompanyContentSyncService({
    commandGuard: {
      async consume(context) {
        if (consumed.has(context.requestId)) return 'replayed';
        consumed.add(context.requestId);
        return 'accepted';
      },
    },
    syncLock: {
      async run(_workspaceId, operation) {
        lockCalls += 1;
        return Object.freeze({ acquired: true as const, value: await operation() });
      },
    },
    principalResolver: {
      async resolve() { return Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }); },
    },
    accessReader: {
      async load() {
        return Object.freeze({
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Property Predator',
          snapshotAt: NOW,
          canManage: true,
        });
      },
    },
    coordinator: {
      snapshot() { throw new Error('unexpected snapshot'); },
      async sync() {
        sourceReads += 1;
        return status({ state: 'retry_wait', sourceFresh: false });
      },
    },
  });
  const identity = {
    sessionToken: 'opaque-session',
    requestId: 'company-content-sync-withdrawn-source',
  };
  const first = await service.sync(identity);
  const replay = await service.sync(identity);
  assert.equal(first.ok, true);
  assert.deepEqual(replay, {
    ok: false,
    kind: 'replayed',
    message: 'That protected source-sync command was already consumed.',
  });
  assert.equal(sourceReads, 1);
  assert.equal(lockCalls, 1, 'replay must stop before a source-owning workspace lock');
});

test('operator service denies non-admins before the source coordinator is touched', async () => {
  let touched = false;
  const service = new PgPortalCompanyContentSyncService({
    commandGuard: acceptedCommandGuard,
    syncLock: acquiredSyncLock,
    principalResolver: {
      async resolve() { return Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }); },
    },
    accessReader: {
      async load() {
        return Object.freeze({
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Property Predator',
          snapshotAt: NOW,
          canManage: false,
        });
      },
    },
    coordinator: {
      snapshot() { touched = true; return status(); },
      async sync() { touched = true; return status(); },
    },
  });
  const result = await service.sync({ sessionToken: 'opaque-session', requestId: 'portal-sync-2' });
  assert.deepEqual(result, {
    ok: false,
    kind: 'forbidden',
    message: 'Founder or workspace-admin access is required for source sync.',
  });
  assert.equal(touched, false);
});

test('operator service returns a safe conflict without touching the coordinator when workspace is locked', async () => {
  let touched = false;
  const service = new PgPortalCompanyContentSyncService({
    commandGuard: acceptedCommandGuard,
    syncLock: {
      async run(workspaceId) {
        assert.equal(workspaceId, WORKSPACE_ID);
        return Object.freeze({ acquired: false as const });
      },
    },
    principalResolver: {
      async resolve() { return Object.freeze({ userId: USER_ID, workspaceId: WORKSPACE_ID }); },
    },
    accessReader: {
      async load() {
        return Object.freeze({
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Property Predator',
          snapshotAt: NOW,
          canManage: true,
        });
      },
    },
    coordinator: {
      snapshot() { touched = true; return status(); },
      async sync() { touched = true; return status(); },
    },
  });
  assert.deepEqual(
    await service.sync({ sessionToken: 'opaque-session', requestId: 'portal-sync-locked' }),
    {
      ok: false,
      kind: 'conflict',
      message: 'Another protected source sync is already running for this workspace.',
    },
  );
  assert.equal(touched, false);
});

test('workspace advisory lock pins one transaction around the whole operation and always releases it', async () => {
  const queries: Array<Readonly<{ sql: string; values?: readonly unknown[] }>> = [];
  const releases: unknown[] = [];
  let operationRan = false;
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, ...(values ? { values } : {}) });
      if (sql.includes('workspace-lock')) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    release(destroy?: boolean) { releases.push(destroy); },
  };
  const lock = new PgPortalCompanyContentSyncLock({
    async connect() { return client; },
  } as never);
  const result = await lock.run(WORKSPACE_ID, async () => {
    operationRan = true;
    assert.equal(queries.length, 2, 'lock must be held before the sync starts');
    return 'done';
  });
  assert.deepEqual(result, { acquired: true, value: 'done' });
  assert.equal(operationRan, true);
  assert.equal(queries.length, 3);
  assert.match(queries[0]!.sql, /BEGIN/);
  assert.match(queries[1]!.sql, /pg_try_advisory_xact_lock/);
  assert.deepEqual(queries[1]!.values, [WORKSPACE_ID]);
  assert.match(queries[2]!.sql, /ROLLBACK/);
  assert.deepEqual(releases, [false]);
});

test('PostgreSQL command guard commits durable consumption before returning accepted', async () => {
  const queries: Array<Readonly<{ sql: string; values?: readonly unknown[] }>> = [];
  const releases: unknown[] = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, ...(values ? { values } : {}) });
      if (sql.includes('consume-command')) return { rows: [{ disposition: 'accepted' }] };
      return { rows: [] };
    },
    release(destroy?: boolean) { releases.push(destroy); },
  };
  const guard = new PgPortalCompanyContentSyncCommandGuard({
    async connect() { return client; },
  } as never);
  const disposition = await guard.consume({
    actorKind: 'user',
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'company-content-sync-durable-command',
    portalSessionTokenHash: Buffer.alloc(32, 73),
  });
  assert.equal(disposition, 'accepted');
  assert.match(queries[0]!.sql, /BEGIN/);
  assert.doesNotMatch(queries.map(({ sql }) => sql).join('\n'), /lock-portal-session/);
  assert.match(queries[1]!.sql, /set_config/);
  assert.match(queries[2]!.sql, /consume_company_content_sync_command/);
  assert.deepEqual(queries[2]!.values, [
    WORKSPACE_ID,
    Buffer.alloc(32, 73),
    'company-content-sync-durable-command',
  ]);
  assert.match(queries[3]!.sql, /COMMIT/);
  assert.deepEqual(releases, [false]);
});

test('workspace advisory lock skips a competing operation and destroys a connection when release fails', async () => {
  let operationRan = false;
  const releases: unknown[] = [];
  let rollbackFails = false;
  const client = {
    async query(sql: string) {
      if (sql.includes('workspace-lock')) return { rows: [{ acquired: false }] };
      if (sql.includes('lock-release') && rollbackFails) throw new Error('rollback failed');
      return { rows: [] };
    },
    release(destroy?: boolean) { releases.push(destroy); },
  };
  const lock = new PgPortalCompanyContentSyncLock({
    async connect() { return client; },
  } as never);
  assert.deepEqual(await lock.run(WORKSPACE_ID, async () => {
    operationRan = true;
    return 'never';
  }), { acquired: false });
  assert.equal(operationRan, false);
  assert.deepEqual(releases, [false]);

  rollbackFails = true;
  assert.deepEqual(await lock.run(WORKSPACE_ID, async () => 'never'), { acquired: false });
  assert.deepEqual(releases, [false, true]);
});

test('status view exposes freshness, retry and safe why-blocked copy without effect controls', () => {
  const sync = status({
    state: 'retry_wait',
    sourceFresh: false,
    canRetry: false,
    nextRetryAt: '2026-08-28T10:00:05.000Z',
    counts: Object.freeze({
      sourceItems: 7,
      importedVersions: 0,
      refreshedAttestations: 0,
      unchangedVersions: 1,
      verifiedArtworkBytes: 8,
      quarantinedItems: 2,
      reviewIncompleteItems: 3,
      blockedItems: 1,
    }),
    blockers: Object.freeze([Object.freeze({
      code: 'source_unavailable',
      itemRef: '<private-source>',
      message: 'The owned source could not be checked safely.',
      retryable: true,
    })]),
  });
  const snapshot: PortalCompanyContentSyncSnapshot = Object.freeze({
    workspace: Object.freeze({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Property Predator',
      snapshotAt: NOW,
      canManage: true,
    }),
    sync,
    dataset: 'postgres_authoritative',
    providerEffects: false,
  });
  const html = renderCompanyContentSyncBody(snapshot, {
    csrfToken: 'csrf-safe-test-token',
    commandToken: 'command-safe-test-token-that-is-long-enough',
    companyAssetsAvailable: true,
    brandBrainAvailable: true,
  });

  assert.match(html, /Source Sync/);
  assert.match(html, /retry window active/i);
  assert.match(html, /why anything is blocked/i);
  assert.match(html, /source unavailable/i);
  assert.match(html, /&lt;private-source&gt;/);
  assert.match(html, /Blocked \/ quarantined<\/span><strong>6<\/strong>/);
  assert.match(html, /8 verified · 0 copied/);
  assert.match(html, /providerEffects=false/);
  assert.match(html, /customer-private accepted: no/i);
  assert.match(html, /artwork bytes are verified in memory and never copied/i);
  assert.doesNotMatch(html, /name="provider|name="recipient|name="message/i);
});

test('Source Sync route requires authentication and the exact Property Predator Growth composition', async () => {
  const snapshots: unknown[] = [];
  const service = routerService({ snapshots });
  const unauthenticated = await routerCall(
    COMPANY_CONTENT_SYNC_ROUTE,
    routerDeps(service),
  );
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');
  assert.equal(snapshots.length, 0);

  const wrongProduct = await routerCall(
    COMPANY_CONTENT_SYNC_ROUTE,
    routerDeps(service, { productProfile: RELAUNCH72_PRODUCT_PROFILE }),
    COOKIE,
  );
  assert.equal(wrongProduct.statusCode, 404);
  assert.doesNotMatch(wrongProduct.body, /Effects-off operator sync/);
  assert.equal(snapshots.length, 0);

  const unsupported = await routerCall(
    COMPANY_CONTENT_SYNC_ROUTE,
    routerDeps(service),
    COOKIE,
    'PUT',
  );
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.allow, 'GET, POST');
  assert.equal(snapshots.length, 0);
});

test('Source Sync GET renders one signed command, scoped navigation and no effect controls', async () => {
  const snapshots: unknown[] = [];
  const result = await routerCall(
    COMPANY_CONTENT_SYNC_ROUTE,
    routerDeps(routerService({ snapshots })),
    COOKIE,
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /aria-current="page">Source Sync/);
  assert.match(result.body, /name="_csrf" value="[A-Za-z0-9_-]{43}"/);
  assert.match(result.body, /name="command_token" value="[A-Za-z0-9_-]{16,128}~[0-9a-z]{1,11}\.[A-Za-z0-9_-]{43}"/);
  assert.match(result.body, /data-provider-effects="none"/);
  assert.doesNotMatch(result.body, /name="provider|name="recipient|name="message|Publish now/i);
  assert.deepEqual(snapshots, [{
    sessionToken: SESSION,
    requestId: 'company-content-sync-router-request',
  }]);
});

test('Source Sync POST is strict, CSRF-bound and uses POST-303-GET without refresh replay', async () => {
  const snapshots: unknown[] = [];
  const syncs: unknown[] = [];
  const service = routerService({ snapshots, syncs });
  const commandKey = 'company-content-sync-command-0001';
  const body = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_token: companyContentSyncCommandToken(SECRET, SESSION, commandKey, Date.parse(NOW)),
  }).toString();
  const posted = await routerCall(
    COMPANY_CONTENT_SYNC_ROUTE,
    routerDeps(service),
    COOKIE,
    'POST',
    body,
  );
  assert.equal(posted.statusCode, 303);
  assert.match(posted.headers.location ?? '', /^\/portal\/content\/source-sync\?notice=synced\./);
  assert.equal(posted.headers['cache-control'], 'no-store');
  assert.deepEqual(syncs, [{ sessionToken: SESSION, requestId: commandKey }]);
  assert.equal(snapshots.length, 0);

  const followed = await routerCall(
    posted.headers.location!,
    routerDeps(service),
    COOKIE,
  );
  assert.equal(followed.statusCode, 200);
  assert.match(followed.body, /Owned-content proof refreshed/);
  assert.equal(syncs.length, 1);
  assert.equal(snapshots.length, 1);

  const refreshed = await routerCall(
    posted.headers.location!,
    routerDeps(service),
    COOKIE,
  );
  assert.equal(refreshed.statusCode, 200);
  assert.equal(syncs.length, 1, 'refreshing the GET receipt must never resubmit the sync');
  assert.equal(snapshots.length, 2);
});

test('Source Sync consumes one short-lived command once before any sequential replay can read the source', async () => {
  const syncs: unknown[] = [];
  const service = routerService({ syncs });
  const deps = routerDeps(service);
  const commandKey = 'company-content-sync-command-replay';
  const command = companyContentSyncCommandToken(
    SECRET,
    SESSION,
    commandKey,
    Date.parse(NOW),
  );
  const body = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_token: command,
  }).toString();

  const first = await routerCall(COMPANY_CONTENT_SYNC_ROUTE, deps, COOKIE, 'POST', body);
  const replay = await routerCall(COMPANY_CONTENT_SYNC_ROUTE, deps, COOKIE, 'POST', body);

  assert.equal(first.statusCode, 303);
  assert.match(first.headers.location ?? '', /\?notice=synced\./);
  assert.equal(replay.statusCode, 303);
  assert.match(replay.headers.location ?? '', /\?notice=replayed\./);
  assert.deepEqual(syncs, [{ sessionToken: SESSION, requestId: commandKey }]);
  const replayNotice = new URL(replay.headers.location!, 'https://hq.propertypredator.test');
  assert.match(
    companyContentSyncNoticeFromQuery(replayNotice.searchParams, SECRET, SESSION)?.message ?? '',
    /No duplicate source read or sync started/,
  );
});

test('Source Sync command proof rejects expired and materially future issue times', () => {
  const now = Date.parse(NOW);
  const key = 'company-content-sync-command-expiry';
  const expired = companyContentSyncCommandToken(SECRET, SESSION, key, now - 10 * 60_000 - 1);
  const future = companyContentSyncCommandToken(SECRET, SESSION, key, now + 30_001);
  assert.equal(verifyCompanyContentSyncCommandToken(SECRET, SESSION, expired, now), null);
  assert.equal(verifyCompanyContentSyncCommandToken(SECRET, SESSION, future, now), null);
});

test('explicit in-memory test fallback fails closed at capacity without evicting a live command', () => {
  const now = Date.parse(NOW);
  const guard = new InMemoryCompanyContentSyncReplayGuard();
  const originalKey = 'company-content-sync-capacity-original';
  assert.equal(guard.consume(SESSION, originalKey, now), 'accepted');
  for (let index = 1; index < 2_048; index += 1) {
    assert.equal(
      guard.consume(SESSION, `company-content-sync-capacity-${index.toString().padStart(4, '0')}`, now),
      'accepted',
    );
  }
  assert.equal(guard.consume(SESSION, originalKey, now), 'replayed');

  const saturatedKey = 'company-content-sync-capacity-new';
  assert.equal(guard.consume(SESSION, saturatedKey, now), 'saturated');
  assert.equal(guard.consume(SESSION, originalKey, now), 'replayed');
});

test('Source Sync POST rejects missing, duplicate, forged and extra singleton fields before service invocation', async () => {
  const syncs: unknown[] = [];
  const service = routerService({ syncs });
  const csrf = portalCsrfToken(SECRET, SESSION);
  const command = companyContentSyncCommandToken(
    SECRET,
    SESSION,
    'company-content-sync-command-0002',
    Date.parse(NOW),
  );
  const cases = [
    new URLSearchParams({ command_token: command }),
    new URLSearchParams({ _csrf: 'forged', command_token: command }),
    new URLSearchParams({ _csrf: csrf, command_token: `${command}forged` }),
    new URLSearchParams({ _csrf: csrf, command_token: command, workspace_id: WORKSPACE_ID }),
    new URLSearchParams([['_csrf', csrf], ['_csrf', csrf], ['command_token', command]]),
    new URLSearchParams([['_csrf', csrf], ['command_token', command], ['command_token', command]]),
  ];
  for (const fields of cases) {
    const result = await routerCall(
      COMPANY_CONTENT_SYNC_ROUTE,
      routerDeps(service),
      COOKIE,
      'POST',
      fields.toString(),
    );
    assert.equal(result.statusCode, 303);
    assert.match(result.headers.location ?? '', /\?notice=invalid\./);
  }
  const wrongMedia = await routerCall(
    COMPANY_CONTENT_SYNC_ROUTE,
    routerDeps(service),
    COOKIE,
    'POST',
    JSON.stringify({ _csrf: csrf, command_token: command }),
    'application/json',
  );
  assert.equal(wrongMedia.statusCode, 303);
  assert.match(wrongMedia.headers.location ?? '', /\?notice=invalid\./);
  assert.equal(syncs.length, 0);
});

test('Source Sync conflict and notice evidence remain signed and session-bound', async () => {
  const syncs: unknown[] = [];
  const service = routerService({
    syncs,
    syncOutcome: {
      ok: false,
      kind: 'conflict',
      message: 'Another protected source sync is already running for this workspace.',
    },
  });
  const posted = await routerCall(
    COMPANY_CONTENT_SYNC_ROUTE,
    routerDeps(service),
    COOKIE,
    'POST',
    new URLSearchParams({
      _csrf: portalCsrfToken(SECRET, SESSION),
      command_token: companyContentSyncCommandToken(
        SECRET,
        SESSION,
        'company-content-sync-command-0003',
        Date.parse(NOW),
      ),
    }).toString(),
  );
  assert.equal(posted.statusCode, 303);
  assert.match(posted.headers.location ?? '', /\?notice=busy\./);
  const noticeUrl = new URL(posted.headers.location!, 'https://hq.propertypredator.test');
  assert.match(
    companyContentSyncNoticeFromQuery(noticeUrl.searchParams, SECRET, SESSION)?.title ?? '',
    /already running/,
  );
  assert.equal(
    companyContentSyncNoticeFromQuery(
      noticeUrl.searchParams,
      SECRET,
      Buffer.alloc(32, 62).toString('base64url'),
    ),
    undefined,
  );
  noticeUrl.searchParams.append('notice', noticeUrl.searchParams.get('notice')!);
  assert.equal(
    companyContentSyncNoticeFromQuery(noticeUrl.searchParams, SECRET, SESSION),
    undefined,
  );
  assert.equal(syncs.length, 1);
});
