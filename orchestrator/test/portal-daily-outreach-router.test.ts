import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { DAILY_OUTREACH_ROUTE } from '../src/portal/daily-outreach-presenter.js';
import {
  DAILY_OUTREACH_MANUAL_ATTEMPT_ROUTE,
  DAILY_OUTREACH_OUTCOME_ROUTE,
  renderDailyOutreachLiveBody,
} from '../src/portal/daily-outreach-live-view.js';
import type {
  DailyOutreachAuthoritativeSnapshot,
  PortalDailyOutreachService,
} from '../src/portal/daily-outreach-service.js';
import {
  PROPERTY_PREDATOR_GROWTH_PROFILE,
  RELAUNCH72_PRODUCT_PROFILE,
} from '../src/portal/product-profile.js';
import { buildPostgresPortalDeps } from '../src/portal/provision.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE } from '../src/portal/session.js';

const SECRET = 'daily-outreach-router-secret';
const SESSION = Buffer.alloc(32, 81).toString('base64url');
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
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: '2026-09-02T08:15:00.000Z',
      canWrite: true,
    },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: {
      id: WORKSPACE_ID,
      name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      snapshotAt: '2026-09-02T08:15:00.000Z',
      canWrite: true,
    },
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
        requestId: 'daily-outreach-request',
        requestHash: Buffer.alloc(32, 82),
        clientAddress: '127.0.0.1',
        sourceHash: Buffer.alloc(32, 83),
      }),
      abuseHashSecret: 'daily-outreach-abuse-secret-at-least-32-characters',
      requestId: () => 'daily-outreach-request',
      now: () => Date.parse('2026-09-02T08:15:00.000Z'),
    }),
    ...overrides,
  };
}

function request(url: string, method = 'GET', cookie?: string, body?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = cookie ? { cookie } : {};
  setTimeout(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  }, 1);
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
  body?: string,
) {
  const res = response();
  await handlePortal(request(url, method, cookie, body) as never, res as never, deps);
  return res;
}

