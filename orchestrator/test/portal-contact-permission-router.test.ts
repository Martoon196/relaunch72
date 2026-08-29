import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import type { Lead360View } from '../src/portal/lead-360-view.js';
import type {
  PortalContactPermissionInput,
  PortalContactPermissionResult,
  PortalContactPermissionService,
} from '../src/portal/contact-permission-service.js';
import {
  CONTACT_PERMISSION_ROUTE,
  contactPermissionNoticeToken,
} from '../src/portal/contact-permission-actions.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';

const SECRET = 'contact-permission-router-secret';
const SESSION = Buffer.alloc(32, 83).toString('base64url');
const OTHER_SESSION = Buffer.alloc(32, 84).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';
const CONTACT_ID = 'fc100000-0000-4000-8000-000000000001';
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

function caseFile(): Lead360View {
  return {
    identity: {
      contactId: CONTACT_ID, displayName: 'Avery Stone', companyName: null,
      primaryEmail: 'avery@example.test', primaryPhone: null, ownerName: null,
    },
    score: null, scoreExplanation: null,
    journey: { label: 'Agency LAPS', stages: [] },
    evidence: [], nextMove: null, offers: [],
    consent: [{
      channelLabel: 'Email · avery@example.test', state: 'unknown', basis: null,
      updatedAt: null, endpoint: 'avery@example.test', contactPointId: POINT_ID,
      channel: 'email', purpose: null, evidenceSource: null, policyVersion: null,
      policyTextSha256: null, effectiveAt: null, recordedAt: null, recordedBy: null,
      suppressionState: null, suppressionReason: null,
    }],
    suppressionReason: null,
    crm: { opportunities: [], tasks: [] },
    asOf: '2026-08-30T08:00:00.000Z',
  };
}

const crm: PortalCrmService = {
  snapshot: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-30T08:00:00.000Z', canWrite: true },
    contacts: [], stages: [], opportunities: [], tasks: [], timeline: [],
  }),
  workspaceShell: async () => ({
    workspace: { id: WORKSPACE_ID, name: 'Growth HQ', timezone: 'Europe/London', snapshotAt: '2026-08-30T08:00:00.000Z', canWrite: true },
  }),
  lead360: async () => caseFile(),
  createLead: async () => ({ ok: false, kind: 'unavailable', message: 'unused' }),
  moveOpportunity: async () => ({ ok: false, kind: 'unavailable', message: 'unused' }),
  completeTask: async () => ({ ok: false, kind: 'unavailable', message: 'unused' }),
} as PortalCrmService;

class FakePermission implements PortalContactPermissionService {
  readonly calls: PortalContactPermissionInput[] = [];
  outcome: PortalContactPermissionResult = {
    ok: true, disposition: 'applied',
    consentEventId: 'fe100000-0000-4000-8000-000000000001',
    receiptId: 'ff100000-0000-4000-8000-000000000001',
    messagesQueued: 'none',
  };

  async recordDecision(
    _identity: unknown,
    input: PortalContactPermissionInput,
  ): Promise<PortalContactPermissionResult> {
    this.calls.push(input);
    return this.outcome;
  }
}

function deps(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres', sessionSecret: SECRET, secure: false,
    requestId: () => 'permission-router-request',
    productProfile: PROPERTY_PREDATOR_GROWTH_PROFILE,
    auth, crm, ...overrides,
  } as PostgresPortalDeps;
}

function request(method: string, url: string, body?: string, cookie: string = COOKIE) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { cookie };
  // setImmediate, not queueMicrotask: the router awaits session resolution
  // before it subscribes to the request body, and a microtask would fire the
  // end event first and hang the read forever.
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
  const fields: Record<string, string> = {
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'aa100000-0000-4000-8000-000000000001',
    contact_id: CONTACT_ID,
    contact_point_id: POINT_ID,
    channel: 'email',
    purpose: 'property_predator_marketing',
    decision: 'granted',
    lawful_basis: 'consent',
    evidence_source: 'founder.written_confirmation',
    policy_version: 'pp-privacy-2026-08',
    policy_text_sha256: 'a'.repeat(64),
    source_event_id: 'signed-form-4821',
    occurred_at: '2026-08-30T09:00:00.000Z',
    confirm_permission: 'RECORD',
    ...overrides,
  };
  return new URLSearchParams(fields).toString();
}

test('a confirmed decision returns to the exact case file with a signed notice', async () => {
  const permission = new FakePermission();
  const res = await call('POST', CONTACT_PERMISSION_ROUTE, deps({ contactPermission: permission }), form());
  assert.equal(res.statusCode, 303);
  const location = res.headers.location ?? '';
  assert.ok(location.startsWith(`${CASE_FILE}?notice=`), `unexpected redirect: ${location}`);
  const notice = new URL(location, 'https://portal.test').searchParams.get('notice') ?? '';
  assert.equal(
    notice, contactPermissionNoticeToken(SECRET, SESSION, 'permission_recorded'),
  );
  assert.equal(permission.calls.length, 1);
  assert.equal(permission.calls[0]?.contactId, CONTACT_ID);
  assert.equal(permission.calls[0]?.operatorConfirmed, true);
});

