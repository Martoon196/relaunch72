import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPropertyPredatorProviderReadinessFixture } from '../src/portal/provider-readiness-cockpit-fixtures.js';
import { PROVIDER_READINESS_COCKPIT_ROUTE } from '../src/portal/provider-readiness-cockpit-presenter.js';
import type { PortalProviderReadinessService } from '../src/portal/provider-readiness-cockpit-service.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'provider-readiness-router-secret';
const SESSION = Buffer.alloc(32, 47).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'fb100000-0000-4000-8000-000000000001',
    userEmail: 'fictional@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-27T12:00:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-27T12:00:00.000Z', canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function service(
  snapshot: PortalProviderReadinessService['snapshot'] = async () => ({
    ok: true,
    snapshot: createPropertyPredatorProviderReadinessFixture(),
  }),
): PortalProviderReadinessService {
  return { snapshot };
}

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => 'provider-readiness-request',
    now: () => Date.parse('2026-08-27T12:00:00.000Z'),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...overrides,
  };
}

function request(url: string, method = 'GET', cookie?: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = url;
  req.headers = cookie ? { cookie } : {};
  queueMicrotask(() => req.emit('end'));
  return req;
}

function response() {
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

async function call(url: string, deps: PostgresPortalDeps, cookie?: string, method = 'GET') {
  const res = response();
  await handlePortal(request(url, method, cookie) as never, res as never, deps);
  return res;
}

test('provider readiness route is authenticated, Property Predator scoped and uncomposed by default', async () => {
  const unauthenticated = await call(PROVIDER_READINESS_COCKPIT_ROUTE, postgres({ providerReadiness: service() }));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const missing = await call(PROVIDER_READINESS_COCKPIT_ROUTE, postgres(), COOKIE);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /Provider Readiness not connected/);

  const wrongProfile = await call(PROVIDER_READINESS_COCKPIT_ROUTE, postgres({
    providerReadiness: service(),
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE);
  assert.equal(wrongProfile.statusCode, 404);
});

test('provider readiness route passes only opaque identity and renders no operation surface', async () => {
  const calls: unknown[] = [];
  const result = await call(PROVIDER_READINESS_COCKPIT_ROUTE, postgres({
    providerReadiness: service(async (identity) => {
      calls.push(identity);
      return { ok: true, snapshot: createPropertyPredatorProviderReadinessFixture() };
    }),
  }), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /Provider Readiness/);
  assert.match(result.body, /ILLUSTRATIVE TEST DATA/);
  assert.match(result.body, /EXTERNAL EFFECTS OFF/);
  assert.doesNotMatch(result.body, /<form[^>]+action="\/portal\/providers|Connect now|Activate now/i);
  assert.deepEqual(calls, [{ sessionToken: SESSION, requestId: 'provider-readiness-request' }]);
});

test('provider readiness has no POST command and malformed safety claims fail closed', async () => {
  let reads = 0;
  const providerReadiness = service(async () => {
    reads += 1;
    const fixture = structuredClone(createPropertyPredatorProviderReadinessFixture());
    (fixture.rails[0]!.switches as { railEffects: 'off' | 'on' }).railEffects = 'on';
    return { ok: true, snapshot: fixture };
  });
  const post = await call(PROVIDER_READINESS_COCKPIT_ROUTE, postgres({ providerReadiness }), COOKIE, 'POST');
  assert.equal(post.statusCode, 404);
  assert.equal(reads, 0);

  const get = await call(PROVIDER_READINESS_COCKPIT_ROUTE, postgres({ providerReadiness }), COOKIE);
  assert.equal(get.statusCode, 503);
  assert.match(get.body, /No provider account, credential, switch, send, post or direct message was changed/);
  assert.equal(reads, 1);
});
