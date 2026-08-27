import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import {
  CAMPAIGN_WIZARD_CREATE_TEST_ROUTE,
  CAMPAIGN_WIZARD_ROUTE,
  campaignWizardNoticeFromQuery,
  campaignWizardNoticeToken,
} from '../src/portal/campaign-wizard-actions.js';
import type { PortalCompanyContentService } from '../src/portal/company-content-service.js';
import { createPropertyPredatorContentCatalogFixture } from '../src/portal/content-control-room-fixtures.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import type {
  PortalCancelPublicSocialPlanningTargetInput,
  PortalCreatePublicSocialCampaignPlanInput,
  PortalPublicSocialRequestIdentity,
  PortalPublicSocialService,
  PortalReschedulePublicSocialTargetInput,
} from '../src/portal/public-social-service.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type {
  SocialPlannerTargetProjection,
  SocialPlanningCalendarProjection,
} from '../src/social-campaign-pg/types.js';

const SECRET = 'planning-mutations-router-session-secret';
const SESSION = Buffer.alloc(32, 73).toString('base64url');
const OTHER_SESSION = Buffer.alloc(32, 74).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const NOW = '2026-08-27T12:00:00.000Z';
const CONTENT_CALENDAR_ROUTE = '/portal/content/calendar';
const RESCHEDULE_ROUTE = '/portal/content/calendar/test-reschedule';
const CANCEL_ROUTE = '/portal/content/calendar/test-cancel';

const IDS = Object.freeze({
  workspace: '91000000-0000-4000-8000-000000000001',
  user: '92000000-0000-4000-8000-000000000001',
  campaign: '93000000-0000-4000-8000-000000000001',
  revision: '94000000-0000-4000-8000-000000000001',
  intent: '95000000-0000-4000-8000-000000000001',
  successorIntent: '95000000-0000-4000-8000-000000000002',
  targetOne: '96000000-0000-4000-8000-000000000001',
  targetTwo: '96000000-0000-4000-8000-000000000002',
  contentItem: '97000000-0000-4000-8000-000000000001',
  contentVersion: '98000000-0000-4000-8000-000000000001',
  mediaOne: '99000000-0000-4000-8000-000000000001',
  mediaTwo: '99000000-0000-4000-8000-000000000002',
});

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: IDS.user,
    userEmail: 'owner@propertypredator.test',
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
    requestId: () => 'planning-mutations-router-request',
    now: () => Date.parse(NOW),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...overrides,
  };
}

