import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  LIVE_CHANNELS_ROUTE,
  LIVE_CHANNELS_SMS_BIND_ROUTE,
  LIVE_CHANNELS_SMS_REVOKE_ROUTE,
  LIVE_CHANNELS_SMS_STAGE_ROUTE,
} from '../src/portal/live-channels-presenter.js';
import { liveChannelsNoticeToken } from '../src/portal/live-channels-actions.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type {
  PortalSmsBindSenderResult,
  PortalSmsBindingService,
  PortalSmsFailureKind,
  PortalSmsReadinessResult,
  PortalSmsRevokeSenderResult,
  PortalSmsStageResult,
} from '../src/portal/sms-binding-service.js';
import { PgPortalSmsBindingService } from '../src/portal/sms-binding-pg-service.js';
import {
  SMS_ACTIVATION_BLOCKER_CODES,
  SMS_ACTIVATION_DIMENSIONS,
  SMS_DAILY_SEGMENT_HARD_CAP,
  SMS_MONTHLY_SEGMENT_HARD_CAP,
  buildSmsActivationReadinessReport,
  type SmsActivationReadinessReport,
} from '../src/sms-activation/foundation.js';

const SECRET = 'twilio-sms-commands-secret';
const SESSION = Buffer.alloc(32, 71).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const REQUEST_ID = 'twilio-sms-request';
const WORKSPACE_ID = 'ea100000-0000-4000-8000-000000000001';
const USER_ID = 'eb100000-0000-4000-8000-000000000001';
const COMMAND_KEY = 'ea900000-0000-4000-8000-00000000aa01';
const BINDING_ID = 'ec100000-0000-4000-8000-0000000000c1';
const CONNECTION_ID = 'ec200000-0000-4000-8000-0000000000d1';
const ENDPOINT_ID = 'ec300000-0000-4000-8000-0000000000e1';
const MESSAGE_VERSION_ID = 'ec400000-0000-4000-8000-0000000000f1';
const APPROVAL_REQUEST_ID = 'ec500000-0000-4000-8000-000000000101';
const APPROVAL_DECISION_ID = 'ec600000-0000-4000-8000-000000000111';
const CONTACT_ID = 'ec700000-0000-4000-8000-000000000121';
const CONTACT_POINT_ID = 'ec800000-0000-4000-8000-000000000131';
const CONSENT_EVENT_ID = 'ec900000-0000-4000-8000-000000000141';
const COMPLIANCE_SUBJECT_ID = 'eca00000-0000-4000-8000-000000000151';
const POLICY_PUBLICATION_ID = 'ecb00000-0000-4000-8000-000000000161';
const PECR_SENDER_ID = 'ecc00000-0000-4000-8000-000000000171';
const PECR_INSTIGATOR_ID = 'ecd00000-0000-4000-8000-000000000181';
const PERMISSION_USE_ID = 'ece00000-0000-4000-8000-000000000191';
const OPERATION_ID = 'ecf00000-0000-4000-8000-0000000001a1';
const DELIVERY_ID = 'ed000000-0000-4000-8000-0000000001b1';
const CORRELATION_ID = 'ed100000-0000-4000-8000-0000000001c1';
const REVOCATION_ID = 'ed200000-0000-4000-8000-0000000001d1';
const JOB_ID = 'ed300000-0000-4000-8000-0000000001e1';

/**
 * Deliberately recognisable Twilio identifiers. They are not credentials, but
 * they identify the founder's live Twilio account, so the browser must never
 * see either of them echoed back in any part of a response.
 */
// Assembled at runtime rather than written as literals. These are fabricated
// fixtures, but a literal 'AC' followed by 32 hex characters is exactly the
// Twilio Account SID shape that secret scanners flag, and a test fixture is
// never a good reason to teach anyone to bypass push protection. The runtime
// values are still the exact shapes the seam validates.
const HEX_32 = '0123456789abcdef'.repeat(2);
const ACCOUNT_SID = `AC${HEX_32}`;
const MESSAGING_SERVICE_SID = `MG${HEX_32}`;
const SENDER_NUMBER = '+447700900123';
const OWNED_RECIPIENT = '+447700900456';
const REGULATORY_EVIDENCE = 'ofcom-cli-registration-001';
const OWNERSHIP_EVIDENCE = 'twilio-console-ownership-001';
const EVIDENCE_OBSERVED_AT = '2026-08-27T11:02:00.000Z';
const AUTHORITY_VALID_UNTIL = '2026-08-27T13:00:00.000Z';
const PURPOSE = 'marketing';

const SHA256_HEX = /^[0-9a-f]{64}$/u;