test('Daily Outreach route is authenticated and Property Predator scoped', async () => {
  const unauthenticated = await call(DAILY_OUTREACH_ROUTE, postgres());
  assert.equal(unauthenticated.statusCode, 302);
  assert.equal(unauthenticated.headers.location, '/portal/login');

  const wrongProfile = await call(DAILY_OUTREACH_ROUTE, postgres({
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE);
  assert.equal(wrongProfile.statusCode, 404);

  const result = await call(DAILY_OUTREACH_ROUTE, postgres(), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /Growth HQ · Daily Outreach/);
  assert.match(result.body, /Fill the tank/);
  assert.match(result.body, /FICTIONAL TEST DATA/);
  assert.match(result.body, /MANUAL FIRST TOUCH/);
  assert.match(result.body, /SOCIAL REPLY SUPPORTED/);
  assert.match(result.body, /Creator Watch · Authority Commenter preview/);

  const home = await call('/portal', postgres(), COOKIE);
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /href="\/portal\/outreach\/daily">Daily Outreach/);
});

function authoritativeSnapshot(): DailyOutreachAuthoritativeSnapshot {
  return {
    schemaVersion: 1,
    dataset: 'postgres_authoritative',
    quotaTimezone: 'UTC',
    quotaDayUtc: '2026-09-02',
    snapshotAt: '2026-09-02T08:15:00.000Z',
    workspace: { id: WORKSPACE_ID },
    operator: {
      id: '72000000-0000-4000-8000-000000000002',
      viewerUserId: '72000000-0000-4000-8000-000000000002',
      viewerIsOperator: true,
    },
    programme: {
      id: '72000000-0000-4000-8000-000000000003',
      key: 'founder_daily_linkedin', versionNumber: 1, channel: 'linkedin',
      segmentKey: 'property_founders', dailyTarget: 12, operatingDailyCap: 15,
      providerDailyCap: 0, cooldownSeconds: 259200,
      effectiveFrom: '2026-09-01', effectiveUntil: null,
      providerEffectsEnabled: false,
    },
    manager: {
      prospectsReviewed: 1, validAttempts: 0, responses: 0, positiveResponses: 0,
      booked: 0, noResponse: 0, invalidTargets: 0, suppressed: 0, blocked: 0,
      activeLeases: 0, cooling: 0, stopped: 0, tasksCreated: 0,
      responseEvidencePending: 0, target: 12, operatingDailyCap: 15,
      providerDailyCap: 0, remainingToTarget: 12,
      metricAvailability: { conversationsCreated: 'not_linked_in_slice' },
    },
    queue: [{
      allocationId: '72000000-0000-4000-8000-000000000004',
      programmeVersionId: '72000000-0000-4000-8000-000000000003',
      prospectMembershipId: '72000000-0000-4000-8000-000000000005',
      contact: {
        id: '72000000-0000-4000-8000-000000000006',
        displayName: 'Avery Stone', companyName: 'Stone Developments',
      },
      operatorUserId: '72000000-0000-4000-8000-000000000002',
      channel: 'linkedin', segmentKey: 'property_founders', quotaDayUtc: '2026-09-02',
      priorityRank: 1,
      source: {
        adapter: 'approved_company_list', observedAt: '2026-09-02T08:00:00.000Z',
        expiresAt: '2026-09-03T08:00:00.000Z',
      },
      eligibility: {
        id: '72000000-0000-4000-8000-000000000007',
        decision: 'manual_first_touch', reasonCode: 'verified_operator_route',
        evaluatedAt: '2026-09-02T08:05:00.000Z', expiresAt: '2026-09-02T12:00:00.000Z',
        providerEffectsEnabled: false,
      },
      lease: null,
      contentAssignment: {
        id: '72000000-0000-4000-8000-000000000008',
        assignedAt: '2026-09-02T08:06:00.000Z',
        contentItemId: '72000000-0000-4000-8000-000000000009',
        contentVersionId: '72000000-0000-4000-8000-000000000010',
        contentSha256: 'a'.repeat(64),
        approvalRequestId: '72000000-0000-4000-8000-000000000011',
        approvalDecisionId: '72000000-0000-4000-8000-000000000012',
        current: true,
      },
      latestOutcome: null, control: null, projection: null, task: null,
      actionState: 'manual_ready', commandRechecksRequired: true,
    }],
    recentOutcomes: [], commandBoundaryAvailable: true, externalEffects: false,
  };
}

test('authoritative Daily Outreach service replaces the fixture and accepts only protected evidence commands', async () => {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const dailyOutreach: PortalDailyOutreachService = {
    snapshot: async () => ({ ok: true, snapshot: authoritativeSnapshot() }),
    recordManualAttempt: async (_identity, input) => {
      calls.push({ kind: 'manual', input });
      return {
        ok: true, disposition: 'recorded',
        outcomeEventId: '72000000-0000-4000-8000-000000000013', taskId: null,
        lapsDisposition: 'cold_attempt_not_eligible',
      };
    },
    recordOutcome: async (_identity, input) => {
      calls.push({ kind: 'outcome', input });
      return {
        ok: true, disposition: 'recorded',
        outcomeEventId: '72000000-0000-4000-8000-000000000014', taskId: null,
        lapsDisposition: 'response_evidence_pending',
      };
    },
  };
  const deps = postgres({ dailyOutreach });
  const page = await call(DAILY_OUTREACH_ROUTE, deps, COOKIE);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /data-dataset="postgres_authoritative"/);
  assert.match(page.body, /PostgreSQL authoritative/);
  assert.match(page.body, /Avery Stone/);
  assert.match(page.body, /Open Lead 360/);
  assert.match(page.body, /Open exact approved copy/);
  assert.match(page.body, /href="\/portal\/crm\/contacts\/72000000-0000-4000-8000-000000000006"/);
  assert.match(page.body, /href="\/portal\/content\/items\/72000000-0000-4000-8000-000000000009\/versions\/72000000-0000-4000-8000-000000000010\/review"/);
  assert.match(page.body, new RegExp(`action="${DAILY_OUTREACH_MANUAL_ATTEMPT_ROUTE}"`));
  assert.doesNotMatch(page.body, /FICTIONAL TEST DATA|Creator Watch · Authority Commenter preview/);
  const csrf = /name="_csrf" value="([^"]+)"/u.exec(page.body)?.[1];
  assert.ok(csrf);
  const body = new URLSearchParams({
    _csrf: csrf,
    command_key: '72000000-0000-4000-8000-000000000015',
    allocation_id: '72000000-0000-4000-8000-000000000004',
  }).toString();
  const saved = await call(DAILY_OUTREACH_MANUAL_ATTEMPT_ROUTE, deps, COOKIE, 'POST', body);
  assert.equal(saved.statusCode, 303);
  assert.equal(saved.headers.location, DAILY_OUTREACH_ROUTE);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    kind: 'manual',
    input: {
      allocationId: '72000000-0000-4000-8000-000000000004',
      attemptedAt: '2026-09-02T08:15:00.000Z',
      commandKey: '72000000-0000-4000-8000-000000000015',
    },
  });

  const malformed = await call(
    DAILY_OUTREACH_OUTCOME_ROUTE,
    deps,
    COOKIE,
    'POST',
    `${body}&unexpected=1`,
  );
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.length, 1);
});

