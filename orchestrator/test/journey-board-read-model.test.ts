import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JourneyBoardReadDataError,
  JourneyBoardReadService,
  type JourneyBoardCardRead,
  type JourneyBoardReadSnapshot,
} from '../src/conversion-pg/journey-board-read-model.js';
import type { CrmTransactionRunner, SqlExecutor } from '../src/crm-pg/types.js';
import {
  requestDatabaseContext,
  workerDatabaseContext,
  type DatabaseRequestContext,
} from '../src/db/rls.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PIPELINE_ID = '33333333-3333-4333-8333-333333333333';
const OPEN_STAGE_ID = '44444444-4444-4444-8444-444444444444';
const WON_STAGE_ID = '55555555-5555-4555-8555-555555555555';
const OPPORTUNITY_ID = '66666666-6666-4666-8666-666666666666';
const CONTACT_ID = '77777777-7777-4777-8777-777777777777';
const ENROLLMENT_ID = '88888888-8888-4888-8888-888888888888';
const MILESTONE_ID = '99999999-9999-4999-8999-999999999999';
const SCORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVIDENCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AFFILIATE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SECOND_OPPORTUNITY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECOND_CONTACT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type Row = Record<string, unknown>;

const ABSENT_JOURNEY = {
  journey_enrollment_id: null,
  journey_enrollment_status: null,
  journey_enrolled_at: null,
  journey_last_event_at: null,
  journey_ended_at: null,
  journey_slug: null,
  journey_name: null,
  current_milestone_id: null,
  current_milestone_key: null,
  current_milestone_name: null,
  current_milestone_position: null,
  current_milestone_semantic: null,
  current_milestone_reached_at: null,
  current_milestone_source_kind: null,
  current_milestone_actor_kind: null,
  current_milestone_commerce_fact_type: null,
  current_milestone_payment_fact_id: null,
  route_enrollment_count: null,
  score_id: null,
  score_enrollment_id: null,
  total_score: null,
  band_key: null,
  reasons: null,
  score_source_occurred_at: null,
  score_evaluated_at: null,
} as const;

const ABSENT_EVIDENCE = {
  evidence_id: null,
  evidence_kind: null,
  evidence_title: null,
  evidence_detail: null,
  progress_basis_points: null,
  evidence_occurred_at: null,
  evidence_source_label: null,
  evidence_source_kind: null,
  evidence_actor_kind: null,
  evidence_commerce_fact_type: null,
  evidence_payment_fact_id: null,
  content_summary: null,
  offer_summary: null,
} as const;

const ABSENT_TASK = {
  task_id: null,
  task_title: null,
  task_priority: null,
  task_due_at: null,
} as const;

const ABSENT_ATTRIBUTION = {
  attribution_origin: null,
  attribution_source_system: null,
  attribution_source_reference: null,
  attribution_type: null,
  attribution_channel: null,
  affiliate_id: null,
  affiliate_source_id: null,
  affiliate_name: null,
  affiliate_code: null,
  referral_code: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  attributed_at: null,
} as const;