const auth: PortalAuthService = {
  resolve: async (token) => token === SESSION ? {
    sessionToken: token,
    userId: USER_ID,
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

function postgres(overrides: Partial<PostgresPortalDeps> = {}): PostgresPortalDeps {
  return {
    kind: 'postgres',
    sessionSecret: SECRET,
    secure: false,
    requestId: () => REQUEST_ID,
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

function noticeLocation(code: Parameters<typeof liveChannelsNoticeToken>[2]): string {
  return `${LIVE_CHANNELS_ROUTE}?notice=${encodeURIComponent(liveChannelsNoticeToken(SECRET, SESSION, code))}`;
}

function encodeForm(fields: Readonly<Record<string, string>>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function bindFields(): Record<string, string> {
  return {
    _csrf: csrfFor(SESSION),
    command_key: COMMAND_KEY,
    binding_id: BINDING_ID,
    connection_id: CONNECTION_ID,
    endpoint_id: ENDPOINT_ID,
    display_name: 'Property Predator SMS',
    account_sid: ACCOUNT_SID,
    messaging_service_sid: MESSAGING_SERVICE_SID,
    sender_number: SENDER_NUMBER,
    regulatory_evidence: REGULATORY_EVIDENCE,
    ownership_evidence: OWNERSHIP_EVIDENCE,
    evidence_observed_at: EVIDENCE_OBSERVED_AT,
    confirm_sender: 'BIND',
  };
}

function revokeFields(): Record<string, string> {
  return {
    _csrf: csrfFor(SESSION),
    command_key: COMMAND_KEY,
    binding_id: BINDING_ID,
    reason_code: 'founder_rotation',
    revocation_evidence: 'sms-revocation-evidence-001',
    confirm_sender_revoke: 'REVOKE',
  };
}

function stageFields(): Record<string, string> {
  return {
    _csrf: csrfFor(SESSION),
    command_key: COMMAND_KEY,
    binding_id: BINDING_ID,
    connection_id: CONNECTION_ID,
    endpoint_id: ENDPOINT_ID,
    message_version_id: MESSAGE_VERSION_ID,
    approval_request_id: APPROVAL_REQUEST_ID,
    approval_decision_id: APPROVAL_DECISION_ID,
    person_id: CONTACT_ID,
    phone_endpoint_id: CONTACT_POINT_ID,
    consent_event_id: CONSENT_EVENT_ID,
    compliance_subject_id: COMPLIANCE_SUBJECT_ID,
    policy_publication_id: POLICY_PUBLICATION_ID,
    pecr_sender_id: PECR_SENDER_ID,
    pecr_instigator_id: PECR_INSTIGATOR_ID,
    permission_use_id: PERMISSION_USE_ID,
    operation_id: OPERATION_ID,
    delivery_id: DELIVERY_ID,
    correlation_id: CORRELATION_ID,
    authority_valid_until: AUTHORITY_VALID_UNTIL,
    segment_count: '1',
    owned_recipient: OWNED_RECIPIENT,
    purpose: PURPOSE,
    confirm_sms_stage: 'STAGE',
  };
}

interface RouteCase {
  readonly name: string;
  readonly route: string;
  readonly confirmField: string;
  readonly fields: () => Record<string, string>;
}

const ROUTE_CASES: readonly RouteCase[] = [
  { name: 'sender', route: LIVE_CHANNELS_SMS_BIND_ROUTE, confirmField: 'confirm_sender', fields: bindFields },
  { name: 'revocation', route: LIVE_CHANNELS_SMS_REVOKE_ROUTE, confirmField: 'confirm_sender_revoke', fields: revokeFields },
  { name: 'staging', route: LIVE_CHANNELS_SMS_STAGE_ROUTE, confirmField: 'confirm_sms_stage', fields: stageFields },
];

interface RecordedCall {
  readonly method: 'bindSender' | 'revokeSender' | 'readiness' | 'stageOwnedTest';
  readonly identity: unknown;
  readonly input: unknown;
}

const READY_OUTCOME = Object.freeze({
  ok: true,
  jobId: JOB_ID,
  disposition: 'queued',
  providerEffects: 'none',
  workerLeaseClaimed: false,
  caps: Object.freeze({ dailySegments: 10, monthlySegments: 50 }),
}) as PortalSmsStageResult;

function fakeBinding(results: Readonly<{
  bind?: PortalSmsBindSenderResult;
  revoke?: PortalSmsRevokeSenderResult;
  stage?: PortalSmsStageResult;
}> = {}): { service: PortalSmsBindingService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const service: PortalSmsBindingService = {
    workspaceId: WORKSPACE_ID,
    bindSender: async (identity, input) => {
      calls.push({ method: 'bindSender', identity, input });
      return results.bind ?? { ok: true, bindingId: BINDING_ID, providerEffects: 'none' };
    },
    revokeSender: async (identity, input) => {
      calls.push({ method: 'revokeSender', identity, input });
      return results.revoke ?? { ok: true, revocationId: REVOCATION_ID, providerEffects: 'none' };
    },
    readiness: async (identity, input): Promise<PortalSmsReadinessResult> => {
      calls.push({ method: 'readiness', identity, input });
      return { ok: true, report: readinessReport() };
    },
    stageOwnedTest: async (identity, input) => {
      calls.push({ method: 'stageOwnedTest', identity, input });
      return results.stage ?? READY_OUTCOME;
    },
  };
  return { service, calls };
}

/** A report the foundation itself validates, so no test can invent a shape. */
function readinessReport(blocked = false): SmsActivationReadinessReport {
  return buildSmsActivationReadinessReport(SMS_ACTIVATION_DIMENSIONS.map((dimension, index) => (
    blocked && index === 0
      ? { dimension, ready: false, blockerCode: SMS_ACTIVATION_BLOCKER_CODES[0]! }
      : { dimension, ready: true, blockerCode: null }
  )));
}

/* ------------------------------------------------------------------ *
 * Router: the three founder-only Twilio SMS POST boundaries.
 * ------------------------------------------------------------------ */

test('every Twilio SMS command route demands an authenticated session', async () => {
  for (const { route } of ROUTE_CASES) {
    const result = await call(route, postgres(), undefined, 'POST', encodeForm({ confirm_sender: 'BIND' }));
    assert.equal(result.statusCode, 302);
    assert.match(result.headers.location ?? '', /\/portal\/login/u);
  }
});

test('Twilio SMS command routes are Property Predator-only even for an invalid body', async () => {
  for (const { route } of ROUTE_CASES) {
    const { service, calls } = fakeBinding();
    const result = await call(
      route,
      postgres({ productProfile: RELAUNCH72_PRODUCT_PROFILE, smsBinding: service }),
      COOKIE,
      'POST',
      'garbage=1&garbage=2',
    );
    assert.equal(result.statusCode, 404);
    assert.match(result.body, /Live Channels not connected/u);
    assert.deepEqual(calls, []);
  }
});

test('each Twilio SMS route rejects unconfirmed, forged, stray and keyless commands', async () => {
  const invalid = noticeLocation('sms_invalid');
  for (const { name, route, confirmField, fields } of ROUTE_CASES) {
    const { service, calls } = fakeBinding();
    const deps = postgres({ smsBinding: service });

    const missingConfirmation = fields();
    delete missingConfirmation[confirmField];

    const wrongCsrf = { ...fields(), _csrf: 'not-the-token' };

    const strayKey = { ...fields(), unexpected_field: '1' };

    const badCommandKey = { ...fields(), command_key: 'not-a-uuid' };

    const missingCommandKey = fields();
    delete missingCommandKey.command_key;

    for (const [label, body] of [
      ['missing confirmation', missingConfirmation],
      ['wrong csrf', wrongCsrf],
      ['stray key', strayKey],
      ['non-uuid command key', badCommandKey],
      ['missing command key', missingCommandKey],
    ] as const) {
      const result = await call(route, deps, COOKIE, 'POST', encodeForm(body));
      assert.equal(result.statusCode, 303, `${name}/${label} status`);
      assert.equal(result.headers.location, invalid, `${name}/${label} location`);
    }
    assert.deepEqual(calls, [], `${name} must never reach the seam`);
  }
});

test('a well-formed Twilio SMS command is honest when the seam is not composed', async () => {
  const unavailable = noticeLocation('sms_unavailable');
  for (const { route, fields } of ROUTE_CASES) {
    const result = await call(route, postgres(), COOKIE, 'POST', encodeForm(fields()));
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, unavailable);
  }
});

test('bind outcomes map onto exactly one signed notice each', async () => {
  const cases: ReadonlyArray<readonly [PortalSmsBindSenderResult, string]> = [
    [{ ok: true, bindingId: BINDING_ID, providerEffects: 'none' }, 'sms_sender_bound'],
    [{ ok: false, kind: 'forbidden' }, 'sms_forbidden'],
    [{ ok: false, kind: 'unauthenticated' }, 'sms_forbidden'],
    [{ ok: false, kind: 'validation' }, 'sms_invalid'],
    [{ ok: false, kind: 'conflict' }, 'sms_invalid'],
    [{ ok: false, kind: 'unavailable' }, 'sms_unavailable'],
  ];
  for (const [outcome, notice] of cases) {
    const { service } = fakeBinding({ bind: outcome });
    const result = await call(
      LIVE_CHANNELS_SMS_BIND_ROUTE,
      postgres({ smsBinding: service }),
      COOKIE,
      'POST',
      encodeForm(bindFields()),
    );
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation(notice as never));
  }
});

test('revoke outcomes map onto exactly one signed notice each', async () => {
  const cases: ReadonlyArray<readonly [PortalSmsRevokeSenderResult, string]> = [
    [{ ok: true, revocationId: REVOCATION_ID, providerEffects: 'none' }, 'sms_sender_revoked'],
    [{ ok: false, kind: 'forbidden' }, 'sms_forbidden'],
    [{ ok: false, kind: 'unauthenticated' }, 'sms_forbidden'],
    [{ ok: false, kind: 'validation' }, 'sms_invalid'],
    [{ ok: false, kind: 'conflict' }, 'sms_invalid'],
    [{ ok: false, kind: 'unavailable' }, 'sms_unavailable'],
  ];
  for (const [outcome, notice] of cases) {
    const { service } = fakeBinding({ revoke: outcome });
    const result = await call(
      LIVE_CHANNELS_SMS_REVOKE_ROUTE,
      postgres({ smsBinding: service }),
      COOKIE,
      'POST',
      encodeForm(revokeFields()),
    );
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation(notice as never));
  }
});

test('a refused staging readiness verdict reports blocked, never a generic rejection', async () => {
  const cases: ReadonlyArray<readonly [PortalSmsStageResult, string]> = [
    [READY_OUTCOME, 'sms_test_staged'],
    // 'blocked' is deliberately distinct from 'forbidden': the founder had the
    // authority to ask, the database simply did not prove the evidence.
    [{ ok: false, kind: 'blocked' }, 'sms_staging_blocked'],
    [{ ok: false, kind: 'forbidden' }, 'sms_forbidden'],
    [{ ok: false, kind: 'unauthenticated' }, 'sms_forbidden'],
    [{ ok: false, kind: 'validation' }, 'sms_invalid'],
    [{ ok: false, kind: 'conflict' }, 'sms_invalid'],
    [{ ok: false, kind: 'unavailable' }, 'sms_unavailable'],
  ];
  for (const [outcome, notice] of cases) {
    const { service } = fakeBinding({ stage: outcome });
    const result = await call(
      LIVE_CHANNELS_SMS_STAGE_ROUTE,
      postgres({ smsBinding: service }),
      COOKIE,
      'POST',
      encodeForm(stageFields()),
    );
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation(notice as never));
  }
});

test('the Twilio account and messaging-service identifiers never reach the browser', async () => {
  const { service, calls } = fakeBinding();
  const result = await call(
    LIVE_CHANNELS_SMS_BIND_ROUTE,
    postgres({ smsBinding: service }),
    COOKIE,
    'POST',
    encodeForm(bindFields()),
  );
  assert.equal(result.statusCode, 303);
  assert.equal(result.headers.location, noticeLocation('sms_sender_bound'));

  // The response, in every part a browser could read back.
  const rendered = [
    String(result.statusCode),
    JSON.stringify(result.headers),
    result.headers.location ?? '',
    result.body,
  ].join('\u0000');
  for (const secret of [ACCOUNT_SID, MESSAGING_SERVICE_SID]) {
    assert.equal(rendered.includes(secret), false, `${secret} must not be echoed`);
    assert.equal(rendered.includes(encodeURIComponent(secret)), false);
    assert.equal(rendered.includes(secret.toLowerCase()), false);
  }

  // But the seam did receive them: passed through, never reflected.
  assert.equal(calls.length, 1);
  const input = calls[0]!.input as { accountSid: string; messagingServiceSid: string };
  assert.equal(input.accountSid, ACCOUNT_SID);
  assert.equal(input.messagingServiceSid, MESSAGING_SERVICE_SID);
});

test('the bind seam receives exactly the request identity and the parsed fields', async () => {
  const { service, calls } = fakeBinding();
  await call(
    LIVE_CHANNELS_SMS_BIND_ROUTE,
    postgres({ smsBinding: service }),
    COOKIE,
    'POST',
    encodeForm(bindFields()),
  );
  assert.deepEqual(calls, [{
    method: 'bindSender',
    identity: { sessionToken: SESSION, requestId: REQUEST_ID },
    input: {
      bindingId: BINDING_ID,
      providerConnectionId: CONNECTION_ID,
      channelEndpointId: ENDPOINT_ID,
      displayName: 'Property Predator SMS',
      accountSid: ACCOUNT_SID,
      messagingServiceSid: MESSAGING_SERVICE_SID,
      senderNumber: SENDER_NUMBER,
      regulatoryEvidence: REGULATORY_EVIDENCE,
      ownershipEvidence: OWNERSHIP_EVIDENCE,
      ownershipAttested: true,
      evidenceObservedAt: EVIDENCE_OBSERVED_AT,
    },
  }]);
});

test('the revoke and staging seams receive exactly the request identity and parsed fields', async () => {
  const revoke = fakeBinding();
  await call(
    LIVE_CHANNELS_SMS_REVOKE_ROUTE,
    postgres({ smsBinding: revoke.service }),
    COOKIE,
    'POST',
    encodeForm(revokeFields()),
  );
  assert.deepEqual(revoke.calls, [{
    method: 'revokeSender',
    identity: { sessionToken: SESSION, requestId: REQUEST_ID },
    input: {
      bindingId: BINDING_ID,
      reasonCode: 'founder_rotation',
      revocationEvidence: 'sms-revocation-evidence-001',
    },
  }]);

  const stage = fakeBinding();
  await call(
    LIVE_CHANNELS_SMS_STAGE_ROUTE,
    postgres({ smsBinding: stage.service }),
    COOKIE,
    'POST',
    encodeForm(stageFields()),
  );
  assert.deepEqual(stage.calls, [{
    method: 'stageOwnedTest',
    identity: { sessionToken: SESSION, requestId: REQUEST_ID },
    input: {
      bindingId: BINDING_ID,
      providerConnectionId: CONNECTION_ID,
      channelEndpointId: ENDPOINT_ID,
      messageVersionId: MESSAGE_VERSION_ID,
      messageApprovalRequestId: APPROVAL_REQUEST_ID,
      messageApprovalDecisionId: APPROVAL_DECISION_ID,
      contactId: CONTACT_ID,
      contactPointId: CONTACT_POINT_ID,
      consentEventId: CONSENT_EVENT_ID,
      complianceSubjectId: COMPLIANCE_SUBJECT_ID,
      policyPublicationEventId: POLICY_PUBLICATION_ID,
      pecrSenderDecisionEventId: PECR_SENDER_ID,
      pecrInstigatorDecisionEventId: PECR_INSTIGATOR_ID,
      permissionUseReceiptId: PERMISSION_USE_ID,
      providerOperationId: OPERATION_ID,
      messageDeliveryId: DELIVERY_ID,
      correlationId: CORRELATION_ID,
      authorityValidUntil: AUTHORITY_VALID_UNTIL,
      expectedSegmentCount: 1,
      ownedRecipient: OWNED_RECIPIENT,
      purpose: PURPOSE,
    },
  }]);
});

/* ------------------------------------------------------------------ *
 * PgPortalSmsBindingService: the founder-only postgres implementation.
 * ------------------------------------------------------------------ */

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

interface Harness {
  readonly service: PgPortalSmsBindingService;
  readonly calls: Call[];
  readonly enqueued: unknown[];
  readonly digestCalls: unknown[];
  readonly readinessCalls: unknown[];
}

const IDENTITY = { sessionToken: SESSION, requestId: REQUEST_ID };
const REQUEST_DIGEST = 'd'.repeat(64);

function harness(options: Readonly<{
  throws?: unknown;
  blocked?: boolean;
  principalWorkspaceId?: string;
  enqueueThrows?: unknown;
}> = {}): Harness {
  const calls: Call[] = [];
  const enqueued: unknown[] = [];
  const digestCalls: unknown[] = [];
  const readinessCalls: unknown[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (/^(?:BEGIN|COMMIT|ROLLBACK)/u.test(sql)
          || sql.includes("set_config('app.user_id'")) return { rows: [] };
      if (sql.includes('active_portal_session')) return { rows: [{ active: true }] };
      if (options.throws !== undefined) throw options.throws;
      if (sql.includes('record_sms_live_binding')) return { rows: [{ id: BINDING_ID }] };
      if (sql.includes('revoke_sms_live_binding')) return { rows: [{ id: REVOCATION_ID }] };
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
  const service = new PgPortalSmsBindingService({
    principalResolver: {
      resolve: async () => ({
        userId: USER_ID,
        workspaceId: options.principalWorkspaceId ?? WORKSPACE_ID,
      }),
    },
    commandPool: { connect: async () => client },
    commandService: {
      authorizeAndEnqueue: async (_context, command) => {
        enqueued.push(command);
        if (options.enqueueThrows !== undefined) throw options.enqueueThrows;
        return {
          jobId: JOB_ID,
          disposition: 'queued',
          providerEffects: 'none',
          caps: { dailySegments: 10, monthlySegments: 50, recipientsPerJob: 1 },
        };
      },
    },
    readinessProbe: {
      readiness: async (_context, target) => {
        readinessCalls.push(target);
        return readinessReport(options.blocked === true);
      },
      requestDigest: async (_context, input) => {
        digestCalls.push(input);
        return REQUEST_DIGEST;
      },
    },
    workspaceId: WORKSPACE_ID,
  });
  return { service, calls, enqueued, digestCalls, readinessCalls };
}

function bindInput(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: BINDING_ID,
    providerConnectionId: CONNECTION_ID,
    channelEndpointId: ENDPOINT_ID,
    displayName: 'Property Predator SMS',
    accountSid: ACCOUNT_SID,
    messagingServiceSid: MESSAGING_SERVICE_SID,
    senderNumber: SENDER_NUMBER,
    regulatoryEvidence: REGULATORY_EVIDENCE,
    ownershipEvidence: OWNERSHIP_EVIDENCE,
    ownershipAttested: true,
    evidenceObservedAt: EVIDENCE_OBSERVED_AT,
    ...overrides,
  } as never;
}

function revokeInput(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: BINDING_ID,
    reasonCode: 'founder_rotation',
    revocationEvidence: 'sms-revocation-evidence-001',
    ...overrides,
  } as never;
}

