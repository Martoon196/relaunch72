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
  EMAIL_PILOT_AUTHORISE_ROUTE,
  EMAIL_PILOT_CONFIRM_VALUE,
  EMAIL_PILOT_POLICY_CONFIRM_VALUE,
  EMAIL_PILOT_POLICY_ROUTE,
  EMAIL_PILOT_PREPARE_CONFIRM_VALUE,
  EMAIL_PILOT_PREPARE_ROUTE,
  founderEmailPilotNoticeToken,
  founderEmailPilotPreviewToken,
  founderEmailPilotStepToken,
  type FounderEmailPilotNoticeCode,
} from '../src/portal/founder-email-pilot-actions.js';
import {
  deriveFounderEmailPilotIdentifiers,
  founderEmailPilotEvidenceDigest,
  type FounderEmailPilotEvidence,
} from '../src/founder-email-pilot/foundation.js';
import type {
  AttachEndpointInput,
  AttachEndpointResult,
  AuthoriseInput,
  AuthoriseResult,
  PilotReadinessResult,
  PortalFounderEmailPilotService,
  PrepareContentInput,
  PrepareContentResult,
  RecordPolicyEvidenceInput,
  RecordPolicyEvidenceResult,
  ResolveAuthorisationResult,
} from '../src/portal/founder-email-pilot-service.js';
import {
  FOUNDER_PILOT_POLICY_CLAUSES,
  FOUNDER_PILOT_REVIEW_AUTHORITY,
  FOUNDER_PILOT_ROUTE_CLASSIFICATION,
} from '../src/founder-email-pilot/policy-asset.js';
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
const PILOT_COMMAND_KEY = 'ab100000-0000-4000-8000-000000000001';
const JOB_ID = 'ac100000-0000-4000-8000-000000000001';
const IDENTIFIERS = deriveFounderEmailPilotIdentifiers(WORKSPACE_ID, PILOT_COMMAND_KEY);

