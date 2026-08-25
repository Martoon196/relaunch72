import assert from 'node:assert/strict';
import test from 'node:test';
import type { CrmTransactionRunner, SqlExecutor } from '../src/crm-pg/index.js';
import {
  Lead360ReadDataError,
  Lead360ReadService,
} from '../src/conversion-pg/index.js';
import {
  requestDatabaseContext,
  workerDatabaseContext,
  type DatabaseRequestContext,
} from '../src/db/rls.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const ENROLLMENT_ID = '44444444-4444-4444-8444-444444444444';
const JOURNEY_ID = '55555555-5555-4555-8555-555555555555';
const VERSION_ID = '66666666-6666-4666-8666-666666666666';
const LEAD_STAGE_ID = '77777777-7777-4777-8777-777777777777';
const CURRENT_STAGE_ID = '88888888-8888-4888-8888-888888888888';
const SCORE_ID = '99999999-9999-4999-8999-999999999999';
const CONTENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPOINTMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OFFER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RESPONSE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const POINT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONSENT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SUPPRESSION_ID = '12121212-1212-4212-8212-121212121212';
const OPPORTUNITY_ID = '13131313-1313-4313-8313-131313131313';
const PIPELINE_ID = '14141414-1414-4414-8414-141414141414';
const CRM_STAGE_ID = '15151515-1515-4515-8515-151515151515';
const TASK_ID = '16161616-1616-4616-8616-161616161616';

type Row = Record<string, unknown>;

function scoped(row: Row): Row {
  return { workspace_id: WORKSPACE_ID, contact_id: CONTACT_ID, ...row };
}

function journeyStage(row: Row): Row {
  return scoped({
    enrollment_id: ENROLLMENT_ID,
    journey_id: JOURNEY_ID,
    journey_version_id: VERSION_ID,
    journey_name: 'Property Predator self-serve',
    enrollment_status: 'active',
    current_milestone_id: CURRENT_STAGE_ID,
    enrolled_at: new Date('2026-08-20T09:00:00.000Z'),
    last_event_at: new Date('2026-08-25T10:15:00.000Z'),
    ended_at: null,
    ...row,
  });
}

