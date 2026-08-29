import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE,
  LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE,
  LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE,
  LIVE_CHANNELS_ROUTE,
} from '../src/portal/live-channels-presenter.js';
import { liveChannelsNoticeToken } from '../src/portal/live-channels-actions.js';
import type { PortalAuthService } from '../src/portal/auth-service.js';
import type { PortalCrmService } from '../src/portal/crm-service.js';
import { PROPERTY_PREDATOR_GROWTH_PROFILE, RELAUNCH72_PRODUCT_PROFILE } from '../src/portal/product-profile.js';
import { handlePortal, type PostgresPortalDeps } from '../src/portal/router.js';
import { PORTAL_COOKIE, portalCsrfToken } from '../src/portal/session.js';
import type {
  PortalOwnedSocialBindingService,
  PortalOwnedSocialFailureKind,
  PortalOwnedSocialReadinessResult,
  PortalOwnedSocialRecordProfileResult,
  PortalOwnedSocialRevokeProfileResult,
  PortalOwnedSocialStageResult,
} from '../src/portal/owned-social-binding-service.js';
import { PgPortalOwnedSocialBindingService } from '../src/portal/owned-social-binding-pg-service.js';
import {
  OWNED_SOCIAL_ACTIVATION_CONTRACT,
  deriveOwnedSocialStagingDigests,
  type OwnedSocialActivationReadinessReport,
} from '../src/owned-social-activation/foundation.js';
import type {
  EnqueueOwnedPublicSocialJobCommand,
  OwnedPublicSocialLiveCommandService,
  RecordOwnedPublicSocialProfileCommand,
  RevokeOwnedPublicSocialProfileCommand,
} from '../src/owned-public-social-pg/command-types.js';

const SECRET = 'owned-social-commands-secret';
const SESSION = Buffer.alloc(32, 61).toString('base64url');
const COOKIE = `${PORTAL_COOKIE}=${SESSION}`;
const REQUEST_ID = 'owned-social-request';
const WORKSPACE_ID = 'fa100000-0000-4000-8000-000000000001';
const USER_ID = 'fb100000-0000-4000-8000-000000000001';
const COMMAND_KEY = 'fa900000-0000-4000-8000-00000000aa01';
const PROVIDER_CONNECTION_ID = 'fc100000-0000-4000-8000-0000000000c1';
const PROFILE_ID = 'fc200000-0000-4000-8000-0000000000d1';
const CONTENT_ITEM_ID = 'fc300000-0000-4000-8000-0000000000e1';
const CONTENT_VERSION_ID = 'fc400000-0000-4000-8000-0000000000f1';
const APPROVAL_REQUEST_ID = 'fc500000-0000-4000-8000-000000000101';
const APPROVAL_DECISION_ID = 'fc600000-0000-4000-8000-000000000111';
const SOURCE_ATTESTATION_ID = 'fc700000-0000-4000-8000-000000000121';
const REVOCATION_ID = 'fc800000-0000-4000-8000-000000000131';
const JOB_ID = 'fc900000-0000-4000-8000-000000000141';

/** A deliberately recognisable clear Profile Key. It must never be echoed. */
const PROFILE_KEY = 'SUPERSECRETPROFILEKEY123';
const OWNED_ACCOUNT = '@propertypredator';
const PROFILE_REFERENCE = 'ayrshare-profile-ref-001';
const OAUTH_EVIDENCE = 'x-oauth-evidence-001';
const OPERATION_TAG = 'founder-owned-first-post';
const LINKED_AT = '2026-08-27T11:00:00.000Z';
const EVIDENCE_OBSERVED_AT = '2026-08-27T11:02:00.000Z';

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
    profile_id: PROFILE_ID,
    display_name: 'Property Predator on X',
    profile_reference: PROFILE_REFERENCE,
    owned_account: OWNED_ACCOUNT,
    profile_credential: PROFILE_KEY,
    oauth_evidence: OAUTH_EVIDENCE,
    linked_at: LINKED_AT,
    evidence_observed_at: EVIDENCE_OBSERVED_AT,
    confirm_owned: 'OWNED',
  };
}

