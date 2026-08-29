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
  PortalLiveChannelsService,
  PortalLiveChannelsSnapshot,
} from '../src/portal/live-channels-service.js';
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

function evidenceSnapshot(): PortalLiveChannelsSnapshot {
  const data = structuredClone(createPropertyPredatorLiveChannelsFixture()) as any;
  data.dataset = 'evidence';
  data.channels[0].switches.emergencyPaused = false;
  return data as PortalLiveChannelsSnapshot;
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

test('without a composed service the labelled fixture renders', async () => {
  const result = await call(LIVE_CHANNELS_ROUTE, postgres(), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.match(result.body, /ILLUSTRATIVE TEST DATA/);
  assert.match(result.body, /data-dataset="illustrative_fixture"/);
  assert.match(result.body, /0 of 3 channels live/);
  assert.match(result.body, /ALL RAILS PAUSED/);
  // Every rail is paused in the fixture, so no pause form can render anywhere.
  assert.doesNotMatch(result.body, /name="confirm_pause"/);
  // The shell titles this page as itself, never as a sibling surface.
  assert.match(result.body, /<title>PropertyPredator Live Channels — /);
  // With no composed readiness cockpit, no link can dead-end on it.
  assert.doesNotMatch(result.body, /href="\/portal\/providers\/readiness"/);
});

test('a composed service is called with the request identity and renders evidence', async () => {
  const calls: unknown[] = [];
  const service: PortalLiveChannelsService = {
    snapshot: async (identity) => {
      calls.push(identity);
      return { ok: true, snapshot: evidenceSnapshot() };
    },
  };
  const result = await call(LIVE_CHANNELS_ROUTE, postgres({ liveChannels: service }), COOKIE);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /OBSERVED EVIDENCE/);
  assert.match(result.body, /Connected · ready/);
  assert.deepEqual(calls, [{ sessionToken: SESSION, requestId: 'live-channels-request' }]);
});

test('service outcomes map onto honest status pages', async () => {
  const forbidden = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannels: { snapshot: async () => ({ ok: false, kind: 'forbidden', message: 'No live channel access.' }) },
  }), COOKIE);
  assert.equal(forbidden.statusCode, 403);

  const unavailable = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannels: { snapshot: async () => ({ ok: false, kind: 'unavailable', message: 'Evidence store unreachable. Nothing was changed.' }) },
  }), COOKIE);
  assert.equal(unavailable.statusCode, 503);
  assert.match(unavailable.body, /Nothing was changed/);
});

test('a snapshot that breaks the truth boundary renders 503, never a page', async () => {
  const lying = structuredClone(createPropertyPredatorLiveChannelsFixture()) as any;
  lying.channels[0].switches.emergencyPaused = false; // illustrative + deliverable = contradiction
  const result = await call(LIVE_CHANNELS_ROUTE, postgres({
    liveChannels: { snapshot: async () => ({ ok: true, snapshot: lying }) },
  }), COOKIE);
  assert.equal(result.statusCode, 503);
  assert.match(result.body, /No channel, switch, credential or provider operation was changed/);
});

test('signed notices render and forged notices are ignored', async () => {
  const token = liveChannelsNoticeToken(SECRET, SESSION, 'pause_engaged');
  const signed = await call(`${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(token)}`, postgres(), COOKIE);
  assert.equal(signed.statusCode, 200);
  assert.match(signed.body, /Emergency pause engaged/);

  const forged = await call(`${LIVE_CHANNELS_ROUTE}?notice=pause_engaged.forgery`, postgres(), COOKIE);
  assert.equal(forged.statusCode, 200);
  assert.doesNotMatch(forged.body, /class="plc-notice/);
});

test('pause command rejects missing confirmation, bad csrf and stray keys', async () => {
  let engaged = 0;
  const service: PortalLiveChannelsService = {
    snapshot: async () => ({ ok: true, snapshot: evidenceSnapshot() }),
    engageEmergencyPause: async () => { engaged += 1; return { ok: true, state: 'engaged' }; },
  };
  const deps = postgres({ liveChannels: service });
  const csrf = csrfFor(SESSION);
  const invalidExpected = encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, 'invalid'));

  const noConfirm = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=all`);
  assert.equal(noConfirm.statusCode, 303);
  assert.equal(noConfirm.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  const badCsrf = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=wrong&command_key=${COMMAND_KEY}&scope=all&confirm_pause=ENGAGE`);
  assert.equal(badCsrf.statusCode, 303);
  assert.equal(badCsrf.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  const strayKey = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=all&confirm_pause=ENGAGE&extra=1`);
  assert.equal(strayKey.statusCode, 303);
  assert.equal(strayKey.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  const badScope = await call(LIVE_CHANNELS_PAUSE_ROUTE, deps, COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=everything&confirm_pause=ENGAGE`);
  assert.equal(badScope.statusCode, 303);
  assert.equal(badScope.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${invalidExpected}`);

  assert.equal(engaged, 0);
});

test('pause command without a composed seam changes nothing and says so', async () => {
  const csrf = csrfFor(SESSION);
  const result = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres(), COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=all&confirm_pause=ENGAGE`);
  assert.equal(result.statusCode, 303);
  const expected = encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, 'unavailable'));
  assert.equal(result.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${expected}`);
});

test('a confirmed pause command reaches the seam exactly once', async () => {
  const commands: unknown[] = [];
  const service: PortalLiveChannelsService = {
    snapshot: async () => ({ ok: true, snapshot: evidenceSnapshot() }),
    engageEmergencyPause: async (identity, input) => {
      commands.push({ identity, input });
      return { ok: true, state: 'engaged' };
    },
  };
  const csrf = csrfFor(SESSION);
  const result = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres({ liveChannels: service }), COOKIE, 'POST',
    `_csrf=${encodeURIComponent(csrf)}&command_key=${COMMAND_KEY}&scope=customer_email_mailgun&confirm_pause=ENGAGE`);
  assert.equal(result.statusCode, 303);
  const expected = encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, 'pause_engaged'));
  assert.equal(result.headers.location, `${LIVE_CHANNELS_ROUTE}?notice=${expected}`);
  assert.deepEqual(commands, [{
    identity: { sessionToken: SESSION, requestId: 'live-channels-request' },
    input: { scope: 'customer_email_mailgun', commandKey: COMMAND_KEY },
  }]);
});

test('pause command is Property Predator-only and auth-gated', async () => {
  const wrongProfile = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres({
    productProfile: RELAUNCH72_PRODUCT_PROFILE,
  }), COOKIE, 'POST', 'scope=all');
  assert.equal(wrongProfile.statusCode, 404);

  const unauthenticated = await call(LIVE_CHANNELS_PAUSE_ROUTE, postgres(), undefined, 'POST', 'scope=all');
  assert.equal(unauthenticated.statusCode, 302);
});
