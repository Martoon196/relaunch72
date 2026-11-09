import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPropertyPredatorAffiliateComplianceFixture } from '../src/portal/affiliate-compliance-fixtures.js';
import { AFFILIATE_COMPLIANCE_ROUTE } from '../src/portal/affiliate-compliance-presenter.js';
import type { PortalAffiliateComplianceService } from '../src/portal/affiliate-compliance-service.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'affiliate-compliance-router-secret';
const SESSION = Buffer.alloc(32, 44).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'ad100000-0000-4000-8000-000000000001';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'ad200000-0000-4000-8000-000000000001',
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
  snapshot: PortalAffiliateComplianceService['snapshot'] = async () => ({
    ok: true,
    snapshot: createPropertyPredatorAffiliateComplianceFixture(),
  }),
): PortalAffiliateComplianceService {
  return { snapshot };
}

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => 'affiliate-compliance-request',
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
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
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

test('Affiliate Compliance route is authenticated, Property Predator scoped and uncomposed by default', async () => {
  const unauthenticated = await call(AFFILIATE_COMPLIANCE_ROUTE, postgres({ affiliateCompliance: service() }));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const missing = await call(AFFILIATE_COMPLIANCE_ROUTE, postgres(), COOKIE);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /Affiliate Compliance not connected/);

  const wrongProfile = await call(AFFILIATE_COMPLIANCE_ROUTE, postgres({
    affiliateCompliance: service(),
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE);
  assert.equal(wrongProfile.statusCode, 404);
});

test('Affiliate Compliance receives only opaque session identity and renders a truthful preview', async () => {
  const calls: unknown[] = [];
  const result = await call(AFFILIATE_COMPLIANCE_ROUTE, postgres({
    affiliateCompliance: service(async (identity) => {
      calls.push(identity);
      return { ok: true, snapshot: createPropertyPredatorAffiliateComplianceFixture() };
    }),
  }), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /Grow the network/);
  assert.match(result.body, /EXTERNAL EFFECTS OFF/);
  assert.match(result.body, /Fictional affiliate 01/);
  assert.match(result.body, /href="\/portal\/affiliates\/compliance" aria-current="page"/);
  assert.doesNotMatch(result.body, /action="\/portal\/affiliates|Create link|Send now|Publish now/i);
  assert.deepEqual(calls, [{ sessionToken: SESSION, requestId: 'affiliate-compliance-request' }]);
});

test('Affiliate Compliance has no POST command and malformed fixture claims fail closed', async () => {
  let reads = 0;
  const compliance = service(async () => {
    reads += 1;
    const fixture = createPropertyPredatorAffiliateComplianceFixture();
    return { ok: true, snapshot: { ...fixture, programme: { ...fixture.programme, externalEffects: true } } as never };
  });
  const post = await call(AFFILIATE_COMPLIANCE_ROUTE, postgres({ affiliateCompliance: compliance }), COOKIE, 'POST');
  assert.equal(post.statusCode, 404);
  assert.equal(reads, 0);

  const get = await call(AFFILIATE_COMPLIANCE_ROUTE, postgres({ affiliateCompliance: compliance }), COOKIE);
  assert.equal(get.statusCode, 503);
  assert.match(get.body, /No legal, acceptance, training, declaration, channel, case or permission evidence was changed/);
  assert.equal(reads, 1);
});

test('Affiliate Compliance service failures stay sanitised and never imply eligibility', async () => {
  const result = await call(AFFILIATE_COMPLIANCE_ROUTE, postgres({
    affiliateCompliance: service(async () => ({ ok: false, kind: 'unavailable', message: 'The compliance evidence is not ready.' })),
  }), COOKIE);
  assert.equal(result.statusCode, 503);
  assert.match(result.body, /The compliance evidence is not ready/);
  assert.doesNotMatch(result.body, /eligible|link ready|provider ready/i);
});