function fixtures(): Record<string, Row[]> {
  return {
    'conversion.journey-board.read-workspace': [{
      workspace_id: WORKSPACE_ID,
      workspace_name: 'Property Predator Growth HQ',
      timezone: 'Europe/London',
      currency: 'GBP',
      default_pipeline_id: PIPELINE_ID,
      can_write: true,
      snapshot_at: new Date('2026-08-25T12:00:00.000Z'),
    }],
    'conversion.journey-board.read-stages': [{
      workspace_id: WORKSPACE_ID,
      pipeline_id: PIPELINE_ID,
      stage_id: OPEN_STAGE_ID,
      stage_name: 'Lead',
      position: 1,
      stage_type: 'open',
      is_terminal: false,
      row_version: '3',
    }, {
      workspace_id: WORKSPACE_ID,
      pipeline_id: PIPELINE_ID,
      stage_id: WON_STAGE_ID,
      stage_name: 'Sale',
      position: 2,
      stage_type: 'won',
      is_terminal: true,
      row_version: '4',
    }],
    'conversion.journey-board.read-cards': [{
      workspace_id: WORKSPACE_ID,
      opportunity_id: OPPORTUNITY_ID,
      contact_id: CONTACT_ID,
      contact_name: 'Avery Stone',
      company_name: 'Stone Developments',
      lifecycle_status: 'lead',
      contact_source: 'property-predator',
      primary_email: 'avery@example.test',
      primary_phone: '+447700900001',
      pipeline_id: PIPELINE_ID,
      stage_id: OPEN_STAGE_ID,
      board_stage_position: 1,
      lane_total_count: '2',
      lane_rank: '1',
      opportunity_title: 'Property Predator annual',
      opportunity_status: 'open',
      value_minor: '299900',
      currency: 'GBP',
      probability: 65,
      owner_user_id: USER_ID,
      expected_close_date: '2026-09-04',
      updated_at: new Date('2026-08-25T11:45:00.000Z'),
      row_version: '7',
      journey_enrollment_id: ENROLLMENT_ID,
      journey_enrollment_status: 'active',
      journey_enrolled_at: new Date('2026-08-20T09:00:00.000Z'),
      journey_last_event_at: new Date('2026-08-25T11:30:00.000Z'),
      journey_ended_at: null,
      journey_slug: 'property-predator-self-serve',
      journey_name: 'Property Predator self-serve conversion',
      current_milestone_id: MILESTONE_ID,
      current_milestone_key: 'presentation',
      current_milestone_name: 'Presentation watched',
      current_milestone_position: 3,
      current_milestone_semantic: 'presentation',
      current_milestone_reached_at: new Date('2026-08-25T11:30:00.000Z'),
      current_milestone_source_kind: 'event',
      current_milestone_actor_kind: 'webhook',
      current_milestone_commerce_fact_type: null,
      current_milestone_payment_fact_id: null,
      route_enrollment_count: '2',
      score_id: SCORE_ID,
      score_enrollment_id: ENROLLMENT_ID,
      total_score: '76',
      band_key: 'burning',
      reasons: ['Watched 92% of briefing', 'Requested a call'],
      score_source_occurred_at: new Date('2026-08-25T11:30:00.000Z'),
      score_evaluated_at: new Date('2026-08-25T11:31:00.000Z'),
      evidence_id: EVIDENCE_ID,
      evidence_kind: 'watched',
      evidence_title: 'The Predator Briefing',
      evidence_detail: 'progressed · predator-briefing · v1',
      progress_basis_points: '9200',
      evidence_occurred_at: new Date('2026-08-25T11:30:00.000Z'),
      evidence_source_label: 'Content · video',
      evidence_source_kind: 'verified_webhook',
      evidence_actor_kind: 'webhook',
      evidence_commerce_fact_type: null,
      evidence_payment_fact_id: null,
      content_summary: 'The Predator Briefing · 92.0% complete',
      offer_summary: 'Property Predator annual · requested_contact',
      task_id: TASK_ID,
      task_title: 'Call Avery while intent is hot',
      task_priority: 'urgent',
      task_due_at: new Date('2026-08-25T13:00:00.000Z'),
      attribution_origin: 'canonical',
      attribution_source_system: 'property-predator',
      attribution_source_reference: 'abababab-abab-4bab-8bab-abababababab',
      attribution_type: 'affiliate_referral',
      attribution_channel: 'affiliate',
      affiliate_id: AFFILIATE_ID,
      affiliate_source_id: null,
      affiliate_name: null,
      affiliate_code: null,
      referral_code: 'MARTIN42',
      utm_source: 'partner-network',
      utm_medium: 'affiliate',
      utm_campaign: 'predator-launch',
      attributed_at: new Date('2026-08-20T08:58:00.000Z'),
    }, {
      workspace_id: WORKSPACE_ID,
      opportunity_id: SECOND_OPPORTUNITY_ID,
      contact_id: SECOND_CONTACT_ID,
      contact_name: 'Jordan Reed',
      company_name: null,
      lifecycle_status: 'lead',
      contact_source: 'legacy-import',
      primary_email: null,
      primary_phone: null,
      pipeline_id: PIPELINE_ID,
      stage_id: OPEN_STAGE_ID,
      board_stage_position: 1,
      lane_total_count: '2',
      lane_rank: '2',
      opportunity_title: 'Imported lead',
      opportunity_status: 'open',
      value_minor: '0',
      currency: 'GBP',
      probability: 0,
      owner_user_id: null,
      expected_close_date: null,
      updated_at: new Date('2026-08-24T10:00:00.000Z'),
      row_version: '1',
      ...ABSENT_JOURNEY,
      ...ABSENT_EVIDENCE,
      ...ABSENT_TASK,
      ...ABSENT_ATTRIBUTION,
      attribution_origin: 'legacy',
      attribution_source_system: 'ghl',
      attribution_source_reference: 'lead-9821',
      affiliate_source_id: 'affiliate-77',
      affiliate_name: 'North Star Sourcing',
      affiliate_code: 'NORTH77',
      referral_code: 'NORTH77',
      utm_source: 'north-star',
      utm_medium: 'affiliate',
      utm_campaign: 'legacy-summer',
      attributed_at: new Date('2025-08-10T08:00:00.000Z'),
    }],
  };
}