/** A resolved tuple shaped exactly as the 0064 resolver returns it. */
const EVIDENCE: FounderEmailPilotEvidence = Object.freeze({
  campaignTemplateVersionId: 'ad100000-0000-4000-8000-000000000001',
  campaignTemplateStepId: 'ad100000-0000-4000-8000-000000000002',
  campaignStepContentSha256: 'a'.repeat(64),
  campaignApprovalRequestId: 'ad100000-0000-4000-8000-000000000003',
  campaignApprovalDecisionId: 'ad100000-0000-4000-8000-000000000004',
  campaignVersionNo: 3,
  messageVersionId: 'ad100000-0000-4000-8000-000000000005',
  messageApprovalRequestId: 'ad100000-0000-4000-8000-000000000006',
  messageApprovalDecisionId: 'ad100000-0000-4000-8000-000000000007',
  messageVersionNumber: 2,
  channelEndpointId: 'ad100000-0000-4000-8000-000000000008',
  consentEventId: 'ad100000-0000-4000-8000-000000000009',
  complianceSubjectId: 'ad100000-0000-4000-8000-00000000000a',
  policyPublicationEventId: 'ad100000-0000-4000-8000-00000000000b',
  pecrSenderDecisionEventId: 'ad100000-0000-4000-8000-00000000000c',
  pecrInstigatorDecisionEventId: 'ad100000-0000-4000-8000-00000000000d',
  permissionUseReceiptId: 'ad100000-0000-4000-8000-00000000000e',
  recipientEmail: 'office@example.test',
  subject: 'Your Property Predator briefing',
  bodyText: 'Hello,\n\nYour briefing is ready. <not markup>\n\nMartin',
});
const EVIDENCE_DIGEST = founderEmailPilotEvidenceDigest(EVIDENCE);
/** Inside the five-minute window the preview token accepts. */
const AUTHORITY_VALID_UNTIL = new Date(Date.now() + 4 * 60 * 1000).toISOString();

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
    channelLabel: 'Email · office@example.test', state: 'unknown', basis: null,
    updatedAt: null, endpoint: 'office@example.test', contactPointId: POINT_ID,
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
      recipientEmail: 'office@example.test', recipientVerified: true,
      purpose: 'property_predator_marketing', dailyUsed: 0, dailyCap: 10,
      monthlyUsed: 0, monthlyCap: 50,
    },
  };

  readonly authoriseCalls: AuthoriseInput[] = [];
  authoriseOutcome: AuthoriseResult = {
    ok: true, disposition: 'queued', jobId: JOB_ID, providerEffects: 'none',
    recipientEmail: 'office@example.test', subject: 'Your Property Predator briefing',
  };

  resolveOutcome: ResolveAuthorisationResult = {
    ok: true,
    preview: {
      evidence: EVIDENCE,
      evidenceDigest: EVIDENCE_DIGEST,
      authorityValidUntil: AUTHORITY_VALID_UNTIL,
      identifiers: IDENTIFIERS,
    },
  };

  async attachEndpoint(_i: unknown, input: AttachEndpointInput): Promise<AttachEndpointResult> {
    this.attachCalls.push(input);
    return this.attachOutcome;
  }

  async readiness(): Promise<PilotReadinessResult> {
    return this.readinessOutcome;
  }

  async resolveAuthorisation(): Promise<ResolveAuthorisationResult> {
    return this.resolveOutcome;
  }

  async authorise(_i: unknown, input: AuthoriseInput): Promise<AuthoriseResult> {
    this.authoriseCalls.push(input);
    return this.authoriseOutcome;
  }

  readonly prepareCalls: PrepareContentInput[] = [];
  readonly policyCalls: RecordPolicyEvidenceInput[] = [];
  prepareOutcome: PrepareContentResult = {
    ok: true, disposition: 'prepared',
    campaignTemplateVersionId: EVIDENCE.campaignTemplateVersionId,
    messageVersionId: EVIDENCE.messageVersionId,
    approvedContentId: 'ae100000-0000-4000-8000-000000000001',
    providerEffects: 'none',
  };
  policyOutcome: RecordPolicyEvidenceResult = {
    ok: true, disposition: 'recorded',
    policyPublicationEventId: EVIDENCE.policyPublicationEventId,
    pecrSenderDecisionEventId: EVIDENCE.pecrSenderDecisionEventId,
    pecrInstigatorDecisionEventId: EVIDENCE.pecrInstigatorDecisionEventId,
    actionScopeSha256: 'f'.repeat(64),
    reviewAuthority: FOUNDER_PILOT_REVIEW_AUTHORITY,
    ownershipControlChecked: false,
    providerEffects: 'none',
  };

  async prepareContent(
    _i: unknown, input: PrepareContentInput,
  ): Promise<PrepareContentResult> {
    this.prepareCalls.push(input);
    return this.prepareOutcome;
  }

  async recordPolicyEvidence(
    _i: unknown, input: RecordPolicyEvidenceInput,
  ): Promise<RecordPolicyEvidenceResult> {
    this.policyCalls.push(input);
    return this.policyOutcome;
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

function request(method: string, url: string, body?: string, cookie = COOKIE) {
  const req = new EventEmitter() as EventEmitter & {
    method: string; url: string; headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { cookie };
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

async function call(
  method: string,
  url: string,
  portal: PostgresPortalDeps,
  body?: string,
  cookie = COOKIE,
) {
  const res = response();
  await handlePortal(request(method, url, body, cookie) as never, res as never, portal);
  return res;
}

function form(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: 'aa100000-0000-4000-8000-000000000001',
    contact_id: CONTACT_ID,
    email: 'office@example.test',
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
  assert.match(res.body, /office@example\.test/);
  assert.match(res.body, /0 of 10 sends used/);
  assert.match(res.body, /0 of 50 sends used/);
});

test('an uncomposed boundary shows neither form nor invented readiness', async () => {
  const res = await call('GET', CASE_FILE, deps());
  assert.doesNotMatch(res.body, new RegExp(`action="${CONTACT_ENDPOINT_ATTACH_ROUTE}"`));
  assert.match(res.body, /endpoint boundary is not composed/);
  assert.doesNotMatch(res.body, /Customer email pilot readiness/);
});

function authoriseForm(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: PILOT_COMMAND_KEY,
    contact_id: CONTACT_ID,
    contact_point_id: POINT_ID,
    purpose: 'property_predator_marketing',
    preview_token: founderEmailPilotPreviewToken(SECRET, SESSION, {
      commandKey: PILOT_COMMAND_KEY,
      authorityValidUntil: AUTHORITY_VALID_UNTIL,
      evidenceDigest: EVIDENCE_DIGEST,
    }),
    confirm_send: EMAIL_PILOT_CONFIRM_VALUE,
    ...overrides,
  }).toString();
}

async function authorise(pilot: FakePilot, overrides: Record<string, string> = {}) {
  return call(
    'POST', EMAIL_PILOT_AUTHORISE_ROUTE,
    deps({ founderEmailPilot: pilot }), authoriseForm(overrides),
  );
}

test('authorising passes the exact verified preview claims to the enqueue seam', async () => {
  const pilot = new FakePilot();
  const res = await authorise(pilot);
  assert.equal(res.statusCode, 303);
  assert.equal(
    new URL(res.headers.location ?? '', 'https://portal.test').searchParams.get('notice'),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'pilot_queued'),
  );
  assert.equal(pilot.authoriseCalls.length, 1);
  const call1 = pilot.authoriseCalls[0];
  // The digest and window come from the signed token, never from the form.
  assert.equal(call1?.evidenceDigest, EVIDENCE_DIGEST);
  assert.equal(call1?.authorityValidUntil, AUTHORITY_VALID_UNTIL);
  assert.equal(call1?.commandKey, PILOT_COMMAND_KEY);
  assert.equal(call1?.contactPointId, POINT_ID);
  assert.equal(call1?.operatorConfirmed, true);
});

