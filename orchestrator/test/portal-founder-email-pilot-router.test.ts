import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import {
  renderLead360Body,
  type Lead360ConsentView,
  type Lead360View,
} from '../src/portal/lead-360-view.js';
import {
  CONTACT_ENDPOINT_ATTACH_ROUTE,
  founderEmailPilotNoticeToken,
} from '../src/portal/founder-email-pilot-actions.js';
import type {
  AttachEndpointInput,
  AttachEndpointResult,
  PilotReadinessResult,
  PortalFounderEmailPilotService,
} from '../src/portal/founder-email-pilot-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';

const SECRET = 'founder-email-pilot-router-secret';
const SESSION = Buffer.alloc(32, 91).toString('base64url');
const OTHER_SESSION = Buffer.alloc(32, 92).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';
const CONTACT_ID = '725fb294-41a3-4806-a020-fd97cbf9c715';
const POINT_ID = 'fd100000-0000-4000-8000-000000000001';
const CASE_FILE = `/portal/crm/contacts/${CONTACT_ID}`;

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: 'fb100000-0000-4000-8000-000000000001',
    userEmail: 'founder@example.test',
    workspaceId: WORKSPACE_ID,
  } : null,
  login: async () => null,
  revoke: async () => undefined,
};

function endpoint(overrides: Partial<Lead360ConsentView> = {}): Lead360ConsentView {
  return {
    channelLabel: 'Email · office@propertypredator.com', state: 'unknown', basis: null,
    updatedAt: null, endpoint: 'office@propertypredator.com', contactPointId: POINT_ID,
    channel: 'email', purpose: 'property_predator_marketing', evidenceSource: null,
    policyVersion: null, policyTextSha256: null, effectiveAt: null, recordedAt: null,
    recordedBy: null, suppressionState: null, suppressionReason: null,
    ...overrides,
  };
}

function caseFile(consent: readonly Lead360ConsentView[] = []): Lead360View {
  return {
    identity: {
      contactId: CONTACT_ID, displayName: 'Martin Howard', companyName: null,
      primaryEmail: null, primaryPhone: null, ownerName: null,
    },
    score: null, scoreExplanation: null,
    journey: { label: 'Agency LAPS', stages: [] },
    evidence: [], nextMove: null, offers: [], consent, suppressionReason: null,
    crm: { opportunities: [], tasks: [] },
    asOf: '2026-08-30T10:00:00.000Z',
  };
}

const crm = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-30T08:00:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-30T08:00:00.000Z', canWrite: true },
  }),
  lead360: async () => caseFile([endpoint()]),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'unused' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'unused' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'unused' }),
} as unknown as PortalCrmService;

class FakePilot implements PortalFounderEmailPilotService {
  readonly attachCalls: AttachEndpointInput[] = [];
  attachOutcome: AttachEndpointResult = {
    ok: true, disposition: 'applied', contactPointId: POINT_ID,
    receiptId: 'fe100000-0000-4000-8000-000000000001', consentRecorded: 'none',
  };
  readinessOutcome: PilotReadinessResult = {
    ok: true,
    report: {
      schemaVersion: 1, result: 'blocked', enqueued: false, providerEffects: false,
      dimensions: [], blockers: ['CONSENT_NOT_GRANTED'], nextStep: 'Resolve the listed blockers.',
    },
    preview: {
      recipientEmail: 'office@propertypredator.com', recipientVerified: true,
      purpose: 'property_predator_marketing', dailyUsed: 0, dailyCap: 10,
      monthlyUsed: 0, monthlyCap: 50,
    },
  };

  async attachEndpoint(_i: unknown, input: AttachEndpointInput): Promise<AttachEndpointResult> {
    this.attachCalls.push(input);
    return this.attachOutcome;
  }

  async readiness(): Promise<PilotReadinessResult> {
    return this.readinessOutcome;
  }
}

function deps(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'pilot-router-request',
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth, crm, ...overrides,
  } as PostgresPortalDeps;
}

function request(method: string, url: string, body?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { cookie: COOKIE };
  // setImmediate, not queueMicrotask: the router awaits session resolution
  // before subscribing to the body, and a microtask would hang the read.
  setImmediate(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
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

async function call(method: string, url: string, portal: PostgresPortalDeps, body?: string) {
  const res = response();
  await handlePortal(request(method, url, body) as never, res as never, portal);
  return res;
}

function form(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'aa100000-0000-4000-8000-000000000001',
    contact_id: CONTACT_ID,
    email: 'office@propertypredator.com',
    label: 'Owned office mailbox',
    evidence_source: 'founder.owned_mailbox',
    evidence_reference: 'owned-mailbox-attestation-1',
    verified_at: '2026-08-30T09:00:00.000Z',
    confirm_endpoint: 'VERIFY',
    ...overrides,
  }).toString();
}

test('attaching an endpoint returns to the exact case file with a signed notice', async () => {
  const pilot = new FakePilot();
  const res = await call('POST', CONTACT_ENDPOINT_ATTACH_ROUTE, deps({ founderEmailPilot: pilot }), form());
  assert.equal(res.statusCode, 303);
  const location = res.headers.location ?? '';
  assert.ok(location.startsWith(`${CASE_FILE}?notice=`), location);
  assert.equal(
    new URL(location, 'https://portal.test').searchParams.get('notice'),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'endpoint_attached'),
  );
  assert.equal(pilot.attachCalls.length, 1);
  assert.equal(pilot.attachCalls[0]?.contactId, CONTACT_ID);
  assert.equal(pilot.attachCalls[0]?.operatorConfirmed, true);
});

