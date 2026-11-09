import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { PortalAuthService } from '../src/portal/auth-service.js';
import { createPropertyPredatorBrandBrainFixture } from '../src/portal/brand-brain-fixtures.js';
import type { PortalBrandBrainService } from '../src/portal/brand-brain-service.js';
import { createPropertyPredatorCompanyAssetsFixture } from '../src/portal/company-assets-fixtures.js';
import type { PortalCompanyAssetsService } from '../src/portal/company-assets-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { createAuthoritativeImageStudioSnapshot } from '../src/portal/image-studio-authoritative.js';
import { IMAGE_STUDIO_ROUTE, presentImageStudio } from '../src/portal/image-studio-presenter.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'image-studio-router-session-secret';
const SESSION = Buffer.alloc(32, 89).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'a7000000-0000-4000-8000-000000000001';
const NOW = '2026-08-28T15:30:00.000Z';

function authoritativeSources() {
  const brandFixture = createPropertyPredatorBrandBrainFixture();
  const assetFixture = createPropertyPredatorCompanyAssetsFixture();
  const sourceItem = assetFixture.itemPage.items[0]!;
  const clearItem = Object.freeze({
    ...sourceItem,
    itemId: 'asset:property-predator-app-icon',
    decisions: Object.freeze([
      Object.freeze({ dimension: 'visual_policy' as const, outcome: 'clear' as const, reasonCode: 'visual_policy_match' as const, evidenceSha256: '6'.repeat(64), recordedAt: NOW }),
      Object.freeze({ dimension: 'claim' as const, outcome: 'clear' as const, reasonCode: 'no_claims_present' as const, evidenceSha256: '6'.repeat(64), recordedAt: NOW }),
      Object.freeze({ dimension: 'asset' as const, outcome: 'clear' as const, reasonCode: 'asset_integrity_verified' as const, evidenceSha256: '7'.repeat(64), recordedAt: NOW }),
    ]),
  });
  return {
    brain: Object.freeze({
      ...brandFixture,
      workspace: Object.freeze({ ...brandFixture.workspace, workspaceId: WORKSPACE_ID, snapshotAt: NOW }),
      dataset: 'postgres_authoritative' as const,
    }),
    assets: Object.freeze({
      ...assetFixture,
      workspace: Object.freeze({ ...assetFixture.workspace, workspaceId: WORKSPACE_ID, snapshotAt: NOW }),
      itemPage: Object.freeze({ items: Object.freeze([clearItem]), hasMore: false }),
      dataset: 'postgres_authoritative' as const,
    }),
  };
}

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'a8000000-0000-4000-8000-000000000001',
    userEmail: 'founder@propertypredator.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: NOW, canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: NOW, canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function services() {
  const sources = authoritativeSources();
  const brandBrain: PortalBrandBrainService = {
    snapshot: async () => ({ ok: true, snapshot: sources.brain }),
  };
  const companyAssets: PortalCompanyAssetsService = {
    snapshot: async () => ({ ok: true, snapshot: sources.assets }),
    quarantine: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
  return { brandBrain, companyAssets };
}

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'image-studio-router-request', now: () => Date.parse(NOW),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE, auth, crm, ...overrides,
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

async function call(url: string, deps: PostgresPortalDeps, cookie?: string, method = 'GET') {
  const res = response();
  await handlePortal(request(url, method, cookie) as never, res as never, deps);
  return res;
}

test('authoritative Image Studio binds exact Brand Brain and cleared company artwork', () => {
  const sources = authoritativeSources();
  const snapshot = createAuthoritativeImageStudioSnapshot({
    brandBrain: sources.brain,
    companyAssets: sources.assets,
    query: new URLSearchParams({
      subject: 'UK auction evidence under a cyan scan line',
      quality: 'high', size: '1536x1024', intended_use: 'campaign-concept',
    }),
  });
  const view = presentImageStudio(snapshot);

  assert.equal(view.dataset, 'postgres_authoritative');
  assert.equal(view.brief.subject, 'UK auction evidence under a cyan scan line');
  assert.equal(view.brief.quality, 'high');
  assert.equal(view.references[0]?.kind, 'logo');
  assert.equal(view.references[0]?.approved, true);
  assert.equal(view.currentImageMakerHref, 'https://propertypredator.com/admin.html#ai-image-maker');
  assert.equal(view.generateAvailable, false);
});

test('Image Studio drops secrets, personal data and external links from browser briefs', () => {
  const sources = authoritativeSources();
  const snapshot = createAuthoritativeImageStudioSnapshot({
    brandBrain: sources.brain,
    companyAssets: sources.assets,
    query: new URLSearchParams({
      subject: 'api_key=sk-not-a-real-key-but-still-private',
      forensic_concept: 'Contact person@example.test or visit https://attacker.example',
    }),
  });
  assert.doesNotMatch(snapshot.brief.subject, /sk-|api_key/iu);
  assert.doesNotMatch(snapshot.brief.forensicConcept, /example\.test|https:/iu);
});

test('Image Studio route is authenticated, product-scoped and uncomposed by default', async () => {
  const unauthenticated = await call(IMAGE_STUDIO_ROUTE, postgres(services()));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const missing = await call(IMAGE_STUDIO_ROUTE, postgres(), COOKIE);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /Image Studio not connected/);
});

test('Image Studio route renders the authoritative brief editor and current owned maker', async () => {
  const result = await call(
    `${IMAGE_STUDIO_ROUTE}?subject=Dark+UK+terrace&quality=medium`,
    postgres(services()), COOKIE,
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /data-source="postgres_authoritative"/);
  assert.match(result.body, /name="subject" maxlength="180" value="Dark UK terrace"/);
  assert.match(result.body, /Update proposal brief/);
  assert.match(result.body, /Open current Property Predator Image Maker/);
  assert.match(result.body, /propertypredator\.com\/admin\.html#ai-image-maker/);
  assert.match(result.body, /authoritative workspace evidence/);
  assert.doesNotMatch(result.body, /Recent fictional proposals|fixture captured/);
});

test('Image Studio has no POST command until the isolated worker is composed', async () => {
  const result = await call(IMAGE_STUDIO_ROUTE, postgres(services()), COOKIE, 'POST');
  assert.equal(result.statusCode, 404);
  assert.doesNotMatch(result.body, /Generate review proposal/);
});
