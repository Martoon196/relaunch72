import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GrowthIntelligenceReadDataError,
  GrowthIntelligenceReadService,
} from '../src/conversion-pg/index.js';
import type { CrmTransactionRunner, SqlExecutor } from '../src/crm-pg/index.js';
import { requestDatabaseContext, workerDatabaseContext, type DatabaseRequestContext } from '../src/db/rls.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown>;

function fixtures(): Record<string, Row[]> {
  return {
    'conversion.growth.read-funnels': [{
      journey_slug: 'property-predator-self-serve',
      journey_name: 'Property Predator self-serve conversion',
      journey_description: 'Captured identity to paid conversion.',
      milestone_key: 'lead', milestone_name: 'Lead', position: 1,
      achieved_count: '12', moved_in_window: '4',
    }, {
      journey_slug: 'property-predator-self-serve',
      journey_name: 'Property Predator self-serve conversion',
      journey_description: 'Captured identity to paid conversion.',
      milestone_key: 'activated', milestone_name: 'Activated', position: 2,
      achieved_count: '7', moved_in_window: '3',
    }],
    'conversion.growth.read-hot-leads': [{
      contact_id: CONTACT_ID,
      display_name: 'Avery Stone',
      company_name: 'Stone Developments',
      journey_slug: 'property-predator-self-serve',
      current_stage: 'Priced',
      total_score: '76',
      band_key: 'burning',
      evidence_kind: 'watched',
      evidence_label: 'The Predator Briefing',
      evidence_detail: '92% complete',
      evidence_at: new Date('2026-08-25T10:15:00.000Z'),
      content_summary: 'The Predator Briefing · 92%',
      offer_summary: 'apex-annual · shown',
    }],
    'conversion.growth.read-evidence-totals': [{
      snapshot_at: new Date('2026-08-25T12:00:00.000Z'),
      content_started: '9', content_completed: '4', offers_shown: '3', replies: '2', appointments: '1',
    }],
  };
}

function marker(sql: string): string {
  const match = /\/\* (conversion\.growth\.read-[a-z-]+) \*\//.exec(sql);
  if (!match) throw new Error(`Missing growth read marker: ${sql}`);
  return match[1]!;
}

class FakeRunner implements CrmTransactionRunner {
  readonly contexts: DatabaseRequestContext[] = [];
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];

  constructor(private readonly rowsByMarker: Record<string, Row[]>) {}

  async run<T>(context: DatabaseRequestContext, operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    this.contexts.push(context);
    return operation({
      query: async <TRow extends Row = Row>(sql: string, values?: readonly unknown[]) => {
        this.calls.push({ sql, values });
        const rows = this.rowsByMarker[marker(sql)];
        if (!rows) throw new Error(`No rows for ${marker(sql)}`);
        return { rows: rows as TRow[], rowCount: rows.length };
      },
    });
  }
}

function userContext(): DatabaseRequestContext {
  return requestDatabaseContext({ workspaceId: WORKSPACE_ID, userId: USER_ID, requestId: 'growth-read-test' });
}

test('GrowthIntelligenceReadService maps one evidence snapshot inside one user-scoped transaction', async () => {
  const runner = new FakeRunner(fixtures());
  const snapshot = await new GrowthIntelligenceReadService({ transactionRunner: runner }).load(userContext());

  assert.equal(runner.contexts.length, 1);
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.calls[0]?.values, [[
    'property-predator-self-serve', 'property-predator-agency-laps',
  ]]);
  assert.equal(snapshot.asOf, '2026-08-25T12:00:00.000Z');
  assert.equal(snapshot.windowLabel, 'Last 30 days');
  assert.deepEqual(snapshot.funnels[1], {
    journeySlug: 'property-predator-self-serve',
    journeyName: 'Property Predator self-serve conversion',
    journeyDescription: 'Captured identity to paid conversion.',
    milestoneKey: 'activated', milestoneName: 'Activated', position: 2,
    count: 7, movedInWindow: 3,
  });
  assert.deepEqual(snapshot.hotLeads[0], {
    contactId: CONTACT_ID,
    displayName: 'Avery Stone', companyName: 'Stone Developments',
    journeySlug: 'property-predator-self-serve', currentStage: 'Priced',
    score: 76, band: 'burning', evidenceKind: 'watched',
    evidenceLabel: 'The Predator Briefing', evidenceDetail: '92% complete',
    evidenceAt: '2026-08-25T10:15:00.000Z',
    contentSummary: 'The Predator Briefing · 92%', offerSummary: 'apex-annual · shown',
  });
  assert.deepEqual(snapshot.evidenceTotals, {
    contentStarted: 9, contentCompleted: 4, offersShown: 3, replies: 2, appointments: 1,
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.hotLeads[0]));
});

