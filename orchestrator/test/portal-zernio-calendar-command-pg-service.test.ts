import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PgPortalZernioCalendarCommandService,
  type PgPortalZernioCalendarCommandDependencies,
} from '../src/portal/zernio-calendar-command-pg-service.js';
import type { PortalZernioCalendarCommandInput } from '../src/portal/zernio-calendar-command-service.js';

const WORKSPACE_ID = '11000000-0000-4000-8000-000000000001';
const USER_ID = '12000000-0000-4000-8000-000000000002';
const CONNECTION_ID = '13000000-0000-4000-8000-000000000003';
const INTENT_ID = '14000000-0000-4000-8000-000000000004';
const TARGET_ID = '15000000-0000-4000-8000-000000000005';
const CONTENT_ID = '16000000-0000-4000-8000-000000000006';
const VERSION_ID = '17000000-0000-4000-8000-000000000007';
const REQUEST_ID = '18000000-0000-4000-8000-000000000008';
const DECISION_ID = '19000000-0000-4000-8000-000000000009';
const ATTESTATION_ID = '1a000000-0000-4000-8000-00000000000a';
const JOB_ID = '1b000000-0000-4000-8000-00000000000b';
const INSTAGRAM_TARGET_ID = '1c000000-0000-4000-8000-00000000000c';
const LINKEDIN_TARGET_ID = '1d000000-0000-4000-8000-00000000000d';
const TEST_CONNECTION_ID = '1e000000-0000-4000-8000-00000000000e';
const SESSION_TOKEN = 'portal-session-token';
const PROVIDER_PROFILE_ID = 'propertypredator-profile';
const INSTAGRAM_ACCOUNT_ID = 'propertypredator-instagram';
const LINKEDIN_ACCOUNT_ID = 'propertypredator-linkedin';
const IDEMPOTENCY = 'a'.repeat(64);

interface Call {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakeClient {
  readonly calls: Call[] = [];
  functionError: unknown = null;
  functionRows: unknown[] = [{
    job_id: JOB_ID,
    idempotency_key_sha256: IDEMPOTENCY,
    daily_publish_cap: 1,
    monthly_publish_cap: 3,
  }];
  scheduledRows: unknown[] = [];
  bootstrapRows = new Map<string, unknown[]>([
    ['instagram', [{ test_provider_connection_id: TEST_CONNECTION_ID,
      test_target_id: INSTAGRAM_TARGET_ID, test_account_ref_sha256: 'b'.repeat(64),
      disposition: 'applied' }]],
    ['linkedin', [{ test_provider_connection_id: TEST_CONNECTION_ID,
      test_target_id: LINKEDIN_TARGET_ID, test_account_ref_sha256: 'c'.repeat(64),
      disposition: 'replayed' }]],
  ]);

  async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, values });
    if (sql.includes('active_portal_session')) return { rows: [{ active: true }] };
    if (sql.includes('enqueue_zernio_calendar_from_connected_account')) {
      if (this.functionError) throw this.functionError;
      return { rows: this.functionRows };
    }
    if (sql.includes('bootstrap_zernio_calendar_planner_target')) {
      if (this.functionError) throw this.functionError;
      return { rows: this.bootstrapRows.get(String(values[2])) ?? [] };
    }
    if (sql.includes('list_zernio_calendar_jobs')) {
      if (this.functionError) throw this.functionError;
      return { rows: this.scheduledRows };
    }
    return { rows: [] };
  }

  release(): void { /* pooled client */ }
}

function dependencies(
  client: FakeClient,
  overrides: Partial<PgPortalZernioCalendarCommandDependencies> = {},
): PgPortalZernioCalendarCommandDependencies {
  return {
    principalResolver: {
      async resolve() {
        return { workspaceId: WORKSPACE_ID, userId: USER_ID } as never;
      },
    },
    commandPool: { async connect() { return client as never; } },
    workspaceId: WORKSPACE_ID,
    providerConnectionId: CONNECTION_ID,
    providerProfileId: PROVIDER_PROFILE_ID,
    accounts: [
      { network: 'instagram', providerAccountId: INSTAGRAM_ACCOUNT_ID },
      { network: 'linkedin', providerAccountId: LINKEDIN_ACCOUNT_ID },
    ],
    ...overrides,
  };
}

