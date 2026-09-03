import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { liveChannelsNoticeToken } from '../src/portal/live-channels-actions.js';
import { createPropertyPredatorLiveChannelsFixture } from '../src/portal/live-channels-fixtures.js';
import {
  LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE,
  LIVE_CHANNELS_ROUTE,
  presentLiveChannels,
} from '../src/portal/live-channels-presenter.js';
import { renderLiveChannelsBody } from '../src/portal/live-channels-view.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import type { PortalZernioCalendarCommandService } from '../src/portal/zernio-calendar-command-service.js';

const SECRET = 'zernio-calendar-router-secret';
const SESSION = Buffer.alloc(32, 77).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';
const USER_ID = 'fb100000-0000-4000-8000-000000000001';
const COMMAND_KEY = 'fa900000-0000-4000-8000-00000000aa01';
const PLANNING_INTENT_ID = 'fca00000-0000-4000-8000-000000000151';
const PLANNING_TARGET_ID = 'fcb00000-0000-4000-8000-000000000161';
const CONTENT_ITEM_ID = 'fc300000-0000-4000-8000-0000000000e1';
const CONTENT_VERSION_ID = 'fc400000-0000-4000-8000-0000000000f1';
const APPROVAL_REQUEST_ID = 'fc500000-0000-4000-8000-000000000101';
const APPROVAL_DECISION_ID = 'fc600000-0000-4000-8000-000000000111';
const SOURCE_ATTESTATION_ID = 'fc700000-0000-4000-8000-000000000121';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token, userId: USER_ID, userEmail: 'founder@example.test', workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-09-02T08:00:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Property Predator Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-09-02T08:00:00.000Z', canWrite: true },
  }),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'not used' }),
};

function postgres(zernioCalendar: PortalZernioCalendarCommandService): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false, auth, crm,
    requestId: () => 'zernio-calendar-router-request',
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    zernioCalendar,
  };
}

function request(body: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = 'POST';
  req.url = LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE;
  req.headers = {
    cookie: COOKIE,
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(Buffer.byteLength(body)),
  };
  setImmediate(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
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

function fields(): Record<string, string> {
  return {
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: COMMAND_KEY,
    network: 'instagram',
    planning_intent_id: PLANNING_INTENT_ID,
    planning_target_id: PLANNING_TARGET_ID,
    content_item_id: CONTENT_ITEM_ID,
    content_version_id: CONTENT_VERSION_ID,
    approval_request_id: APPROVAL_REQUEST_ID,
    approval_decision_id: APPROVAL_DECISION_ID,
    source_attestation_id: SOURCE_ATTESTATION_ID,
    operation_tag: 'calendar-proof',
    scheduled_for: '2026-09-02T09:00:00.000Z',
    confirm_stage: 'STAGE',
  };
}

function encodeForm(input: Readonly<Record<string, string>>): string {
  return new URLSearchParams(input).toString();
}

test('Zernio calendar staging accepts immutable evidence and rejects browser provider identity', async () => {
  const calls: unknown[] = [];
  const service: PortalZernioCalendarCommandService = {
    configuredNetworks: ['instagram', 'linkedin'],
    stage: async (identity, input) => {
      calls.push({ identity, input });
      return {
        ok: true,
        jobId: 'fc900000-0000-4000-8000-000000000141',
        idempotencyKeySha256: 'a'.repeat(64),
        caps: { daily: 1, monthly: 3 },
        providerEffects: 'none',
        workerLeaseClaimed: false,
      };
    },
  };
  const res = response();
  await handlePortal(request(encodeForm(fields())) as never, res as never, postgres(service));
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, 'publication_staged'))}`);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { input: unknown }).input, {
    network: 'instagram',
    planningIntentId: PLANNING_INTENT_ID,
    planningTargetId: PLANNING_TARGET_ID,
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
    approvalRequestId: APPROVAL_REQUEST_ID,
    approvalDecisionId: APPROVAL_DECISION_ID,
    sourceAttestationId: SOURCE_ATTESTATION_ID,
    operationTag: 'calendar-proof',
    scheduledFor: '2026-09-02T09:00:00.000Z',
  });

  const forged = response();
  await handlePortal(request(encodeForm({ ...fields(), provider_profile_id: 'browser-owned', owned_account: 'browser-owned' })) as never, forged as never, postgres(service));
  assert.equal(forged.statusCode, 303);
  assert.equal(forged.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, 'owned_social_invalid'))}`);
  assert.equal(calls.length, 1);
});

test('live-channel panel exposes calendar evidence but no provider identity fields', () => {
  const html = renderLiveChannelsBody(presentLiveChannels(createPropertyPredatorLiveChannelsFixture()), {
    workspaceName: 'Property Predator Growth HQ',
    csrfToken: 'csrf',
    pauseCommandAvailable: true,
    pauseCommandKeys: {
      all: COMMAND_KEY, customer_email: COMMAND_KEY, owned_social: COMMAND_KEY,
      whatsapp: COMMAND_KEY, sms: COMMAND_KEY, social_dm: COMMAND_KEY,
    },
    railStatusAvailable: true,
    handoff: { conversionInboxComposed: true, inboxOperationsComposed: true, lead360Composed: true },
    ownedSocialCommandAvailable: true,
    zernioCalendarCommandAvailable: true,
    zernioCalendarConfiguredNetworks: ['instagram', 'linkedin'],
    ownedSocialCommandKeys: { bind: COMMAND_KEY, revoke: COMMAND_KEY, stage: COMMAND_KEY },
  });
  assert.match(html, /Arm calendar publication/u);
  assert.match(html, /Manage connected accounts/u);
  assert.match(html, /1-per-day \/ 3-per-month cap/u);
  assert.doesNotMatch(html, /name="(?:profile_id|owned_account|provider_profile_id|profile_credential)"/u);
  assert.doesNotMatch(html, /Ayrshare Profile Key/u);
  assert.doesNotMatch(html, /zernio/i);
});