test('the signed send button submits the complete action without hidden fields or a magic phrase', async () => {
  const pilot = new FakePilot();
  const previewToken = founderEmailPilotPreviewToken(SECRET, SESSION, {
    commandKey: PILOT_COMMAND_KEY,
    authorityValidUntil: AUTHORITY_VALID_UNTIL,
    evidenceDigest: EVIDENCE_DIGEST,
    contactId: CONTACT_ID,
    contactPointId: POINT_ID,
    purpose: 'property_predator_marketing',
  });
  const res = await call(
    'POST', EMAIL_PILOT_AUTHORISE_ROUTE, deps({ founderEmailPilot: pilot }),
    new URLSearchParams({ preview_token: previewToken }).toString(),
  );
  assert.equal(noticeOf(res), founderEmailPilotNoticeToken(SECRET, SESSION, 'pilot_queued'));
  assert.equal(pilot.authoriseCalls.length, 1);
  assert.equal(pilot.authoriseCalls[0]?.contactId, CONTACT_ID);
  assert.equal(pilot.authoriseCalls[0]?.contactPointId, POINT_ID);
  assert.equal(pilot.authoriseCalls[0]?.purpose, 'property_predator_marketing');
});

test('the rendered send button authorises through its signed route and an empty form', async () => {
  const pilot = new FakePilot();
  const page = await call('GET', CASE_FILE, deps({ founderEmailPilot: pilot }));
  const action = new RegExp(
    `<form[^>]+action="(${EMAIL_PILOT_AUTHORISE_ROUTE}/[^"]+)"`,
  ).exec(page.body)?.[1];
  assert.ok(action);
  const res = await call(
    'POST', action, deps({ founderEmailPilot: pilot }), '',
  );
  assert.equal(noticeOf(res), founderEmailPilotNoticeToken(SECRET, SESSION, 'pilot_queued'));
  assert.equal(pilot.authoriseCalls.length, 1);
});

test('the signed send button rejects another session and extra browser fields', async () => {
  const token = founderEmailPilotPreviewToken(SECRET, OTHER_SESSION, {
    commandKey: PILOT_COMMAND_KEY,
    authorityValidUntil: AUTHORITY_VALID_UNTIL,
    evidenceDigest: EVIDENCE_DIGEST,
    contactId: CONTACT_ID,
    contactPointId: POINT_ID,
    purpose: 'property_predator_marketing',
  });
  for (const body of [
    new URLSearchParams({ preview_token: token }).toString(),
    new URLSearchParams({
      preview_token: founderEmailPilotPreviewToken(SECRET, SESSION, {
        commandKey: PILOT_COMMAND_KEY,
        authorityValidUntil: AUTHORITY_VALID_UNTIL,
        evidenceDigest: EVIDENCE_DIGEST,
        contactId: CONTACT_ID,
        contactPointId: POINT_ID,
        purpose: 'property_predator_marketing',
      }),
      smuggled: '1',
    }).toString(),
  ]) {
    const pilot = new FakePilot();
    await call('POST', EMAIL_PILOT_AUTHORISE_ROUTE, deps({ founderEmailPilot: pilot }), body);
    assert.deepEqual(pilot.authoriseCalls, []);
  }
});

test('a replay reports the original job rather than a second send', async () => {
  const pilot = new FakePilot();
  pilot.authoriseOutcome = {
    ok: true, disposition: 'replayed', jobId: JOB_ID, providerEffects: 'none',
    recipientEmail: 'office@example.test', subject: 'Your Property Predator briefing',
  };
  const res = await authorise(pilot);
  assert.match(res.headers.location ?? '', /notice=/);
  assert.equal(
    new URL(res.headers.location ?? '', 'https://portal.test').searchParams.get('notice'),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'pilot_replayed'),
  );
});

test('every authorisation failure keeps its own honest notice', async () => {
  const cases = [
    [{ ok: false, kind: 'stale_preview' }, 'pilot_stale_preview'],
    [{ ok: false, kind: 'conflict' }, 'pilot_conflict'],
    [{ ok: false, kind: 'blocked' }, 'pilot_blocked'],
    [{ ok: false, kind: 'forbidden' }, 'pilot_forbidden'],
    [{ ok: false, kind: 'unauthenticated' }, 'pilot_forbidden'],
    [{ ok: false, kind: 'validation' }, 'pilot_invalid'],
    [{ ok: false, kind: 'unavailable' }, 'pilot_unavailable'],
  ] as const;
  for (const [outcome, expected] of cases) {
    const pilot = new FakePilot();
    pilot.authoriseOutcome = outcome as AuthoriseResult;
    const res = await authorise(pilot);
    assert.equal(
      new URL(res.headers.location ?? '', 'https://portal.test').searchParams.get('notice'),
      founderEmailPilotNoticeToken(SECRET, SESSION, expected),
      expected,
    );
  }
});