function input(
  overrides: Partial<PortalZernioCalendarCommandInput> = {},
): PortalZernioCalendarCommandInput {
  return {
    network: 'instagram',
    planningIntentId: INTENT_ID,
    planningTargetId: TARGET_ID,
    contentItemId: CONTENT_ID,
    contentVersionId: VERSION_ID,
    approvalRequestId: REQUEST_ID,
    approvalDecisionId: DECISION_ID,
    sourceAttestationId: ATTESTATION_ID,
    operationTag: 'calendar.approved',
    scheduledFor: '2026-09-03T09:00:00.000Z',
    ...overrides,
  };
}

const identity = { sessionToken: SESSION_TOKEN, requestId: 'calendar-request-1' } as never;

function commandCall(client: FakeClient): Call {
  const call = client.calls.find((entry) =>
    entry.sql.includes('enqueue_zernio_calendar_from_connected_account'));
  assert.ok(call, 'calendar command must reach the exact database function');
  return call;
}

test('the service hashes configured provider references and runs one serializable stage command', async () => {
  const client = new FakeClient();
  const service = new PgPortalZernioCalendarCommandService(dependencies(client));
  const outcome = await service.stage(identity, input());

  assert.deepEqual(outcome, {
    ok: true,
    jobId: JOB_ID,
    idempotencyKeySha256: IDEMPOTENCY,
    caps: { daily: 1, monthly: 3 },
    providerEffects: 'none',
    workerLeaseClaimed: false,
  });
  assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
  const call = commandCall(client);
  assert.equal(call.values[0], WORKSPACE_ID);
  assert.equal(call.values[1], CONNECTION_ID);
  assert.equal(call.values[2], 'instagram');
  assert.deepEqual(call.values[3], createHash('sha256').update(PROVIDER_PROFILE_ID).digest());
  assert.deepEqual(call.values[4], createHash('sha256').update(INSTAGRAM_ACCOUNT_ID).digest());
  assert.deepEqual(call.values.slice(5), [
    INTENT_ID, TARGET_ID, CONTENT_ID, VERSION_ID, REQUEST_ID, DECISION_ID,
    ATTESTATION_ID, 'calendar.approved', '2026-09-03T09:00:00.000Z',
  ]);
  const renderedCalls = JSON.stringify(client.calls);
  assert.equal(renderedCalls.includes(PROVIDER_PROFILE_ID), false);
  assert.equal(renderedCalls.includes(INSTAGRAM_ACCOUNT_ID), false);
  assert.equal(renderedCalls.includes(LINKEDIN_ACCOUNT_ID), false);
});

