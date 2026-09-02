import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgPortalDailyOutreachService } from '../src/portal/daily-outreach-pg-service.js';

const WORKSPACE_ID = '72000000-0000-4000-8000-000000000001';
const USER_ID = '72000000-0000-4000-8000-000000000002';
const ATTEMPT_ID = '72000000-0000-4000-8000-000000000003';
const OUTCOME_ID = '72000000-0000-4000-8000-000000000004';
const CONTROL_ID = '72000000-0000-4000-8000-000000000005';
const PROJECTION_ID = '72000000-0000-4000-8000-000000000006';
const ALLOCATION_ID = '72000000-0000-4000-8000-000000000007';
const NOW = Date.parse('2026-09-02T08:15:00.000Z');
const SERVICE_SOURCE = readFileSync(
  new URL('../src/portal/daily-outreach-pg-service.ts', import.meta.url),
  'utf8',
);

function result(rows: readonly unknown[] = []): QueryResult {
  return { command: '', rowCount: rows.length, oid: 0, fields: [], rows: [...rows] };
}

function replayPool(queryLog: string[]): Pick<Pool, 'connect'> {
  const client = {
    async query(sql: string, parameters?: readonly unknown[]) {
      queryLog.push(sql);
      if (sql.includes('active_portal_session')) return result([{ active: true }]);
      if (sql.includes('resolve_daily_outreach_command_replay')) {
        const commandKind = parameters?.[1];
        return result([{
          commandKind,
          allocationId: ALLOCATION_ID,
          previousOutcomeEventId: commandKind === 'outcome' ? OUTCOME_ID : null,
          outcome: commandKind === 'outcome' ? 'replied' : 'attempted',
          disposition: 'replayed',
          attemptReceiptId: ATTEMPT_ID,
          outcomeEventId: OUTCOME_ID,
          controlEventId: CONTROL_ID,
          projectionReceiptId: PROJECTION_ID,
          taskId: null,
          lapsDisposition: 'cold_attempt_not_eligible',
        }]);
      }
      return result();
    },
    release() {},
  } as unknown as PoolClient;
  return { connect: async () => client };
}

function service(queryLog: string[], readConnections: { count: number }) {
  return new PgPortalDailyOutreachService({
    principalResolver: {
      resolve: async () => ({ workspaceId: WORKSPACE_ID, userId: USER_ID }),
    },
    readPool: {
      connect: async () => {
        readConnections.count += 1;
        throw new Error('a replay must not read or claim today\'s queue');
      },
    },
    commandPool: replayPool(queryLog),
    now: () => NOW,
  });
}

test('manual-attempt retries resolve before reading or claiming another allocation', async () => {
  const queryLog: string[] = [];
  const readConnections = { count: 0 };
  const outcome = await service(queryLog, readConnections).recordManualAttempt({
    sessionToken: 'opaque-session',
    requestId: 'daily-outreach-replay-manual',
  }, {
    allocationId: ALLOCATION_ID,
    attemptedAt: '2026-09-02T08:15:00.000Z',
    commandKey: 'manual-command-key',
  });
  assert.deepEqual(outcome, {
    ok: true,
    disposition: 'replayed',
    outcomeEventId: OUTCOME_ID,
    taskId: null,
    lapsDisposition: 'cold_attempt_not_eligible',
  });
  assert.equal(readConnections.count, 0);
  assert.ok(queryLog.some((sql) => sql.includes('resolve_daily_outreach_command_replay')));
  assert.ok(queryLog.some((sql) => (
    sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'
  )));
  assert.ok(queryLog.every((sql) => !sql.includes('REPEATABLE READ')));
  assert.ok(queryLog.every((sql) => !sql.includes('claim_next_manual_daily_outreach')));
});

test('a reused manual command key cannot silently target another allocation', async () => {
  const queryLog: string[] = [];
  const readConnections = { count: 0 };
  const outcome = await service(queryLog, readConnections).recordManualAttempt({
    sessionToken: 'opaque-session',
    requestId: 'daily-outreach-replay-manual-conflict',
  }, {
    allocationId: '72000000-0000-4000-8000-000000000008',
    attemptedAt: '2026-09-02T08:15:00.000Z',
    commandKey: 'manual-command-key',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'conflict',
    message: 'That command key has already been used for another outreach action.',
  });
  assert.equal(readConnections.count, 0);
});