function revokeFields(): Record<string, string> {
  return {
    _csrf: csrfFor(SESSION),
    command_key: COMMAND_KEY,
    profile_id: PROFILE_ID,
    reason_code: 'founder_rotation',
    revocation_evidence: 'revocation-evidence-001',
    confirm_revoke: 'REVOKE',
  };
}

function stageFields(): Record<string, string> {
  return {
    _csrf: csrfFor(SESSION),
    command_key: COMMAND_KEY,
    profile_id: PROFILE_ID,
    content_item_id: CONTENT_ITEM_ID,
    content_version_id: CONTENT_VERSION_ID,
    approval_request_id: APPROVAL_REQUEST_ID,
    approval_decision_id: APPROVAL_DECISION_ID,
    source_attestation_id: SOURCE_ATTESTATION_ID,
    owned_account: OWNED_ACCOUNT,
    operation_tag: OPERATION_TAG,
    confirm_stage: 'STAGE',
  };
}

interface RouteCase {
  readonly name: string;
  readonly route: string;
  readonly confirmField: string;
  readonly fields: () => Record<string, string>;
}

const ROUTE_CASES: readonly RouteCase[] = [
  { name: 'profile', route: LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE, confirmField: 'confirm_owned', fields: bindFields },
  { name: 'revocation', route: LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE, confirmField: 'confirm_revoke', fields: revokeFields },
  { name: 'staging', route: LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE, confirmField: 'confirm_stage', fields: stageFields },
];

interface RecordedCall {
  readonly method: 'recordProfile' | 'revokeProfile' | 'readiness' | 'stagePublication';
  readonly identity: unknown;
  readonly input: unknown;
}

function fakeBinding(results: Readonly<{
  record?: PortalOwnedSocialRecordProfileResult;
  revoke?: PortalOwnedSocialRevokeProfileResult;
  stage?: PortalOwnedSocialStageResult;
}> = {}): { service: PortalOwnedSocialBindingService; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const service: PortalOwnedSocialBindingService = {
    providerConnectionId: PROVIDER_CONNECTION_ID,
    profileBindingComposed: true,
    recordProfile: async (identity, input) => {
      calls.push({ method: 'recordProfile', identity, input });
      return results.record ?? { ok: true, profileId: PROFILE_ID, providerEffects: 'none' };
    },
    revokeProfile: async (identity, input) => {
      calls.push({ method: 'revokeProfile', identity, input });
      return results.revoke ?? { ok: true, revocationId: REVOCATION_ID, providerEffects: 'none' };
    },
    readiness: async (identity, input): Promise<PortalOwnedSocialReadinessResult> => {
      calls.push({ method: 'readiness', identity, input });
      return { ok: true, report: readinessReport('ready-for-separately-authorised-owned-test') };
    },
    stagePublication: async (identity, input) => {
      calls.push({ method: 'stagePublication', identity, input });
      return results.stage ?? {
        ok: true,
        jobId: JOB_ID,
        providerEffects: 'none',
        workerLeaseClaimed: false,
        idempotencyKeySha256: 'a'.repeat(64),
        caps: { daily: 1, monthly: 3 },
      };
    },
  };
  return { service, calls };
}

function readinessReport(
  result: OwnedSocialActivationReadinessReport['result'],
): OwnedSocialActivationReadinessReport {
  return Object.freeze({
    schemaVersion: 1,
    contract: OWNED_SOCIAL_ACTIVATION_CONTRACT,
    result,
    providerEffects: false,
    providerCallsMade: false,
    postsPublished: false,
    dimensions: Object.freeze([]),
    blockers: result === 'blocked'
      ? Object.freeze(['APPROVED_CONTENT_REQUIRED' as const])
      : Object.freeze([]),
    nextStep: 'Fictional readiness report used only by this test.',
  });
}

