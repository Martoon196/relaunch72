import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import type { CrmTransactionRunner } from '../../src/crm-pg/types.js';
import {
  GrowthIntelligenceReadService,
  Lead360ReadService,
} from '../../src/conversion-pg/index.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

interface SourceEvent {
  readonly id: string;
  readonly type: string;
  readonly version: 1;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly subject: Readonly<{ kind: 'account'; id: string }>;
  readonly data: Readonly<Record<string, unknown>>;
}

interface ProjectionRow extends QueryResultRow {
  disposition: string;
  replayed: boolean;
}

interface JourneyProjectionRow extends ProjectionRow {
  enrollments_started: number;
  milestones_achieved: number;
  score_snapshots_written: number;
  consent_facts_written: number;
  commerce_facts_written: number;
}

const recordSql = `
  SELECT disposition, replayed
  FROM app_private.record_external_event_shadow_receipt(
    $1::uuid, 'property_predator', $2::uuid, $3::text, 1::smallint,
    $4::timestamptz, $5::uuid, 'account', $6::uuid, $7::bytea,
    $8::jsonb, 'growth-integration-v1', $9::timestamptz
  )`;

async function recordEvent(
  pool: Pool,
  workspaceId: string,
  event: SourceEvent,
): Promise<void> {
  const raw = Buffer.from(JSON.stringify(event), 'utf8');
  const payloadHash = createHash('sha256').update(raw).digest();
  const rows = await scopedQuery<ProjectionRow>(
    pool,
    'r72_external_event_command',
    { workspaceId, requestId: `property-predator:${event.id}` },
    recordSql,
    [
      workspaceId,
      event.id,
      event.type,
      event.occurredAt,
      event.correlationId,
      event.subject.id,
      payloadHash,
      JSON.stringify(event),
      '2026-08-25T12:00:01.000Z',
    ],
  );
  assert.deepEqual(rows, [{ disposition: 'shadow', replayed: false }]);
}

async function projectEvent(
  pool: Pool,
  workspaceId: string,
  eventId: string,
): Promise<ProjectionRow[]> {
  return scopedQuery<ProjectionRow>(
    pool,
    'r72_webhook',
    { workspaceId, requestId: `property-predator-projector:${eventId}` },
    `SELECT disposition, replayed
     FROM app_private.project_property_predator_growth_event($1::uuid)`,
    [eventId],
  );
}

async function projectJourneyEvent(
  pool: Pool,
  workspaceId: string,
  eventId: string,
  requestSuffix = '',
): Promise<JourneyProjectionRow[]> {
  return scopedQuery<JourneyProjectionRow>(
    pool,
    'r72_webhook',
    {
      workspaceId,
      requestId: `property-predator-journey:${eventId}${requestSuffix}`,
    },
    `SELECT disposition, replayed, enrollments_started, milestones_achieved,
            score_snapshots_written, consent_facts_written,
            commerce_facts_written
     FROM app_private.project_property_predator_journey_event($1::uuid)`,
    [eventId],
  );
}