function fixtures(): Record<string, Row[]> {
  return {
    'conversion.lead-360.read-contact': [scoped({
      display_name: '<img src=x onerror=alert(1)>',
      company_name: 'Stone & Sons',
      lifecycle_status: 'lead',
      owner_user_id: USER_ID,
      created_at: new Date('2026-08-19T08:00:00.000Z'),
      updated_at: new Date('2026-08-25T11:00:00.000Z'),
      primary_email: 'avery@example.test',
      primary_phone: '+440000000001',
      snapshot_at: new Date('2026-08-25T12:00:00.000Z'),
    })],
    'conversion.lead-360.read-journey': [
      journeyStage({
        milestone_id: LEAD_STAGE_ID,
        milestone_key: 'lead',
        milestone_name: 'Lead',
        position: 1,
        semantic: 'lead',
        is_completion: false,
        reached_at: new Date('2026-08-20T09:00:00.000Z'),
      }),
      journeyStage({
        milestone_id: CURRENT_STAGE_ID,
        milestone_key: 'appointment',
        milestone_name: 'Appointment booked',
        position: 2,
        semantic: 'appointment',
        is_completion: false,
        reached_at: new Date('2026-08-25T10:15:00.000Z'),
      }),
    ],
    'conversion.lead-360.read-score': [scoped({
      score_id: SCORE_ID,
      enrollment_id: ENROLLMENT_ID,
      total_score: '76',
      band_key: 'burning',
      component_scores: { engagement: 62, intent: 14 },
      reasons: ['Watched <b>92%</b>', 'Booked a call'],
      source_occurred_at: new Date('2026-08-25T10:15:00.000Z'),
      evaluated_at: new Date('2026-08-25T10:16:00.000Z'),
    })],
    'conversion.lead-360.read-evidence': [
      scoped({
        id: CONTENT_ID,
        evidence_kind: 'watched',
        title: '<script>not markup</script>',
        detail: 'progressed · predator-briefing · 1',
        progress_basis_points: '9200',
        occurred_at: new Date('2026-08-25T10:10:00.000Z'),
        source_label: 'Content · video',
      }),
      scoped({
        id: APPOINTMENT_ID,
        evidence_kind: 'appointment',
        title: 'Appointment booked',
        detail: 'appointment',
        progress_basis_points: null,
        occurred_at: new Date('2026-08-25T10:15:00.000Z'),
        source_label: 'Property Predator self-serve',
      }),
    ],
    'conversion.lead-360.read-offers': [scoped({
      id: OFFER_ID,
      offer_key: 'apex-annual',
      offer_label: 'Apex Annual',
      offer_version: '2026.08',
      product_key: 'property-predator-apex',
      price_minor: '9900',
      currency: 'GBP',
      placement: 'results',
      presented_at: new Date('2026-08-25T10:20:00.000Z'),
      response_id: RESPONSE_ID,
      response: 'accepted',
      responded_at: new Date('2026-08-25T10:22:00.000Z'),
    })],
    'conversion.lead-360.read-consent': [scoped({
      contact_point_id: POINT_ID,
      contact_point_kind: 'email',
      contact_point_label: 'Work <email>',
      contact_point_value: 'avery@example.test',
      is_primary: true,
      is_verified: true,
      dedupe_state: 'normal',
      channel: 'email',
      purpose: 'property_predator_marketing',
      consent_event_id: CONSENT_ID,
      consent_state: 'granted',
      lawful_basis: 'consent',
      consent_occurred_at: new Date('2026-08-20T09:00:00.000Z'),
      suppression_event_id: SUPPRESSION_ID,
      suppression_reason: 'provider-bounce<script>',
      suppression_occurred_at: new Date('2026-08-25T10:30:00.000Z'),
    })],
    'conversion.lead-360.read-opportunities': [scoped({
      id: OPPORTUNITY_ID,
      pipeline_id: PIPELINE_ID,
      stage_id: CRM_STAGE_ID,
      stage_name: 'Qualified',
      title: 'Apex annual',
      status: 'open',
      value_minor: '9900',
      currency: 'GBP',
      probability: 70,
      expected_close_date: '2026-08-31',
      closed_at: null,
      updated_at: new Date('2026-08-25T11:00:00.000Z'),
    })],
    'conversion.lead-360.read-tasks': [scoped({
      id: TASK_ID,
      opportunity_id: OPPORTUNITY_ID,
      title: 'Call <Avery>',
      priority: 'high',
      status: 'open',
      due_at: new Date('2026-08-26T09:00:00.000Z'),
      completed_at: null,
      updated_at: new Date('2026-08-25T11:05:00.000Z'),
    })],
  };
}

function marker(sql: string): string {
  const match = /\/\* (conversion\.lead-360\.read-[a-z-]+) \*\//.exec(sql);
  if (!match) throw new Error(`Missing Lead 360 marker: ${sql}`);
  return match[1]!;
}

class FakeRunner implements CrmTransactionRunner {
  readonly contexts: DatabaseRequestContext[] = [];
  readonly calls: Array<{ sql: string; values?: readonly unknown[]; executor: object }> = [];

  constructor(private readonly rowsByMarker: Record<string, Row[]>) {}

  async run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    this.contexts.push(context);
    const executor: SqlExecutor = {
      query: async <TRow extends Row = Row>(sql: string, values?: readonly unknown[]) => {
        this.calls.push({ sql, values, executor });
        const rows = this.rowsByMarker[marker(sql)];
        if (!rows) throw new Error(`No rows for ${marker(sql)}`);
        return { rows: rows as TRow[], rowCount: rows.length };
      },
    };
    return operation(executor);
  }
}

