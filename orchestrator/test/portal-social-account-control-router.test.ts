import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';
import { buildPostgresPortalDeps } from '../src/portal/provision.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';
import { SOCIAL_ACCOUNT_CONTROL_ROUTE } from '../src/portal/social-account-control-presenter.js';

const SECRET = 'social-account-control-router-secret';
const SESSION = Buffer.alloc(32, 71).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = '72000000-0000-4000-8000-000000000001';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: '72000000-0000-4000-8000-000000000002',
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-28T10:30:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-28T10:30:00.000Z', canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    ...buildPostgresPortalDeps({
      sessionSecret: SECRET,
      secure: false,
      auth,
      crm,
      productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
      abuse: {
        admit: async () => ({ allowed: true, retryAfterSeconds: 0, leaseHash: null }),
        complete: async () => undefined,
        assertReady: async () => undefined,
        close: async () => undefined,
      },
      requestContext: () => ({
        requestId: 'social-account-control-request',
        requestHash: Buffer.alloc(32, 72),
        clientAddress: '127.0.0.1',
        sourceHash: Buffer.alloc(32, 73),
      }),
      abuseHashSecret: 'social-account-control-abuse-secret-at-least-32-characters',
      requestId: () => 'social-account-control-request',
      now: () => Date.parse('2026-08-28T10:30:00.000Z'),
    }),
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

test('social-account control room is authenticated and Property Predator scoped', async () => {
  const unauthenticated = await call(SOCIAL_ACCOUNT_CONTROL_ROUTE, postgres());
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const wrongProfile = await call(SOCIAL_ACCOUNT_CONTROL_ROUTE, postgres({
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE);
  assert.equal(wrongProfile.statusCode, 404);

  const result = await call(SOCIAL_ACCOUNT_CONTROL_ROUTE, postgres(), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /Plug in the audience/);
  assert.match(result.body, /FICTIONAL ACCOUNT REHEARSAL/);
  assert.match(result.body, /Live connections<\/small><strong>0<\/strong>/);
  assert.match(result.body, /href="\/portal\/campaigns\/new"/);
  assert.equal(postgres().providerReadiness, undefined, 'canonical production composition has no invented readiness evidence service');
  assert.doesNotMatch(result.body, /href="\/portal\/providers\/readiness"/);
});

test('social-account control room exposes no command route or provider effect', async () => {
  const post = await call(SOCIAL_ACCOUNT_CONTROL_ROUTE, postgres(), COOKIE, 'POST');
  assert.equal(post.statusCode, 404);

  const result = await call(SOCIAL_ACCOUNT_CONTROL_ROUTE, postgres(), COOKIE);
  assert.match(result.body, /data-provider-effects="off"/);
  assert.match(result.body, /data-account-linking-effects="off"/);
  assert.match(result.body, /data-publishing-effects="off"/);
  assert.match(result.body, /data-revocation-effects="off"/);
  const surfaceStart = result.body.indexOf('<article class="sac"');
  const surfaceEnd = result.body.indexOf('</main>', surfaceStart);
  assert.ok(surfaceStart >= 0 && surfaceEnd > surfaceStart);
  const surface = result.body.slice(surfaceStart, surfaceEnd);
  assert.doesNotMatch(surface, /<form\b|oauth\/authorize|fetch\s*\(/iu);
});