function marker(sql: string): string {
  const match = /\/\* (conversion\.journey-board\.read-[a-z-]+) \*\//.exec(sql);
  if (!match) throw new Error(`Missing Journey Board read marker: ${sql}`);
  return match[1]!;
}

class FakeRunner implements CrmTransactionRunner {
  readonly contexts: DatabaseRequestContext[] = [];
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];

  constructor(private readonly rowsByMarker: Record<string, Row[]>) {}

  async run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    this.contexts.push(context);
    return operation({
      query: async <TRow extends Row = Row>(sql: string, values?: readonly unknown[]) => {
        this.calls.push({ sql, values });
        const queryMarker = marker(sql);
        const rows = this.rowsByMarker[queryMarker];
        if (!rows) throw new Error(`No rows for ${queryMarker}`);
        return { rows: rows as TRow[], rowCount: rows.length };
      },
    });
  }
}

function userContext(): DatabaseRequestContext {
  return requestDatabaseContext({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    requestId: 'journey-board-read-test',
  });
}

async function load(rows = fixtures()): Promise<JourneyBoardReadSnapshot> {
  return new JourneyBoardReadService({ transactionRunner: new FakeRunner(rows) }).load(userContext());
}

test('JourneyBoardReadService maps an operational board snapshot in one scoped transaction', async () => {
  const runner = new FakeRunner(fixtures());
  const snapshot: JourneyBoardReadSnapshot = await new JourneyBoardReadService({
    transactionRunner: runner,
  }).load(userContext());

  assert.equal(runner.contexts.length, 1);
  assert.equal(runner.calls.length, 3);
  assert.deepEqual(runner.calls[1]?.values, [101]);
  assert.deepEqual(runner.calls[2]?.values, [[
    'property-predator-self-serve', 'property-predator-agency-laps',
  ], 75]);
  assert.deepEqual(snapshot.workspace, {
    id: WORKSPACE_ID,
    name: 'Property Predator Growth HQ',
    timezone: 'Europe/London',
    currency: 'GBP',
    defaultPipelineId: PIPELINE_ID,
    canWrite: true,
  });
  assert.equal(snapshot.asOf, '2026-08-25T12:00:00.000Z');
  assert.equal(snapshot.perLaneCardLimit, 75);
  assert.equal(snapshot.loadedCardCount, 2);
  assert.equal(snapshot.totalCardCount, 2);
  assert.deepEqual(snapshot.laneCoverage, [{
    stageId: OPEN_STAGE_ID, loadedCardCount: 2, totalCardCount: 2, truncated: false,
  }, {
    stageId: WON_STAGE_ID, loadedCardCount: 0, totalCardCount: 0, truncated: false,
  }]);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.stages.map(({ id, name, stageType, rowVersion }) => ({
    id, name, stageType, rowVersion,
  })), [{ id: OPEN_STAGE_ID, name: 'Lead', stageType: 'open', rowVersion: 3 }, {
    id: WON_STAGE_ID, name: 'Sale', stageType: 'won', rowVersion: 4,
  }]);

  const card: JourneyBoardCardRead = snapshot.cards[0]!;
  assert.equal(card.opportunityId, OPPORTUNITY_ID);
  assert.equal(card.rowVersion, 7, 'the card carries the existing move command version');
  assert.equal(card.primaryJourney?.otherEnrollmentCount, 1);
  assert.deepEqual(card.primaryJourney?.currentMilestone, {
    id: MILESTONE_ID,
    key: 'presentation',
    name: 'Presentation watched',
    position: 3,
    semantic: 'presentation',
    reachedAt: '2026-08-25T11:30:00.000Z',
    sourceKind: 'event',
    sourceActorKind: 'webhook',
    commerceFactType: null,
    automatic: true,
    paymentVerified: false,
  });
  assert.deepEqual(card.primaryJourney?.score, {
    id: SCORE_ID,
    total: 76,
    band: 'burning',
    reasons: ['Watched 92% of briefing', 'Requested a call'],
    sourceOccurredAt: '2026-08-25T11:30:00.000Z',
    evaluatedAt: '2026-08-25T11:31:00.000Z',
  });
  assert.deepEqual(card.latestEvidence, {
    id: EVIDENCE_ID,
    kind: 'watched',
    title: 'The Predator Briefing',
    detail: 'progressed · predator-briefing · v1',
    progressBasisPoints: 9200,
    occurredAt: '2026-08-25T11:30:00.000Z',
    sourceLabel: 'Content · video',
    sourceKind: 'verified_webhook',
    sourceActorKind: 'webhook',
    commerceFactType: null,
    automatic: true,
    paymentVerified: false,
  });
  assert.deepEqual(card.nextTask, {
    id: TASK_ID,
    title: 'Call Avery while intent is hot',
    priority: 'urgent',
    dueAt: '2026-08-25T13:00:00.000Z',
  });
  assert.deepEqual(card.attribution, {
    origin: 'canonical',
    sourceSystem: 'property-predator',
    sourceReference: 'abababab-abab-4bab-8bab-abababababab',
    attributionType: 'affiliate_referral',
    channel: 'affiliate',
    affiliateId: AFFILIATE_ID,
    affiliateSourceId: null,
    affiliateName: null,
    affiliateCode: null,
    referralCode: 'MARTIN42',
    utmSource: 'partner-network',
    utmMedium: 'affiliate',
    utmCampaign: 'predator-launch',
    attributedAt: '2026-08-20T08:58:00.000Z',
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.cards));
  assert.ok(Object.isFrozen(card));
  assert.ok(Object.isFrozen(card.primaryJourney?.score));
});