function request(method: 'GET' | 'POST', url: string, cookie?: string, body = '') {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = {
    ...(cookie ? { cookie } : {}),
    ...(method === 'POST' ? {
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
  method: 'GET' | 'POST',
  url: string,
  deps: PostgresPortalDeps,
  form?: URLSearchParams,
  cookie = COOKIE,
) {
  const res = response();
  await handlePortal(
    request(method, url, cookie, form?.toString() ?? '') as never,
    res as never,
    deps,
  );
  return res;
}

function target(
  targetId: string,
  network: SocialPlannerTargetProjection['network'],
  targetLabel: string,
): SocialPlannerTargetProjection {
  return Object.freeze({
    targetId,
    network,
    targetLabel,
    environment: 'test',
    providerEffects: 'none',
  });
}

function planningRow(
  overrides: Partial<SocialPlanningCalendarProjection> = {},
): SocialPlanningCalendarProjection {
  return Object.freeze({
    intentId: IDS.intent,
    campaignId: IDS.campaign,
    revisionId: IDS.revision,
    revisionNumber: 1,
    campaignTitle: 'Evidence Week',
    desiredFor: '2026-08-28T09:30:00.000Z',
    contentItemId: IDS.contentItem,
    contentVersionId: IDS.contentVersion,
    contentSha256: 'a'.repeat(64),
    intentSha256: 'b'.repeat(64),
    targetId: IDS.targetOne,
    network: 'linkedin',
    targetLabel: 'LinkedIn owned TEST rail',
    planningState: 'awaiting_revalidation',
    materializedPostId: null,
    materializedOperationId: null,
    operationState: null,
    revalidationState: 'waiting_for_window',
    nextRevalidationAt: '2026-08-28T08:30:00.000Z',
    lastErrorCode: null,
    updatedAt: '2026-08-27T11:45:00.000Z',
    environment: 'test',
    providerEffects: 'none',
    ...overrides,
  });
}

interface SocialCalls {
  snapshots: Array<Readonly<{ identity: PortalPublicSocialRequestIdentity; input: unknown }>>;
  plans: Array<Readonly<{
    identity: PortalPublicSocialRequestIdentity;
    input: PortalCreatePublicSocialCampaignPlanInput;
  }>>;
  reschedules: Array<Readonly<{
    identity: PortalPublicSocialRequestIdentity;
    input: PortalReschedulePublicSocialTargetInput;
  }>>;
  cancels: Array<Readonly<{
    identity: PortalPublicSocialRequestIdentity;
    input: PortalCancelPublicSocialPlanningTargetInput;
  }>>;
}

function socialService(
  calls: SocialCalls,
  row: SocialPlanningCalendarProjection = planningRow(),
): PortalPublicSocialService {
  return {
    snapshot: async (identity, input) => {
      calls.snapshots.push({ identity, input });
      return {
        ok: true,
        snapshot: {
          workspace: {
            workspaceId: IDS.workspace,
            workspaceName: 'Property Predator Growth HQ',
            timezone: 'Europe/London',
            snapshotAt: NOW,
            canManage: true,
          },
          campaign: { items: [], hasMore: false },
          calendar: { items: [], hasMore: false },
          planning: {
            targets: {
              items: [
                target(IDS.targetOne, 'linkedin', 'LinkedIn owned TEST rail'),
                target(IDS.targetTwo, 'instagram', 'Instagram owned TEST rail'),
              ],
              hasMore: false,
            },
            calendar: { items: [row], hasMore: false },
          },
          environment: 'test',
          providerEffects: 'none',
        },
      };
    },
    createRevision: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    createCampaignPlan: async (identity, input) => {
      calls.plans.push({ identity, input });
      return {
        ok: true,
        result: {
          campaignId: IDS.campaign,
          revisionId: IDS.revision,
          intentId: IDS.intent,
          intentSha256: row.intentSha256,
          disposition: 'applied',
        },
        environment: 'test',
        providerEffects: 'none',
      };
    },
    reschedule: async (identity, input) => {
      calls.reschedules.push({ identity, input });
      return {
        ok: true,
        result: { successorIntentId: IDS.successorIntent, disposition: 'applied' },
        environment: 'test',
        providerEffects: 'none',
      };
    },
    cancel: async (identity, input) => {
      calls.cancels.push({ identity, input });
      return {
        ok: true,
        result: {
          intentId: input.intentId,
          targetId: input.targetId,
          state: 'cancelled',
          disposition: 'applied',
        },
        environment: 'test',
        providerEffects: 'none',
      };
    },
  };
}

function freshCalls(): SocialCalls {
  return { snapshots: [], plans: [], reschedules: [], cancels: [] };
}

function contentService(): PortalCompanyContentService {
  const fixture = createPropertyPredatorContentCatalogFixture();
  const copy = fixture.items[0]!;
  const artwork = fixture.items[2]!;
  return {
    snapshot: async () => ({
      ok: true,
      snapshot: {
        workspace: {
          workspaceId: IDS.workspace,
          workspaceName: 'Property Predator Growth HQ',
          snapshotAt: NOW,
          canWrite: true,
          canManage: true,
        },
        catalog: {
          items: [
            Object.freeze({
              ...copy,
              contentItemId: IDS.contentItem,
              contentVersionId: IDS.contentVersion,
              contentSha256: 'a'.repeat(64),
              sourceCheckedAt: '2026-08-27T11:55:00.000Z',
              sourceExpiresAt: '2026-08-27T12:05:00.000Z',
              sourceFresh: true,
              publishable: true,
            }),
            Object.freeze({
              ...artwork,
              contentVersionId: IDS.mediaOne,
              approvalStatus: 'approved' as const,
              approvalStale: false,
              sourceCheckedAt: '2026-08-27T11:55:00.000Z',
              sourceExpiresAt: '2026-08-27T12:05:00.000Z',
              sourceFresh: true,
              publishable: true,
            }),
          ],
          nextCursor: null,
        },
      },
    }),
    requestApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
    decideApproval: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  };
}

function baseCreateForm(): URLSearchParams {
  const form = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'campaign-command-0001',
    environment: 'test',
    timezone: 'Europe/London',
    return_to: CONTENT_CALENDAR_ROUTE,
    title: 'Property Predator evidence sprint',
    objective: 'Prove an owned education rhythm using exact approved company assets.',
    content_version_id: IDS.contentVersion,
    desired_for_local: '2026-08-28T10:30',
    max_attempts: '2',
    confirm_test_only: 'confirmed',
  });
  form.append('target_ids', IDS.targetOne.toUpperCase());
  form.append('target_ids', IDS.targetTwo);
  form.append('media_version_ids', IDS.mediaOne);
  form.append('media_version_ids', IDS.mediaTwo.toUpperCase());
  return form;
}

function baseCalendarForm(kind: 'reschedule' | 'cancel'): URLSearchParams {
  const form = new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: `${kind}-command-0001`,
    intent_id: IDS.intent,
    target_id: IDS.targetOne,
    intent_sha256: 'b'.repeat(64),
    expected_updated_at: '2026-08-27T11:45:00.000Z',
    reason: kind === 'reschedule' ? 'Move this TEST rehearsal after review.' : 'Stop this obsolete TEST target.',
    return_mode: 'week',
    return_date: '2026-08-28',
    return_channel: 'linkedin',
  });
  if (kind === 'reschedule') {
    form.set('desired_for_local', '2026-08-29T11:00');
    form.set('confirm_change', 'confirmed');
  } else {
    form.set('confirm_cancel', 'confirmed');
  }
  return form;
}