test('Daily Outreach route contains no provider command surface', async () => {
  const post = await call(DAILY_OUTREACH_ROUTE, postgres(), COOKIE, 'POST');
  assert.equal(post.statusCode, 404);

  const result = await call(DAILY_OUTREACH_ROUTE, postgres(), COOKIE);
  const surfaceStart = result.body.indexOf('<article class="pdo"');
  const surfaceEnd = result.body.indexOf('</article>', surfaceStart);
  assert.ok(surfaceStart >= 0 && surfaceEnd > surfaceStart);
  const surface = result.body.slice(surfaceStart, surfaceEnd);
  assert.match(surface, /data-provider-effects="none"/);
  assert.match(surface, /data-contact-effects="none"/);
  assert.match(surface, /data-command-boundary="absent"/);
  assert.doesNotMatch(surface, /<form\b|<button\b|method="post"|fetch\s*\(/iu);
});

test('authoritative read-only snapshots expose no command forms', () => {
  const snapshot = { ...authoritativeSnapshot(), commandBoundaryAvailable: false } as const;
  const html = renderDailyOutreachLiveBody(snapshot, {
    csrfToken: 'csrf-test',
    nextCommandKey: () => 'command-test',
  });
  assert.match(html, /data-dataset="postgres_authoritative"/);
  assert.doesNotMatch(html, /<form\b|method="post"/iu);
});

test('authoritative manager evidence calculates truthful operating rates', () => {
  const source = authoritativeSnapshot();
  const snapshot: DailyOutreachAuthoritativeSnapshot = {
    ...source,
    manager: {
      ...source.manager,
      validAttempts: 8,
      responses: 3,
      positiveResponses: 2,
    },
  };
  const html = renderDailyOutreachLiveBody(snapshot, {
    csrfToken: 'csrf-test', nextCommandKey: () => 'command-test',
  });
  assert.match(html, /Response rate<\/span><strong>37\.5%/u);
  assert.match(html, /Positive rate<\/span><strong>25%/u);
});

test('authoritative over-target gauge stays inside its ARIA range', () => {
  const source = authoritativeSnapshot();
  const snapshot: DailyOutreachAuthoritativeSnapshot = {
    ...source,
    manager: {
      ...source.manager,
      validAttempts: 14,
      remainingToTarget: 0,
    },
  };
  const html = renderDailyOutreachLiveBody(snapshot, {
    csrfToken: 'csrf-test', nextCommandKey: () => 'command-test',
  });

  assert.match(html, /aria-valuemax="12" aria-valuenow="12"/);
  assert.match(html, /aria-label="Daily outreach fuel: 14 completed of 12"/);
  assert.match(html, />14\/12</);
});

test('only the first actionable allocation receives a manual-attempt command', () => {
  const source = authoritativeSnapshot();
  const first = source.queue[0]!;
  const secondAllocationId = '72000000-0000-4000-8000-000000000016';
  const snapshot: DailyOutreachAuthoritativeSnapshot = {
    ...source,
    queue: [first, {
      ...first,
      allocationId: secondAllocationId,
      prospectMembershipId: '72000000-0000-4000-8000-000000000017',
      contact: {
        id: '72000000-0000-4000-8000-000000000018',
        displayName: 'Second Prospect',
        companyName: 'Second Company',
      },
      eligibility: first.eligibility ? {
        ...first.eligibility,
        id: '72000000-0000-4000-8000-000000000019',
      } : null,
      contentAssignment: first.contentAssignment ? {
        ...first.contentAssignment,
        id: '72000000-0000-4000-8000-000000000020',
      } : null,
      priorityRank: 2,
    }],
  };
  const html = renderDailyOutreachLiveBody(snapshot, {
    csrfToken: 'csrf-test',
    nextCommandKey: () => 'command-test',
  });
  assert.match(html, /Second Prospect/);
  assert.doesNotMatch(
    html,
    new RegExp(`name="allocation_id" value="${secondAllocationId}"`),
  );
  assert.equal(
    html.match(new RegExp(`name="allocation_id" value="${first.allocationId}"`, 'gu'))?.length,
    2,
    'the next card and its queue row may both record only the same first allocation',
  );
});

test('prior-day unresolved outcomes remain actionable without re-entering today\'s queue', () => {
  const source = authoritativeSnapshot();
  const assignment = source.queue[0]!.contentAssignment!;
  const previousOutcomeEventId = '72000000-0000-4000-8000-000000000021';
  const attemptReceiptId = '72000000-0000-4000-8000-000000000022';
  const snapshot: DailyOutreachAuthoritativeSnapshot = {
    ...source,
    queue: [],
    recentOutcomes: [{
      id: previousOutcomeEventId,
      attemptReceiptId,
      allocationId: '72000000-0000-4000-8000-000000000023',
      programmeVersionId: source.programme.id,
      quotaDayUtc: '2026-09-01',
      attemptedAt: '2026-09-01T08:15:00.000Z',
      cooldownSeconds: 259_200,
      contact: source.queue[0]!.contact,
      channel: 'linkedin',
      outcome: 'attempted',
      occurredAt: '2026-09-01T08:15:00.000Z',
      recordedAt: '2026-09-01T08:15:01.000Z',
      isLatest: true,
      canRecordOutcome: true,
      contentAssignmentId: assignment.id,
      contentItemId: assignment.contentItemId,
      contentVersionId: assignment.contentVersionId,
      contentSha256: assignment.contentSha256,
      approvalRequestId: assignment.approvalRequestId,
      approvalDecisionId: assignment.approvalDecisionId,
      control: null,
      projection: null,
      task: null,
    }],
  };
  const html = renderDailyOutreachLiveBody(snapshot, {
    csrfToken: 'csrf-test',
    nextCommandKey: () => 'command-test',
  });
  assert.match(html, /Delayed replies stay actionable/);
  assert.match(html, new RegExp(`name="attempt_receipt_id" value="${attemptReceiptId}"`));
  assert.match(html, new RegExp(`name="previous_outcome_event_id" value="${previousOutcomeEventId}"`));
  assert.match(html, /attempt 2026-09-01/);
});