function stageInput(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: BINDING_ID,
    providerConnectionId: CONNECTION_ID,
    channelEndpointId: ENDPOINT_ID,
    messageVersionId: MESSAGE_VERSION_ID,
    messageApprovalRequestId: APPROVAL_REQUEST_ID,
    messageApprovalDecisionId: APPROVAL_DECISION_ID,
    contactId: CONTACT_ID,
    contactPointId: CONTACT_POINT_ID,
    consentEventId: CONSENT_EVENT_ID,
    complianceSubjectId: COMPLIANCE_SUBJECT_ID,
    policyPublicationEventId: POLICY_PUBLICATION_ID,
    pecrSenderDecisionEventId: PECR_SENDER_ID,
    pecrInstigatorDecisionEventId: PECR_INSTIGATOR_ID,
    permissionUseReceiptId: PERMISSION_USE_ID,
    providerOperationId: OPERATION_ID,
    messageDeliveryId: DELIVERY_ID,
    correlationId: CORRELATION_ID,
    authorityValidUntil: AUTHORITY_VALID_UNTIL,
    expectedSegmentCount: 1,
    ownedRecipient: OWNED_RECIPIENT,
    purpose: PURPOSE,
    ...overrides,
  } as never;
}

/** Every value the boundary bound, across every statement it issued. */
function everyValue(calls: readonly Call[]): readonly unknown[] {
  return calls.flatMap((entry) => [...entry.values]);
}