/* ------------------------------------------------------------------ *
 * Router: the three founder-only owned-social POST boundaries.
 * ------------------------------------------------------------------ */

test('every owned-social command route demands an authenticated session', async () => {
  for (const { route } of ROUTE_CASES) {
    const result = await call(route, postgres(), undefined, 'POST', encodeForm({ confirm_owned: 'OWNED' }));
    assert.equal(result.statusCode, 302);
    assert.match(result.headers.location ?? '', /\/portal\/login/u);
  }
});

test('owned-social command routes are Property Predator-only even for an invalid body', async () => {
  for (const { route } of ROUTE_CASES) {
    const result = await call(
      route,
      postgres({ productProfile: RELAUNCH72_PRODUCT_PROFILE, ownedSocialBinding: fakeBinding().service }),
      COOKIE,
      'POST',
      'garbage=1&garbage=2',
    );
    assert.equal(result.statusCode, 404);
    assert.match(result.body, /Live Channels not connected/u);
  }
});

test('each owned-social route rejects unconfirmed, forged, stray and keyless commands', async () => {
  const invalid = noticeLocation('owned_social_invalid');
  for (const { name, route, confirmField, fields } of ROUTE_CASES) {
    const { service, calls } = fakeBinding();
    const deps = postgres({ ownedSocialBinding: service });

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

test('a well-formed owned-social command is honest when the seam is not composed', async () => {
  const unavailable = noticeLocation('owned_social_unavailable');
  for (const { route, fields } of ROUTE_CASES) {
    const result = await call(route, postgres(), COOKIE, 'POST', encodeForm(fields()));
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, unavailable);
  }
});

test('bind outcomes map onto exactly one signed notice each', async () => {
  const cases: ReadonlyArray<readonly [PortalOwnedSocialRecordProfileResult, string]> = [
    [{ ok: true, profileId: PROFILE_ID, providerEffects: 'none' }, 'profile_bound'],
    [{ ok: false, kind: 'unauthenticated' }, 'owned_social_forbidden'],
    [{ ok: false, kind: 'forbidden' }, 'owned_social_forbidden'],
    [{ ok: false, kind: 'validation' }, 'owned_social_invalid'],
    [{ ok: false, kind: 'conflict' }, 'owned_social_invalid'],
    [{ ok: false, kind: 'unavailable' }, 'owned_social_unavailable'],
  ];
  for (const [outcome, notice] of cases) {
    const { service } = fakeBinding({ record: outcome });
    const result = await call(
      LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE,
      postgres({ ownedSocialBinding: service }),
      COOKIE,
      'POST',
      encodeForm(bindFields()),
    );
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation(notice as never));
  }
});

test('revoke outcomes map onto exactly one signed notice each', async () => {
  const cases: ReadonlyArray<readonly [PortalOwnedSocialRevokeProfileResult, string]> = [
    [{ ok: true, revocationId: REVOCATION_ID, providerEffects: 'none' }, 'profile_revoked'],
    [{ ok: false, kind: 'unauthenticated' }, 'owned_social_forbidden'],
    [{ ok: false, kind: 'forbidden' }, 'owned_social_forbidden'],
    [{ ok: false, kind: 'validation' }, 'owned_social_invalid'],
    [{ ok: false, kind: 'conflict' }, 'owned_social_invalid'],
    [{ ok: false, kind: 'unavailable' }, 'owned_social_unavailable'],
  ];
  for (const [outcome, notice] of cases) {
    const { service } = fakeBinding({ revoke: outcome });
    const result = await call(
      LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE,
      postgres({ ownedSocialBinding: service }),
      COOKIE,
      'POST',
      encodeForm(revokeFields()),
    );
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation(notice as never));
  }
});