test('each attach failure returns its own honest notice', async () => {
  for (const [kind, code] of [
    ['conflict', 'endpoint_conflict'],
    ['forbidden', 'endpoint_forbidden'],
    ['unauthenticated', 'endpoint_forbidden'],
    ['validation', 'endpoint_invalid'],
    ['unavailable', 'endpoint_unavailable'],
  ] as const) {
    const pilot = new FakePilot();
    pilot.attachOutcome = { ok: false, kind };
    const res = await call('POST', CONTACT_ENDPOINT_ATTACH_ROUTE, deps({ founderEmailPilot: pilot }), form());
    assert.match(res.headers.location ?? '', new RegExp(`notice=${code}`), `${kind} → ${code}`);
  }
});

test('CSRF, confirmation, command key and unknown fields are refused', async () => {
  for (const body of [
    form({ _csrf: 'forged' }),
    form({ confirm_endpoint: 'yes' }),
    form({ command_key: 'not-a-uuid' }),
    `${form()}&smuggled=1`,
  ]) {
    const pilot = new FakePilot();
    const res = await call('POST', CONTACT_ENDPOINT_ATTACH_ROUTE, deps({ founderEmailPilot: pilot }), body);
    assert.match(res.headers.location ?? '', /notice=endpoint_invalid/);
    assert.deepEqual(pilot.attachCalls, [], 'nothing may reach the seam');
  }
});

test('an uncomposed boundary says so rather than implying success', async () => {
  const res = await call('POST', CONTACT_ENDPOINT_ATTACH_ROUTE, deps(), form());
  assert.match(res.headers.location ?? '', /notice=endpoint_unavailable/);
});

test('an unusable contact id returns to the contact list rather than guessing', async () => {
  const pilot = new FakePilot();
  const res = await call(
    'POST', CONTACT_ENDPOINT_ATTACH_ROUTE, deps({ founderEmailPilot: pilot }),
    form({ contact_id: 'not-a-contact' }),
  );
  assert.equal(res.headers.location, '/portal/crm/contacts');
  assert.deepEqual(pilot.attachCalls, []);
});

test('a forged or cross-session endpoint notice is ignored', async () => {
  const portal = deps({ founderEmailPilot: new FakePilot() });
  const genuine = founderEmailPilotNoticeToken(SECRET, SESSION, 'endpoint_attached');
  const shown = await call('GET', `${CASE_FILE}?notice=${encodeURIComponent(genuine)}`, portal);
  assert.match(shown.body, /Email endpoint attached and verified/);
  for (const forged of [
    'endpoint_attached.forged',
    'endpoint_attached',
    founderEmailPilotNoticeToken(SECRET, OTHER_SESSION, 'endpoint_attached'),
    founderEmailPilotNoticeToken('another-secret', SESSION, 'endpoint_attached'),
  ]) {
    const res = await call('GET', `${CASE_FILE}?notice=${encodeURIComponent(forged)}`, portal);
    assert.doesNotMatch(res.body, /Email endpoint attached and verified/, forged);
  }
});

test('the case file shows the attach form and the pilot blockers when composed', async () => {
  const res = await call('GET', CASE_FILE, deps({ founderEmailPilot: new FakePilot() }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, new RegExp(`action="${CONTACT_ENDPOINT_ATTACH_ROUTE}"`));
  assert.match(res.body, /Attach and verify endpoint/);
  // The precise blocker, not a generic refusal.
  assert.match(res.body, /CONSENT_NOT_GRANTED/);
  assert.match(res.body, /latest recorded permission for this endpoint/);
  // The exact recipient preview before any authorisation.
  assert.match(res.body, /office@propertypredator\.com/);
  assert.match(res.body, /0 of 10 sends used/);
  assert.match(res.body, /0 of 50 sends used/);
});

test('an uncomposed boundary shows neither form nor invented readiness', async () => {
  const res = await call('GET', CASE_FILE, deps());
  assert.doesNotMatch(res.body, new RegExp(`action="${CONTACT_ENDPOINT_ATTACH_ROUTE}"`));
  assert.match(res.body, /endpoint boundary is not composed/);
  assert.doesNotMatch(res.body, /Customer email pilot readiness/);
});

test('the view escapes every operator and contact controlled value', () => {
  const hostile = '"><script>alert(1)</script>';
  const html = renderLead360Body(caseFile([endpoint()]), {
    endpointCommandAvailable: true,
    endpointCommandKey: hostile,
    csrfToken: hostile,
    pilotReadiness: {
      ready: false,
      blockers: [{ code: hostile, message: hostile }],
      preview: {
        recipientEmail: hostile, recipientVerified: false, purpose: hostile,
        dailyUsed: 0, dailyCap: 10, monthlyUsed: 0, monthlyCap: 50,
      },
    },
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(/value="[^"]*"><script/u.test(html), false);
});

test('a ready pilot says so without claiming anything was sent', () => {
  const html = renderLead360Body(caseFile([endpoint()]), {
    endpointCommandAvailable: true,
    pilotReadiness: { ready: true, blockers: [], preview: null },
  });
  assert.match(html, /Every dimension is proven/);
  assert.match(html, /separate, explicit act/);
  assert.match(html, /cannot queue a job, call Mailgun or send anything/);
});