test('binding validation refuses malformed evidence before any SQL is issued', async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['non-uuid binding id', { bindingId: 'not-a-uuid' }],
    ['non-uuid connection id', { providerConnectionId: 'not-a-uuid' }],
    ['non-uuid endpoint id', { channelEndpointId: 'not-a-uuid' }],
    ['empty display name', { displayName: '   ' }],
    ['oversized display name', { displayName: 'x'.repeat(121) }],
    ['ownership not attested', { ownershipAttested: false }],
    ['ownership attested with a truthy non-boolean', { ownershipAttested: 'true' }],
    ['uppercase account sid body', { accountSid: `AC${HEX_32.toUpperCase()}` }],
    ['short account sid', { accountSid: 'AC0123456789abcdef' }],
    ['messaging service sid in the account shape', { messagingServiceSid: ACCOUNT_SID }],
    ['short messaging service sid', { messagingServiceSid: 'MG0123456789abcdef' }],
    ['non-UK sender number', { senderNumber: '+15551234567' }],
    ['national sender number', { senderNumber: '07700900123' }],
    ['non-canonical evidenceObservedAt', { evidenceObservedAt: '2026-08-27T11:02:00Z' }],
    ['offset evidenceObservedAt', { evidenceObservedAt: '2026-08-27T11:02:00.000+00:00' }],
  ];
  for (const [label, overrides] of cases) {
    const mocked = harness();
    assert.deepEqual(
      await mocked.service.bindSender(IDENTITY, bindInput(overrides)),
      { ok: false, kind: 'validation' },
      label,
    );
    assert.deepEqual(mocked.calls, [], `${label} must not issue SQL`);
  }
});