test('a refused staging readiness verdict reports blocked, never a generic rejection', async () => {
  const cases: ReadonlyArray<readonly [PortalOwnedSocialStageResult, string]> = [
    [{
      ok: true,
      jobId: JOB_ID,
      providerEffects: 'none',
      workerLeaseClaimed: false,
      idempotencyKeySha256: 'b'.repeat(64),
      caps: { daily: 1, monthly: 3 },
    }, 'publication_staged'],
    [{ ok: false, kind: 'blocked' }, 'staging_blocked'],
    [{ ok: false, kind: 'unauthenticated' }, 'owned_social_forbidden'],
    [{ ok: false, kind: 'validation' }, 'owned_social_invalid'],
    [{ ok: false, kind: 'conflict' }, 'owned_social_invalid'],
    [{ ok: false, kind: 'unavailable' }, 'owned_social_unavailable'],
  ];
  for (const [outcome, notice] of cases) {
    const { service } = fakeBinding({ stage: outcome });
    const result = await call(
      LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE,
      postgres({ ownedSocialBinding: service }),
      COOKIE,
      'POST',
      encodeForm(stageFields()),
    );
    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, noticeLocation(notice as never));
  }
});

test('the clear Profile Key reaches the seam and is never echoed back to the browser', async () => {
  const { service, calls } = fakeBinding();
  const result = await call(
    LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE,
    postgres({ ownedSocialBinding: service }),
    COOKIE,
    'POST',
    encodeForm(bindFields()),
  );
  assert.equal(result.statusCode, 303);
  assert.equal(result.headers.location, noticeLocation('profile_bound'));

  // The response, in every part a browser could read back.
  const rendered = [
    String(result.statusCode),
    JSON.stringify(result.headers),
    result.headers.location ?? '',
    result.body,
  ].join('\u0000');
  assert.equal(rendered.includes(PROFILE_KEY), false);
  assert.equal(rendered.includes(encodeURIComponent(PROFILE_KEY)), false);
  assert.equal(rendered.includes(OWNED_ACCOUNT), false);

  // But the seam did receive it: passed through, never reflected.
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.input as { profileKey: string }).profileKey, PROFILE_KEY);
});

test('the bind seam receives exactly the request identity and the parsed fields', async () => {
  const { service, calls } = fakeBinding();
  await call(
    LIVE_CHANNELS_OWNED_SOCIAL_BIND_ROUTE,
    postgres({ ownedSocialBinding: service }),
    COOKIE,
    'POST',
    encodeForm(bindFields()),
  );
  assert.deepEqual(calls, [{
    method: 'recordProfile',
    identity: { sessionToken: SESSION, requestId: REQUEST_ID },
    input: {
      profileId: PROFILE_ID,
      displayName: 'Property Predator on X',
      providerProfileReference: PROFILE_REFERENCE,
      ownedAccountReference: OWNED_ACCOUNT,
      profileKey: PROFILE_KEY,
      ownershipAttested: true,
      oauthPermissions: 'read_write',
      oauthLinkEvidence: OAUTH_EVIDENCE,
      linkedAt: LINKED_AT,
      evidenceObservedAt: EVIDENCE_OBSERVED_AT,
    },
  }]);
});

test('the revoke and staging seams receive exactly the request identity and parsed fields', async () => {
  const revoke = fakeBinding();
  await call(
    LIVE_CHANNELS_OWNED_SOCIAL_REVOKE_ROUTE,
    postgres({ ownedSocialBinding: revoke.service }),
    COOKIE,
    'POST',
    encodeForm(revokeFields()),
  );
  assert.deepEqual(revoke.calls, [{
    method: 'revokeProfile',
    identity: { sessionToken: SESSION, requestId: REQUEST_ID },
    input: {
      profileId: PROFILE_ID,
      reasonCode: 'founder_rotation',
      revocationEvidence: 'revocation-evidence-001',
    },
  }]);

  const stage = fakeBinding();
  await call(
    LIVE_CHANNELS_OWNED_SOCIAL_STAGE_ROUTE,
    postgres({ ownedSocialBinding: stage.service }),
    COOKIE,
    'POST',
    encodeForm(stageFields()),
  );
  assert.deepEqual(stage.calls, [{
    method: 'stagePublication',
    identity: { sessionToken: SESSION, requestId: REQUEST_ID },
    input: {
      profileId: PROFILE_ID,
      contentItemId: CONTENT_ITEM_ID,
      contentVersionId: CONTENT_VERSION_ID,
      approvalRequestId: APPROVAL_REQUEST_ID,
      approvalDecisionId: APPROVAL_DECISION_ID,
      sourceAttestationId: SOURCE_ATTESTATION_ID,
      ownedAccountReference: OWNED_ACCOUNT,
      operationTag: OPERATION_TAG,
    },
  }]);
});

