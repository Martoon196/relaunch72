import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  PgControlledEmailPilotBoundary,
  PropertyPredatorEmailPilotReservationConflictError,
  assertPropertyPredatorEmailPilotBoundaryReady,
} from '../src/property-predator-email-pilot-pg/index.js';
import type { ControlledEmailPilotBoundaryInput } from '../src/providers/controlled-property-predator-email-pilot.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CORRELATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RUN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '33333333-3333-4333-8333-333333333333';
const CONTACT_POINT_ID = '44444444-4444-4444-8444-444444444444';
const CONSENT_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_ID = '66666666-6666-4666-8666-666666666666';
const IDEMPOTENCY_SHA = '1'.repeat(64);
const REQUEST_SHA = '2'.repeat(64);
const CONTENT_SHA = '3'.repeat(64);
const EMAIL_SHA = '4'.repeat(64);

type QueryCall = Readonly<{ sql: string; values: readonly unknown[] }>;

function pool(
  domain: (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>,
): { pool: Pick<Pool, 'connect' | 'query'>; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (/^(?:BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (sql.includes("set_config('app.user_id'")) return { rows: [{}] };
    return domain(sql, values);
  };
  const client = { query, release: () => undefined } as unknown as PoolClient;
  return {
    pool: { connect: async () => client, query } as unknown as Pick<Pool, 'connect' | 'query'>,
    calls,
  };
}

function input(): ControlledEmailPilotBoundaryInput {
  return Object.freeze({
    workspaceId: WORKSPACE_ID,
    providerConnectionId: CONNECTION_ID,
    operationId: OPERATION_ID,
    correlationId: CORRELATION_ID,
    idempotencyKeySha256: IDEMPOTENCY_SHA,
    requestSha256: REQUEST_SHA,
    runId: RUN_ID,
    utcMonth: '2026-08',
    stage: 'internal-seed',
    recipientScope: 'owned-internal-seeds-only',
    approval: Object.freeze({
      messageVersionId: VERSION_ID,
      approvalRequestId: REQUEST_ID,
      approvalDecisionId: DECISION_ID,
      approvedContentSha256: CONTENT_SHA,
    }),
    recipients: Object.freeze([Object.freeze({
      email: 'owned.seed@propertypredator.co.uk',
      emailSha256: EMAIL_SHA,
      contactPointId: CONTACT_POINT_ID,
      consentEventId: CONSENT_ID,
    })]),
    requestedMessages: 1,
    estimatedSpendUsdMicros: 1_500,
    limits: Object.freeze({
      maxMessagesPerRun: 10,
      maxMessagesPerUtcMonth: 100,
      maxSpendUsdMicrosPerRun: 15_000,
      maxSpendUsdMicrosPerUtcMonth: 150_000,
    }),
  });
}

function evidence() {
  return {
    workspaceId: WORKSPACE_ID,
    providerConnectionId: CONNECTION_ID,
    stage: 'internal-seed',
    recipientScope: 'owned-internal-seeds-only',
    providerEffectsEnabled: true,
    emailDeliveryEnabled: true,
    emergencyPaused: false,
    approval: {
      messageVersionId: VERSION_ID,
      approvalRequestId: REQUEST_ID,
      approvalDecisionId: DECISION_ID,
      approvedContentSha256: CONTENT_SHA,
      decision: 'approved', immutable: true,
    },
    recipients: [{
      contactPointId: CONTACT_POINT_ID,
      consentEventId: CONSENT_ID,
      emailSha256: EMAIL_SHA,
      consentState: 'granted', suppressed: false, ownedInternalSeed: true,
    }],
    usageAfterReservation: {
      runMessages: 1, runSpendUsdMicros: 1_500,
      monthMessages: 1, monthSpendUsdMicros: 1_500, utcMonth: '2026-08',
    },
  };
}

function boundary(mocked: ReturnType<typeof pool>): PgControlledEmailPilotBoundary {
  return new PgControlledEmailPilotBoundary({
    commandPool: mocked.pool,
    workspaceId: WORKSPACE_ID,
    runtimeEvidence: {
      providerEffectsEnabled: true,
      emailDeliveryEnabled: true,
      emergencyPaused: false,
    },
  });
}

test('authorization installs worker context and sends only bounded hashed recipient evidence', async () => {
  const mocked = pool(async () => ({ rows: [{
    disposition: 'authorized', reason: null, reservationId: RESERVATION_ID,
    requestSha256: Buffer.from(REQUEST_SHA, 'hex'), evidence: evidence(),
    providerResult: null,
  }] }));
  const result = await boundary(mocked).authorizeImmediatelyBeforeProviderCall(input());
  assert.equal(result.disposition, 'authorized');
  const context = mocked.calls.find((call) => call.sql.includes("set_config('app.user_id'"))!;
  assert.deepEqual(context.values.slice(0, 3), ['', WORKSPACE_ID, 'worker']);
  assert.match(String(context.values[3]), /^mailgun-pilot:[0-9a-f]{48}$/);
  const authorize = mocked.calls.find((call) => call.sql.includes('authorize_property_predator_email_pilot'))!;
  assert.equal(authorize.values[0], WORKSPACE_ID);
  assert.equal(authorize.values[1], CONNECTION_ID);
  assert.deepEqual(authorize.values[4], Buffer.from(IDEMPOTENCY_SHA, 'hex'));
  assert.deepEqual(JSON.parse(String(authorize.values[14])), [{
    contact_point_id: CONTACT_POINT_ID,
    consent_event_id: CONSENT_ID,
    email_sha256: EMAIL_SHA,
  }]);
  assert.equal(authorize.values.includes('owned.seed@propertypredator.co.uk'), false);
  assert.deepEqual(authorize.values.slice(21), [true, true, false]);
});

test('blocked and settled replay decisions are canonical and never re-authorized in memory', async () => {
  for (const row of [
    {
      disposition: 'blocked', reason: 'database_effects_disabled',
      reservationId: null, requestSha256: null, evidence: null, providerResult: null,
    },
    {
      disposition: 'replay', reason: null, reservationId: RESERVATION_ID,
      requestSha256: Buffer.from(REQUEST_SHA, 'hex'), evidence: null,
      providerResult: {
        status: 'needs_attention', externalId: null,
        occurredAt: '2026-08-26T12:00:00.000Z', retryable: false,
        errorCode: 'mailgun_outcome_unknown', summary: 'Manual reconciliation required',
      },
    },
  ]) {
    const mocked = pool(async () => ({ rows: [row] }));
    const result = await boundary(mocked).authorizeImmediatelyBeforeProviderCall(input());
    assert.equal(result.disposition, row.disposition);
  }
});

test('cancel and settlement use the same trusted workspace and preserve ambiguous outcomes', async () => {
  const mocked = pool(async (sql) => ({ rows: [{
    [sql.includes('cancel_property') ? 'cancelled' : 'settled']: true,
  }] }));
  const repository = boundary(mocked);
  await repository.cancelBeforeProviderCall(RESERVATION_ID, REQUEST_SHA, 'request_aborted');
  await repository.settleProviderCall(RESERVATION_ID, REQUEST_SHA, {
    status: 'needs_attention', externalId: null,
    occurredAt: '2026-08-26T12:00:00.000Z', retryable: false,
    errorCode: 'mailgun_outcome_unknown',
    summary: 'Mailgun outcome requires manual reconciliation',
  });
  const cancel = mocked.calls.find((call) => call.sql.includes('cancel_property'))!;
  const settle = mocked.calls.find((call) => call.sql.includes('settle_property'))!;
  assert.equal(cancel.values[0], WORKSPACE_ID);
  assert.equal(settle.values[0], WORKSPACE_ID);
  assert.equal(settle.values[3], 'needs_attention');
  assert.equal(settle.values[6], false);
});

test('serialization conflicts are translated without leaking database detail', async () => {
  const mocked = pool(async () => {
    throw Object.assign(new Error('sensitive database text'), { code: '40001' });
  });
  await assert.rejects(
    () => boundary(mocked).authorizeImmediatelyBeforeProviderCall(input()),
    PropertyPredatorEmailPilotReservationConflictError,
  );
  await assert.rejects(
    () => boundary(mocked).settleProviderCall(RESERVATION_ID, REQUEST_SHA, {
      status: 'needs_attention', externalId: null,
      occurredAt: '2026-08-26T12:00:00.000Z', retryable: false,
      errorCode: 'mailgun_outcome_unknown', summary: 'Manual reconciliation required',
    }),
    PropertyPredatorEmailPilotReservationConflictError,
  );
});

test('readiness calls only the dedicated function and fails closed', async () => {
  const ready = pool(async () => ({ rows: [{ ready: true }] }));
  await assert.doesNotReject(assertPropertyPredatorEmailPilotBoundaryReady(ready.pool));
  assert.match(ready.calls[0]!.sql, /property_predator_email_pilot_boundary_ready/);
  const unavailable = pool(async () => ({ rows: [{ ready: false }] }));
  await assert.rejects(
    assertPropertyPredatorEmailPilotBoundaryReady(unavailable.pool),
    /boundary is not ready/,
  );
});