test('GET campaign wizard joins safe company content and TEST targets into one protected form', async () => {
  const calls = freshCalls();
  const result = await call('GET', CAMPAIGN_WIZARD_ROUTE, postgres({
    publicSocial: socialService(calls),
    companyContent: contentService(),
  }));

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /Build the rhythm\. <em>Keep control\.<\/em>/);
  assert.match(result.body, new RegExp(`action="${CAMPAIGN_WIZARD_CREATE_TEST_ROUTE}"`));
  assert.match(result.body, new RegExp(`name="content_version_id" value="${IDS.contentVersion}"`));
  assert.match(result.body, new RegExp(`name="media_version_ids" value="${IDS.mediaOne}"`));
  assert.match(result.body, new RegExp(`name="target_ids" value="${IDS.targetOne}"`));
  assert.match(result.body, new RegExp(`name="target_ids" value="${IDS.targetTwo}"`));
  assert.match(result.body, /data-environment="test"/);
  assert.match(result.body, /data-provider-effects="none"/);
  assert.doesNotMatch(
    result.body,
    /name="(?:body|body_text|provider|provider_id|connection_id|account_ref|storage_key|credential|publish)"/i,
  );
  assert.equal(calls.snapshots.length, 1);
  assert.deepEqual(calls.snapshots[0]?.identity, {
    sessionToken: SESSION,
    requestId: 'planning-mutations-router-request',
  });
});

test('production calendar CSP permits its same-origin protected mutation enhancement', async () => {
  const calls = freshCalls();
  const result = await call('GET', CONTENT_CALENDAR_ROUTE, postgres({
    publicSocial: socialService(calls),
    companyContent: contentService(),
  }));

  assert.equal(result.statusCode, 200);
  assert.match(result.headers['content-security-policy'] ?? '', /connect-src 'self'/);
  assert.match(result.body, /\/portal\/assets\/content-calendar\.js/);
  assert.match(result.body, new RegExp(`action="${RESCHEDULE_ROUTE}"`));
  assert.match(result.body, new RegExp(`action="${CANCEL_ROUTE}"`));
});