test('GrowthIntelligenceReadService rejects non-user contexts and malformed score evidence', async () => {
  const runner = new FakeRunner(fixtures());
  await assert.rejects(
    () => new GrowthIntelligenceReadService({ transactionRunner: runner }).load(
      workerDatabaseContext({ workspaceId: WORKSPACE_ID, requestId: 'worker-growth-read' }),
    ),
    /authenticated user context/,
  );

  const malformed = fixtures();
  malformed['conversion.growth.read-hot-leads']![0]!.total_score = '101';
  await assert.rejects(
    () => new GrowthIntelligenceReadService({ transactionRunner: new FakeRunner(malformed) }).load(userContext()),
    GrowthIntelligenceReadDataError,
  );

  const duplicated = fixtures();
  duplicated['conversion.growth.read-hot-leads']!.push({
    ...duplicated['conversion.growth.read-hot-leads']![0]!,
  });
  await assert.rejects(
    () => new GrowthIntelligenceReadService({ transactionRunner: new FakeRunner(duplicated) }).load(userContext()),
    /each contact at most once/,
  );
});

test('growth intelligence SQL reads only RLS-scoped app tables and never private payload journals', async () => {
  const runner = new FakeRunner(fixtures());
  await new GrowthIntelligenceReadService({ transactionRunner: runner }).load(userContext());
  const sql = runner.calls.map((call) => call.sql).join('\n');
  assert.match(sql, /app_private\.current_workspace_id\(\)/);
  assert.match(sql, /app\.content_consumption_facts/);
  assert.match(sql, /app\.offer_presentation_facts/);
  assert.match(sql, /count\(DISTINCT fact\.contact_id\)::text AS achieved_count/, 'funnel stages count people, not repeat enrollments');
  assert.match(sql, /count\(DISTINCT fact\.contact_id\) FILTER/, 'window movement counts each person once per milestone');
  assert.equal(
    (sql.match(/AND fact\.(?:occurred_at|presented_at|responded_at) <= transaction_timestamp\(\)/g) ?? []).length,
    6,
    'every 30-day funnel and evidence window is capped at the read snapshot',
  );
  assert.match(sql, /consumption\.id AS source_id/);
  assert.match(sql, /presentation\.id AS source_id/);
  assert.match(sql, /response\.id AS source_id/);
  assert.match(
    sql,
    /ORDER BY evidence\.occurred_at DESC, evidence\.kind, evidence\.label,\s+evidence\.source_id DESC/,
    'same-time evidence has a stable immutable fact tie-breaker',
  );
  assert.match(sql, /DISTINCT ON \(enrollment\.contact_id\)/, 'hot list contains each person once');
  assert.match(sql, /enrollment\.status = 'active'/, 'terminal journeys do not displace actionable enrollments');
  assert.match(sql, /latest_score\.total_score >= 22/, 'quiet and unscored records stay out of the attention list');
  assert.match(
    sql,
    /ORDER BY enrollment\.contact_id,\s+latest_score\.total_score DESC NULLS LAST,\s+latest_score\.evaluated_at DESC,\s+enrollment\.last_event_at DESC NULLS LAST,\s+current_milestone\.position DESC NULLS LAST,\s+journey\.slug::text,\s+enrollment\.id DESC/,
    'two active journeys choose the most actionable enrollment with total ordering',
  );
  assert.match(sql, /count\(DISTINCT \(fact\.contact_id, fact\.content_key, fact\.content_version\)\)/);
  assert.doesNotMatch(sql, /response <> 'presented'/, 'every persisted response is a real reply');
  assert.doesNotMatch(sql, /external_event_shadow|payload_sha256|raw_payload|signature/i);
});
