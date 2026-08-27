import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { SocialCampaignCommandProjection } from '../src/social-campaign-pg/types.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { PUBLIC_SOCIAL_CAMPAIGNS_ROUTE } from '../src/portal/public-social-campaigns-presenter.js';
import type { PortalPublicSocialService } from '../src/portal/public-social-service.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'campaign-router-session-secret';
const SESSION = Buffer.alloc(32, 61).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const NOW = '2026-08-27T12:00:00.000Z';
const IDS = Object.freeze({
  workspace: '11000000-0000-4000-8000-000000000001',
  user: '12000000-0000-4000-8000-000000000001',
  campaign: '13000000-0000-4000-8000-000000000001',
  revision: '14000000-0000-4000-8000-000000000001',
  post: '15000000-0000-4000-8000-000000000001',
  item: '16000000-0000-4000-8000-000000000001',
  version: '17000000-0000-4000-8000-000000000001',
  operation: '18000000-0000-4000-8000-000000000001',
  target: '19000000-0000-4000-8000-000000000001',
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
    requestId: () => 'campaign-router-request',
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

function projection(
  overrides: Partial<SocialCampaignCommandProjection> = {},
): SocialCampaignCommandProjection {
  return Object.freeze({
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 4,
    revisionSha256: 'a'.repeat(64),
    title: 'Predator Signal Sprint',
    objective: 'Move exact approved education through a measured TEST rhythm.',
    timezone: 'Europe/London',
    postId: IDS.post,
    contentItemId: IDS.item,
    contentVersionId: IDS.version,
    contentSha256: 'b'.repeat(64),
    planSha256: 'c'.repeat(64),
    scheduledFor: '2026-08-28T09:30:00.000Z',
    operationId: IDS.operation,
    targetId: IDS.target,
    network: 'linkedin',
    targetLabel: 'LinkedIn owned TEST rail',
    state: 'simulated_succeeded',
    simulationAttemptCount: 1,
    maxSimulationAttempts: 3,
    reconciliationAttemptCount: 0,
    maxReconciliationAttempts: 3,
    testReferenceSha256: 'd'.repeat(64),
    environment: 'test',
    providerEffects: 'none',
    ...overrides,
  });
}

function successSnapshot(
  campaign: readonly SocialCampaignCommandProjection[] = [projection()],
  campaignHasMore = false,
) {
  return {
    ok: true as const,
    snapshot: {
      workspace: {
        workspaceId: IDS.workspace,
        workspaceName: 'Property Predator Growth HQ',
        timezone: 'Europe/London',
        snapshotAt: NOW,
        canManage: true,
      },
      campaign: { items: campaign, hasMore: campaignHasMore },
      calendar: { items: [], hasMore: false },
      environment: 'test' as const,
      providerEffects: 'none' as const,
    },
  };
}

function publicSocialService(
  snapshot: PortalPublicSocialService['snapshot'],
  onEffect: () => void = () => undefined,
): PortalPublicSocialService {
  return {
    snapshot,
    createRevision: async () => {
      onEffect();
      return { ok: false, kind: 'unavailable', message: 'not used' };
    },
    registerTestTarget: async () => {
      onEffect();
      return { ok: false, kind: 'unavailable', message: 'not used' };
    },
    schedule: async () => {
      onEffect();
      return { ok: false, kind: 'unavailable', message: 'not used' };
    },
    cancelTarget: async () => {
      onEffect();
      return { ok: false, kind: 'unavailable', message: 'not used' };
    },
  };
}

test('Campaign Command requires authentication and the protected public-social read service', async () => {
  let reads = 0;
  const service = publicSocialService(async () => {
    reads += 1;
    return successSnapshot();
  });

  const unauthenticated = await call(PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, postgres({
    publicSocial: service,
  }));
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');
  assert.equal(reads, 0);

  const missing = await call(PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, postgres(), COOKIE);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.body, /Campaign Command not connected/);
  assert.equal(reads, 0);
});

test('canonicalises exact lowercase and uppercase campaign UUIDs before the bounded read', async () => {
  for (const supplied of [IDS.campaign, IDS.campaign.toUpperCase()]) {
    const calls: unknown[][] = [];
    const result = await call(
      `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=${encodeURIComponent(supplied)}`,
      postgres({
        publicSocial: publicSocialService(async (...args) => {
          calls.push(args);
          return successSnapshot();
        }),
      }),
      COOKIE,
    );

    assert.equal(result.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.[1] as { campaignId?: unknown }).campaignId, IDS.campaign);
    assert.match(result.body, new RegExp(IDS.campaign));
  }
});

test('rejects duplicate and invalid campaign identities before crossing the service boundary', async () => {
  let reads = 0;
  const service = publicSocialService(async () => {
    reads += 1;
    return successSnapshot();
  });
  const invalidUrls = [
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=${IDS.campaign}&campaign=${IDS.campaign}`,
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=not-a-uuid`,
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=00000000-0000-0000-0000-000000000000`,
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=13000000-0000-4000-7000-000000000001`,
  ];

  for (const url of invalidUrls) {
    const result = await call(url, postgres({ publicSocial: service }), COOKIE);
    assert.equal(result.statusCode, 400);
    assert.match(result.body, /Campaign address not valid/);
  }
  assert.equal(reads, 0);
});