test('unscored and unenrolled saved CRM people stay visible, including typed legacy attribution', async () => {
  const snapshot = await load();
  const card = snapshot.cards[1]!;

  assert.equal(card.contactId, SECOND_CONTACT_ID);
  assert.equal(card.primaryJourney, null);
  assert.equal(card.latestEvidence, null);
  assert.equal(card.contentSummary, null);
  assert.equal(card.offerSummary, null);
  assert.equal(card.nextTask, null);
  assert.deepEqual(card.attribution, {
    origin: 'legacy',
    sourceSystem: 'ghl',
    sourceReference: 'lead-9821',
    attributionType: null,
    channel: null,
    affiliateId: null,
    affiliateSourceId: 'affiliate-77',
    affiliateName: 'North Star Sourcing',
    affiliateCode: 'NORTH77',
    referralCode: 'NORTH77',
    utmSource: 'north-star',
    utmMedium: 'affiliate',
    utmCampaign: 'legacy-summer',
    attributedAt: '2025-08-10T08:00:00.000Z',
  });
});

test('database text is preserved exactly so escaping remains the portal renderer responsibility', async () => {
  const rows = fixtures();
  const card = rows['conversion.journey-board.read-cards']![0]!;
  card.contact_name = '<script>alert("contact")</script>';
  card.opportunity_title = '<b>Untrusted opportunity</b>';
  card.evidence_title = 'Watch & learn <today>';

  const snapshot = await load(rows);
  assert.equal(snapshot.cards[0]?.contactName, '<script>alert("contact")</script>');
  assert.equal(snapshot.cards[0]?.title, '<b>Untrusted opportunity</b>');
  assert.equal(snapshot.cards[0]?.latestEvidence?.title, 'Watch & learn <today>');
});