async function installPropertyPredatorJourneyBlueprints(
  pool: Pool,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const scoreModelId = randomUUID();
  const scoreVersionId = randomUUID();
  const selfJourneyId = randomUUID();
  const selfVersionId = randomUUID();
  const agencyJourneyId = randomUUID();
  const agencyVersionId = randomUUID();
  const definition = {
    schemaVersion: 1,
    slug: 'property-predator-lead-score',
    name: 'Property Predator Lead Score',
    version: 2,
    components: [
      { key: 'engagement', name: 'Engagement', maxPoints: 35 },
      { key: 'intent', name: 'Intent', maxPoints: 65 },
    ],
    bands: [
      { key: 'cold', name: 'Cold', minScore: 0, maxScore: 19 },
      { key: 'warm', name: 'Warm', minScore: 20, maxScore: 49 },
      { key: 'hot', name: 'Hot', minScore: 50, maxScore: 100 },
    ],
    rules: [
      {
        key: 'account-created', componentKey: 'engagement', kind: 'event',
        sourceKey: 'identity.account.created', points: 5,
        reason: 'Account created', mode: 'direct', frequency: 'once_per_enrollment',
      },
      {
        key: 'analysis-completed', componentKey: 'engagement', kind: 'event',
        sourceKey: 'product.analysis.completed', points: 15,
        reason: 'Analysis completed', mode: 'direct', frequency: 'once_per_enrollment',
      },
      {
        key: 'content-completed', componentKey: 'engagement', kind: 'event',
        sourceKey: 'content.consumption.completed', points: 15,
        reason: 'Content completed', mode: 'direct', frequency: 'once_per_enrollment',
      },
      {
        key: 'offer-presented', componentKey: 'intent', kind: 'event',
        sourceKey: 'offer.presented', points: 10,
        reason: 'Offer presented', mode: 'direct', frequency: 'once_per_enrollment',
      },
      {
        key: 'appointment-booked', componentKey: 'intent', kind: 'event',
        sourceKey: 'sales.appointment.booked', points: 10,
        reason: 'Appointment booked', mode: 'direct', frequency: 'once_per_enrollment',
      },
      {
        key: 'presentation-completed', componentKey: 'intent', kind: 'event',
        sourceKey: 'sales.presentation.completed', points: 10,
        reason: 'Presentation completed', mode: 'direct', frequency: 'once_per_enrollment',
      },
      {
        key: 'payment-collected', componentKey: 'intent', kind: 'commerce',
        sourceKey: 'payment_collected', points: 5,
        reason: 'Payment collected', mode: 'direct', frequency: 'once_per_enrollment',
      },
    ],
  } as const;
  const definitionJson = JSON.stringify(definition);
  const definitionHash = createHash('sha256').update(definitionJson).digest();
  const settings = JSON.stringify({
    schemaVersion: 1,
    mappingMode: 'direct',
    mappingFrequency: 'once_per_enrollment',
    scoreModelDefinitionHash: definitionHash.toString('hex'),
  });

  await ownerQuery(
    pool,
    `INSERT INTO app.lead_score_models
       (id, workspace_id, slug, name, status, created_by_user_id)
     VALUES ($1, $2, 'property-predator-lead-score',
             'Property Predator Lead Score', 'draft', $3)`,
    [scoreModelId, workspaceId, userId],
  );
  await ownerQuery(
    pool,
    `INSERT INTO app.lead_score_model_versions
       (id, workspace_id, model_id, version_no, definition,
        definition_sha256, created_by_user_id)
     VALUES ($1, $2, $3, 2, $4::jsonb, $5::bytea, $6)`,
    [scoreVersionId, workspaceId, scoreModelId, definitionJson, definitionHash, userId],
  );
  await ownerQuery(
    pool,
    `INSERT INTO app.conversion_journeys
       (id, workspace_id, slug, name, status, created_by_user_id)
     VALUES
       ($1, $3, 'property-predator-self-serve', 'PP Self Serve', 'draft', $4),
       ($2, $3, 'property-predator-agency-laps', 'PP Agency LAPS', 'draft', $4)`,
    [selfJourneyId, agencyJourneyId, workspaceId, userId],
  );
  await ownerQuery(
    pool,
    `INSERT INTO app.conversion_journey_versions
       (id, workspace_id, journey_id, version_no, score_model_version_id,
        settings, definition_sha256, created_by_user_id)
     VALUES
       ($1, $3, $4, 2, $5, $6::jsonb, $7::bytea, $9),
       ($2, $3, $8, 2, $5, $6::jsonb, $10::bytea, $9)`,
    [
      selfVersionId,
      agencyVersionId,
      workspaceId,
      selfJourneyId,
      scoreVersionId,
      settings,
      createHash('sha256').update('property-predator-self-serve:v2').digest(),
      agencyJourneyId,
      userId,
      createHash('sha256').update('property-predator-agency-laps:v2').digest(),
    ],
  );

  const milestones = [
    { id: randomUUID(), journeyVersionId: selfVersionId, key: 'lead', name: 'Lead', position: 1, semantic: 'lead', completion: false },
    { id: randomUUID(), journeyVersionId: selfVersionId, key: 'activated', name: 'Activated', position: 2, semantic: 'activation', completion: false },
    { id: randomUUID(), journeyVersionId: selfVersionId, key: 'priced', name: 'Priced', position: 3, semantic: 'offer', completion: false },
    { id: randomUUID(), journeyVersionId: selfVersionId, key: 'sale', name: 'Sale', position: 4, semantic: 'sale', completion: true },
    { id: randomUUID(), journeyVersionId: agencyVersionId, key: 'lead', name: 'Lead', position: 1, semantic: 'lead', completion: false },
    { id: randomUUID(), journeyVersionId: agencyVersionId, key: 'appointment', name: 'Appointment', position: 2, semantic: 'appointment', completion: false },
    { id: randomUUID(), journeyVersionId: agencyVersionId, key: 'presentation', name: 'Presentation', position: 3, semantic: 'presentation', completion: false },
    { id: randomUUID(), journeyVersionId: agencyVersionId, key: 'sale', name: 'Sale', position: 4, semantic: 'sale', completion: true },
  ];
  await ownerQuery(
    pool,
    `INSERT INTO app.conversion_journey_milestones
       (id, workspace_id, journey_version_id, milestone_key, name,
        position, semantic, is_completion)
     SELECT row.id, $1, row.journey_version_id, row.milestone_key,
            row.name, row.position, row.semantic, row.is_completion
     FROM jsonb_to_recordset($2::jsonb) AS row(
       id uuid, journey_version_id uuid, milestone_key text, name text,
       position integer, semantic text, is_completion boolean
     )`,
    [
      workspaceId,
      JSON.stringify(milestones.map((milestone) => ({
        id: milestone.id,
        journey_version_id: milestone.journeyVersionId,
        milestone_key: milestone.key,
        name: milestone.name,
        position: milestone.position,
        semantic: milestone.semantic,
        is_completion: milestone.completion,
      }))),
    ],
  );
  const milestone = Object.fromEntries(
    milestones.map((row) => [`${row.journeyVersionId}:${row.key}`, row.id]),
  );
  const triggers = [
    { journeyVersionId: selfVersionId, milestoneId: milestone[`${selfVersionId}:lead`], kind: 'event', source: 'identity.account.created' },
    { journeyVersionId: selfVersionId, milestoneId: milestone[`${selfVersionId}:activated`], kind: 'event', source: 'product.analysis.completed' },
    { journeyVersionId: selfVersionId, milestoneId: milestone[`${selfVersionId}:priced`], kind: 'event', source: 'offer.presented' },
    { journeyVersionId: selfVersionId, milestoneId: milestone[`${selfVersionId}:sale`], kind: 'commerce', source: 'payment_collected' },
    { journeyVersionId: agencyVersionId, milestoneId: milestone[`${agencyVersionId}:appointment`], kind: 'event', source: 'sales.appointment.booked' },
    { journeyVersionId: agencyVersionId, milestoneId: milestone[`${agencyVersionId}:presentation`], kind: 'event', source: 'sales.presentation.completed' },
    { journeyVersionId: agencyVersionId, milestoneId: milestone[`${agencyVersionId}:sale`], kind: 'commerce', source: 'payment_collected' },
  ];
  await ownerQuery(
    pool,
    `INSERT INTO app.conversion_journey_triggers
       (workspace_id, journey_version_id, milestone_id, trigger_kind, source_key)
     SELECT $1, row.journey_version_id, row.milestone_id,
            row.trigger_kind, row.source_key
     FROM jsonb_to_recordset($2::jsonb) AS row(
       journey_version_id uuid, milestone_id uuid,
       trigger_kind text, source_key text
     )`,
    [
      workspaceId,
      JSON.stringify(triggers.map((trigger) => ({
        journey_version_id: trigger.journeyVersionId,
        milestone_id: trigger.milestoneId,
        trigger_kind: trigger.kind,
        source_key: trigger.source,
      }))),
    ],
  );
  await ownerQuery(
    pool,
    `UPDATE app.lead_score_models
        SET status = 'active', active_version_id = $2,
            row_version = row_version + 1, updated_at = statement_timestamp()
      WHERE workspace_id = $1 AND id = $3`,
    [workspaceId, scoreVersionId, scoreModelId],
  );
  await ownerQuery(
    pool,
    `UPDATE app.conversion_journeys AS journey
        SET status = 'active',
            active_version_id = CASE journey.id WHEN $2::uuid THEN $3::uuid ELSE $4::uuid END,
            row_version = journey.row_version + 1,
            updated_at = statement_timestamp()
      WHERE journey.workspace_id = $1 AND journey.id IN ($2::uuid, $5::uuid)`,
    [workspaceId, selfJourneyId, selfVersionId, agencyVersionId, agencyJourneyId],
  );
}