test('a replay reports the original decision rather than a duplicate', async () => {
  const permission = new FakePermission();
  permission.outcome = {
    ok: true, disposition: 'replayed',
    consentEventId: 'fe100000-0000-4000-8000-000000000001',
    receiptId: 'ff100000-0000-4000-8000-000000000001',
    messagesQueued: 'none',
  };
  const res = await call('POST', CONTACT_PERMISSION_ROUTE, deps({ contactPermission: permission }), form());
  assert.match(res.headers.location ?? '', /notice=permission_replayed/);
});

test('each failure kind returns its own honest notice', async () => {
  for (const [kind, code] of [
    ['conflict', 'permission_conflict'],
    ['forbidden', 'permission_forbidden'],
    ['unauthenticated', 'permission_forbidden'],
    ['validation', 'permission_invalid'],
    ['unavailable', 'permission_unavailable'],
  ] as const) {
    const permission = new FakePermission();
    permission.outcome = { ok: false, kind };
    const res = await call('POST', CONTACT_PERMISSION_ROUTE, deps({ contactPermission: permission }), form());
    assert.match(res.headers.location ?? '', new RegExp(`notice=${code}`), `${kind} → ${code}`);
  }
});

test('CSRF, confirmation, command key and unknown fields are all refused', async () => {
  for (const body of [
    form({ _csrf: 'forged' }),
    form({ confirm_permission: 'yes' }),
    form({ command_key: 'not-a-uuid' }),
    `${form()}&smuggled=1`,
  ]) {
    const permission = new FakePermission();
    const res = await call('POST', CONTACT_PERMISSION_ROUTE, deps({ contactPermission: permission }), body);
    assert.equal(res.statusCode, 303);
    assert.match(res.headers.location ?? '', /notice=permission_invalid/);
    assert.deepEqual(permission.calls, [], 'nothing may reach the seam');
  }
});

test('an uncomposed permission boundary says so instead of implying success', async () => {
  const res = await call('POST', CONTACT_PERMISSION_ROUTE, deps(), form());
  assert.match(res.headers.location ?? '', /notice=permission_unavailable/);
});

test('an unusable contact id returns to the contact list rather than guessing', async () => {
  const permission = new FakePermission();
  const res = await call(
    'POST', CONTACT_PERMISSION_ROUTE, deps({ contactPermission: permission }),
    form({ contact_id: 'not-a-contact' }),
  );
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/portal/crm/contacts');
  assert.deepEqual(permission.calls, []);
});

test('a forged or cross-session notice is ignored on the case file', async () => {
  const portal = deps({ contactPermission: new FakePermission() });
  const genuine = contactPermissionNoticeToken(SECRET, SESSION, 'permission_recorded');
  const shown = await call('GET', `${CASE_FILE}?notice=${encodeURIComponent(genuine)}`, portal);
  assert.equal(shown.statusCode, 200);
  assert.match(shown.body, /Permission decision recorded/);

  for (const forged of [
    'permission_recorded.forged',
    'permission_recorded',
    `permission_forbidden.${genuine.split('.')[1]}`,
    contactPermissionNoticeToken(SECRET, OTHER_SESSION, 'permission_recorded'),
    contactPermissionNoticeToken('another-secret', SESSION, 'permission_recorded'),
  ]) {
    const res = await call('GET', `${CASE_FILE}?notice=${encodeURIComponent(forged)}`, portal);
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /Permission decision recorded/, `forged notice honoured: ${forged}`);
  }
});

test('the case file offers the founder form only when the boundary is composed', async () => {
  const composed = await call('GET', CASE_FILE, deps({ contactPermission: new FakePermission() }));
  assert.match(composed.body, new RegExp(`action="${CONTACT_PERMISSION_ROUTE}"`));
  assert.match(composed.body, /Record permission decision/);

  const bare = await call('GET', CASE_FILE, deps());
  assert.doesNotMatch(bare.body, new RegExp(`action="${CONTACT_PERMISSION_ROUTE}"`));
  assert.match(bare.body, /boundary is not composed for this workspace/);
});

test('the form never offers an inferred permission source', async () => {
  const res = await call('GET', CASE_FILE, deps({ contactPermission: new FakePermission() }));
  for (const inferred of [
    'login', 'account_creation', 'crm_stage', 'opportunity', 'previous_send', 'site_activity',
  ]) {
    assert.doesNotMatch(
      res.body, new RegExp(`value="${inferred}"`), `${inferred} must not be offered`,
    );
  }
  assert.match(res.body, /never inferred from a login, account creation, CRM stage/);
});