test('a bound sender travels as digests, with only the number in clear', async () => {
  const mocked = harness();
  const outcome = await mocked.service.bindSender(IDENTITY, bindInput());
  assert.deepEqual(outcome, { ok: true, bindingId: BINDING_ID, providerEffects: 'none' });

  const command = mocked.calls.find((entry) =>
    entry.sql.includes('record_sms_live_binding'))!;
  assert.ok(command, 'the binding statement must be issued');
  assert.match(command.sql, /\/\* portal\.twilio-sms\.record-binding \*\//u);
  assert.match(command.sql, /app_private\.record_sms_live_binding\(/u);
  assert.equal(command.values[0], WORKSPACE_ID);
  assert.equal(command.values[1], BINDING_ID);

  // The two Twilio identifiers cross as 32-byte digests, never as text.
  for (const index of [5, 6]) {
    const value = command.values[index];
    assert.equal(Buffer.isBuffer(value), true, `value ${index} must be a Buffer`);
    assert.equal((value as Buffer).length, 32);
  }
  assert.deepEqual(
    command.values[5],
    createHash('sha256').update(ACCOUNT_SID, 'utf8').digest(),
  );
  assert.deepEqual(
    command.values[6],
    createHash('sha256').update(MESSAGING_SERVICE_SID, 'utf8').digest(),
  );

  // Nothing the boundary bound, anywhere, is either identifier in clear.
  for (const value of everyValue(mocked.calls)) {
    if (typeof value !== 'string') continue;
    assert.equal(value.includes(ACCOUNT_SID), false);
    assert.equal(value.includes(MESSAGING_SERVICE_SID), false);
  }

  // The sender number is deliberately clear: channel_endpoints must route it.
  assert.equal(command.values[7], SENDER_NUMBER);
  assert.equal(
    everyValue(mocked.calls).some((value) => value === SENDER_NUMBER),
    true,
  );
});

test('revocation issues its own marked statement and validates its reason code', async () => {
  const mocked = harness();
  assert.deepEqual(
    await mocked.service.revokeSender(IDENTITY, {
      bindingId: BINDING_ID,
      reasonCode: 'founder_rotation',
      revocationEvidence: 'sms-revocation-evidence-001',
    }),
    { ok: true, revocationId: REVOCATION_ID, providerEffects: 'none' },
  );
  const command = mocked.calls.find((entry) =>
    entry.sql.includes('revoke_sms_live_binding'))!;
  assert.ok(command, 'the revocation statement must be issued');
  assert.match(command.sql, /\/\* portal\.twilio-sms\.revoke-binding \*\//u);
  assert.deepEqual(command.values.slice(0, 3), [WORKSPACE_ID, BINDING_ID, 'founder_rotation']);
  assert.equal(Buffer.isBuffer(command.values[3]), true);
  assert.equal((command.values[3] as Buffer).length, 32);

  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['uppercase reason code', { reasonCode: 'Founder_Rotation' }],
    ['reason code starting with a digit', { reasonCode: '1founder' }],
    ['oversized reason code', { reasonCode: `a${'b'.repeat(100)}` }],
    ['empty reason code', { reasonCode: '' }],
    ['non-uuid binding id', { bindingId: 'not-a-uuid' }],
    ['empty revocation evidence', { revocationEvidence: '' }],
  ];
  for (const [label, overrides] of cases) {
    const rejected = harness();
    assert.deepEqual(
      await rejected.service.revokeSender(IDENTITY, revokeInput(overrides)),
      { ok: false, kind: 'validation' },
      label,
    );
    assert.deepEqual(rejected.calls, [], `${label} must not issue SQL`);
  }
});

test('a blocked readiness verdict stops staging before the enqueue is attempted', async () => {
  const mocked = harness({ blocked: true });
  const outcome = await mocked.service.stageOwnedTest(IDENTITY, stageInput());
  // 'blocked' is deliberately distinct from 'forbidden': the founder had the
  // authority to ask, the database simply did not prove the evidence.
  assert.deepEqual(outcome, { ok: false, kind: 'blocked' });
  assert.deepEqual(mocked.enqueued, []);
  assert.deepEqual(mocked.digestCalls, []);
  assert.equal(mocked.readinessCalls.length, 1);
});

test('a ready verdict enqueues one job with a derived key and the database digest', async () => {
  const mocked = harness();
  const outcome = await mocked.service.stageOwnedTest(IDENTITY, stageInput());

  assert.equal(mocked.readinessCalls.length, 1);
  assert.equal(mocked.digestCalls.length, 1, 'the request digest must come from the database');
  assert.equal(mocked.enqueued.length, 1);
  const command = mocked.enqueued[0] as {
    idempotencyKeySha256: string; requestSha256: string; expectedSegmentCount: number;
  };
  assert.match(command.idempotencyKeySha256, SHA256_HEX);
  assert.equal(command.requestSha256, REQUEST_DIGEST);
  assert.notEqual(command.idempotencyKeySha256, command.requestSha256);
  assert.equal(command.expectedSegmentCount, 1);

  // The key the probe was asked to bind is the one that was enqueued.
  const digestInput = mocked.digestCalls[0] as { idempotencyKeySha256: string };
  assert.equal(digestInput.idempotencyKeySha256, command.idempotencyKeySha256);

  assert.deepEqual(outcome, {
    ok: true,
    jobId: JOB_ID,
    disposition: 'queued',
    providerEffects: 'none',
    workerLeaseClaimed: false,
    caps: {
      dailySegments: SMS_DAILY_SEGMENT_HARD_CAP,
      monthlySegments: SMS_MONTHLY_SEGMENT_HARD_CAP,
    },
  });
});

test('staging validation refuses malformed evidence before readiness is probed', async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['non-uuid binding id', { bindingId: 'not-a-uuid' }],
    ['non-uuid correlation id', { correlationId: 'not-a-uuid' }],
    ['non-canonical authority expiry', { authorityValidUntil: '2026-08-27T13:00:00Z' }],
    ['zero segments', { expectedSegmentCount: 0 }],
    ['segments beyond the hard cap', { expectedSegmentCount: SMS_DAILY_SEGMENT_HARD_CAP + 1 }],
    ['fractional segments', { expectedSegmentCount: 1.5 }],
    ['uppercase purpose', { purpose: 'Marketing' }],
    ['non-UK owned recipient', { ownedRecipient: '+15551234567' }],
  ];
  for (const [label, overrides] of cases) {
    const mocked = harness();
    assert.deepEqual(
      await mocked.service.stageOwnedTest(IDENTITY, stageInput(overrides)),
      { ok: false, kind: 'validation' },
      label,
    );
    assert.deepEqual(mocked.readinessCalls, [], `${label} must not probe readiness`);
    assert.deepEqual(mocked.enqueued, [], `${label} must not enqueue`);
  }
});