test('a forged, borrowed or stale preview never reaches the enqueue seam', async () => {
  const stale = founderEmailPilotPreviewToken(SECRET, SESSION, {
    commandKey: PILOT_COMMAND_KEY,
    // Already expired: the founder read this message too long ago.
    authorityValidUntil: new Date(Date.now() - 1000).toISOString(),
    evidenceDigest: EVIDENCE_DIGEST,
  });
  const otherSession = founderEmailPilotPreviewToken(SECRET, OTHER_SESSION, {
    commandKey: PILOT_COMMAND_KEY,
    authorityValidUntil: AUTHORITY_VALID_UNTIL,
    evidenceDigest: EVIDENCE_DIGEST,
  });
  const otherSecret = founderEmailPilotPreviewToken('another-secret', SESSION, {
    commandKey: PILOT_COMMAND_KEY,
    authorityValidUntil: AUTHORITY_VALID_UNTIL,
    evidenceDigest: EVIDENCE_DIGEST,
  });
  // A genuine token for a different command key: it must not authorise this one.
  const otherCommand = founderEmailPilotPreviewToken(SECRET, SESSION, {
    commandKey: 'ab100000-0000-4000-8000-0000000000ff',
    authorityValidUntil: AUTHORITY_VALID_UNTIL,
    evidenceDigest: EVIDENCE_DIGEST,
  });
  for (const token of ['', 'forged', stale, otherSession, otherSecret, otherCommand]) {
    const pilot = new FakePilot();
    const res = await authorise(pilot, { preview_token: token });
    assert.equal(
      new URL(res.headers.location ?? '', 'https://portal.test').searchParams.get('notice'),
      founderEmailPilotNoticeToken(SECRET, SESSION, 'pilot_stale_preview'),
      token,
    );
    assert.deepEqual(pilot.authoriseCalls, [], token);
  }
});

test('CSRF, the typed confirmation and unknown fields are all required', async () => {
  const rejected: Record<string, string>[] = [
    { _csrf: 'wrong' },
    { confirm_send: 'send' },
    { confirm_send: '' },
    { command_key: 'not-a-uuid' },
    { contact_point_id: 'not-a-uuid' },
  ];
  for (const overrides of rejected) {
    const pilot = new FakePilot();
    const res = await authorise(pilot, overrides);
    assert.equal(
      new URL(res.headers.location ?? '', 'https://portal.test').searchParams.get('notice'),
      founderEmailPilotNoticeToken(SECRET, SESSION, 'pilot_invalid'),
      JSON.stringify(overrides),
    );
    assert.deepEqual(pilot.authoriseCalls, [], JSON.stringify(overrides));
  }
  // An extra field is refused rather than ignored.
  const pilot = new FakePilot();
  const res = await call(
    'POST', EMAIL_PILOT_AUTHORISE_ROUTE, deps({ founderEmailPilot: pilot }),
    `${authoriseForm()}&smuggled=1`,
  );
  assert.match(res.headers.location ?? '', /notice=/);
  assert.deepEqual(pilot.authoriseCalls, []);
});

test('an uncomposed enqueue offers no authorisation and claims none', async () => {
  const res = await call('POST', EMAIL_PILOT_AUTHORISE_ROUTE, deps(), authoriseForm());
  assert.equal(
    new URL(res.headers.location ?? '', 'https://portal.test').searchParams.get('notice'),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'pilot_unavailable'),
  );
  const page = await call('GET', CASE_FILE, deps());
  assert.doesNotMatch(page.body, new RegExp(`action="${EMAIL_PILOT_AUTHORISE_ROUTE}"`));
});

test('the case file shows the exact subject and full body before authorising', async () => {
  const res = await call('GET', CASE_FILE, deps({ founderEmailPilot: new FakePilot() }));
  assert.match(res.body, new RegExp(`action="${EMAIL_PILOT_AUTHORISE_ROUTE}/`));
  assert.match(res.body, /Your Property Predator briefing/);
  // The body verbatim, escaped rather than summarised or stripped.
  assert.match(res.body, /Your briefing is ready\. &lt;not markup&gt;/);
  assert.match(res.body, /v3, approved/);
  assert.match(res.body, /v2, approved/);
  assert.match(res.body, />Send this email now<\/button>/);
  assert.doesNotMatch(res.body, /name="confirm_send"/);
  const sendHtml = res.body.match(new RegExp(
    `<form[^>]+action="${EMAIL_PILOT_AUTHORISE_ROUTE}/[^"]+"[\\s\\S]*?<\\/form>`,
  ))?.[0] ?? '';
  assert.doesNotMatch(sendHtml, /<(input|select|textarea)\b/);
});