function userContext(): DatabaseRequestContext {
  return requestDatabaseContext({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'lead-360-read-test',
  });
}

test('Lead360ReadService maps and deeply freezes one narrow case file in one scoped transaction', async () => {
  const runner = new FakeRunner(fixtures());
  const result = await new Lead360ReadService({ transactionRunner: runner }).load(
    userContext(),
    CONTACT_ID,
  );

  assert.ok(result);
  assert.equal(runner.contexts.length, 1);
  assert.equal(runner.calls.length, 8);
  assert.equal(new Set(runner.calls.map((call) => call.executor)).size, 1);
  assert.ok(runner.calls.every((call) => call.values?.length === 1 && call.values[0] === CONTACT_ID));
  assert.equal(result.workspaceId, WORKSPACE_ID);
  assert.equal(result.contactId, CONTACT_ID);
  assert.equal(result.asOf, '2026-08-25T12:00:00.000Z');
  assert.deepEqual(result.identity, {
    contactId: CONTACT_ID,
    displayName: '<img src=x onerror=alert(1)>',
    companyName: 'Stone & Sons',
    primaryEmail: 'avery@example.test',
    primaryPhone: '+440000000001',
    lifecycle: 'lead',
    ownerUserId: USER_ID,
    createdAt: '2026-08-19T08:00:00.000Z',
    updatedAt: '2026-08-25T11:00:00.000Z',
  });
  assert.equal(result.journey?.name, 'Property Predator self-serve');
  assert.deepEqual(result.journey?.stages.map((stage) => [stage.name, stage.isCurrent, stage.reachedAt]), [
    ['Lead', false, '2026-08-20T09:00:00.000Z'],
    ['Appointment booked', true, '2026-08-25T10:15:00.000Z'],
  ]);
  assert.deepEqual(result.score, {
    id: SCORE_ID,
    enrollmentId: ENROLLMENT_ID,
    total: 76,
    band: 'burning',
    componentScores: { engagement: 62, intent: 14 },
    reasons: ['Watched <b>92%</b>', 'Booked a call'],
    sourceOccurredAt: '2026-08-25T10:15:00.000Z',
    evaluatedAt: '2026-08-25T10:16:00.000Z',
  });
  assert.equal(result.evidence[0]?.title, '<script>not markup</script>');
  assert.equal(result.evidence[0]?.progressBasisPoints, 9200);
  assert.deepEqual(result.offers[0]?.latestResponse, {
    id: RESPONSE_ID,
    response: 'accepted',
    respondedAt: '2026-08-25T10:22:00.000Z',
  });
  assert.equal(result.offers[0]?.label, 'Apex Annual');
  assert.deepEqual(result.consent[0], {
    contactPointId: POINT_ID,
    contactPointKind: 'email',
    contactPointLabel: 'Work <email>',
    contactPointValue: 'avery@example.test',
    isPrimary: true,
    isVerified: true,
    dedupeState: 'normal',
    channel: 'email',
    purpose: 'property_predator_marketing',
    state: 'suppressed',
    lawfulBasis: 'consent',
    updatedAt: '2026-08-25T10:30:00.000Z',
    consentEventId: CONSENT_ID,
    suppressionEventId: SUPPRESSION_ID,
    suppressionReason: 'provider-bounce<script>',
  });
  assert.equal(result.crm.opportunities[0]?.stageName, 'Qualified');
  assert.equal(result.crm.tasks[0]?.title, 'Call <Avery>');

  for (const value of [
    result,
    result.identity,
    result.journey,
    result.journey?.stages,
    result.journey?.stages[0],
    result.score,
    result.score?.componentScores,
    result.score?.reasons,
    result.evidence,
    result.evidence[0],
    result.offers,
    result.offers[0],
    result.offers[0]?.latestResponse,
    result.consent,
    result.consent[0],
    result.crm,
    result.crm.opportunities,
    result.crm.opportunities[0],
    result.crm.tasks,
    result.crm.tasks[0],
  ]) assert.ok(value && Object.isFrozen(value));
});

