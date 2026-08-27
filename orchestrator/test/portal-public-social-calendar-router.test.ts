import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { SocialCampaignCalendarProjection } from '../src/social-campaign-pg/types.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { CONTENT_CALENDAR_ROUTE } from '../src/portal/content-calendar-presenter.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type { PortalPublicSocialService } from '../src/portal/public-social-service.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'calendar-router-session-secret';
const SESSION = Buffer.alloc(32, 52).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const NOW = '2026-08-27T09:45:00.000Z';
const IDS = Object.freeze({
  workspace: '11000000-0000-4000-8000-000000000001',
  otherWorkspace: '11000000-0000-4000-8000-000000000002',
  user: '12000000-0000-4000-8000-000000000001',
  campaign: '13000000-0000-4000-8000-000000000001',
  revision: '14000000-0000-4000-8000-000000000001',
  post: '15000000-0000-4000-8000-000000000001',
  operation: '16000000-0000-4000-8000-000000000001',
  target: '17000000-0000-4000-8000-000000000001',
});

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: IDS.user,
    userEmail: 'owner@example.test',
    workspaceId: IDS.workspace,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: {
      id: IDS.workspace,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: NOW,
      canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: {
      id: IDS.workspace,
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

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => 'calendar-router-request',
    now: () => Date.parse(NOW),
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

function exactCatalog() {
  const fixture = createPropertyPredatorContentCatalogFixture();
  const first = fixture.items[0];
  if (!first) throw new Error('company-content fixture is incomplete');
  const exact = Object.freeze({
    ...first,
    contentSha256: 'a'.repeat(64),
    sourceCheckedAt: '2026-08-27T09:40:00.000Z',
    sourceExpiresAt: '2026-08-27T09:50:00.000Z',
    sourceFresh: true,
    publishable: true,
  });
  return Object.freeze({
    items: Object.freeze([exact, ...fixture.items.slice(1)]),
    nextCursor: null,
  });
}

function calendarProjection(
  overrides: Partial<SocialCampaignCalendarProjection> = {},
): SocialCampaignCalendarProjection {
  const item = exactCatalog().items[0];
  if (!item) throw new Error('exact catalogue item is missing');
  return Object.freeze({
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 7,
    campaignTitle: 'Evidence Week TEST campaign',
    postId: IDS.post,
    contentItemId: item.contentItemId,
    contentVersionId: item.contentVersionId,
    contentSha256: item.contentSha256,
    planSha256: 'b'.repeat(64),
    scheduledFor: '2026-08-28T09:00:00.000Z',
    operationId: IDS.operation,
    targetId: IDS.target,
    network: 'facebook',
    targetLabel: 'Facebook owned TEST rail',
    state: 'waiting_for_test_time',
    simulationAttemptCount: 0,
    maxSimulationAttempts: 3,
    reconciliationAttemptCount: 0,
    maxReconciliationAttempts: 3,
    updatedAt: NOW,
    environment: 'test',
    providerEffects: 'none',
    ...overrides,
  });
}

function publicSocialService(
  snapshot: PortalPublicSocialService['snapshot'],
): PortalPublicSocialService {
  return {
    snapshot,
    createRevision: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    registerTestTarget: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    schedule: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    cancelTarget: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
}

function companyContentService(
  snapshot: PortalCompanyContentService['snapshot'],
): PortalCompanyContentService {
  return {
    snapshot,
    requestApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    decideApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
}

function successfulServices(overrides: Readonly<{
  socialWorkspaceId?: string;
  contentWorkspaceId?: string;
  projection?: SocialCampaignCalendarProjection;
  calendarHasMore?: boolean;
}> = {}) {
  const publicSocial = publicSocialService(async () => ({
    ok: true,
    snapshot: {
      workspace: {
        workspaceId: overrides.socialWorkspaceId ?? IDS.workspace,
        workspaceName: 'Property Predator Growth HQ',
        timezone: 'Europe/London',
        snapshotAt: NOW,
        canManage: true,
      },
      campaign: { items: [], hasMore: false },
      calendar: {
        items: [overrides.projection ?? calendarProjection()],
        hasMore: overrides.calendarHasMore ?? false,
      },
      environment: 'test',
      providerEffects: 'none',
    },
  }));
  const companyContent = companyContentService(async () => ({
    ok: true,
    snapshot: {
      workspace: {
        workspaceId: overrides.contentWorkspaceId ?? IDS.workspace,
        workspaceName: 'Property Predator Growth HQ',
        snapshotAt: NOW,
        canWrite: false,
        canManage: false,
      },
      catalog: exactCatalog(),
    },
  }));
  return { publicSocial, companyContent };
}

test('real Campaign Calendar route requires authentication and both read boundaries', async () => {
  let reads = 0;
  const services = successfulServices();
  const trackedSocial = publicSocialService(async (...args) => {
    reads += 1;
    return services.publicSocial.snapshot(...args);
  });
  const unauthenticated = await call(CONTENT_CALENDAR_ROUTE, postgres({
    ...services,
    publicSocial: trackedSocial,
  }));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');
  assert.equal(reads, 0);

  const missingSocial = await call(CONTENT_CALENDAR_ROUTE, postgres({
    companyContent: services.companyContent,
  }), COOKIE);
  assert.equal(missingSocial.statusCode, 404);
  assert.match(missingSocial.body, /Campaign Calendar not connected/);

  const missingContent = await call(CONTENT_CALENDAR_ROUTE, postgres({
    publicSocial: services.publicSocial,
  }), COOKIE);
  assert.equal(missingContent.statusCode, 404);
  assert.match(missingContent.body, /Campaign Calendar not connected/);
});

test('calendar uses one opaque identity, bounded reads and renders exact TEST/content proof', async () => {
  const socialCalls: unknown[][] = [];
  const contentCalls: unknown[][] = [];
  const services = successfulServices();
  const publicSocial = publicSocialService(async (...args) => {
    socialCalls.push(args);
    return services.publicSocial.snapshot(...args);
  });
  const companyContent = companyContentService(async (...args) => {
    contentCalls.push(args);
    return services.companyContent.snapshot(...args);
  });
  const result = await call(
    `${CONTENT_CALENDAR_ROUTE}?mode=week&date=2026-08-28&channel=facebook&workspaceId=browser-forgery`,
    postgres({ publicSocial, companyContent }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.headers['content-security-policy'] ?? '', /script-src 'self'/);
  assert.doesNotMatch(result.headers['content-security-policy'] ?? '', /'unsafe-eval'|'unsafe-inline'[^;]*script/);
  assert.equal(socialCalls.length, 1);
  assert.equal(contentCalls.length, 1);
  assert.deepEqual(socialCalls[0]?.[0], {
    sessionToken: SESSION,
    requestId: 'calendar-router-request',
  });
  assert.equal(socialCalls[0]?.[0], contentCalls[0]?.[0], 'both reads share one opaque identity');
  assert.deepEqual(socialCalls[0]?.[1], {
    from: '2026-07-14T00:00:00.000Z',
    to: '2026-10-13T00:00:00.000Z',
    limit: 120,
  });
  assert.deepEqual(contentCalls[0]?.[1], { limit: 100 });
  assert.equal(Object.hasOwn(socialCalls[0]?.[1] as object, 'workspaceId'), false);

  assert.match(result.body, /Own the week/);
  assert.match(result.body, /Evidence Week TEST campaign/);
  assert.match(result.body, /Facebook owned TEST rail/);
  assert.match(result.body, /TEST plan queued/);
  assert.match(result.body, /The postcode is not the opportunity\. The evidence is\./);
  assert.match(result.body, /aaaaaaaaaa…/);
  assert.match(result.body, /data-provider-effects="none"/);
  assert.match(result.body, /Simulation ready/);
  assert.doesNotMatch(result.body, /browser-forgery|test-account:|body[_ -]?text|storage[_ -]?key|connection[_ -]?id|credential|calendar-router-session-secret/i);
});

test('calendar qualifies loaded counts when the database proves continuation', async () => {
  const result = await call(CONTENT_CALENDAR_ROUTE, postgres(successfulServices({
    calendarHasMore: true,
  })), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /data-source-truncated="true"/);
  assert.match(result.body, /Loaded draft placements/);
  assert.match(result.body, /additional complete public-social post aggregates/);
});

test('calendar fails closed when independently scoped reads disagree on workspace', async () => {
  const result = await call(CONTENT_CALENDAR_ROUTE, postgres(successfulServices({
    contentWorkspaceId: IDS.otherWorkspace,
  })), COOKIE);

  assert.equal(result.statusCode, 503);
  assert.match(result.body, /Campaign Calendar temporarily unavailable/);
  assert.match(result.body, /No campaign, content, provider, schedule or delivery state was changed/);
  assert.doesNotMatch(result.body, new RegExp(IDS.otherWorkspace));
});

test('service exceptions and unsafe projection extensions are sanitised at the router boundary', async () => {
  const companyContent = successfulServices().companyContent;
  const thrown = await call(CONTENT_CALENDAR_ROUTE, postgres({
    companyContent,
    publicSocial: publicSocialService(async () => {
      throw new Error('postgres://owner:SUPER-SECRET@production.internal/customer-data');
    }),
  }), COOKIE);
  assert.equal(thrown.statusCode, 503);
  assert.match(thrown.body, /Campaign Calendar temporarily unavailable/);
  assert.doesNotMatch(thrown.body, /SUPER-SECRET|production\.internal|customer-data/);

  const unsafe = {
    ...calendarProjection(),
    bodyText: 'PRIVATE-BODY-SENTINEL',
    accountRef: 'PRIVATE-ACCOUNT-SENTINEL',
    storageKey: 'PRIVATE-STORAGE-SENTINEL',
    secret: 'PRIVATE-SECRET-SENTINEL',
  } as unknown as SocialCampaignCalendarProjection;
  const rejected = await call(CONTENT_CALENDAR_ROUTE, postgres(successfulServices({
    projection: unsafe,
  })), COOKIE);
  assert.equal(rejected.statusCode, 503);
  assert.match(rejected.body, /Campaign Calendar temporarily unavailable/);
  assert.doesNotMatch(rejected.body, /PRIVATE-(?:BODY|ACCOUNT|STORAGE|SECRET)-SENTINEL/);
});

test('calendar exposes no POST or provider-effect path', async () => {
  let socialReads = 0;
  let contentReads = 0;
  const services = successfulServices();
  const result = await call(CONTENT_CALENDAR_ROUTE, postgres({
    publicSocial: publicSocialService(async (...args) => {
      socialReads += 1;
      return services.publicSocial.snapshot(...args);
    }),
    companyContent: companyContentService(async (...args) => {
      contentReads += 1;
      return services.companyContent.snapshot(...args);
    }),
  }), COOKIE, 'POST');

  assert.equal(result.statusCode, 404);
  assert.equal(socialReads, 0);
  assert.equal(contentReads, 0);
  assert.doesNotMatch(result.body, /published|sent|scheduled with provider/i);
});