test('an unresolved tuple offers no send, only the blockers', async () => {
  const pilot = new FakePilot();
  pilot.resolveOutcome = { ok: true, preview: null };
  const res = await call('GET', CASE_FILE, deps({ founderEmailPilot: pilot }));
  assert.doesNotMatch(res.body, new RegExp(`action="${EMAIL_PILOT_AUTHORISE_ROUTE}"`));
  assert.match(res.body, /CONSENT_NOT_GRANTED/);
});

test('the identifiers a replay depends on are derived, not random', () => {
  const again = deriveFounderEmailPilotIdentifiers(WORKSPACE_ID, PILOT_COMMAND_KEY);
  assert.deepEqual(again, IDENTIFIERS);
  // A different command key must not collide with this one.
  const other = deriveFounderEmailPilotIdentifiers(
    WORKSPACE_ID, 'ab100000-0000-4000-8000-0000000000ff',
  );
  for (const field of [
    'providerOperationId', 'messageDeliveryId', 'correlationId',
    'idempotencyKeySha256', 'requestId',
  ] as const) {
    assert.notEqual(other[field], IDENTIFIERS[field], field);
  }
  // Each derived id must satisfy the same UUID shape every boundary validates.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  assert.match(IDENTIFIERS.providerOperationId, uuid);
  assert.match(IDENTIFIERS.messageDeliveryId, uuid);
  assert.match(IDENTIFIERS.correlationId, uuid);
  assert.notEqual(IDENTIFIERS.providerOperationId, IDENTIFIERS.messageDeliveryId);
  assert.notEqual(IDENTIFIERS.messageDeliveryId, IDENTIFIERS.correlationId);
});

function stepForm(field: string, phrase: string, overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    _csrf: portalCsrfToken(SECRET, SESSION),
    command_key: PILOT_COMMAND_KEY,
    contact_id: CONTACT_ID,
    contact_point_id: POINT_ID,
    purpose: 'property_predator_marketing',
    [field]: phrase,
    ...overrides,
  }).toString();
}

const prepareForm = (o: Record<string, string> = {}) =>
  stepForm('confirm_prepare', EMAIL_PILOT_PREPARE_CONFIRM_VALUE, o);
const policyForm = (o: Record<string, string> = {}) =>
  stepForm('confirm_policy', EMAIL_PILOT_POLICY_CONFIRM_VALUE, o);

