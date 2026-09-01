import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createPropertyPredatorLiveChannelsFixture } from '../src/portal/live-channels-fixtures.js';
import {
  LIVE_CHANNELS_PAUSE_ROUTE,
  LIVE_CHANNELS_ROUTE,
} from '../src/portal/live-channels-presenter.js';
import { liveChannelsNoticeToken } from '../src/portal/live-channels-actions.js';
import type {
  PortalLiveChannelTruthService,
  PortalLiveChannelTruthSnapshot,
} from '../src/portal/live-channel-truth-service.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';

const SECRET = 'live-channels-router-secret';
const SESSION = Buffer.alloc(32, 53).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';
const COMMAND_KEY = 'fa900000-0000-4000-8000-00000000aa01';

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'fb100000-0000-4000-8000-000000000001',
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

/** Authoritative truth snapshot: the fixture rails re-stamped by the seam's own dataset. */
function truthSnapshot(): PortalLiveChannelTruthSnapshot {
  const data = structuredClone(createPropertyPredatorLiveChannelsFixture()) as any;
  data.dataset = 'postgres_authoritative';
  return {
    workspaceId: data.workspaceId,
    snapshotAt: data.snapshotAt,
    dataset: 'postgres_authoritative',
    rails: data.rails,
  } as PortalLiveChannelTruthSnapshot;
}

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => 'live-channels-request',
    now: () => Date.parse('2026-08-27T12:00:00.000Z'),
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth,
    crm,
    ...overrides,
  };
}

function request(url: string, method = 'GET', cookie?: string, body?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = {
    ...(cookie ? { cookie } : {}),
    ...(body === undefined ? {} : {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    }),
  };
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
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

async function call(url: string, deps: PostgresPortalDeps, cookie?: string, method = 'GET', body?: string) {
  const res = response();
  await handlePortal(request(url, method, cookie, body) as never, res as never, deps);
  return res;
}

function csrfFor(sessionToken: string): string {
  return portalCsrfToken(SECRET, sessionToken);
}

test('live channels requires an authenticated session', async () => {
  const result = await call(LIVE_CHANNELS_ROUTE, postgres());
  assert.equal(result.statusCode, 302);
  assert.match(result.headers.location ?? '', /\/portal\/login/);
});

test('live channels is Property Predator-only', async () => {
  const result = await call(
    LIVE_CHANNELS_ROUTE,
    postgres({ productProfile: RELAUNCH72_PRODUCT_PROFILE }),
    COOKIE,
  );
  assert.equal(result.statusCode, 404);
  assert.match(result.body, /Live Channels not connected/);
});

test('production fails closed when the truth seam is not composed', async () => {
  const result = await call(LIVE_CHANNELS_ROUTE, postgres(), COOKIE);
  assert.equal(result.statusCode, 404);
  assert.match(result.body, /truth seam is not composed/);
  // The fixture never renders from the production route.
  assert.doesNotMatch(result.body, /ILLUSTRATIVE TEST DATA/);
  assert.doesNotMatch(result.body, /data-dataset/);
});

test('a composed truth seam is called with the request identity and renders evidence', async () => {
  const calls: unknown[] = [];
  const service: PortalLiveChannelTruthService = {
    snapshot: async (identity) => {
      calls.push(identity);
      return { ok: true, snapshot: truthSnapshot() };
    },
  };
  const result = await call(LIVE_CHANNELS_ROUTE, postgres({ liveChannelTruth: service }), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /POSTGRES-AUTHORITATIVE EVIDENCE/);
  assert.match(result.body, /data-dataset="postgres_authoritative"/);
  assert.doesNotMatch(result.body, /ILLUSTRATIVE TEST DATA/);
  assert.match(result.body, /<title>PropertyPredator Live Channels — Property Predator Growth HQ/);
  assert.match(result.body, /0 of 5 channels live/);
  assert.match(result.body, /LIVE_ADAPTER_NOT_COMPOSED/);
  // No pause boundary exists, so no pause form can render in production.
  assert.doesNotMatch(result.body, /name="confirm_pause"/);
  assert.match(result.body, /command boundary not composed/);
  assert.deepEqual(calls, [{ sessionToken: SESSION, requestId: 'live-channels-request' }]);
});

test('an exact calendar handoff opens the Instagram stage form with immutable evidence prefilled', async () => {
  const params = new URLSearchParams({
    stage: 'owned_social', network: 'instagram',
    planning_intent_id: '11111111-1111-4111-8111-111111111111',
    content_item_id: '22222222-2222-4222-8222-222222222222',
    content_version_id: '33333333-3333-4333-8333-333333333333',
    approval_request_id: '44444444-4444-4444-8444-444444444444',
    approval_decision_id: '55555555-5555-4555-8555-555555555555',
    source_attestation_id: '66666666-6666-4666-8666-666666666666',
    scheduled_for: '2026-09-02T09:30:00.000Z',
    operation_tag: 'calendar:11111111-1111-4111-8111-111111111111',
  });
  const unavailable = async () => ({ ok: false as const, kind: 'unavailable' as const });
  const result = await call(`${LIVE_CHANNELS_ROUTE}?${params}`, postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: true, snapshot: truthSnapshot() }) },
    ownedSocialBinding: {
      providerConnectionId: '77777777-7777-4777-8777-777777777777',
      profileBindingComposed: true,
      recordProfile: unavailable, revokeProfile: unavailable,
      readiness: unavailable, stagePublication: unavailable,
    },
  }), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /id="plc-owned-social-stage" open/u);
  assert.match(result.body, /name="network" value="instagram"/u);
  assert.match(result.body, /name="planning_intent_id" value="11111111-1111-4111-8111-111111111111"/u);
  assert.match(result.body, /name="scheduled_for" value="2026-09-02T09:30:00.000Z"/u);
  assert.match(result.body, /Arm calendar publication/u);
});