/* ------------------------------------------------------------------ *
 * PgPortalOwnedSocialBindingService: the founder-only implementation.
 * ------------------------------------------------------------------ */

interface CommandServiceProbe {
  readonly service: OwnedPublicSocialLiveCommandService;
  readonly recorded: RecordOwnedPublicSocialProfileCommand[];
  readonly revoked: RevokeOwnedPublicSocialProfileCommand[];
  readonly enqueued: EnqueueOwnedPublicSocialJobCommand[];
}

function commandServiceProbe(throws?: unknown): CommandServiceProbe {
  const recorded: RecordOwnedPublicSocialProfileCommand[] = [];
  const revoked: RevokeOwnedPublicSocialProfileCommand[] = [];
  const enqueued: EnqueueOwnedPublicSocialJobCommand[] = [];
  const service: OwnedPublicSocialLiveCommandService = {
    workspaceId: WORKSPACE_ID,
    providerConnectionId: PROVIDER_CONNECTION_ID,
    recordProfile: async (_context, command) => {
      recorded.push(command);
      if (throws !== undefined) throw throws;
      return { profileId: command.profileId, providerEffects: 'none' };
    },
    revokeProfile: async (_context, command) => {
      revoked.push(command);
      if (throws !== undefined) throw throws;
      return { revocationId: REVOCATION_ID, providerEffects: 'none' };
    },
    enqueue: async (_context, command) => {
      enqueued.push(command);
      if (throws !== undefined) throw throws;
      return { jobId: JOB_ID, providerEffects: 'none', caps: { daily: 1, monthly: 3 } };
    },
  };
  return { service, recorded, revoked, enqueued };
}

function serviceUnder(options: Readonly<{
  commands: CommandServiceProbe;
  encryption?: boolean;
  readiness?: OwnedSocialActivationReadinessReport['result'];
  readinessCalls?: unknown[];
}>): PgPortalOwnedSocialBindingService {
  const readinessCalls = options.readinessCalls ?? [];
  return new PgPortalOwnedSocialBindingService({
    principalResolver: { resolve: async () => ({ userId: USER_ID, workspaceId: WORKSPACE_ID }) },
    commandService: options.commands.service,
    readinessProbe: {
      readiness: async (_context, target) => {
        readinessCalls.push(target);
        return readinessReport(options.readiness ?? 'ready-for-separately-authorised-owned-test');
      },
    },
    providerConnectionId: PROVIDER_CONNECTION_ID,
    ...(options.encryption === false
      ? {}
      : { profileEncryption: { key: Buffer.alloc(32, 9), keyVersion: 'owned-social-v1' } }),
  });
}

const IDENTITY = { sessionToken: SESSION, requestId: REQUEST_ID };

function recordInput(overrides: Record<string, unknown> = {}) {
  return {
    profileId: PROFILE_ID,
    displayName: 'Property Predator on X',
    providerProfileReference: PROFILE_REFERENCE,
    ownedAccountReference: OWNED_ACCOUNT,
    profileKey: PROFILE_KEY,
    ownershipAttested: true,
    oauthPermissions: 'read_write',
    oauthLinkEvidence: OAUTH_EVIDENCE,
    linkedAt: LINKED_AT,
    evidenceObservedAt: EVIDENCE_OBSERVED_AT,
    ...overrides,
  } as never;
}