function signedStepForm(
  step: 'prepare' | 'policy',
  overrides: Record<string, string> = {},
): string {
  const token = founderEmailPilotStepToken(SECRET, SESSION, {
    step,
    commandKey: PILOT_COMMAND_KEY,
    contactId: CONTACT_ID,
    contactPointId: POINT_ID,
    purpose: 'property_predator_marketing',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  return new URLSearchParams({ step_token: token, ...overrides }).toString();
}

function noticeOf(res: { headers: Record<string, string> }): string | null {
  return new URL(res.headers.location ?? '', 'https://portal.test')
    .searchParams.get('notice');
}

test('both preparation steps pass the resolved endpoint and never a typed address', async () => {
  const pilot = new FakePilot();
  const prepared = await call(
    'POST', EMAIL_PILOT_PREPARE_ROUTE, deps({ founderEmailPilot: pilot }), prepareForm(),
  );
  assert.equal(noticeOf(prepared), founderEmailPilotNoticeToken(SECRET, SESSION, 'prepare_done'));
  assert.equal(pilot.prepareCalls.length, 1);
  assert.equal(pilot.prepareCalls[0]?.contactPointId, POINT_ID);
  assert.equal(pilot.prepareCalls[0]?.purpose, 'property_predator_marketing');
  assert.equal(pilot.prepareCalls[0]?.operatorConfirmed, true);

  const recorded = await call(
    'POST', EMAIL_PILOT_POLICY_ROUTE, deps({ founderEmailPilot: pilot }), policyForm(),
  );
  assert.equal(noticeOf(recorded), founderEmailPilotNoticeToken(SECRET, SESSION, 'policy_recorded'));
  assert.equal(pilot.policyCalls.length, 1);
  assert.equal(pilot.policyCalls[0]?.contactPointId, POINT_ID);
});

test('signed preparation buttons work without hidden fields or typed phrases', async () => {
  const pilot = new FakePilot();
  const prepared = await call(
    'POST', EMAIL_PILOT_PREPARE_ROUTE, deps({ founderEmailPilot: pilot }),
    signedStepForm('prepare'),
  );
  assert.equal(noticeOf(prepared), founderEmailPilotNoticeToken(SECRET, SESSION, 'prepare_done'));
  const policy = await call(
    'POST', EMAIL_PILOT_POLICY_ROUTE, deps({ founderEmailPilot: pilot }),
    signedStepForm('policy'),
  );
  assert.equal(noticeOf(policy), founderEmailPilotNoticeToken(SECRET, SESSION, 'policy_recorded'));
  assert.equal(pilot.prepareCalls.length, 1);
  assert.equal(pilot.policyCalls.length, 1);
});

test('rendered preparation buttons use server-resolved routes and empty forms', async () => {
  const pilot = unpreparedPilot();
  const page = await call('GET', CASE_FILE, deps({ founderEmailPilot: pilot }));
  const prepareAction = new RegExp(
    `<form[^>]+action="(${EMAIL_PILOT_PREPARE_ROUTE}/[^"]+)"`,
  ).exec(page.body)?.[1];
  const policyAction = new RegExp(
    `<form[^>]+action="(${EMAIL_PILOT_POLICY_ROUTE}/[^"]+)"`,
  ).exec(page.body)?.[1];
  assert.ok(prepareAction);
  assert.ok(policyAction);
  const directAction = new RegExp(
    `^${EMAIL_PILOT_PREPARE_ROUTE}/${CONTACT_ID}/[0-9a-f-]{36}$`,
  );
  assert.match(prepareAction, directAction);
  assert.match(
    policyAction,
    new RegExp(`^${EMAIL_PILOT_POLICY_ROUTE}/${CONTACT_ID}/[0-9a-f-]{36}$`),
  );
  await call(
    'POST', prepareAction, deps({ founderEmailPilot: pilot }), '',
  );
  await call(
    'POST', policyAction, deps({ founderEmailPilot: pilot }), '',
  );
  assert.equal(pilot.prepareCalls.length, 1);
  assert.equal(pilot.policyCalls.length, 1);
  assert.equal(pilot.prepareCalls[0]?.contactId, CONTACT_ID);
  assert.equal(pilot.prepareCalls[0]?.contactPointId, POINT_ID);
  assert.equal(pilot.prepareCalls[0]?.purpose, 'property_predator_marketing');
  assert.notEqual(pilot.prepareCalls[0]?.commandKey, pilot.policyCalls[0]?.commandKey);
});

test('a direct preparation action reopens Lead 360 and fails closed if the contact disappears', async () => {
  const pilot = unpreparedPilot();
  const page = await call('GET', CASE_FILE, deps({ founderEmailPilot: pilot }));
  const prepareAction = new RegExp(
    `<form[^>]+action="(${EMAIL_PILOT_PREPARE_ROUTE}/[^"]+)"`,
  ).exec(page.body)?.[1];
  assert.ok(prepareAction);
  const missingCrm = {
    ...crm,
    lead360: async () => null,
  } as unknown as PortalCrmService;
  const result = await call(
    'POST', prepareAction, deps({ founderEmailPilot: pilot, crm: missingCrm }), '',
  );
  assert.equal(
    noticeOf(result),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'prepare_invalid'),
  );
  assert.deepEqual(pilot.prepareCalls, []);
});

test('signed preparation actions are session-bound, step-bound and reject extra fields', async () => {
  const wrongSession = founderEmailPilotStepToken(SECRET, OTHER_SESSION, {
    step: 'prepare', commandKey: PILOT_COMMAND_KEY, contactId: CONTACT_ID,
    contactPointId: POINT_ID, purpose: 'property_predator_marketing',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  for (const body of [
    new URLSearchParams({ step_token: wrongSession }).toString(),
    signedStepForm('policy'),
    signedStepForm('prepare', { smuggled: '1' }),
  ]) {
    const pilot = new FakePilot();
    const res = await call(
      'POST', EMAIL_PILOT_PREPARE_ROUTE, deps({ founderEmailPilot: pilot }), body,
    );
    assert.deepEqual(pilot.prepareCalls, []);
    assert.match(res.headers.location ?? '', /^\/portal\/crm\/contacts/);
  }
});

test('neither preparation step accepts a hash, id or evidence reference', async () => {
  // The whole point of deriving server-side: there is no field a browser could
  // use to assert a compliance fact, and an extra one is refused outright.
  for (const [route, form, code] of [
    [EMAIL_PILOT_PREPARE_ROUTE, prepareForm, 'prepare_invalid'],
    [EMAIL_PILOT_POLICY_ROUTE, policyForm, 'policy_invalid'],
  ] as const) {
    for (const smuggled of [
      'bundle_sha256=deadbeef', 'decision_reference=solicitor',
      'policy_pack_id=11111111-1111-4111-8111-111111111111',
      'action_scope_sha256=' + 'a'.repeat(64), 'ownership_control_checked=true',
    ]) {
      const pilot = new FakePilot();
      const res = await call(
        'POST', route, deps({ founderEmailPilot: pilot }), `${form()}&${smuggled}`,
      );
      assert.equal(noticeOf(res), founderEmailPilotNoticeToken(SECRET, SESSION, code), smuggled);
      assert.deepEqual(pilot.prepareCalls, [], smuggled);
      assert.deepEqual(pilot.policyCalls, [], smuggled);
    }
  }
});

test('each step demands its own exact phrase and never the send phrase', async () => {
  const rejected: readonly [
    string,
    (overrides?: Record<string, string>) => string,
    FounderEmailPilotNoticeCode,
    Record<string, string>,
  ][] = [
    [EMAIL_PILOT_PREPARE_ROUTE, prepareForm, 'prepare_invalid', { _csrf: 'wrong' }],
    [EMAIL_PILOT_PREPARE_ROUTE, prepareForm, 'prepare_invalid', { confirm_prepare: 'prepare' }],
    // Typing the send phrase into a preparation form must not work.
    [EMAIL_PILOT_PREPARE_ROUTE, prepareForm, 'prepare_invalid',
      { confirm_prepare: EMAIL_PILOT_CONFIRM_VALUE }],
    [EMAIL_PILOT_PREPARE_ROUTE, prepareForm, 'prepare_invalid',
      { confirm_prepare: EMAIL_PILOT_POLICY_CONFIRM_VALUE }],
    [EMAIL_PILOT_PREPARE_ROUTE, prepareForm, 'prepare_invalid', { command_key: 'nope' }],
    [EMAIL_PILOT_POLICY_ROUTE, policyForm, 'policy_invalid', { _csrf: 'wrong' }],
    [EMAIL_PILOT_POLICY_ROUTE, policyForm, 'policy_invalid',
      { confirm_policy: EMAIL_PILOT_CONFIRM_VALUE }],
    [EMAIL_PILOT_POLICY_ROUTE, policyForm, 'policy_invalid',
      { confirm_policy: EMAIL_PILOT_PREPARE_CONFIRM_VALUE }],
    [EMAIL_PILOT_POLICY_ROUTE, policyForm, 'policy_invalid', { contact_point_id: 'nope' }],
  ];
  for (const [route, form, code, overrides] of rejected) {
    const pilot = new FakePilot();
    const res = await call('POST', route, deps({ founderEmailPilot: pilot }), form(overrides));
    assert.equal(
      noticeOf(res), founderEmailPilotNoticeToken(SECRET, SESSION, code),
      JSON.stringify(overrides),
    );
    assert.deepEqual(pilot.prepareCalls, []);
    assert.deepEqual(pilot.policyCalls, []);
  }
});

test('every preparation failure keeps its own honest notice', async () => {
  for (const [kind, prepareCode, policyCode] of [
    ['conflict', 'prepare_conflict', 'policy_conflict'],
    ['blocked', 'prepare_blocked', 'policy_blocked'],
    ['forbidden', 'prepare_forbidden', 'policy_forbidden'],
    ['unauthenticated', 'prepare_forbidden', 'policy_forbidden'],
    ['validation', 'prepare_invalid', 'policy_invalid'],
    ['unavailable', 'prepare_unavailable', 'policy_unavailable'],
  ] as const) {
    const pilot = new FakePilot();
    pilot.prepareOutcome = { ok: false, kind };
    pilot.policyOutcome = { ok: false, kind };
    const prepared = await call(
      'POST', EMAIL_PILOT_PREPARE_ROUTE, deps({ founderEmailPilot: pilot }), prepareForm(),
    );
    assert.equal(
      noticeOf(prepared), founderEmailPilotNoticeToken(SECRET, SESSION, prepareCode), kind,
    );
    const recorded = await call(
      'POST', EMAIL_PILOT_POLICY_ROUTE, deps({ founderEmailPilot: pilot }), policyForm(),
    );
    assert.equal(
      noticeOf(recorded), founderEmailPilotNoticeToken(SECRET, SESSION, policyCode), kind,
    );
  }
});

test('a replayed step reports the original record rather than a second one', async () => {
  const pilot = new FakePilot();
  pilot.prepareOutcome = { ...pilot.prepareOutcome, disposition: 'replayed' } as never;
  pilot.policyOutcome = { ...pilot.policyOutcome, disposition: 'replayed' } as never;
  assert.equal(
    noticeOf(await call(
      'POST', EMAIL_PILOT_PREPARE_ROUTE, deps({ founderEmailPilot: pilot }), prepareForm(),
    )),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'prepare_replayed'),
  );
  assert.equal(
    noticeOf(await call(
      'POST', EMAIL_PILOT_POLICY_ROUTE, deps({ founderEmailPilot: pilot }), policyForm(),
    )),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'policy_replayed'),
  );
});

test('an uncomposed pilot offers no preparation and claims none', async () => {
  assert.equal(
    noticeOf(await call('POST', EMAIL_PILOT_PREPARE_ROUTE, deps(), prepareForm())),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'prepare_unavailable'),
  );
  assert.equal(
    noticeOf(await call('POST', EMAIL_PILOT_POLICY_ROUTE, deps(), policyForm())),
    founderEmailPilotNoticeToken(SECRET, SESSION, 'policy_unavailable'),
  );
  const page = await call('GET', CASE_FILE, deps());
  assert.doesNotMatch(page.body, new RegExp(`action="${EMAIL_PILOT_PREPARE_ROUTE}"`));
  assert.doesNotMatch(page.body, new RegExp(`action="${EMAIL_PILOT_POLICY_ROUTE}"`));
});

