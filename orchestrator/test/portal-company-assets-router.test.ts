import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import {
  COMPANY_ASSETS_ROUTE,
  COMPANY_ASSET_QUARANTINE_ROUTE,
} from '../src/portal/company-assets-actions.js';
import { createPropertyPredatorCompanyAssetsFixture } from '../src/portal/company-assets-fixtures.js';
import type {
  PortalCompanyAssetsService,
  PortalQuarantineCompanyAssetInput,
} from '../src/portal/company-assets-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
} from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';

const SECRET = 'company-assets-router-secret';
const SESSION = Buffer.alloc(32, 27).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'a7000000-0000-4000-8000-000000000001';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'a7400000-0000-4000-8000-000000000001',
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London',
      snapshotAt: '2026-08-27T11:15:00.000Z', canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: {
      id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London',
      snapshotAt: '2026-08-27T11:15:00.000Z', canWrite: true,
    },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'company-assets-router-request',
    now: () => Date.parse('2026-08-27T11:15:00.000Z'),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth, crm, ...overrides,
  };
}

function request(url: string, method = 'GET', cookie?: string, body = '') {
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
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    } : {}),
  };
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
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
  body = '',
) {
  const res = response();
  await handlePortal(request(url, method, cookie, body) as never, res as never, deps);
  return res;
}

function fixtureService(input: Readonly<{
  snapshots?: unknown[];
  commands?: PortalQuarantineCompanyAssetInput[];
}> = {}): PortalCompanyAssetsService {
  return {
    snapshot: async (identity) => {
      input.snapshots?.push(identity);
      return {
        ok: true,
        snapshot: {
          ...createPropertyPredatorCompanyAssetsFixture(),
          dataset: 'postgres_authoritative',
        },
      };
    },
    quarantine: async (identity, command) => {
      input.snapshots?.push(identity);
      input.commands?.push(command);
      return {
        ok: true,
        disposition: 'applied',
        quarantineDecisionId: 'a7500000-0000-4000-8000-000000000001',
        sourceReleaseId: command.sourceReleaseId,
        releaseItemId: command.releaseItemId,
        itemType: command.itemType,
        itemId: command.itemId,
        itemContentSha256: command.itemContentSha256,
        itemBrandSha256: command.itemBrandSha256,
        dimension: command.dimension,
        outcome: 'quarantined',
        reasonCode: command.reasonCode,
        evidenceSha256: command.evidenceSha256,
        providerEffects: false,
      };
    },
  };
}

test('company-assets route is authenticated, product-scoped and uncomposed by default', async () => {
  const unauthenticated = await call(
    COMPANY_ASSETS_ROUTE,
    postgres({ companyAssets: fixtureService() }),
  );
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const missing = await call(COMPANY_ASSETS_ROUTE, postgres(), COOKIE);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /Company Assets not connected/);

  const wrongProduct = await call(COMPANY_ASSETS_ROUTE, postgres({
    companyAssets: fixtureService(),
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE);
  assert.equal(wrongProduct.statusCode, 404);
});

test('company-assets GET passes opaque identity and renders only bounded metadata/quarantine forms', async () => {
  const snapshots: unknown[] = [];
  const result = await call(
    COMPANY_ASSETS_ROUTE,
    postgres({ companyAssets: fixtureService({ snapshots }) }),
    COOKIE,
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /PROVIDER EFFECTS OFF/);
  assert.match(result.body, /Authoritative migration 0033 metadata/);
  assert.match(result.body, /action="\/portal\/content\/assets\/quarantine"/);
  assert.match(result.body, /Clear locked/);
  assert.match(result.body, /Approval locked/);
  assert.doesNotMatch(result.body, /name="outcome" value="clear"|<img\b|Generate now|Publish now/i);
  assert.deepEqual(snapshots, [{
    sessionToken: SESSION,
    requestId: 'company-assets-router-request',
  }]);
});

test('company-assets quarantine POST is CSRF-bound and forwards one exact server-derived tuple', async () => {
  const fixture = createPropertyPredatorCompanyAssetsFixture();
  const item = fixture.itemPage.items[0]!;
  const commands: PortalQuarantineCompanyAssetInput[] = [];
  const body = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'company-assets-router-command-1',
    workspace_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    source_release_id: item.sourceReleaseId,
    release_item_id: item.releaseItemId,
    item_type: item.itemType,
    item_id: item.itemId,
    item_content_sha256: item.contentSha256,
    item_brand_sha256: item.brandSha256,
    dimension: 'visual_policy',
    outcome: 'quarantined',
    reason_code: 'visual_policy_conflict',
    evidence_sha256: item.contentSha256,
    return_anchor: 'company-asset-1',
  }).toString();
  const result = await call(
    COMPANY_ASSET_QUARANTINE_ROUTE,
    postgres({ companyAssets: fixtureService({ commands }) }),
    COOKIE,
    'POST',
    body,
  );
  assert.equal(result.statusCode, 303);
  assert.match(result.headers.location ?? '', /^\/portal\/content\/assets\?notice=quarantined\./);
  assert.match(result.headers.location ?? '', /#company-asset-1$/);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], {
    commandKey: 'company-assets-router-command-1',
    sourceReleaseId: item.sourceReleaseId,
    releaseItemId: item.releaseItemId,
    itemType: item.itemType,
    itemId: item.itemId,
    itemContentSha256: item.contentSha256,
    itemBrandSha256: item.brandSha256,
    dimension: 'visual_policy',
    outcome: 'quarantined',
    reasonCode: 'visual_policy_conflict',
    evidenceSha256: item.contentSha256,
  });
  assert.equal('workspaceId' in commands[0]!, false);
});

test('company-assets POST rejects CSRF, clear and forged evidence before service invocation', async () => {
  const fixture = createPropertyPredatorCompanyAssetsFixture();
  const item = fixture.itemPage.items[0]!;
  const commands: PortalQuarantineCompanyAssetInput[] = [];
  const base = {
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'company-assets-router-command-2',
    source_release_id: item.sourceReleaseId,
    release_item_id: item.releaseItemId,
    item_type: item.itemType,
    item_id: item.itemId,
    item_content_sha256: item.contentSha256,
    item_brand_sha256: item.brandSha256,
    dimension: 'visual_policy',
    outcome: 'quarantined',
    reason_code: 'visual_policy_conflict',
    evidence_sha256: item.contentSha256,
  };
  const service = fixtureService({ commands });
  for (const changes of [
    { _csrf: 'invalid' },
    { outcome: 'clear' },
    { evidence_sha256: 'f'.repeat(64) },
    { reason_code: 'visual_policy_match' },
  ]) {
    const result = await call(
      COMPANY_ASSET_QUARANTINE_ROUTE,
      postgres({ companyAssets: service }),
      COOKIE,
      'POST',
      new URLSearchParams({ ...base, ...changes }).toString(),
    );
    assert.equal(result.statusCode, 303);
  }
  assert.equal(commands.length, 0);
});