test('a principal from another workspace is unauthenticated and issues no SQL', async () => {
  const other = 'ee100000-0000-4000-8000-0000000009f1';
  for (const attempt of ['bind', 'revoke', 'stage'] as const) {
    const mocked = harness({ principalWorkspaceId: other });
    const outcome = attempt === 'bind'
      ? await mocked.service.bindSender(IDENTITY, bindInput())
      : attempt === 'revoke'
        ? await mocked.service.revokeSender(IDENTITY, {
          bindingId: BINDING_ID,
          reasonCode: 'founder_rotation',
          revocationEvidence: 'sms-revocation-evidence-001',
        })
        : await mocked.service.stageOwnedTest(IDENTITY, stageInput());
    assert.deepEqual(outcome, { ok: false, kind: 'unauthenticated' }, attempt);
    assert.deepEqual(mocked.calls, [], `${attempt} must not issue SQL`);
    assert.deepEqual(mocked.readinessCalls, [], `${attempt} must not probe readiness`);
    assert.deepEqual(mocked.enqueued, [], `${attempt} must not enqueue`);
  }
});

test('a seam bound to a non-uuid workspace refuses to exist at all', () => {
  assert.throws(() => new PgPortalSmsBindingService({
    principalResolver: { resolve: async () => null },
    commandPool: { connect: async () => ({} as never) },
    commandService: { authorizeAndEnqueue: async () => ({} as never) },
    readinessProbe: {
      readiness: async () => readinessReport(),
      requestDigest: async () => REQUEST_DIGEST,
    },
    workspaceId: 'not-a-uuid',
  }), /requires the exact workspace id/u);
});