test('bounded pages are fair per lane and expose exact partial-result coverage', async () => {
  const rows = fixtures();
  const template = rows['conversion.journey-board.read-cards']![0]!;
  const cardId = (index: number): string => (
    `12345678-1234-4abc-8def-${index.toString(16).padStart(12, '0')}`
  );
  const openCards = Array.from({ length: 75 }, (_, index) => ({
    ...template,
    opportunity_id: cardId(index + 1),
    lane_total_count: '90',
    lane_rank: String(index + 1),
  }));
  const wonCard = {
    ...template,
    opportunity_id: cardId(1_000),
    stage_id: WON_STAGE_ID,
    board_stage_position: 2,
    opportunity_status: 'won',
    lane_total_count: '1',
    lane_rank: '1',
  };
  rows['conversion.journey-board.read-cards'] = [...openCards, wonCard];

  const snapshot = await load(rows);
  assert.equal(snapshot.cards.length, 76, 'a busy first lane does not starve later lanes');
  assert.equal(snapshot.cards.at(-1)?.stageId, WON_STAGE_ID);
  assert.deepEqual(snapshot.laneCoverage, [{
    stageId: OPEN_STAGE_ID, loadedCardCount: 75, totalCardCount: 90, truncated: true,
  }, {
    stageId: WON_STAGE_ID, loadedCardCount: 1, totalCardCount: 1, truncated: false,
  }]);
  assert.equal(snapshot.loadedCardCount, 76);
  assert.equal(snapshot.totalCardCount, 91);
  assert.equal(snapshot.truncated, true);
});

test('manual milestones remain visibly manual and Sale requires canonical collected-payment provenance', async () => {
  const manualRows = fixtures();
  const manual = manualRows['conversion.journey-board.read-cards']![0]!;
  manual.current_milestone_source_kind = 'manual';
  manual.current_milestone_actor_kind = 'user';
  manual.evidence_source_kind = 'manual';
  manual.evidence_actor_kind = 'user';
  const manualSnapshot = await load(manualRows);
  assert.equal(manualSnapshot.cards[0]?.primaryJourney?.currentMilestone?.automatic, false);
  assert.equal(manualSnapshot.cards[0]?.latestEvidence?.automatic, false);

  const paidRows = fixtures();
  const paid = paidRows['conversion.journey-board.read-cards']![0]!;
  paid.current_milestone_key = 'sale';
  paid.current_milestone_name = 'Sale';
  paid.current_milestone_semantic = 'sale';
  paid.current_milestone_source_kind = 'commerce';
  paid.current_milestone_actor_kind = 'webhook';
  paid.current_milestone_commerce_fact_type = 'payment_collected';
  paid.current_milestone_payment_fact_id = 'abababab-abab-4bab-8bab-abababababab';
  const paidSnapshot = await load(paidRows);
  assert.equal(paidSnapshot.cards[0]?.primaryJourney?.currentMilestone?.paymentVerified, true);

  paid.current_milestone_payment_fact_id = null;
  await assert.rejects(() => load(paidRows), /canonical collected payment/);
});