function stageInput(overrides: Record<string, unknown> = {}) {
  return {
    profileId: PROFILE_ID,
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
    approvalRequestId: APPROVAL_REQUEST_ID,
    approvalDecisionId: APPROVAL_DECISION_ID,
    sourceAttestationId: SOURCE_ATTESTATION_ID,
    operationTag: OPERATION_TAG,
    ownedAccountReference: OWNED_ACCOUNT,
    ...overrides,
  } as never;
}

test('a seam with no profile-key encryption refuses to bind and never commands', async () => {
  const commands = commandServiceProbe();
  const service = serviceUnder({ commands, encryption: false });
  assert.equal(service.profileBindingComposed, false);
  const outcome = await service.recordProfile(IDENTITY, recordInput());
  assert.deepEqual(outcome, { ok: false, kind: 'unavailable' });
  assert.deepEqual(commands.recorded, []);
});

test('binding validation refuses malformed evidence before any command is issued', async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['non-uuid profile id', { profileId: 'not-a-uuid' }],
    ['empty display name', { displayName: '   ' }],
    ['oversized display name', { displayName: 'x'.repeat(121) }],
    ['ownership not attested', { ownershipAttested: false }],
    ['ownership attested with a truthy non-boolean', { ownershipAttested: 'true' }],
    ['narrower oauth permissions', { oauthPermissions: 'read' }],
    ['too short profile key', { profileKey: 'short7' }],
    ['non-canonical linkedAt', { linkedAt: '2026-08-27T11:00:00Z' }],
    ['non-canonical evidenceObservedAt', { evidenceObservedAt: '2026-08-27T11:02:00+00:00' }],
    ['linked more than five minutes after the evidence', {
      linkedAt: '2026-08-27T11:10:00.000Z',
      evidenceObservedAt: '2026-08-27T11:00:00.000Z',
    }],
  ];
  for (const [label, overrides] of cases) {
    const commands = commandServiceProbe();
    const service = serviceUnder({ commands });
    const outcome = await service.recordProfile(IDENTITY, recordInput(overrides));
    assert.deepEqual(outcome, { ok: false, kind: 'validation' }, label);
    assert.deepEqual(commands.recorded, [], `${label} must not command`);
  }
});

test('a bound profile travels as ciphertext and digests, never as the clear key', async () => {
  const commands = commandServiceProbe();
  const service = serviceUnder({ commands });
  const outcome = await service.recordProfile(IDENTITY, recordInput());
  assert.deepEqual(outcome, { ok: true, profileId: PROFILE_ID, providerEffects: 'none' });

  assert.equal(commands.recorded.length, 1);
  const command = commands.recorded[0]!;
  assert.equal(command.envelope.algorithm, 'aes-256-gcm-v1');
  assert.equal(command.envelope.keyVersion, 'owned-social-v1');
  assert.equal(command.profileId, PROFILE_ID);
  assert.equal(command.displayName, 'Property Predator on X');
  assert.equal(command.linkedAt, LINKED_AT);
  assert.equal(command.evidenceObservedAt, EVIDENCE_OBSERVED_AT);

  const sha = (value: string): string =>
    createHash('sha256').update(value.trim(), 'utf8').digest('hex');
  for (const digest of [
    command.providerProfileRefSha256,
    command.ownedAccountRefSha256,
    command.xOAuthLinkEvidenceSha256,
  ]) {
    assert.match(digest, SHA256_HEX);
  }
  assert.equal(command.providerProfileRefSha256, sha(PROFILE_REFERENCE));
  assert.equal(command.ownedAccountRefSha256, sha(OWNED_ACCOUNT));
  assert.equal(command.xOAuthLinkEvidenceSha256, sha(OAUTH_EVIDENCE));

  // Nothing the command boundary receives contains the clear key or account.
  const serialised = JSON.stringify(command);
  assert.equal(serialised.includes(PROFILE_KEY), false);
  assert.equal(serialised.includes(OWNED_ACCOUNT), false);

  // Nor does anything the caller gets back.
  const returned = JSON.stringify(outcome);
  assert.equal(returned.includes(PROFILE_KEY), false);
  assert.equal(returned.includes(OWNED_ACCOUNT), false);
});