test('Lead360ReadService returns null for an invisible contact without probing related tables', async () => {
  const missing = fixtures();
  missing['conversion.lead-360.read-contact'] = [];
  const runner = new FakeRunner(missing);
  const result = await new Lead360ReadService({ transactionRunner: runner }).load(
    userContext(),
    CONTACT_ID,
  );
  assert.equal(result, null);
  assert.equal(runner.calls.length, 1);
});

test('Lead360ReadService rejects non-user access, malformed contact IDs and malformed database values', async () => {
  const runner = new FakeRunner(fixtures());
  const service = new Lead360ReadService({ transactionRunner: runner });
  await assert.rejects(
    () => service.load(
      workerDatabaseContext({ workspaceId: WORKSPACE_ID, requestId: 'worker-lead-360' }),
      CONTACT_ID,
    ),
    /authenticated user context/,
  );
  await assert.rejects(() => service.load(userContext(), 'not-a-contact'), /contactId must be a UUID/);
  assert.equal(runner.contexts.length, 0);

  const malformed = fixtures();
  malformed['conversion.lead-360.read-score']![0]!.component_scores = { engagement: '76' };
  await assert.rejects(
    () => new Lead360ReadService({ transactionRunner: new FakeRunner(malformed) }).load(
      userContext(),
      CONTACT_ID,
    ),
    Lead360ReadDataError,
  );
});

test('Lead 360 SQL stays parameterized, RLS-scoped and outside private payload journals', async () => {
  const runner = new FakeRunner(fixtures());
  await new Lead360ReadService({ transactionRunner: runner }).load(userContext(), CONTACT_ID);
  for (const call of runner.calls) {
    assert.match(call.sql, /app_private\.current_workspace_id\(\)/);
    assert.match(call.sql, /\$1::uuid/);
    assert.deepEqual(call.values, [CONTACT_ID]);
  }
  const sql = runner.calls.map((call) => call.sql).join('\n');
  assert.match(sql, /app\.content_consumption_facts/);
  assert.match(sql, /app\.conversion_milestone_facts/);
  assert.match(sql, /milestone\.semantic = 'appointment'/);
  assert.match(sql, /app\.offer_presentation_facts/);
  assert.match(sql, /app\.offer_response_facts/);
  assert.match(sql, /app\.conversion_commerce_facts/);
  assert.match(sql, /app\.communication_consent_events/);
  assert.match(sql, /app\.communication_suppression_events/);
  assert.match(sql, /app\.opportunities/);
  assert.match(sql, /app\.tasks/);
  assert.doesNotMatch(sql, /app_private\.(?:external|journal|receipt)/i);
  assert.doesNotMatch(sql, /source_payload_sha256|raw_payload|signature|token_hash|password_hash/i);
});

test('Lead 360 bounds large collections with deterministic business-first ordering', async () => {
  const runner = new FakeRunner(fixtures());
  await new Lead360ReadService({ transactionRunner: runner }).load(userContext(), CONTACT_ID);
  const sqlByMarker = Object.fromEntries(runner.calls.map((call) => [marker(call.sql), call.sql]));

  assert.match(
    sqlByMarker['conversion.lead-360.read-offers']!,
    /ORDER BY presentation\.presented_at DESC, presentation\.id DESC\s+LIMIT 50/,
  );
  assert.match(
    sqlByMarker['conversion.lead-360.read-opportunities']!,
    /ORDER BY opportunity\.updated_at DESC, opportunity\.id DESC\s+LIMIT 50/,
  );
  assert.match(
    sqlByMarker['conversion.lead-360.read-tasks']!,
    /ORDER BY CASE task\.status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,\s+CASE task\.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,\s+task\.due_at ASC NULLS LAST,\s+task\.updated_at DESC,\s+task\.id DESC\s+LIMIT 100/,
  );
});