test('composed engage-only pause seam enables deliberate pause forms with no release control', async () => {
  const result = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: true, snapshot: truthSnapshot() }) },
    liveChannelPause: { engage: async () => ({ ok: true, disposition: 'engaged', scope: 'all' }) },
  }), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /name="confirm_pause" value="ENGAGE"/u);
  assert.match(result.body, /Engage emergency pause/u);
  assert.doesNotMatch(result.body, /Release emergency pause|Resume channel/u);
});

test('truth seam failures map onto honest status pages', async () => {
  const forbidden = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: false, kind: 'forbidden', message: 'No live channel access.' }) },
  }), COOKIE);
  assert.equal(forbidden.statusCode, 403);

  const unavailable = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: false, kind: 'unavailable', message: 'Evidence store unreachable. Nothing was changed.' }) },
  }), COOKIE);
  assert.equal(unavailable.statusCode, 503);
  assert.match(unavailable.body, /Nothing was changed/);

  const invalid = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: false, kind: 'invalid_snapshot', message: 'The stored evidence failed validation. Nothing was changed.' }) },
  }), COOKIE);
  assert.equal(invalid.statusCode, 503);
});

test('a snapshot that breaks the truth boundary renders 503, never a page', async () => {
  const wrongDataset = truthSnapshot() as any;
  wrongDataset.dataset = 'illustrative_fixture';
  const datasetResult = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: true, snapshot: wrongDataset }) },
  }), COOKIE);
  assert.equal(datasetResult.statusCode, 503);

  const composedSocialDm = truthSnapshot() as any;
  composedSocialDm.rails[4].connectionState = 'configured';
  const socialDmResult = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: true, snapshot: composedSocialDm }) },
  }), COOKIE);
  assert.equal(socialDmResult.statusCode, 503);
  assert.match(socialDmResult.body, /No channel, switch, credential or provider operation was changed/);
});

test('signed notices render and forged notices are ignored', async () => {
  const service: PortalLiveChannelTruthService = {
    snapshot: async () => ({ ok: true, snapshot: truthSnapshot() }),
  };
  const token = liveChannelsNoticeToken(SECRET, SESSION, 'unavailable');
  const signed = await call(
    `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(token)}`,
    postgres({ liveChannelTruth: service }),
    COOKIE,
  );
  assert.equal(signed.statusCode, 200);
  assert.match(signed.body, /Pause command not connected/);

  const forged = await call(
    `${LIVE_CHANNELS_ROUTE}?notice=pause_engaged.forgery`,
    postgres({ liveChannelTruth: service }),
    COOKIE,
  );
  assert.equal(forged.statusCode, 200);
  assert.doesNotMatch(forged.body, /class="plc-notice/);
});

test('pause command rejects missing confirmation, bad csrf, stray keys and bad scopes', async () => {
  const deps = postgres({
    liveChannelTruth: { snapshot: async () => ({ ok: true, snapshot: truthSnapshot() }) },
  });
  const csrf = csrfFor(SESSION);
  const invalidExpected = encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, 'invalid'));

  const noConfirm = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=all`);
  assert.equal(noConfirm.statusCode, 303);
  assert.equal(noConfirm.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  const badCsrf = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=wrong&command_key=${COMMAND_KEY}&scope=all&confirm_pause=ENGAGE`);
  assert.equal(badCsrf.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  const strayKey = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=all&confirm_pause=ENGAGE&extra=1`);
  assert.equal(strayKey.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  const badScope = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=everything&confirm_pause=ENGAGE`);
  assert.equal(badScope.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  const legacyScope = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=customer_email_mailgun&confirm_pause=ENGAGE`);
  assert.equal(legacyScope.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);
});

test('a well-formed pause command lands on the honest unavailable notice', async () => {
  const csrf = csrfFor(SESSION);
  const expected = encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, 'unavailable'));
  for (const scope of ['all', 'customer_email', 'owned_social', 'whatsapp', 'social_dm']) {
    const result = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres(), COOKIE, 'POST',
      `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=${scope}&confirm_pause=ENGAGE`);
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${expected}`);
  }
});

test('a well-formed pause command calls the typed seam and maps engage/replay/denial truth', async () => {
  const csrf = csrfFor(SESSION);
  const calls: unknown[] = [];
  const body = `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=sms&confirm_pause=ENGAGE`;
  for (const [outcome, notice] of [
    [{ ok: true, disposition: 'engaged', scope: 'sms' }, 'pause_engaged'],
    [{ ok: true, disposition: 'replayed', scope: 'sms' }, 'pause_already'],
    [{ ok: false, kind: 'forbidden' }, 'forbidden'],
    [{ ok: false, kind: 'validation' }, 'invalid'],
  ] as const) {
    const result = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres({
      liveChannelPause: { engage: async (identity, input) => {
        calls.push({ identity, input }); return outcome;
      } },
    }), COOKIE, 'POST', body);
    const expected = encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, notice));
    assert.equal(result.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${expected}`);
  }
  assert.deepEqual(calls[0], {
    identity: { sessionToken: SESSION, requestId: 'live-channels-request' },
    input: { scope: 'sms', commandKey: COMMAND_KEY },
  });
});

test('pause command is Property Predator-only and auth-gated', async () => {
  const wrongProfile = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres({
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE, 'POST', 'scope=all');
  assert.equal(wrongProfile.statusCode, 404);

  const unauthenticated = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres(), undefined, 'POST', 'scope=all');
  assert.equal(unauthenticated.statusCode, 302);
});