/** Nothing prepared and no policy recorded: both steps are still to do. */
function unpreparedPilot(): FakePilot {
  const pilot = new FakePilot();
  pilot.resolveOutcome = { ok: true, preview: null };
  pilot.readinessOutcome = {
    ok: true,
    report: {
      schemaVersion: 1, result: 'blocked', enqueued: false, providerEffects: false,
      dimensions: [],
      blockers: ['POLICY_AUTHORITY_MISSING', 'PECR_DECISIONS_MISSING'],
      nextStep: 'Resolve the listed blockers.',
    },
    preview: {
      recipientEmail: 'office@example.test', recipientVerified: true,
      purpose: 'property_predator_marketing', dailyUsed: 0, dailyCap: 10,
      monthlyUsed: 0, monthlyCap: 50,
    },
  };
  return pilot;
}

test('a completed step shows its record rather than offering itself again', async () => {
  // The default fixture has content prepared and no policy blocker, so neither
  // form is offered. Confirming that is what stops a founder re-running a step
  // that already happened.
  const res = await call('GET', CASE_FILE, deps({ founderEmailPilot: new FakePilot() }));
  assert.match(res.body, /Prepare and review this pilot/);
  assert.doesNotMatch(res.body, new RegExp(`action="${EMAIL_PILOT_PREPARE_ROUTE}"`));
  assert.doesNotMatch(res.body, new RegExp(`action="${EMAIL_PILOT_POLICY_ROUTE}"`));
  assert.match(res.body, /Done · approved content/);
  assert.match(res.body, /Done · compliance review/);
});

