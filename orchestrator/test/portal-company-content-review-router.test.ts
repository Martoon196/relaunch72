import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { canonicalCompanyContentJson } from '../src/company-content-pg/validation.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import {
  COMPANY_CONTENT_REVIEW_ROUTE_PREFIX,
  type PortalCompanyContentReviewService,
  type PortalCompanyContentReviewSnapshot,
} from '../src/portal/company-content-review-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
} from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'company-content-review-router-secret';
const SESSION = Buffer.alloc(32, 42).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001';
const RELEASE_ITEM_ID = '20000000-0000-4000-8000-000000000002';
const RELEASE_ID = '20000000-0000-4000-8000-000000000003';
const VERSION_ID = '20000000-0000-4000-8000-000000000004';
const APPROVAL_ID = '20000000-0000-4000-8000-000000000005';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: '20000000-0000-4000-8000-000000000006',
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => null,
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function deps(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    requestId: () => 'company-content-review-router-request',
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
  setImmediate(() => req.emit('end'));
  return req;
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0),
    writeHead(code: number, headers?: Record<string, string | string[]>) {
      this.statusCode = code;
      for (const [key, value] of Object.entries(headers ?? {})) {
        this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join('\n') : value;
      }
      return this;
    },
    end(body?: string | Uint8Array) {
      if (typeof body === 'string') this.body = Buffer.from(body);
      else if (body) this.body = Buffer.from(body);
    },
  };
}

async function call(url: string, portal: PostgresPortalDeps, cookie?: string, method = 'GET') {
  const res = response();
  await handlePortal(request(url, method, cookie) as never, res as never, portal);
  return res;
}

function snapshot(): PortalCompanyContentReviewSnapshot {
  const payload = Object.freeze({
    title: 'Evidence before emotion',
    body: 'Read the evidence, then make the offer.',
    category: 'Social posts',
    kind: 'text',
  });
  const canonicalPayload = {
    active: true,
    body: payload.body,
    category: payload.category,
    kind: payload.kind,
    schema: 'propertypredator.company-content/v1',
    title: payload.title,
    type: 'media',
  };
  const canonicalContent = canonicalCompanyContentJson(canonicalPayload);
  return Object.freeze({
    workspace: Object.freeze({
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Property Predator Growth HQ',
      snapshotAt: '2026-08-28T09:00:00.000Z',
      canManage: true,
    }),
    item: Object.freeze({
      releaseItemId: RELEASE_ITEM_ID,
      sourceReleaseId: RELEASE_ID,
      itemType: 'media',
      itemId: 'media:evidence-before-emotion',
      itemVersion: 1,
      sourceVersionId: VERSION_ID,
      contentSha256: createHash('sha256').update(canonicalContent).digest('hex'),
      blobSha256: null,
      brandSha256: 'b'.repeat(64),
      sourceApproval: Object.freeze({
        approvalId: APPROVAL_ID,
        approvedAt: '2026-08-28T08:59:00.000Z',
        meaning: 'source_provenance_only',
        expiresAt: null,
      }),
      hqUseStatus: 'review_required',
      decisions: Object.freeze([]),
      pendingDimensions: Object.freeze(['visual_policy', 'claim', 'asset'] as const),
      quarantined: false,
    }),
    exactContent: Object.freeze({
      mediaType: 'application/json',
      canonicalContent,
      payload,
      verified: true,
    }),
    artwork: null,
    safety: Object.freeze({
      providerEffects: false,
      customerPrivateDataAccepted: false,
      affiliateContentAccepted: false,
      sourceApprovalPromotedToHqApproval: false,
    }),
  });
}

function service(calls: string[] = []): PortalCompanyContentReviewService {
  return {
    review: async (identity, releaseItemId) => {
      calls.push(`review:${identity.sessionToken}:${identity.requestId}:${releaseItemId}`);
      return { ok: true, snapshot: snapshot() };
    },
    artwork: async (identity, releaseItemId) => {
      calls.push(`artwork:${identity.sessionToken}:${identity.requestId}:${releaseItemId}`);
      const bytes = Uint8Array.from([1, 2, 3, 4]);
      return {
        ok: true,
        contentVersionId: VERSION_ID,
        mediaType: 'image/png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes,
        providerEffects: false,
      };
    },
  };
}

test('exact review routes are authenticated, Property-Predator scoped and uncomposed by default', async () => {
  const route = `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${RELEASE_ITEM_ID}`;
  assert.equal((await call(route, deps({ companyContentReview: service() }))).statusCode, 302);
  assert.equal((await call(route, deps(), COOKIE)).statusCode, 404);
  assert.equal((await call(route, deps({
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
    companyContentReview: service(),
  }), COOKIE)).statusCode, 404);
});

test('exact review GET passes only opaque session identity and exact release item id', async () => {
  const calls: string[] = [];
  const result = await call(
    `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${RELEASE_ITEM_ID}`,
    deps({ companyContentReview: service(calls) }),
    COOKIE,
  );
  assert.equal(result.statusCode, 200);
  assert.match(result.headers['content-security-policy'] ?? '', /img-src 'self'/u);
  assert.doesNotMatch(result.headers['content-security-policy'] ?? '', /script-src/u);
  assert.match(result.body.toString(), /Evidence before emotion/);
  assert.match(result.body.toString(), /Not Growth HQ approval|Source provenance only/);
  assert.doesNotMatch(result.body.toString(), /filename|assetFilePath|\/api\/internal|Publish now/i);
  assert.deepEqual(calls, [
    `review:${SESSION}:company-content-review-router-request:${RELEASE_ITEM_ID}`,
  ]);
});

test('verified artwork response has exact private headers and no download/path leakage', async () => {
  const result = await call(
    `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${RELEASE_ITEM_ID}/file`,
    deps({ companyContentReview: service() }),
    COOKIE,
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-type'], 'image/png');
  assert.equal(result.headers['content-length'], '4');
  assert.equal(result.headers['cache-control'], 'private, no-store, max-age=0, no-transform');
  assert.match(result.headers.etag ?? '', /^"sha256-[0-9a-f]{64}"$/u);
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal('content-disposition' in result.headers, false);
  assert.equal('x-company-content-version' in result.headers, false);
  assert.deepEqual([...result.body], [1, 2, 3, 4]);
});

test('exact review boundary is GET-only and never invokes review on POST', async () => {
  const calls: string[] = [];
  const result = await call(
    `${COMPANY_CONTENT_REVIEW_ROUTE_PREFIX}/${RELEASE_ITEM_ID}`,
    deps({ companyContentReview: service(calls) }),
    COOKIE,
    'POST',
  );
  assert.equal(result.statusCode, 405);
  assert.equal(result.headers.allow, 'GET');
  assert.deepEqual(calls, []);
});