test('uses only opaque session identity and a server-owned one-row read bound', async () => {
  const calls: unknown[][] = [];
  const result = await call(
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=${IDS.campaign}`
      + '&workspaceId=BROWSER-WORKSPACE-FORGERY&limit=999999'
      + '&from=1900-01-01T00%3A00%3A00.000Z&body=PRIVATE-QUERY-BODY',
    postgres({
      publicSocial: publicSocialService(async (...args) => {
        calls.push(args);
        return successSnapshot();
      }),
    }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(calls, [[
    {
      sessionToken: SESSION,
      requestId: 'campaign-router-request',
    },
    {
      campaignId: IDS.campaign,
      from: '2026-07-13T00:00:00.000Z',
      to: '2026-10-12T00:00:00.000Z',
      limit: 1,
    },
  ]]);
  assert.equal(Object.hasOwn(calls[0]?.[0] as object, 'workspaceId'), false);
  assert.equal(Object.hasOwn(calls[0]?.[0] as object, 'userId'), false);
  assert.doesNotMatch(result.body, /BROWSER-WORKSPACE-FORGERY|PRIVATE-QUERY-BODY|999999/);
});

test('renders the exact body-free TEST campaign projection without outbound material', async () => {
  const result = await call(
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=${IDS.campaign}`
      + '&calendar_mode=month&calendar_date=2026-10-12&calendar_channel=instagram',
    postgres({ publicSocial: publicSocialService(async () => successSnapshot()) }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /Property Predator · Public-social command truth/);
  assert.match(result.body, /Predator Signal Sprint/);
  assert.match(result.body, /LinkedIn owned TEST rail/);
  assert.match(result.body, /Simulation complete/);
  assert.match(result.body, new RegExp(IDS.revision));
  assert.match(result.body, new RegExp(IDS.post));
  assert.match(result.body, new RegExp(IDS.operation));
  assert.match(result.body, new RegExp('a'.repeat(64)));
  assert.match(result.body, new RegExp('b'.repeat(64)));
  assert.match(result.body, new RegExp('c'.repeat(64)));
  assert.match(result.body, /data-environment="test"/);
  assert.match(result.body, /data-provider-effects="none"/);
  assert.match(result.body, /data-read-only="true"/);
  assert.match(result.body, /href="\/portal\/content\/calendar\?mode=month&amp;date=2026-10-12&amp;channel=instagram"/);
  assert.doesNotMatch(result.body, /test-account:|PRIVATE-(?:BODY|ACCOUNT|STORAGE|SECRET)|providerToken|connectionId/);
});

test('renders database-proven campaign continuation as explicit loaded-only truth', async () => {
  const result = await call(
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=${IDS.campaign}`,
    postgres({
      publicSocial: publicSocialService(async () => successSnapshot([projection()], true)),
    }),
    COOKIE,
  );
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /data-input-truncated="true"/);
  assert.match(result.body, /Safe read boundary reached/);
  assert.match(result.body, /Loaded post plans/);
  assert.doesNotMatch(result.body, /Every fact visible/);
});

test('renders an empty authenticated campaign truth surface without demo substitution', async () => {
  const result = await call(
    `${PUBLIC_SOCIAL_CAMPAIGNS_ROUTE}?campaign=${IDS.campaign}`,
    postgres({ publicSocial: publicSocialService(async () => successSnapshot([])) }),
    COOKIE,
  );

  assert.equal(result.statusCode, 200);
  assert.match(result.body, /No exact campaign projection loaded/);
  assert.match(result.body, /No demo campaign has been substituted/);
  assert.match(result.body, /Open the TEST calendar/);
  assert.match(result.body, new RegExp(IDS.campaign));
  assert.doesNotMatch(result.body, /Predator Signal Sprint|LinkedIn owned TEST rail/);
});

test('sanitises service exceptions and rejects hostile projection extensions', async () => {
  const thrown = await call(PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, postgres({
    publicSocial: publicSocialService(async () => {
      throw new Error('postgres://owner:PRIVATE-SERVICE-SECRET@production.internal/customer-data');
    }),
  }), COOKIE);
  assert.equal(thrown.statusCode, 503);
  assert.match(thrown.body, /Campaign Command temporarily unavailable/);
  assert.match(thrown.body, /No campaign, provider, schedule or delivery state was changed/);
  assert.doesNotMatch(thrown.body, /PRIVATE-SERVICE-SECRET|production\.internal|customer-data/);

  const hostile = {
    ...projection(),
    bodyText: 'PRIVATE-BODY-SENTINEL',
    accountRef: 'PRIVATE-ACCOUNT-SENTINEL',
    storageKey: 'PRIVATE-STORAGE-SENTINEL',
    secret: 'PRIVATE-SECRET-SENTINEL',
  } as unknown as SocialCampaignCommandProjection;
  const rejected = await call(PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, postgres({
    publicSocial: publicSocialService(async () => successSnapshot([hostile])),
  }), COOKIE);
  assert.equal(rejected.statusCode, 503);
  assert.match(rejected.body, /Campaign Command temporarily unavailable/);
  assert.doesNotMatch(
    rejected.body,
    /PRIVATE-(?:BODY|ACCOUNT|STORAGE|SECRET)-SENTINEL/,
  );
});

test('is GET-only and cannot invoke any public-social command or provider effect', async () => {
  let reads = 0;
  let effects = 0;
  const service = publicSocialService(async () => {
    reads += 1;
    return successSnapshot();
  }, () => { effects += 1; });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const result = await call(PUBLIC_SOCIAL_CAMPAIGNS_ROUTE, postgres({
      publicSocial: service,
    }), COOKIE, method);
    assert.equal(result.statusCode, 404);
    assert.doesNotMatch(result.body, /published|sent|provider scheduled/i);
  }
  assert.equal(reads, 0);
  assert.equal(effects, 0);
});