test('postgres failures map onto one honest kind each and never leak the error', async () => {
  const cases: ReadonlyArray<readonly [unknown, PortalSmsFailureKind]> = [
    [{ code: '42501' }, 'forbidden'],
    [{ code: '40001' }, 'conflict'],
    [{ code: '23505' }, 'conflict'],
    [{ code: '22023' }, 'validation'],
    [{ code: '23514' }, 'validation'],
    [{ code: '54000' }, 'validation'],
    [new Error('socket hang up'), 'unavailable'],
    [{ code: 'ECONNREFUSED' }, 'unavailable'],
  ];
  for (const [thrown, kind] of cases) {
    const mocked = harness({ throws: thrown });
    const bound = await mocked.service.bindSender(IDENTITY, bindInput());
    assert.deepEqual(bound, { ok: false, kind }, `bindSender ${kind}`);
    assert.equal(JSON.stringify(bound).includes('socket hang up'), false);

    const revoked = await mocked.service.revokeSender(IDENTITY, {
      bindingId: BINDING_ID,
      reasonCode: 'founder_rotation',
      revocationEvidence: 'sms-revocation-evidence-001',
    });
    assert.deepEqual(revoked, { ok: false, kind }, `revokeSender ${kind}`);

    // The same mapping governs the enqueue, so no staging path can invent a
    // softer failure than the binding paths report.
    const staging = harness({ enqueueThrows: thrown });
    assert.deepEqual(
      await staging.service.stageOwnedTest(IDENTITY, stageInput()),
      { ok: false, kind },
      `stageOwnedTest ${kind}`,
    );
  }
});
