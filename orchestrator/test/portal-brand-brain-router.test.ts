import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import { BRAND_BRAIN_ROUTE } from '../src/portal/brand-brain-actions.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import type { PortalBrandBrainService } from '../src/portal/brand-brain-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
} from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'brand-brain-router-secret';
const SESSION = Buffer.alloc(32, 41).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'c1000000-0000-4000-8000-000000000001';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'c2000000-0000-4000-8000-000000000001',
    userEmail: 'owner@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-27T09:45:00.000Z',
      canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: '2026-08-27T09:45:00.000Z',
      canWrite: true,
    },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => 'brand-brain-router-request',
    now: () => Date.parse('2026-08-27T09:45:00.000Z'),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...overrides,
  };
}

function request(url: string, method = 'GET', cookie?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
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

async function call(
  url: string,
  deps: PostgresPortalDeps,
  cookie?: string,
  method = 'GET',
) {
  const res = response();
  await handlePortal(request(url, method, cookie) as never, res as never, deps);
  return res;
}

function fixtureService(
  snapshot: PortalBrandBrainService['snapshot'] = async () => ({
    ok: true,
    snapshot: createPropertyPredatorBrandBrainFixture(),
  }),
): PortalBrandBrainService {
  return { snapshot };
}

test('Brand Brain route is authenticated, profile-scoped and uncomposed by default', async () => {
  const unauthenticated = await call(BRAND_BRAIN_ROUTE, postgres({ brandBrain: fixtureService() }));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const missing = await call(BRAND_BRAIN_ROUTE, postgres(), COOKIE);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /Brand Brain not connected/);
  assert.doesNotMatch(missing.body, /PROVIDER EFFECTS OFF/);

  const wrongProduct = await call(BRAND_BRAIN_ROUTE, postgres({
    brandBrain: fixtureService(),
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE);
  assert.equal(wrongProduct.statusCode, 404);
  assert.match(wrongProduct.body, /Brand Brain not connected/);
});

test('Brand Brain route passes only the opaque session identity and renders a read-only operational page', async () => {
  const calls: unknown[] = [];
  const brandBrain = fixtureService(async (identity) => {
    calls.push(identity);
    return { ok: true, snapshot: createPropertyPredatorBrandBrainFixture() };
  });
  const result = await call(BRAND_BRAIN_ROUTE, postgres({ brandBrain }), COOKIE);

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /PROVIDER EFFECTS OFF/);
  assert.match(result.body, /Source Social Media Manager/);
  assert.match(result.body, /Adapted into Brand Brain/);
  assert.match(result.body, /Panther imagery vs no-animal visual rule/);
  assert.match(result.body, /href="\/portal\/content\/brain" aria-current="page"/);
  assert.match(result.body, /href="\/portal\/content"/);
  assert.doesNotMatch(result.body, /action="\/portal\/content\/brain|Activate now|Generate now|Connect provider/i);
  assert.deepEqual(calls, [{
    sessionToken: SESSION,
    requestId: 'brand-brain-router-request',
  }]);
});

test('Brand Brain has no POST command and malformed provider state fails closed', async () => {
  let reads = 0;
  const brandBrain = fixtureService(async () => {
    reads += 1;
    const fixture = createPropertyPredatorBrandBrainFixture();
    return {
      ok: true,
      snapshot: {
        ...fixture,
        brain: { ...fixture.brain, providerEffects: true },
      } as never,
    };
  });
  const rejectedPost = await call(BRAND_BRAIN_ROUTE, postgres({ brandBrain }), COOKIE, 'POST');
  assert.equal(rejectedPost.statusCode, 404);
  assert.equal(reads, 0);

  const rejectedSnapshot = await call(BRAND_BRAIN_ROUTE, postgres({ brandBrain }), COOKIE);
  assert.equal(rejectedSnapshot.statusCode, 503);
  assert.match(rejectedSnapshot.body, /No source, review, evaluation, activation or provider state was changed/);
  assert.doesNotMatch(rejectedSnapshot.body, /PROVIDER EFFECTS OFF/);
  assert.equal(reads, 1);
});

test('Brand Brain service failures remain sanitised and never imply an activation', async () => {
  const result = await call(BRAND_BRAIN_ROUTE, postgres({
    brandBrain: fixtureService(async () => ({
      ok: false,
      kind: 'invalid_snapshot',
      message: 'The Brand Brain metadata did not pass verification.',
    })),
  }), COOKIE);

  assert.equal(result.statusCode, 503);
  assert.match(result.body, /Brand Brain temporarily unavailable/);
  assert.match(result.body, /metadata did not pass verification/);
  assert.doesNotMatch(result.body, /activated|provider ready|published/i);
});

test('Content Control composes the Brand Brain nested tab only when both surface and profile are available', async () => {
  const companyContent: PortalCompanyContentService = {
    snapshot: async () => ({
      ok: true,
      snapshot: {
        workspace: {
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Property Predator Growth HQ',
          snapshotAt: '2026-08-27T09:45:00.000Z',
          canWrite: false,
          canManage: false,
        },
        catalog: createPropertyPredatorContentCatalogFixture(),
      },
    }),
    requestApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    decideApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
  const withBrain = await call('/portal/content', postgres({
    companyContent,
    brandBrain: fixtureService(),
  }), COOKIE);
  assert.equal(withBrain.statusCode, 200);
  assert.match(withBrain.body, /href="\/portal\/content\/brain">Brand Brain<\/a>/);

  const withoutBrain = await call('/portal/content', postgres({ companyContent }), COOKIE);
  assert.equal(withoutBrain.statusCode, 200);
  assert.doesNotMatch(withoutBrain.body, /href="\/portal\/content\/brain"/);
});