test('calendar reads normalise and sanitize worker-backed Instagram and LinkedIn job state', async () => {
  const client = new FakeClient();
  client.scheduledRows = [
    {
      job_id: JOB_ID, network: 'instagram', content_body: 'Garden Goldmine.',
      scheduled_for: '2026-09-04 17:35:00+00', state: 'queued',
      provider_external_id: null, safe_code: null, created_at: '2026-09-03 08:00:00+00',
    },
    {
      job_id: LINKEDIN_TARGET_ID, network: 'linkedin', content_body: 'Find small plots.',
      scheduled_for: new Date('2026-09-05T08:17:00.000Z'), state: 'succeeded',
      provider_external_id: 'zernio-post-1', safe_code: 'published',
      created_at: new Date('2026-09-03T08:01:00.000Z'),
    },
  ];
  const service = new PgPortalZernioCalendarCommandService(dependencies(client));

  assert.deepEqual(await service.listScheduled(identity, {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
  }), {
    ok: true,
    items: [
      { jobId: JOB_ID, network: 'instagram', content: 'Garden Goldmine.',
        scheduledFor: '2026-09-04T17:35:00.000Z', state: 'queued',
        providerPostId: null, safeCode: null, createdAt: '2026-09-03T08:00:00.000Z' },
      { jobId: LINKEDIN_TARGET_ID, network: 'linkedin', content: 'Find small plots.',
        scheduledFor: '2026-09-05T08:17:00.000Z', state: 'succeeded',
        providerPostId: 'zernio-post-1', safeCode: 'published',
        createdAt: '2026-09-03T08:01:00.000Z' },
    ],
  });
  const call = client.calls.find((entry) => entry.sql.includes('list_zernio_calendar_jobs'));
  assert.equal(client.calls[0]?.sql, 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
  assert.deepEqual(call?.values, [WORKSPACE_ID,
    '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
  assert.match(call?.sql ?? '', /list_zernio_calendar_jobs\(\$1::uuid,\$2::timestamptz,\$3::timestamptz,100\)/u);
});

test('planner bootstrap creates deterministic TEST targets only and never receives clear provider ids', async () => {
  const client = new FakeClient();
  const service = new PgPortalZernioCalendarCommandService(dependencies(client));

  assert.deepEqual(await service.bootstrapPlannerTargets(identity), {
    ok: true,
    targets: [
      { network: 'instagram', targetId: INSTAGRAM_TARGET_ID, disposition: 'applied' },
      { network: 'linkedin', targetId: LINKEDIN_TARGET_ID, disposition: 'replayed' },
    ],
    providerEffects: 'none',
  });
  const calls = client.calls.filter((entry) =>
    entry.sql.includes('bootstrap_zernio_calendar_planner_target'));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.values.slice(0, 3)), [
    [WORKSPACE_ID, CONNECTION_ID, 'instagram'],
    [WORKSPACE_ID, CONNECTION_ID, 'linkedin'],
  ]);
  assert.deepEqual(calls[0]?.values[3], createHash('sha256').update(PROVIDER_PROFILE_ID).digest());
  assert.deepEqual(calls[0]?.values[4], createHash('sha256').update(INSTAGRAM_ACCOUNT_ID).digest());
  assert.equal(JSON.stringify(client.calls).includes(PROVIDER_PROFILE_ID), false);
  assert.equal(JSON.stringify(client.calls).includes(INSTAGRAM_ACCOUNT_ID), false);
});

test('the portal service exposes no direct provider scheduling or media-upload methods', () => {
  const service = new PgPortalZernioCalendarCommandService(dependencies(new FakeClient()));
  const unsafe = service as unknown as Record<string, unknown>;
  assert.equal(unsafe.scheduleDirect, undefined);
  assert.equal(unsafe.prepareMediaUpload, undefined);
  assert.equal(unsafe.listDirect, undefined);
});

test('the request cannot choose provider profile or account identifiers', async () => {
  const requestKeys = Object.keys(input()).sort();
  assert.deepEqual(requestKeys, [
    'approvalDecisionId', 'approvalRequestId', 'contentItemId', 'contentVersionId',
    'network', 'operationTag', 'planningIntentId', 'planningTargetId',
    'scheduledFor', 'sourceAttestationId',
  ]);
  const client = new FakeClient();
  const service = new PgPortalZernioCalendarCommandService(dependencies(client));
  const injected = {
    ...input(), providerProfileId: 'manual-profile', providerAccountId: 'manual-account',
  } as PortalZernioCalendarCommandInput;
  assert.deepEqual(await service.stage(identity, injected), { ok: false, kind: 'validation' });
  assert.deepEqual(client.calls, []);
});

test('each network uses only its deployment-configured account digest', async () => {
  const client = new FakeClient();
  const service = new PgPortalZernioCalendarCommandService(dependencies(client));
  await service.stage(identity, input({ network: 'linkedin' }));
  assert.deepEqual(commandCall(client).values[4],
    createHash('sha256').update(LINKEDIN_ACCOUNT_ID).digest());
});

test('malformed or unconfigured calendar evidence never opens a transaction', async () => {
  const invalid: Partial<PortalZernioCalendarCommandInput>[] = [
    { planningIntentId: 'not-a-uuid' },
    { operationTag: 'spaces are refused' },
    { scheduledFor: '2026-09-03T10:00:00+01:00' },
    { network: 'linkedin' },
  ];
  for (const value of invalid) {
    const client = new FakeClient();
    const service = new PgPortalZernioCalendarCommandService(dependencies(
      client,
      value.network === 'linkedin' ? {
        accounts: [{ network: 'instagram', providerAccountId: INSTAGRAM_ACCOUNT_ID }],
      } : {},
    ));
    assert.deepEqual(await service.stage(identity, input(value)), { ok: false, kind: 'validation' });
    assert.deepEqual(client.calls, []);
  }
});

test('an unresolved or cross-workspace portal session cannot stage, list or bootstrap', async () => {
  for (const principal of [null, {
    workspaceId: '99000000-0000-4000-8000-000000000099', userId: USER_ID,
  }]) {
    const client = new FakeClient();
    const service = new PgPortalZernioCalendarCommandService(dependencies(client, {
      principalResolver: { async resolve() { return principal as never; } },
    }));
    assert.deepEqual(await service.stage(identity, input()), { ok: false, kind: 'unauthenticated' });
    assert.deepEqual(await service.listScheduled(identity, {
      from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
    }), { ok: false, kind: 'unauthenticated' });
    assert.deepEqual(await service.bootstrapPlannerTargets(identity), {
      ok: false, kind: 'unauthenticated',
    });
    assert.deepEqual(client.calls, []);
  }
});

test('database failures map without leaking details', async () => {
  for (const [code, kind] of [
    ['42501', 'forbidden'], ['40001', 'conflict'], ['23505', 'conflict'],
    ['22023', 'validation'], ['23514', 'validation'], ['23503', 'validation'],
    ['08006', 'unavailable'],
  ] as const) {
    const client = new FakeClient();
    client.functionError = Object.assign(new Error('sensitive database detail'), { code });
    const service = new PgPortalZernioCalendarCommandService(dependencies(client));
    assert.deepEqual(await service.stage(identity, input()), { ok: false, kind });
  }
});

test('invalid database output fails closed', async () => {
  for (const row of [
    null,
    { job_id: 'bad', idempotency_key_sha256: IDEMPOTENCY,
      daily_publish_cap: 1, monthly_publish_cap: 3 },
    { job_id: JOB_ID, idempotency_key_sha256: 'bad',
      daily_publish_cap: 1, monthly_publish_cap: 3 },
    { job_id: JOB_ID, idempotency_key_sha256: IDEMPOTENCY,
      daily_publish_cap: 2, monthly_publish_cap: 3 },
  ]) {
    const client = new FakeClient();
    client.functionRows = row === null ? [] : [row];
    const service = new PgPortalZernioCalendarCommandService(dependencies(client));
    assert.deepEqual(await service.stage(identity, input()), { ok: false, kind: 'unavailable' });
    assert.equal(client.calls.some((call) => call.sql === 'ROLLBACK'), true);
    assert.equal(client.calls.some((call) => call.sql === 'COMMIT'), false);
  }
});

test('invalid worker projection rows fail closed without leaking raw state', async () => {
  const client = new FakeClient();
  client.scheduledRows = [{
    job_id: JOB_ID, network: 'facebook', content_body: 'forged',
    scheduled_for: '2026-09-04T17:35:00.000Z', state: 'queued',
    provider_external_id: null, safe_code: null, created_at: '2026-09-03T08:00:00.000Z',
  }];
  const service = new PgPortalZernioCalendarCommandService(dependencies(client));
  assert.deepEqual(await service.listScheduled(identity, {
    from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
  }), { ok: false, kind: 'unavailable' });
});

test('configuration rejects duplicate or unsupported account bindings', () => {
  const client = new FakeClient();
  assert.throws(() => new PgPortalZernioCalendarCommandService(dependencies(client, {
    accounts: [
      { network: 'instagram', providerAccountId: INSTAGRAM_ACCOUNT_ID },
      { network: 'instagram', providerAccountId: 'another-instagram' },
    ],
  })), /account configuration/u);
  assert.throws(() => new PgPortalZernioCalendarCommandService(dependencies(client, {
    accounts: [],
  })), /command configuration/u);
});