test('atomic wizard POST preserves repeated targets/media and exposes only browser-safe IDs', async () => {
  const calls = freshCalls();
  const result = await call('POST', CAMPAIGN_WIZARD_CREATE_TEST_ROUTE, postgres({
    publicSocial: socialService(calls),
    companyContent: contentService(),
  }), baseCreateForm());

  assert.equal(result.statusCode, 303);
  assert.match(result.headers.location ?? '', /^\/portal\/content\/calendar\?notice=planned\./);
  assert.equal(calls.plans.length, 1);
  assert.deepEqual(calls.plans[0], {
    identity: {
      sessionToken: SESSION,
      requestId: 'planning-mutations-router-request',
    },
    input: {
      commandKey: 'campaign-command-0001',
      title: 'Property Predator evidence sprint',
      objective: 'Prove an owned education rhythm using exact approved company assets.',
      contentVersionId: IDS.contentVersion,
      desiredFor: '2026-08-28T09:30:00.000Z',
      maxAttempts: 2,
      targetIds: [IDS.targetOne, IDS.targetTwo],
      mediaVersionIds: [IDS.mediaOne, IDS.mediaTwo],
    },
  });
  const input = calls.plans[0]!.input as unknown as Record<string, unknown>;
  for (const unsafe of [
    'workspaceId', 'body', 'bodyText', 'provider', 'providerId', 'connectionId',
    'testAccountRef', 'storageKey', 'credential', 'publish',
  ]) assert.equal(Object.hasOwn(input, unsafe), false, `${unsafe} escaped into command DTO`);
});

test('wizard POST rejects CSRF, duplicate singleton, unknown fields and DST gap/fold fail closed', async () => {
  const calls = freshCalls();
  const service = socialService(calls);
  const invalidForms: URLSearchParams[] = [];

  const csrf = baseCreateForm();
  csrf.set('_csrf', 'invalid-csrf');
  invalidForms.push(csrf);

  const duplicate = baseCreateForm();
  duplicate.append('title', 'Attacker-selected duplicate');
  invalidForms.push(duplicate);

  const unknown = baseCreateForm();
  unknown.set('provider_id', 'live-provider-forgery');
  invalidForms.push(unknown);

  const springGap = baseCreateForm();
  springGap.set('desired_for_local', '2026-03-29T01:30');
  invalidForms.push(springGap);

  const autumnFold = baseCreateForm();
  autumnFold.set('desired_for_local', '2026-10-25T01:30');
  invalidForms.push(autumnFold);

  for (const form of invalidForms) {
    const result = await call('POST', CAMPAIGN_WIZARD_CREATE_TEST_ROUTE, postgres({
      publicSocial: service,
      companyContent: contentService(),
    }), form);
    assert.equal(result.statusCode, 303);
    assert.match(result.headers.location ?? '', /^\/portal\/campaigns\/new\?notice=invalid\./);
    assert.doesNotMatch(result.headers.location ?? '', /live-provider-forgery|Attacker-selected/);
  }

  assert.equal(calls.plans.length, 0);
  assert.equal(calls.snapshots.length, 2, 'only the two structurally valid DST forms may read timezone truth');
  assert.equal(calls.reschedules.length, 0);
  assert.equal(calls.cancels.length, 0);
});