test('the case file shows the complete policy, recipient, subject and body', async () => {
  const res = await call('GET', CASE_FILE, deps({ founderEmailPilot: unpreparedPilot() }));
  assert.match(res.body, new RegExp(`action="${EMAIL_PILOT_PREPARE_ROUTE}/`));
  assert.match(res.body, new RegExp(`action="${EMAIL_PILOT_POLICY_ROUTE}/`));
  assert.match(res.body, /Not yet · approved content/);
  assert.match(res.body, /Not yet · compliance review/);
  assert.match(res.body, />Prepare approved email<\/button>/);
  assert.match(res.body, />Record compliance review<\/button>/);
  const prepareHtml = res.body.match(new RegExp(
    `<form[^>]+action="${EMAIL_PILOT_PREPARE_ROUTE}/[^"]+"[\\s\\S]*?<\\/form>`,
  ))?.[0] ?? '';
  const policyHtml = res.body.match(new RegExp(
    `<form[^>]+action="${EMAIL_PILOT_POLICY_ROUTE}/[^"]+"[\\s\\S]*?<\\/form>`,
  ))?.[0] ?? '';
  for (const formHtml of [prepareHtml, policyHtml]) {
    assert.doesNotMatch(formHtml, /<(input|select|textarea)\b/);
    assert.doesNotMatch(formHtml, /name="confirm_(prepare|policy)"/);
  }
  // The recipient resolved from the endpoint, and the exact approved copy.
  assert.match(res.body, /office@example\.test/);
  assert.match(res.body, /Property Predator Growth HQ — founder delivery proof/);
  assert.match(res.body, /verified founder email endpoint shown in Lead 360/);
  // Every policy clause, in full.
  for (const clause of FOUNDER_PILOT_POLICY_CLAUSES) {
    assert.ok(res.body.includes(clause.heading), clause.ref);
  }
  // The honest framing, and the fixed facts of this pilot.
  assert.match(res.body, /founder and operator compliance review, not legal advice/i);
  assert.match(res.body, new RegExp(FOUNDER_PILOT_REVIEW_AUTHORITY));
  assert.match(res.body, new RegExp(FOUNDER_PILOT_ROUTE_CLASSIFICATION));
  assert.match(res.body, /None supplied, recorded as unchecked/);
  // No solicitor approval is claimed anywhere. The page says the opposite, in
  // as many words, so assert the denial and the absence of any affirmative.
  assert.match(res.body, /no solicitor has approved it/iu);
  assert.doesNotMatch(res.body, /approved by a solicitor/iu);
  assert.doesNotMatch(res.body, /solicitor approval (obtained|recorded|given)/iu);
  assert.doesNotMatch(res.body, /legal advice (has been |was )?(given|provided|obtained)/iu);
  // Every mention of a solicitor must sit inside a denial.
  for (const sentence of res.body.split(/(?<=\.)\s+/u)) {
    if (!/solicitor/iu.test(sentence)) continue;
    assert.match(sentence, /\bno\b/iu, sentence.slice(0, 160));
  }
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