function sourceEvent(
  type: string,
  subjectId: string,
  data: Record<string, unknown>,
  occurredAt = '2026-08-25T12:00:00.000Z',
): SourceEvent {
  return {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt,
    correlationId: randomUUID(),
    subject: { kind: 'account', id: subjectId },
    data,
  };
}

function userReadRunner(pool: Pool): CrmTransactionRunner {
  return {
    async run(context, operation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query('SET LOCAL ROLE r72_web');
        await client.query(
          `SELECT
             set_config('app.user_id', $1, true),
             set_config('app.workspace_id', $2, true),
             set_config('app.actor_kind', 'user', true),
             set_config('app.request_id', $3, true)`,
          [context.userId, context.workspaceId, context.requestId],
        );
        const result = await operation({
          query: async (sql, values = []) => {
            const queryResult = await client.query(sql, Array.from(values));
            return { rows: queryResult.rows, rowCount: queryResult.rowCount };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

test('disposable PostgreSQL projects canonical Growth evidence only through the narrow function', {
  skip,
  timeout: 90_000,
}, async () => {
  const pool = await openTestDatabase();
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  const missingSubject = randomUUID();
  const quarantinedSubject = randomUUID();
  const quarantinedContactId = randomUUID();
  const affiliateId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

  const identity = sourceEvent('identity.account.created', subjectA, {
    email: 'growth-projector@example.test',
    signupMethod: 'google',
    displayName: 'Growth Projector Lead',
  });
  const duplicateEmailIdentity = sourceEvent('identity.account.created', subjectB, {
    email: 'growth-projector@example.test',
    signupMethod: 'password',
  });
  const quarantinedEmailIdentity = sourceEvent(
    'identity.account.created',
    quarantinedSubject,
    { email: 'quarantined@example.test', signupMethod: 'password' },
  );
  const content = sourceEvent('content.consumption.progressed', subjectA, {
    contentKey: '2026:deal-analysis',
    contentVersion: '2026.08',
    title: 'Deal Analysis Foundations',
    medium: 'video',
    progressBasisPoints: 6200,
    consumedSeconds: 186,
  }, '2026-08-25T12:01:00.000Z');
  const presentation = sourceEvent('offer.presented', subjectA, {
    offerKey: '2026:pro-investor',
    offerVersion: '2026.08',
    productKey: '2026:pro',
    label: 'Pro Investor Annual',
    price: { amountMinor: 99000, currency: 'gbp' },
    placement: '2026:academy-completion',
  }, '2026-08-25T12:02:00.000Z');
  const response = sourceEvent('offer.responded', subjectA, {
    presentationEventId: presentation.id,
    response: 'requested_contact',
  }, '2026-08-25T12:03:00.000Z');
  const attribution = sourceEvent('affiliate.referral.attributed', subjectA, {
    affiliateId,
    referralCode: 'PP_GROWTH_72',
    model: 'last_click',
  }, '2026-08-25T12:04:00.000Z');
  const missingIdentityContent = sourceEvent(
    'content.consumption.completed',
    missingSubject,
    {
      contentKey: 'academy:missing-identity',
      contentVersion: '1',
      title: 'Missing identity',
      medium: 'article',
      progressBasisPoints: 10000,
      consumedSeconds: 20,
    },
  );
  const invalidContent = sourceEvent('content.consumption.progressed', subjectA, {
    contentKey: 'academy:invalid',
    contentVersion: '1',
    title: ' padded title',
    medium: 'article',
    progressBasisPoints: 100,
    consumedSeconds: 2,
  });
  const unsupportedConsent = sourceEvent('privacy.consent.updated', subjectA, {
    purpose: 'property_predator_marketing',
    channel: 'email',
    state: 'granted',
    source: 'registration',
  });

  try {
    await resetIdentityTables(pool);
    await ownerQuery(
      pool,
      `INSERT INTO app.organizations (id, name, slug, kind)
       VALUES ($1, 'Growth Projector A', $2, 'agency'),
              ($3, 'Growth Projector B', $4, 'agency')`,
      [
        organizationA,
        `growth-projector-a-${suffix}`,
        organizationB,
        `growth-projector-b-${suffix}`,
      ],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp()),
              ($3, $4, 'active', statement_timestamp())`,
      [
        userA,
        `growth-a-${suffix}@example.test`,
        userB,
        `growth-b-${suffix}@example.test`,
      ],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspaces
         (id, organization_id, legacy_tenant_key, name, slug)
       VALUES ($1, $2, NULL, 'Growth Workspace A', $3),
              ($4, $5, NULL, 'Growth Workspace B', $6)`,
      [
        workspaceA,
        organizationA,
        `growth-workspace-a-${suffix}`,
        workspaceB,
        organizationB,
        `growth-workspace-b-${suffix}`,
      ],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.organization_memberships
         (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active'), ($3, $4, 'owner', 'active')`,
      [organizationA, userA, organizationB, userB],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspace_memberships
         (workspace_id, organization_id, user_id, role, status,
          source_organization_id, granted_at)
       VALUES ($1, $2, $3, 'owner', 'active', $2, statement_timestamp()),
              ($4, $5, $6, 'owner', 'active', $5, statement_timestamp())`,
      [workspaceA, organizationA, userA, workspaceB, organizationB, userB],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.contacts
         (id, workspace_id, display_name, source)
       VALUES ($1, $2, 'Quarantined lead', 'manual')`,
      [quarantinedContactId, workspaceA],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.contact_points
         (workspace_id, contact_id, kind, value, normalized_value,
          is_primary, dedupe_state)
       VALUES ($2, $1, 'email', 'quarantined@example.test',
               'quarantined@example.test', false, 'quarantined')`,
      [quarantinedContactId, workspaceA],
    );

    for (const event of [
      content,
      identity,
      duplicateEmailIdentity,
      quarantinedEmailIdentity,
      presentation,
      response,
      attribution,
      missingIdentityContent,
      invalidContent,
      unsupportedConsent,
    ]) await recordEvent(pool, workspaceA, event);

    // The receipt insert and fact insert are one transaction, so a missing
    // identity cannot leave a false projection acknowledgement behind.
    await expectPostgresError(projectEvent(pool, workspaceA, content.id), '23503');
    assert.deepEqual(
      await ownerQuery<{ count: number }>(
        pool,
        `SELECT count(*)::integer AS count
         FROM app_private.external_event_projection_receipts
         WHERE workspace_id = $1 AND event_id = $2`,
        [workspaceA, content.id],
      ),
      [{ count: 0 }],
    );

    assert.deepEqual(
      await projectEvent(pool, workspaceA, identity.id),
      [{ disposition: 'projected', replayed: false }],
    );
    assert.deepEqual(
      await projectEvent(pool, workspaceA, identity.id),
      [{ disposition: 'projected', replayed: true }],
    );
    assert.deepEqual(
      await projectEvent(pool, workspaceA, duplicateEmailIdentity.id),
      [{ disposition: 'projected', replayed: false }],
    );
    assert.deepEqual(
      await projectEvent(pool, workspaceA, quarantinedEmailIdentity.id),
      [{ disposition: 'projected', replayed: false }],
    );

    for (const event of [content, presentation, response, attribution]) {
      assert.deepEqual(
        await projectEvent(pool, workspaceA, event.id),
        [{ disposition: 'projected', replayed: false }],
      );
    }

    await expectPostgresError(
      projectEvent(pool, workspaceA, missingIdentityContent.id),
      '23503',
    );
    await expectPostgresError(projectEvent(pool, workspaceA, invalidContent.id), '22023');
    await expectPostgresError(projectEvent(pool, workspaceA, unsupportedConsent.id), '22023');
    await expectPostgresError(projectEvent(pool, workspaceB, identity.id), '23503');

    const exact = await ownerQuery<{
      contacts: number;
      normal_contact_points: number;
      source_identities: number;
      quarantined_identity_contact_id: string;
      content_key: string;
      content_label: string;
      progress_basis_points: number;
      progress_seconds: number;
      offer_label: string;
      price_minor: string;
      currency: string;
      response: string;
      presentation_event_id: string;
      affiliate_id: string;
      referral_code: string;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.contacts
           WHERE workspace_id = $1) AS contacts,
         (SELECT count(*)::integer FROM app.contact_points
           WHERE workspace_id = $1 AND dedupe_state = 'normal')
           AS normal_contact_points,
         (SELECT count(*)::integer FROM app.contact_source_identities
           WHERE workspace_id = $1) AS source_identities,
         (SELECT identity.contact_id::text
          FROM app.contact_source_identities AS identity
          WHERE identity.workspace_id = $1
            AND identity.source_subject_id = $2)
           AS quarantined_identity_contact_id,
         content.content_key,
         content.content_label,
         content.progress_basis_points,
         content.progress_seconds,
         presented.offer_label,
         presented.price_minor::text,
         presented.currency,
         responded.response,
         presented.source_event_id::text AS presentation_event_id,
         attributed.affiliate_id::text,
         attributed.referral_code
       FROM app.content_consumption_facts AS content
       CROSS JOIN app.offer_presentation_facts AS presented
       CROSS JOIN app.offer_response_facts AS responded
       CROSS JOIN app.contact_attribution_facts AS attributed
       WHERE content.workspace_id = $1
         AND presented.workspace_id = $1
         AND responded.workspace_id = $1
         AND attributed.workspace_id = $1`,
      [workspaceA, quarantinedSubject],
    );
    assert.equal(exact.length, 1);
    const {
      quarantined_identity_contact_id: resolvedQuarantinedContactId,
      ...exactFacts
    } = exact[0]!;
    assert.deepEqual(exactFacts, {
      contacts: 3,
      normal_contact_points: 2,
      source_identities: 3,
      content_key: '2026:deal-analysis',
      content_label: 'Deal Analysis Foundations',
      progress_basis_points: 6200,
      progress_seconds: 186,
      offer_label: 'Pro Investor Annual',
      price_minor: '99000',
      currency: 'GBP',
      response: 'requested_contact',
      presentation_event_id: presentation.id,
      affiliate_id: affiliateId,
      referral_code: 'PP_GROWTH_72',
    });
    assert.notEqual(resolvedQuarantinedContactId, quarantinedContactId);

    assert.deepEqual(
      await scopedQuery<{ content: number; offers: number }>(
        pool,
        'r72_web',
        { workspaceId: workspaceA, userId: userA },
        `SELECT
           (SELECT count(*)::integer FROM app.content_consumption_facts) AS content,
           (SELECT count(*)::integer FROM app.offer_presentation_facts) AS offers`,
      ),
      [{ content: 1, offers: 1 }],
    );
    assert.deepEqual(
      await scopedQuery<{ content: number }>(
        pool,
        'r72_web',
        { workspaceId: workspaceB, userId: userB },
        'SELECT count(*)::integer AS content FROM app.content_consumption_facts',
      ),
      [{ content: 0 }],
    );

    const intelligence = await new GrowthIntelligenceReadService({
      transactionRunner: userReadRunner(pool),
    }).load({
      actorKind: 'user',
      workspaceId: workspaceA,
      userId: userA,
      requestId: 'growth-read-model-integration',
    });
    assert.deepEqual(intelligence.funnels, []);
    assert.deepEqual(intelligence.hotLeads, []);
    assert.deepEqual(intelligence.evidenceTotals, {
      contentStarted: 1,
      contentCompleted: 0,
      offersShown: 1,
      replies: 1,
      appointments: 0,
    });

    // No evidence value can be passed around the projector boundary.
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_webhook',
        { workspaceId: workspaceA },
        'SELECT id FROM app.content_consumption_facts',
      ),
      '42501',
    );
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_webhook',
        { workspaceId: workspaceA },
        `INSERT INTO app.content_consumption_facts
           (workspace_id, contact_id, contact_source_identity_id,
            source_subject_id, projection_receipt_id, medium, action,
            progress_basis_points, progress_seconds, content_key,
            content_version, content_label, source_system, source_event_id,
            source_event_type, source_payload_sha256, occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'video', 'progressed', 9999, 999,
                 'forged', '1', 'Forged', 'property_predator', $6,
                 'content.consumption.progressed', $7, statement_timestamp())`,
        [
          workspaceA,
          randomUUID(),
          randomUUID(),
          subjectA,
          randomUUID(),
          randomUUID(),
          Buffer.alloc(32),
        ],
      ),
      '42501',
    );
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_external_event_command',
        { workspaceId: workspaceA },
        `SELECT disposition, replayed
         FROM app_private.project_property_predator_growth_event($1::uuid)`,
        [identity.id],
      ),
      '42501',
    );

    const capability = await ownerQuery<{
      webhook_growth_table_privileges: number;
      command_table_privileges: number;
      projector_owner: string;
      projector_security_definer: boolean;
      projector_config: string[] | null;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE (namespace.nspname, relation.relname) IN (
            ('app', 'contact_source_identities'),
            ('app', 'content_consumption_facts'),
            ('app', 'offer_presentation_facts'),
            ('app', 'offer_response_facts'),
            ('app', 'contact_attribution_facts'),
            ('app_private', 'external_event_projection_receipts')
          ) AND (
            pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'SELECT')
            OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'INSERT')
            OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'UPDATE')
            OR pg_catalog.has_table_privilege('r72_webhook', relation.oid, 'DELETE')
          )) AS webhook_growth_table_privileges,
         (SELECT count(*)::integer
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname IN ('app', 'app_private')
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              pg_catalog.has_table_privilege(
                'r72_external_event_command', relation.oid, 'SELECT'
              )
              OR pg_catalog.has_table_privilege(
                'r72_external_event_command', relation.oid, 'INSERT'
              )
              OR pg_catalog.has_table_privilege(
                'r72_external_event_command', relation.oid, 'UPDATE'
              )
              OR pg_catalog.has_table_privilege(
                'r72_external_event_command', relation.oid, 'DELETE'
              )
            )) AS command_table_privileges,
         owner_role.rolname AS projector_owner,
         projector.prosecdef AS projector_security_definer,
         projector.proconfig AS projector_config
       FROM pg_catalog.pg_proc AS projector
       JOIN pg_catalog.pg_roles AS owner_role
         ON owner_role.oid = projector.proowner
       WHERE projector.oid = pg_catalog.to_regprocedure(
         'app_private.project_property_predator_growth_event(uuid)'
       )`,
    );
    assert.deepEqual(capability, [{
      webhook_growth_table_privileges: 0,
      command_table_privileges: 0,
      projector_owner: 'r72_growth_projector_definer',
      projector_security_definer: true,
      projector_config: ['search_path=pg_catalog'],
    }]);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});

test('disposable PostgreSQL projects the v2 Property Predator journey transactionally', {
  skip,
  timeout: 120_000,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const subjectId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const identity = sourceEvent('identity.account.created', subjectId, {
    email: `journey-${suffix}@example.test`,
    signupMethod: 'google',
    displayName: 'Journey Runtime Lead',
  }, '2035-01-01T00:00:00.000Z');
  const selfPayment = sourceEvent('commerce.purchase.completed', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_self_payment_001',
    checkoutSessionId: 'cs_self_001',
    productKey: 'pp-one-off',
    billingKind: 'one_off',
    amountMinor: 10000,
    currency: 'usd',
  }, '2035-01-01T00:26:00.000Z');
  const consent = sourceEvent('privacy.consent.updated', subjectId, {
    purpose: 'property_predator_marketing',
    channel: 'email',
    state: 'granted',
    source: 'account_preferences',
    email: `journey-${suffix}@example.test`,
    policyVersion: '2035.1',
    policyTextSha256: 'a'.repeat(64),
  }, '2035-01-01T00:06:00.000Z');
  const appointment = sourceEvent('sales.appointment.booked', subjectId, {
    appointmentId: 'appt_001',
    startsAt: '2035-01-01T00:30:00.000Z',
    bookingSource: 'team',
    meetingKind: 'strategy',
  }, '2035-01-01T00:10:00.000Z');
  const lateAnalysis = sourceEvent('product.analysis.completed', subjectId, {
    toolKey: 'deal-analysis',
    accessMode: 'free',
    unitsSpent: 1,
  }, '2035-01-01T00:09:00.000Z');
  const offer = sourceEvent('offer.presented', subjectId, {
    offerKey: 'pp:agency-pro',
    offerVersion: '2',
    productKey: 'pp:agency-pro',
    label: 'Agency Pro',
    price: { amountMinor: 10000, currency: 'usd' },
    placement: 'laps:presentation',
  }, '2035-01-01T00:11:00.000Z');
  const earlyPresentation = sourceEvent('sales.presentation.completed', subjectId, {
    appointmentId: 'appt_001',
    presentationKey: 'laps:agency-pro',
    durationSeconds: 1200,
    outcome: 'completed',
  }, '2035-01-01T00:09:30.000Z');
  const presentation = sourceEvent('sales.presentation.completed', subjectId, {
    appointmentId: 'appt_001',
    presentationKey: 'laps:agency-pro',
    durationSeconds: 1800,
    outcome: 'proposal_requested',
  }, '2035-01-01T00:12:00.000Z');
  const agencyPayment = sourceEvent('commerce.purchase.completed', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_agency_payment_001',
    checkoutSessionId: 'cs_agency_001',
    productKey: 'pp-agency-pro',
    billingKind: 'subscription',
    subscriptionId: 'sub_agency_001',
    amountMinor: 10000,
    currency: 'usd',
  }, '2035-01-01T00:20:00.000Z');
  const postAgencyCompletionAppointment = sourceEvent(
    'sales.appointment.booked',
    subjectId,
    {
      appointmentId: 'appt_agency_terminal_001',
      startsAt: '2035-01-01T01:00:00.000Z',
      bookingSource: 'team',
      meetingKind: 'strategy',
    },
    '2035-01-01T00:20:30.000Z',
  );
  const earlyRefund = sourceEvent('commerce.purchase.refunded', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_refund_early',
    checkoutSessionId: 'cs_agency_001',
    productKey: 'pp-agency-pro',
    amountMinor: 1000,
    currency: 'usd',
  }, '2035-01-01T00:19:00.000Z');
  const refundOne = sourceEvent('commerce.purchase.refunded', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_refund_001',
    checkoutSessionId: 'cs_agency_001',
    productKey: 'pp-agency-pro',
    amountMinor: 4000,
    currency: 'usd',
    reasonCode: 'customer_request',
  }, '2035-01-01T00:21:00.000Z');
  const refundTwo = sourceEvent('commerce.purchase.refunded', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_refund_002',
    checkoutSessionId: 'cs_agency_001',
    productKey: 'pp-agency-pro',
    amountMinor: 6000,
    currency: 'usd',
  }, '2035-01-01T00:22:00.000Z');
  const overRefund = sourceEvent('commerce.purchase.refunded', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_refund_003',
    checkoutSessionId: 'cs_agency_001',
    productKey: 'pp-agency-pro',
    amountMinor: 1,
    currency: 'usd',
  }, '2035-01-01T00:23:00.000Z');
  const earlyCancellation = sourceEvent('commerce.subscription.cancelled', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_cancel_early',
    subscriptionId: 'sub_agency_001',
    productKey: 'pp-agency-pro',
    effectiveAt: '2035-01-01T00:19:00.000Z',
  }, '2035-01-01T00:24:00.000Z');
  const cancellation = sourceEvent('commerce.subscription.cancelled', subjectId, {
    provider: 'stripe',
    providerEventId: 'evt_cancel_001',
    subscriptionId: 'sub_agency_001',
    productKey: 'pp-agency-pro',
    effectiveAt: '2035-01-01T00:25:00.000Z',
  }, '2035-01-01T00:24:00.000Z');
  const postCompletionAppointment = sourceEvent('sales.appointment.booked', subjectId, {
    appointmentId: 'appt_terminal_001',
    startsAt: '2035-01-02T00:00:00.000Z',
    bookingSource: 'self_serve_calendar',
    meetingKind: 'discovery',
  }, '2035-01-01T00:30:00.000Z');

  try {
    await resetIdentityTables(pool);
    await ownerQuery(
      pool,
      `INSERT INTO app.organizations (id, name, slug, kind)
       VALUES ($1, 'Journey Runtime', $2, 'agency')`,
      [organizationId, `journey-runtime-${suffix}`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [userId, `journey-owner-${suffix}@example.test`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspaces
         (id, organization_id, legacy_tenant_key, name, slug)
       VALUES ($1, $2, NULL, 'Journey Runtime Workspace', $3)`,
      [workspaceId, organizationId, `journey-runtime-workspace-${suffix}`],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.organization_memberships
         (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [organizationId, userId],
    );
    await ownerQuery(
      pool,
      `INSERT INTO app.workspace_memberships
         (workspace_id, organization_id, user_id, role, status,
          source_organization_id, granted_at)
       VALUES ($1, $2, $3, 'owner', 'active', $2, statement_timestamp())`,
      [workspaceId, organizationId, userId],
    );

    assert.deepEqual(
      await scopedQuery<{ ready: boolean }>(
        pool,
        'r72_webhook',
        { workspaceId, requestId: 'journey-readiness-empty' },
        'SELECT app_private.property_predator_journey_runtime_ready() AS ready',
      ),
      [{ ready: false }],
    );
    await installPropertyPredatorJourneyBlueprints(pool, workspaceId, userId);
    assert.deepEqual(
      await scopedQuery<{ ready: boolean }>(
        pool,
        'r72_webhook',
        { workspaceId, requestId: 'journey-readiness-installed' },
        'SELECT app_private.property_predator_journey_runtime_ready() AS ready',
      ),
      [{ ready: true }],
    );

    for (const event of [
      identity,
      selfPayment,
      consent,
      appointment,
      lateAnalysis,
      offer,
      earlyPresentation,
      presentation,
      agencyPayment,
      postAgencyCompletionAppointment,
      earlyRefund,
      refundOne,
      refundTwo,
      overRefund,
      earlyCancellation,
      cancellation,
      postCompletionAppointment,
    ]) await recordEvent(pool, workspaceId, event);

    assert.deepEqual(
      await projectEvent(pool, workspaceId, identity.id),
      [{ disposition: 'projected', replayed: false }],
    );
    const concurrentIdentity = await Promise.all([
      projectJourneyEvent(pool, workspaceId, identity.id, ':a'),
      projectJourneyEvent(pool, workspaceId, identity.id, ':b'),
    ]);
    assert.deepEqual(
      concurrentIdentity.flat().sort((left, right) => Number(left.replayed) - Number(right.replayed)),
      [
        {
          disposition: 'projected', replayed: false,
          enrollments_started: 1, milestones_achieved: 1,
          score_snapshots_written: 1, consent_facts_written: 0,
          commerce_facts_written: 0,
        },
        {
          disposition: 'projected', replayed: true,
          enrollments_started: 1, milestones_achieved: 1,
          score_snapshots_written: 1, consent_facts_written: 0,
          commerce_facts_written: 0,
        },
      ],
    );

    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, consent.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 0, milestones_achieved: 0,
      score_snapshots_written: 0, consent_facts_written: 1,
      commerce_facts_written: 0,
    }]);
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, appointment.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 1, milestones_achieved: 2,
      score_snapshots_written: 2, consent_facts_written: 0,
      commerce_facts_written: 0,
    }]);
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, lateAnalysis.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 0, milestones_achieved: 1,
      score_snapshots_written: 2, consent_facts_written: 0,
      commerce_facts_written: 0,
    }]);
    assert.deepEqual(
      await ownerQuery<{
        journey_slug: string;
        source_event_id: string;
        total_score: number;
        source_occurred_at: string;
        applied_rules: string[];
      }>(
        pool,
        `SELECT journey.slug::text AS journey_slug,
                snapshot.source_event_id,
                snapshot.total_score::integer AS total_score,
                snapshot.source_occurred_at::text AS source_occurred_at,
                snapshot.applied_rules
         FROM app.conversion_enrollments AS enrollment
         JOIN app.conversion_journeys AS journey
           ON journey.workspace_id = enrollment.workspace_id
          AND journey.id = enrollment.journey_id
         JOIN LATERAL (
           SELECT candidate.source_event_id, candidate.total_score,
                  candidate.source_occurred_at, candidate.applied_rules
           FROM app.lead_score_snapshots AS candidate
           WHERE candidate.workspace_id = enrollment.workspace_id
             AND candidate.enrollment_id = enrollment.id
           ORDER BY candidate.evaluated_at DESC, candidate.id DESC
           LIMIT 1
         ) AS snapshot ON true
         WHERE enrollment.workspace_id = $1
           AND snapshot.source_event_id = $2
         ORDER BY journey.slug::text`,
        [workspaceId, lateAnalysis.id],
      ),
      [
        {
          journey_slug: 'property-predator-agency-laps',
          source_event_id: lateAnalysis.id,
          total_score: 30,
          source_occurred_at: '2035-01-01 00:10:00+00',
          applied_rules: [
            'account-created', 'analysis-completed', 'appointment-booked',
          ],
        },
        {
          journey_slug: 'property-predator-self-serve',
          source_event_id: lateAnalysis.id,
          total_score: 30,
          source_occurred_at: '2035-01-01 00:10:00+00',
          applied_rules: [
            'account-created', 'analysis-completed', 'appointment-booked',
          ],
        },
      ],
    );
    assert.deepEqual(
      await ownerQuery<{ last_event_at: string }>(
        pool,
        `SELECT enrollment.last_event_at::text
         FROM app.conversion_enrollments AS enrollment
         JOIN app.conversion_journeys AS journey
           ON journey.workspace_id = enrollment.workspace_id
          AND journey.id = enrollment.journey_id
         WHERE enrollment.workspace_id = $1
           AND journey.slug = 'property-predator-agency-laps'`,
        [workspaceId],
      ),
      [{ last_event_at: '2035-01-01 00:10:00+00' }],
    );

    assert.deepEqual(
      await projectEvent(pool, workspaceId, offer.id),
      [{ disposition: 'projected', replayed: false }],
    );
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, offer.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 0, milestones_achieved: 1,
      score_snapshots_written: 2, consent_facts_written: 0,
      commerce_facts_written: 0,
    }]);

    await expectPostgresError(
      projectJourneyEvent(pool, workspaceId, earlyPresentation.id),
      '23514',
    );
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, presentation.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 0, milestones_achieved: 1,
      score_snapshots_written: 2, consent_facts_written: 0,
      commerce_facts_written: 0,
    }]);
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, agencyPayment.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 0, milestones_achieved: 1,
      score_snapshots_written: 1, consent_facts_written: 0,
      commerce_facts_written: 1,
    }]);
    assert.deepEqual(
      await projectJourneyEvent(
        pool,
        workspaceId,
        postAgencyCompletionAppointment.id,
      ),
      [{
        disposition: 'projected', replayed: false,
        enrollments_started: 0, milestones_achieved: 0,
        score_snapshots_written: 1, consent_facts_written: 0,
        commerce_facts_written: 0,
      }],
    );

    await expectPostgresError(
      projectJourneyEvent(pool, workspaceId, earlyRefund.id),
      '23514',
    );
    for (const refund of [refundOne, refundTwo]) {
      assert.deepEqual(await projectJourneyEvent(pool, workspaceId, refund.id), [{
        disposition: 'projected', replayed: false,
        enrollments_started: 0, milestones_achieved: 0,
        score_snapshots_written: 0, consent_facts_written: 0,
        commerce_facts_written: 1,
      }]);
    }
    await expectPostgresError(
      projectJourneyEvent(pool, workspaceId, overRefund.id),
      '23514',
    );
    await expectPostgresError(
      projectJourneyEvent(pool, workspaceId, earlyCancellation.id),
      '23514',
    );
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, cancellation.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 0, milestones_achieved: 0,
      score_snapshots_written: 0, consent_facts_written: 0,
      commerce_facts_written: 1,
    }]);
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, selfPayment.id), [{
      disposition: 'projected', replayed: false,
      enrollments_started: 0, milestones_achieved: 1,
      score_snapshots_written: 1, consent_facts_written: 0,
      commerce_facts_written: 1,
    }]);
    assert.deepEqual(
      await projectJourneyEvent(pool, workspaceId, postCompletionAppointment.id),
      [{
        disposition: 'projected', replayed: false,
        enrollments_started: 0, milestones_achieved: 0,
        score_snapshots_written: 0, consent_facts_written: 0,
        commerce_facts_written: 0,
      }],
    );

    const exact = await ownerQuery<{
      enrollments: number;
      completed_enrollments: number;
      milestone_facts: number;
      score_snapshots: number;
      consent_facts: number;
      commerce_facts: number;
      refund_total: string;
      agency_payment_route: string;
      self_payment_route: string;
      journey_receipts: number;
      outbox_events: number;
      invalid_outbox_times: number;
      identity_outbox_links: number;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::integer FROM app.conversion_enrollments
          WHERE workspace_id = $1) AS enrollments,
         (SELECT count(*)::integer FROM app.conversion_enrollments
          WHERE workspace_id = $1 AND status = 'completed') AS completed_enrollments,
         (SELECT count(*)::integer FROM app.conversion_milestone_facts
          WHERE workspace_id = $1) AS milestone_facts,
         (SELECT count(*)::integer FROM app.lead_score_snapshots
          WHERE workspace_id = $1) AS score_snapshots,
         (SELECT count(*)::integer FROM app.communication_consent_events
          WHERE workspace_id = $1) AS consent_facts,
         (SELECT count(*)::integer FROM app.conversion_commerce_facts
          WHERE workspace_id = $1) AS commerce_facts,
         (SELECT coalesce(sum(amount_minor), 0)::text
          FROM app.conversion_commerce_facts
          WHERE workspace_id = $1 AND fact_type = 'refund_issued') AS refund_total,
         (SELECT journey.slug::text
          FROM app.conversion_commerce_facts AS commerce
          JOIN app.conversion_enrollments AS enrollment
            ON enrollment.workspace_id = commerce.workspace_id
           AND enrollment.id = commerce.enrollment_id
          JOIN app.conversion_journeys AS journey
            ON journey.workspace_id = enrollment.workspace_id
           AND journey.id = enrollment.journey_id
          WHERE commerce.workspace_id = $1
            AND commerce.source_event_id = $2) AS agency_payment_route,
         (SELECT journey.slug::text
          FROM app.conversion_commerce_facts AS commerce
          JOIN app.conversion_enrollments AS enrollment
            ON enrollment.workspace_id = commerce.workspace_id
           AND enrollment.id = commerce.enrollment_id
          JOIN app.conversion_journeys AS journey
            ON journey.workspace_id = enrollment.workspace_id
           AND journey.id = enrollment.journey_id
          WHERE commerce.workspace_id = $1
            AND commerce.source_event_id = $3) AS self_payment_route,
         (SELECT count(*)::integer
          FROM app_private.external_event_journey_projection_receipts
          WHERE workspace_id = $1) AS journey_receipts,
         (SELECT count(*)::integer FROM app.outbox_events
          WHERE workspace_id = $1
            AND causation_id IS NOT NULL) AS outbox_events,
         (SELECT count(*)::integer FROM app.outbox_events
          WHERE workspace_id = $1 AND created_at < occurred_at) AS invalid_outbox_times,
         (SELECT count(*)::integer FROM app.outbox_events
          WHERE workspace_id = $1
            AND causation_id = $4
            AND correlation_id = $5) AS identity_outbox_links`,
      [
        workspaceId,
        agencyPayment.id,
        selfPayment.id,
        identity.id,
        identity.correlationId,
      ],
    );
    assert.deepEqual(exact, [{
      enrollments: 2,
      completed_enrollments: 2,
      milestone_facts: 8,
      score_snapshots: 12,
      consent_facts: 1,
      commerce_facts: 5,
      refund_total: '10000',
      agency_payment_route: 'property-predator-agency-laps',
      self_payment_route: 'property-predator-self-serve',
      journey_receipts: 13,
      outbox_events: 28,
      invalid_outbox_times: 0,
      identity_outbox_links: 3,
    }]);

    const contactRows = await ownerQuery<{ contact_id: string }>(
      pool,
      `SELECT contact_id::text
       FROM app.contact_source_identities
       WHERE workspace_id = $1
         AND source_system = 'property_predator'
         AND source_subject_id = $2`,
      [workspaceId, subjectId],
    );
    const contactId = contactRows[0]?.contact_id;
    assert.ok(contactId);
    const lead360 = await new Lead360ReadService({
      transactionRunner: userReadRunner(pool),
    }).load({
      actorKind: 'user',
      workspaceId,
      userId,
      requestId: 'journey-lead-360-integration',
    }, contactId);
    assert.ok(lead360);
    assert.deepEqual(
      lead360.journeys?.map((journey) => ({
        slug: journey.slug,
        status: journey.status,
        current: journey.stages.find((stage) => stage.isCurrent)?.semantic,
        score: journey.score?.total,
      })).sort((left, right) => (left.slug ?? '').localeCompare(right.slug ?? '')),
      [
        {
          slug: 'property-predator-agency-laps',
          status: 'completed',
          current: 'sale',
          score: 55,
        },
        {
          slug: 'property-predator-self-serve',
          status: 'completed',
          current: 'sale',
          score: 55,
        },
      ],
    );

    for (const relation of [
      'app.conversion_enrollments',
      'app.lead_score_models',
      'app.conversion_journey_versions',
      'app.communication_consent_events',
      'app.outbox_events',
      'app_private.external_event_journey_projection_receipts',
    ]) {
      await expectPostgresError(
        scopedQuery(
          pool,
          'r72_webhook',
          { workspaceId, requestId: `journey-table-blind:${relation}` },
          `SELECT * FROM ${relation} LIMIT 1`,
        ),
        '42501',
      );
    }

    const outboxBeforeReplay = exact[0]!.outbox_events;
    assert.deepEqual(await projectJourneyEvent(pool, workspaceId, cancellation.id), [{
      disposition: 'projected', replayed: true,
      enrollments_started: 0, milestones_achieved: 0,
      score_snapshots_written: 0, consent_facts_written: 0,
      commerce_facts_written: 1,
    }]);
    assert.deepEqual(
      await ownerQuery<{ count: number }>(
        pool,
        `SELECT count(*)::integer AS count FROM app.outbox_events
         WHERE workspace_id = $1 AND causation_id IS NOT NULL`,
        [workspaceId],
      ),
      [{ count: outboxBeforeReplay }],
    );
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