test('a blocked readiness verdict stops staging before the enqueue is attempted', async () => {
  const commands = commandServiceProbe();
  const service = serviceUnder({ commands, readiness: 'blocked' });
  const outcome = await service.stagePublication(IDENTITY, stageInput());
  // 'blocked' is deliberately distinct from 'forbidden': the founder had the
  // authority to ask, the database simply did not prove the evidence.
  assert.deepEqual(outcome, { ok: false, kind: 'blocked' });
  assert.deepEqual(commands.enqueued, []);
});

test('a ready verdict enqueues one job with self-derived, distinct scope digests', async () => {
  const commands = commandServiceProbe();
  const readinessCalls: unknown[] = [];
  const service = serviceUnder({ commands, readinessCalls });
  const outcome = await service.stagePublication(IDENTITY, stageInput());

  assert.equal(readinessCalls.length, 1);
  assert.equal(commands.enqueued.length, 1);
  const command = commands.enqueued[0]!;
  assert.match(command.idempotencyKeySha256, SHA256_HEX);
  assert.match(command.requestSha256, SHA256_HEX);
  assert.notEqual(command.idempotencyKeySha256, command.requestSha256);
  assert.equal(command.scheduledFor, null);
  assert.equal(command.operationTag, OPERATION_TAG);

  // The digests are derived, never accepted from the caller.
  const expected = deriveOwnedSocialStagingDigests({
    workspaceId: WORKSPACE_ID,
    providerConnectionId: PROVIDER_CONNECTION_ID,
    profileId: PROFILE_ID,
    contentItemId: CONTENT_ITEM_ID,
    contentVersionId: CONTENT_VERSION_ID,
    approvalRequestId: APPROVAL_REQUEST_ID,
    approvalDecisionId: APPROVAL_DECISION_ID,
    sourceAttestationId: SOURCE_ATTESTATION_ID,
    expectedOwnedAccountSha256: createHash('sha256').update(OWNED_ACCOUNT, 'utf8').digest('hex'),
    scheduledFor: null,
  }, OPERATION_TAG);
  assert.equal(command.idempotencyKeySha256, expected.idempotencyKeySha256);
  assert.equal(command.requestSha256, expected.requestSha256);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome, {
    ok: true,
    jobId: JOB_ID,
    providerEffects: 'none',
    workerLeaseClaimed: false,
    idempotencyKeySha256: expected.idempotencyKeySha256,
    caps: { daily: 1, monthly: 3 },
  });
});

test('postgres failures map onto one honest kind each and never leak the error', async () => {
  const cases: ReadonlyArray<readonly [unknown, PortalOwnedSocialFailureKind]> = [
    [{ code: '42501' }, 'forbidden'],
    [{ code: '40001' }, 'conflict'],
    [{ code: '22023' }, 'validation'],
    [new Error('socket hang up'), 'unavailable'],
    [{ code: 'ECONNREFUSED' }, 'unavailable'],
  ];
  for (const [thrown, kind] of cases) {
    const commands = commandServiceProbe(thrown);
    const service = serviceUnder({ commands });
    assert.deepEqual(
      await service.revokeProfile(IDENTITY, {
        profileId: PROFILE_ID,
        reasonCode: 'founder_rotation',
        revocationEvidence: 'revocation-evidence-001',
      }),
      { ok: false, kind },
      String(kind),
    );
    assert.deepEqual(
      await service.recordProfile(IDENTITY, recordInput()),
      { ok: false, kind },
      `recordProfile ${kind}`,
    );
  }
});