test('PRG mutation notices are allowlisted, signed and bound to the authenticated session', async () => {
  const calls = freshCalls();
  const deps = postgres({ publicSocial: socialService(calls), companyContent: contentService() });
  const posted = await call('POST', CAMPAIGN_WIZARD_CREATE_TEST_ROUTE, deps, baseCreateForm());
  const location = posted.headers.location ?? '';
  const redirectQuery = new URL(location, 'https://growth-hq.invalid').searchParams;
  const verified = campaignWizardNoticeFromQuery(redirectQuery, SECRET, SESSION);
  assert.equal(verified?.title, 'Durable TEST campaign planned');
  assert.match(verified?.detail ?? '', /No provider was called/);
  assert.equal(campaignWizardNoticeFromQuery(redirectQuery, SECRET, OTHER_SESSION), undefined);

  const safeToken = campaignWizardNoticeToken(SECRET, SESSION, 'planned');
  const safePage = await call(
    'GET',
    `${CAMPAIGN_WIZARD_ROUTE}?notice=${encodeURIComponent(safeToken)}`,
    deps,
  );
  assert.equal(safePage.statusCode, 200);
  assert.match(safePage.body, /Durable TEST campaign planned/);
  assert.match(safePage.body, /No provider was called/);

  const forgedPage = await call(
    'GET',
    `${CAMPAIGN_WIZARD_ROUTE}?notice=planned.attacker&detail=RAW_PROVIDER_SECRET`,
    deps,
  );
  assert.equal(forgedPage.statusCode, 200);
  assert.doesNotMatch(forgedPage.body, /Durable TEST campaign planned|RAW_PROVIDER_SECRET/);
});

test('calendar reschedule and cancel reject stale evidence before either mutation runs', async () => {
  const calls = freshCalls();
  const service = socialService(calls);

  const staleSha = baseCalendarForm('reschedule');
  staleSha.set('intent_sha256', 'c'.repeat(64));
  const reschedule = await call('POST', RESCHEDULE_ROUTE, postgres({ publicSocial: service }), staleSha);
  assert.equal(reschedule.statusCode, 303);
  assert.match(reschedule.headers.location ?? '', /notice=conflict\./);
  assert.match(reschedule.headers.location ?? '', /mode=week/);
  assert.match(reschedule.headers.location ?? '', /date=2026-08-28/);
  assert.match(reschedule.headers.location ?? '', /channel=linkedin/);

  const staleTimestamp = baseCalendarForm('cancel');
  staleTimestamp.set('expected_updated_at', '2026-08-27T11:44:59.000Z');
  const cancel = await call('POST', CANCEL_ROUTE, postgres({ publicSocial: service }), staleTimestamp);
  assert.equal(cancel.statusCode, 303);
  assert.match(cancel.headers.location ?? '', /notice=conflict\./);

  assert.equal(calls.snapshots.length, 2);
  assert.equal(calls.reschedules.length, 0);
  assert.equal(calls.cancels.length, 0);
});

test('calendar exact-evidence reschedule and cancel invoke only durable TEST command DTOs', async () => {
  const calls = freshCalls();
  const service = socialService(calls);

  const rescheduled = await call(
    'POST', RESCHEDULE_ROUTE, postgres({ publicSocial: service }), baseCalendarForm('reschedule'),
  );
  assert.equal(rescheduled.statusCode, 303);
  assert.match(rescheduled.headers.location ?? '', /notice=rescheduled\./);
  assert.deepEqual(calls.reschedules[0]?.input, {
    commandKey: 'reschedule-command-0001',
    predecessorIntentId: IDS.intent,
    targetId: IDS.targetOne,
    newDesiredFor: '2026-08-29T10:00:00.000Z',
    reason: 'Move this TEST rehearsal after review.',
  });

  const cancelled = await call(
    'POST', CANCEL_ROUTE, postgres({ publicSocial: service }), baseCalendarForm('cancel'),
  );
  assert.equal(cancelled.statusCode, 303);
  assert.match(cancelled.headers.location ?? '', /notice=cancelled\./);
  assert.deepEqual(calls.cancels[0]?.input, {
    intentId: IDS.intent,
    targetId: IDS.targetOne,
    reason: 'Stop this obsolete TEST target.',
  });

  for (const input of [calls.reschedules[0]!.input, calls.cancels[0]!.input]) {
    const projected = input as unknown as Record<string, unknown>;
    for (const unsafe of [
      'workspaceId', 'provider', 'providerId', 'connectionId', 'accountRef',
      'storageKey', 'credential', 'body', 'publish',
    ]) assert.equal(Object.hasOwn(projected, unsafe), false);
  }
});