test('invalid contexts, scope escapes, inconsistent data and duplicates fail closed', async (t) => {
  await t.test('authenticated users only', async () => {
    await assert.rejects(
      () => new JourneyBoardReadService({ transactionRunner: new FakeRunner(fixtures()) }).load(
        workerDatabaseContext({ workspaceId: WORKSPACE_ID, requestId: 'worker-board-read' }),
      ),
      /authenticated user context/,
    );
  });

  await t.test('workspace scope', async () => {
    const rows = fixtures();
    rows['conversion.journey-board.read-cards']![0]!.workspace_id = USER_ID;
    await assert.rejects(() => load(rows), /escaped the requested RLS scope/);
  });

  await t.test('score bounds', async () => {
    const rows = fixtures();
    rows['conversion.journey-board.read-cards']![0]!.total_score = '101';
    await assert.rejects(() => load(rows), JourneyBoardReadDataError);
  });

  await t.test('journey route count', async () => {
    const rows = fixtures();
    rows['conversion.journey-board.read-cards']![0]!.route_enrollment_count = '0';
    await assert.rejects(() => load(rows), /outside its safe range/);
  });

  await t.test('stage status agreement', async () => {
    const rows = fixtures();
    rows['conversion.journey-board.read-cards']![0]!.opportunity_status = 'won';
    await assert.rejects(() => load(rows), /status conflicts with its stage/);
  });

  await t.test('partial journey evidence', async () => {
    const rows = fixtures();
    rows['conversion.journey-board.read-cards']![0]!.journey_name = null;
    await assert.rejects(() => load(rows), /incomplete journey identity/);
  });

  await t.test('duplicate opportunity cards', async () => {
    const rows = fixtures();
    rows['conversion.journey-board.read-cards']!.push({
      ...rows['conversion.journey-board.read-cards']![0]!,
    });
    await assert.rejects(() => load(rows), /duplicate opportunity cards/);
  });
});

test('Journey Board SQL is bounded, deterministic, RLS-scoped and never selects provider payloads', async () => {
  const runner = new FakeRunner(fixtures());
  await new JourneyBoardReadService({ transactionRunner: runner }).load(userContext());
  const sql = runner.calls.map((call) => call.sql).join('\n');
  const cardsSql = runner.calls[2]!.sql;

  assert.match(sql, /app_private\.current_workspace_id\(\)/);
  assert.match(sql, /app_private\.can_write_workspace/);
  assert.match(sql, /pipeline\.is_default/);
  assert.match(runner.calls[1]!.sql, /LIMIT \$1::integer/);
  assert.match(cardsSql, /count\(\*\) OVER \(PARTITION BY opportunity\.stage_id\) AS lane_total_count/);
  assert.match(cardsSql, /row_number\(\) OVER \(\s*PARTITION BY opportunity\.stage_id/);
  assert.match(cardsSql, /WHERE lane_rank <= \$2::bigint/);
  assert.match(cardsSql, /interval '180 days'/);
  assert.match(cardsSql, /count\(\*\) OVER \(PARTITION BY enrollment\.contact_id\)/);
  assert.match(cardsSql, /row_number\(\) OVER \(/);
  assert.match(
    cardsSql,
    /ORDER BY \(enrollment\.status = 'active'\) DESC,[\s\S]*latest_score\.total_score END DESC NULLS LAST,[\s\S]*enrollment\.id DESC/,
    'two active or recent routes have a total deterministic primary ordering',
  );
  assert.match(cardsSql, /ORDER BY score\.evaluated_at DESC, score\.id DESC/);
  assert.match(cardsSql, /app\.content_consumption_facts/);
  assert.match(cardsSql, /app\.offer_presentation_facts/);
  assert.match(cardsSql, /app\.offer_response_facts/);
  assert.match(cardsSql, /app\.conversion_commerce_facts/);
  assert.match(cardsSql, /app\.conversion_milestone_facts/);
  assert.match(cardsSql, /current_fact\.source_kind AS current_milestone_source_kind/);
  assert.match(cardsSql, /current_payment\.fact_type = 'payment_collected'/);
  assert.match(cardsSql, /fact\.source_kind/);
  assert.match(cardsSql, /app\.contact_attribution_facts/);
  assert.match(cardsSql, /app\.contact_import_attribution_facts/);
  assert.match(cardsSql, /task\.opportunity_id = opportunity\.id/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.doesNotMatch(
    sql,
    /raw_payload|source_payload_sha256|payload_sha256|signature|external_event_shadow|contact_import_attribution_payloads/i,
  );
});