test('a committed command remains replayable after its browser timestamp becomes stale', async () => {
  const queryLog: string[] = [];
  const readConnections = { count: 0 };
  const outcome = await service(queryLog, readConnections).recordManualAttempt({
    sessionToken: 'opaque-session',
    requestId: 'daily-outreach-replay-manual-late',
  }, {
    allocationId: ALLOCATION_ID,
    attemptedAt: '2026-09-01T08:15:00.000Z',
    commandKey: 'manual-command-key',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.disposition, 'replayed');
  assert.equal(readConnections.count, 0);
});

test('outcome retries resolve before requiring the prior-day attempt in today\'s queue', async () => {
  const queryLog: string[] = [];
  const readConnections = { count: 0 };
  const outcome = await service(queryLog, readConnections).recordOutcome({
    sessionToken: 'opaque-session',
    requestId: 'daily-outreach-replay-outcome',
  }, {
    attemptReceiptId: ATTEMPT_ID,
    previousOutcomeEventId: OUTCOME_ID,
    outcome: 'replied',
    occurredAt: '2026-09-02T08:15:00.000Z',
    commandKey: 'outcome-command-key',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.disposition, 'replayed');
  assert.equal(readConnections.count, 0);
  assert.ok(queryLog.some((sql) => sql.includes('resolve_daily_outreach_command_replay')));
});

test('a reused outcome command key cannot silently change the recorded transition', async () => {
  const queryLog: string[] = [];
  const readConnections = { count: 0 };
  const outcome = await service(queryLog, readConnections).recordOutcome({
    sessionToken: 'opaque-session',
    requestId: 'daily-outreach-replay-outcome-conflict',
  }, {
    attemptReceiptId: ATTEMPT_ID,
    previousOutcomeEventId: OUTCOME_ID,
    outcome: 'positive',
    occurredAt: '2026-09-02T08:15:00.000Z',
    commandKey: 'outcome-command-key',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'conflict',
    message: 'That command key has already been used for another outreach action.',
  });
  assert.equal(readConnections.count, 0);
});

test('the initial attempted state cannot be injected through the outcome command surface', async () => {
  const queryLog: string[] = [];
  const readConnections = { count: 0 };
  const outcome = await service(queryLog, readConnections).recordOutcome({
    sessionToken: 'opaque-session',
    requestId: 'daily-outreach-invalid-outcome',
  }, {
    attemptReceiptId: ATTEMPT_ID,
    previousOutcomeEventId: OUTCOME_ID,
    outcome: 'attempted' as never,
    occurredAt: '2026-09-02T08:15:00.000Z',
    commandKey: 'outcome-command-key',
  });
  assert.deepEqual(outcome, {
    ok: false,
    kind: 'validation',
    message: 'The selected outcome action is invalid.',
  });
  assert.equal(readConnections.count, 0);
  assert.equal(queryLog.length, 0);
});

test('first-time manual evidence takes its authoritative timestamp only after the lease claim', () => {
  const claim = SERVICE_SOURCE.indexOf('portal.daily-outreach.claim-manual');
  const clock = SERVICE_SOURCE.indexOf('portal.daily-outreach.authoritative-attempt-clock');
  const record = SERVICE_SOURCE.indexOf('portal.daily-outreach.record-manual');
  assert.ok(claim >= 0 && clock > claim && record > clock);
});

test('outcome task timing is derived only after the immutable outcome is saved', () => {
  const record = SERVICE_SOURCE.indexOf('portal.daily-outreach.record-outcome');
  const clock = SERVICE_SOURCE.indexOf('portal.daily-outreach.authoritative-projection-clock');
  const project = SERVICE_SOURCE.indexOf('portal.daily-outreach.project-outcome');
  assert.ok(record >= 0 && clock > record && project > clock);
});
