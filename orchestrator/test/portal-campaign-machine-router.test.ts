import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CAMPAIGN_MACHINE_ROUTE } from '../src/portal/campaign-machine-presenter.js';
import { createPropertyPredatorCampaignMachineFixture } from '../src/portal/campaign-machine-fixtures.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'campaign-machine-router-secret';
const SESSION = Buffer.alloc(32, 71).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'fb100000-0000-4000-8000-000000000001',
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-29T08:00:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-29T08:00:00.000Z', canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function deps(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'campaign-router-request', productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth, crm, ...overrides,
  };
}

function request(cookie?: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> };
  req.method = 'GET'; req.url = CAMPAIGN_MACHINE_ROUTE; req.headers = cookie ? { cookie } : {};
  setImmediate(() => req.emit('end'));
  return req;
}

function response() {
  return {
    statusCode: 0, headers: {} as Record<string, string>, body: '',
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

async function call(input: PostgresPortalDeps, cookie?: string) {
  const res = response();
  await handlePortal(request(cookie) as never, res as never, input);
  return res;
}

test('Campaign Machine production route fails closed without its database reader', async () => {
  const result = await call(deps(), COOKIE);
  assert.equal(result.statusCode, 404);
  assert.match(result.body, /Campaign Machine not connected/);
  assert.doesNotMatch(result.body, /First Hunt|owned-office-lead-activation-nurture/u);
});

test('Campaign Machine renders only the authenticated service snapshot', async () => {
  const calls: unknown[] = [];
  const source = createPropertyPredatorCampaignMachineFixture();
  const snapshot = {
    ...source,
    templates: [{ ...source.templates[0]!, name: 'Database-backed founder sequence' }],
  };
  const result = await call(deps({
    campaignMachine: {
      async snapshot(identity) {
        calls.push(identity);
        return { ok: true, snapshot };
      },
    },
  }), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Database-backed founder sequence/);
  assert.doesNotMatch(result.body, /ILLUSTRATIVE TEST DATA/);
  assert.deepEqual(calls, [{ sessionToken: SESSION, requestId: 'campaign-router-request' }]);
});

test('Campaign Machine maps safe service failures and never renders stale evidence', async () => {
  const forbidden = await call(deps({
    campaignMachine: { snapshot: async () => ({ ok: false, kind: 'forbidden', message: 'No campaign evidence access.' }) },
  }), COOKIE);
  assert.equal(forbidden.statusCode, 403);
  assert.match(forbidden.body, /No campaign evidence access/);
  assert.doesNotMatch(forbidden.body, /First Hunt/u);

  const unavailable = await call(deps({
    campaignMachine: { snapshot: async () => ({ ok: false, kind: 'invalid_snapshot', message: 'Campaign evidence failed validation.' }) },
  }), COOKIE);
  assert.equal(unavailable.statusCode, 503);
  assert.match(unavailable.body, /failed validation/);
});
