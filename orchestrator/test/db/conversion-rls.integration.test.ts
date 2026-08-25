import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  scopedQuery,
  testDatabaseSkipReason,
  withOwnerClient,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

interface ConversionFixture {
  readonly workspaceId: string;
  readonly managerUserId: string;
  readonly contactId: string;
  readonly contactPointId: string;
  readonly scoreModelId: string;
  readonly scoreModelVersionId: string;
  readonly journeyId: string;
  readonly journeyVersionId: string;
  readonly leadMilestoneId: string;
  readonly saleMilestoneId: string;
  readonly enrollmentId: string;
  readonly consentId: string;
  readonly suppressionId: string;
  readonly commerceFactId: string;
  readonly milestoneFactId: string;
  readonly scoreSnapshotId: string;
}

function conversionFixture(
  workspaceId: string,
  managerUserId: string,
  contactId: string,
  contactPointId: string,
): ConversionFixture {
  return {
    workspaceId,
    managerUserId,
    contactId,
    contactPointId,
    scoreModelId: randomUUID(),
    scoreModelVersionId: randomUUID(),
    journeyId: randomUUID(),
    journeyVersionId: randomUUID(),
    leadMilestoneId: randomUUID(),
    saleMilestoneId: randomUUID(),
    enrollmentId: randomUUID(),
    consentId: randomUUID(),
    suppressionId: randomUUID(),
    commerceFactId: randomUUID(),
    milestoneFactId: randomUUID(),
    scoreSnapshotId: randomUUID(),
  };
}

async function publishJourney(pool: Pool, fixture: ConversionFixture): Promise<void> {
  const context = { workspaceId: fixture.workspaceId, userId: fixture.managerUserId };
  await scopedQuery(
    pool,
    'r72_crm_command',
    context,
    `INSERT INTO app.lead_score_models
       (id, workspace_id, slug, name, created_by_user_id)
     VALUES ($1, $2, 'property-predator-score', 'Property Predator score', $3)`,
    [fixture.scoreModelId, fixture.workspaceId, fixture.managerUserId],
  );
  await scopedQuery(
    pool,
    'r72_crm_command',
    context,
    `INSERT INTO app.lead_score_model_versions
       (id, workspace_id, model_id, version_no, definition,
        definition_sha256, created_by_user_id)
     VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
    [
      fixture.scoreModelVersionId,
      fixture.workspaceId,
      fixture.scoreModelId,
      JSON.stringify({ components: [], bands: [], rules: [] }),
      randomBytes(32),
      fixture.managerUserId,
    ],
  );
  assert.deepEqual(await scopedQuery<{ id: string }>(
    pool,
    'r72_crm_command',
    context,
    `UPDATE app.lead_score_models
        SET status = 'active', active_version_id = $1,
            row_version = row_version + 1, updated_at = statement_timestamp()
      WHERE id = $2
      RETURNING id`,
    [fixture.scoreModelVersionId, fixture.scoreModelId],
  ), [{ id: fixture.scoreModelId }]);

  await scopedQuery(
    pool,
    'r72_crm_command',
    context,
    `INSERT INTO app.conversion_journeys
       (id, workspace_id, slug, name, description, created_by_user_id)
     VALUES ($1, $2, 'property-predator-laps', 'Property Predator LAPS',
             'Integration-tested conversion journey.', $3)`,
    [fixture.journeyId, fixture.workspaceId, fixture.managerUserId],
  );
  await scopedQuery(
    pool,
    'r72_crm_command',
    context,
    `INSERT INTO app.conversion_journey_versions
       (id, workspace_id, journey_id, version_no, score_model_version_id,
        settings, definition_sha256, created_by_user_id)
     VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, $5, $6)`,
    [
      fixture.journeyVersionId,
      fixture.workspaceId,
      fixture.journeyId,
      fixture.scoreModelVersionId,
      randomBytes(32),
      fixture.managerUserId,
    ],
  );
  await scopedQuery(
    pool,
    'r72_crm_command',
    context,
    `INSERT INTO app.conversion_journey_milestones
       (id, workspace_id, journey_version_id, milestone_key, name,
        position, semantic, is_completion)
     VALUES ($1, $2, $3, 'lead', 'Lead', 1, 'lead', false),
            ($4, $2, $3, 'sale', 'Sale', 2, 'sale', true)`,
    [
      fixture.leadMilestoneId,
      fixture.workspaceId,
      fixture.journeyVersionId,
      fixture.saleMilestoneId,
    ],
  );
  await expectPostgresError(
    scopedQuery(
      pool,
      'r72_crm_command',
      context,
      `INSERT INTO app.conversion_journey_triggers
         (workspace_id, journey_version_id, milestone_id, trigger_kind, source_key)
       VALUES ($1, $2, $3, 'event', 'privacy.preference.updated')`,
      [fixture.workspaceId, fixture.journeyVersionId, fixture.leadMilestoneId],
    ),
    '23514',
  );
  await scopedQuery(
    pool,
    'r72_crm_command',
    context,
    `INSERT INTO app.conversion_journey_triggers
       (workspace_id, journey_version_id, milestone_id, trigger_kind, source_key)
     VALUES ($1, $2, $3, 'event', 'identity.account.created'),
            ($1, $2, $4, 'commerce', 'payment_collected')`,
    [
      fixture.workspaceId,
      fixture.journeyVersionId,
      fixture.leadMilestoneId,
      fixture.saleMilestoneId,
    ],
  );
  assert.deepEqual(await scopedQuery<{ id: string; status: string }>(
    pool,
    'r72_crm_command',
    context,
    `UPDATE app.conversion_journeys
        SET status = 'active', active_version_id = $1,
            row_version = row_version + 1, updated_at = statement_timestamp()
      WHERE id = $2
      RETURNING id, status`,
    [fixture.journeyVersionId, fixture.journeyId],
  ), [{ id: fixture.journeyId, status: 'active' }]);
}

async function createEnrollment(pool: Pool, fixture: ConversionFixture): Promise<void> {
  await scopedQuery(
    pool,
    'r72_crm_command',
    { workspaceId: fixture.workspaceId, userId: fixture.managerUserId },
    `INSERT INTO app.conversion_enrollments
       (id, workspace_id, journey_id, journey_version_id,
        score_model_version_id, contact_id, enrollment_key,
        current_milestone_id, source, enrolled_by_kind, enrolled_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             'integration-test', 'user', $9)`,
    [
      fixture.enrollmentId,
      fixture.workspaceId,
      fixture.journeyId,
      fixture.journeyVersionId,
      fixture.scoreModelVersionId,
      fixture.contactId,
      `integration:${fixture.enrollmentId}`,
      fixture.leadMilestoneId,
      fixture.managerUserId,
    ],
  );
}

async function recordConsent(pool: Pool, fixture: ConversionFixture): Promise<void> {
  await scopedQuery(
    pool,
    'r72_crm_command',
    { workspaceId: fixture.workspaceId, userId: fixture.managerUserId },
    `INSERT INTO app.communication_consent_events
       (id, workspace_id, contact_id, contact_point_id, channel, purpose,
        state, lawful_basis, source, source_event_id, actor_kind,
        actor_user_id, occurred_at)
     VALUES ($1, $2, $3, $4, 'email', 'marketing', 'granted', 'consent',
             'integration-test', $5, 'user', $6, statement_timestamp())`,
    [
      fixture.consentId,
      fixture.workspaceId,
      fixture.contactId,
      fixture.contactPointId,
      `consent:${fixture.consentId}`,
      fixture.managerUserId,
    ],
  );
}

async function recordSuppression(pool: Pool, fixture: ConversionFixture): Promise<void> {
  await ownerQuery(
    pool,
    `INSERT INTO app.communication_suppression_events
       (id, workspace_id, contact_id, contact_point_id, channel, purpose,
        state, reason, source, source_event_id, actor_kind, occurred_at)
     VALUES ($1, $2, $3, $4, 'email', 'marketing', 'suppressed',
             'provider-bounce', 'integration-test', $5, 'webhook',
             statement_timestamp())`,
    [
      fixture.suppressionId,
      fixture.workspaceId,
      fixture.contactId,
      fixture.contactPointId,
      `suppression:${fixture.suppressionId}`,
    ],
  );
}

async function recordScore(pool: Pool, fixture: ConversionFixture): Promise<void> {
  await ownerQuery(
    pool,
    `INSERT INTO app.lead_score_snapshots
       (id, workspace_id, enrollment_id, contact_id, score_model_version_id,
        total_score, band_key, component_scores, reasons, applied_rules,
        source_system, source_event_id, source_payload_sha256, actor_kind,
        source_occurred_at)
     VALUES ($1, $2, $3, $4, $5, 70, 'burning', '{"engagement":70}'::jsonb,
             '["integration evidence"]'::jsonb, '["integration-rule"]'::jsonb,
             'integration-test', $6, $7, 'webhook', statement_timestamp())`,
    [
      fixture.scoreSnapshotId,
      fixture.workspaceId,
      fixture.enrollmentId,
      fixture.contactId,
      fixture.scoreModelVersionId,
      `score:${fixture.scoreSnapshotId}`,
      randomBytes(32),
    ],
  );
}

async function recordPaidSale(pool: Pool, fixture: ConversionFixture): Promise<void> {
  await ownerQuery(
    pool,
    `INSERT INTO app.conversion_commerce_facts
       (id, workspace_id, enrollment_id, contact_id, source_system,
        source_event_id, source_payload_sha256, fact_type, external_order_id,
        product_key, amount_minor, currency, actor_kind, occurred_at)
     VALUES ($1, $2, $3, $4, 'stripe', $5, $6, 'payment_collected', $7,
             'property-predator', 9900, 'GBP', 'webhook', statement_timestamp())`,
    [
      fixture.commerceFactId,
      fixture.workspaceId,
      fixture.enrollmentId,
      fixture.contactId,
      `evt_${fixture.commerceFactId}`,
      randomBytes(32),
      `order_${fixture.commerceFactId}`,
    ],
  );
  await ownerQuery(
    pool,
    `INSERT INTO app.conversion_milestone_facts
       (id, workspace_id, enrollment_id, contact_id, journey_version_id,
        milestone_id, milestone_semantic, source_kind, commerce_fact_id,
        commerce_fact_type, actor_kind, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'sale', 'commerce', $7,
             'payment_collected', 'webhook', statement_timestamp())`,
    [
      fixture.milestoneFactId,
      fixture.workspaceId,
      fixture.enrollmentId,
      fixture.contactId,
      fixture.journeyVersionId,
      fixture.saleMilestoneId,
      fixture.commerceFactId,
    ],
  );
  assert.deepEqual(await ownerQuery<{ id: string; status: string; current_milestone_id: string }>(
    pool,
    `UPDATE app.conversion_enrollments
        SET status = 'completed', current_milestone_id = $1,
            last_event_at = statement_timestamp(), ended_at = statement_timestamp(),
            row_version = row_version + 1, updated_at = statement_timestamp()
      WHERE id = $2
      RETURNING id, status, current_milestone_id`,
    [fixture.saleMilestoneId, fixture.enrollmentId],
  ), [{
    id: fixture.enrollmentId,
    status: 'completed',
    current_milestone_id: fixture.saleMilestoneId,
  }]);
}

async function cleanupConversionFixtures(
  pool: Pool,
  workspaceIds: readonly string[],
  organizationIds: readonly string[],
  userIds: readonly string[],
): Promise<void> {
  await withOwnerClient(pool, async (client) => {
    const workspaces = [...workspaceIds];
    await client.query('DELETE FROM app.lead_score_snapshots WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.conversion_milestone_facts WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.conversion_commerce_facts WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.communication_suppression_events WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.communication_consent_events WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.conversion_enrollments WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.conversion_journeys WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.lead_score_models WHERE workspace_id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.workspaces WHERE id = ANY ($1::uuid[])', [workspaces]);
    await client.query('DELETE FROM app.organizations WHERE id = ANY ($1::uuid[])', [[...organizationIds]]);
    await client.query('DELETE FROM app.users WHERE id = ANY ($1::uuid[])', [[...userIds]]);
  });
}

test('real PostgreSQL enforces conversion publishing, tenant RLS, immutable evidence, and payment-backed sales', {
  skip,
  timeout: 180_000,
}, async () => {
  const pool = await openTestDatabase();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const managerA = randomUUID();
  const managerB = randomUUID();
  const salesA = randomUUID();
  const viewerA = randomUUID();
  const contactA = randomUUID();
  const contactB = randomUUID();
  const contactPointA = randomUUID();
  const contactPointB = randomUUID();
  const fixtureA = conversionFixture(workspaceA, managerA, contactA, contactPointA);
  const fixtureB = conversionFixture(workspaceB, managerB, contactB, contactPointB);
  const alternateScoreVersionA = randomUUID();
  const alternateJourneyVersionA = randomUUID();
  const alternateJourneyCompletionA = randomUUID();
  const workspaceIds = [workspaceA, workspaceB] as const;
  const organizationIds = [organizationA, organizationB] as const;
  const userIds = [managerA, managerB, salesA, viewerA] as const;

  try {
    await withOwnerClient(pool, async (client) => {
      await client.query(
        `INSERT INTO app.organizations (id, name, slug, kind)
         VALUES ($1, 'Conversion tenant A', $2, 'direct_customer'),
                ($3, 'Conversion tenant B', $4, 'direct_customer')`,
        [organizationA, `conversion-a-${suffix}`, organizationB, `conversion-b-${suffix}`],
      );
      await client.query(
        `INSERT INTO app.users (id, email, status)
         VALUES ($1, $5, 'active'), ($2, $6, 'active'),
                ($3, $7, 'active'), ($4, $8, 'active')`,
        [
          managerA,
          managerB,
          salesA,
          viewerA,
          `manager-a-${suffix}@example.test`,
          `manager-b-${suffix}@example.test`,
          `sales-a-${suffix}@example.test`,
          `viewer-a-${suffix}@example.test`,
        ],
      );
      await client.query(
        `INSERT INTO app.workspaces (id, organization_id, name, slug)
         VALUES ($1, $2, 'Conversion workspace A', $3),
                ($4, $5, 'Conversion workspace B', $6)`,
        [
          workspaceA,
          organizationA,
          `conversion-workspace-a-${suffix}`,
          workspaceB,
          organizationB,
          `conversion-workspace-b-${suffix}`,
        ],
      );
      await client.query(
        `INSERT INTO app.workspace_memberships
           (workspace_id, organization_id, user_id, role, status)
         VALUES ($1, $2, $3, 'owner', 'active'),
                ($1, $2, $4, 'sales', 'active'),
                ($1, $2, $5, 'viewer', 'active'),
                ($6, $7, $8, 'owner', 'active')`,
        [workspaceA, organizationA, managerA, salesA, viewerA, workspaceB, organizationB, managerB],
      );
      await client.query(
        `INSERT INTO app.contacts
           (id, workspace_id, display_name, owner_user_id, source)
         VALUES ($1, $2, 'Conversion lead A', $3, 'integration-test'),
                ($4, $5, 'Conversion lead B', $6, 'integration-test')`,
        [contactA, workspaceA, managerA, contactB, workspaceB, managerB],
      );
      await client.query(
        `INSERT INTO app.contact_points
           (id, workspace_id, contact_id, kind, value, normalized_value, is_verified)
         VALUES ($1, $2, $3, 'email', $4, $4, true),
                ($5, $6, $7, 'email', $8, $8, true)`,
        [
          contactPointA,
          workspaceA,
          contactA,
          `lead-a-${suffix}@example.test`,
          contactPointB,
          workspaceB,
          contactB,
          `lead-b-${suffix}@example.test`,
        ],
      );
    });

    await publishJourney(pool, fixtureA);
    await publishJourney(pool, fixtureB);
    assert.deepEqual(await ownerQuery<{
      score_published: boolean;
      journey_published: boolean;
    }>(
      pool,
      `SELECT score_version.published_at IS NOT NULL AS score_published,
              journey_version.published_at IS NOT NULL AS journey_published
         FROM app.lead_score_model_versions AS score_version
         CROSS JOIN app.conversion_journey_versions AS journey_version
        WHERE score_version.id = $1 AND journey_version.id = $2`,
      [fixtureA.scoreModelVersionId, fixtureA.journeyVersionId],
    ), [{ score_published: true, journey_published: true }]);

    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `UPDATE app.conversion_journeys
          SET status = 'archived', row_version = row_version + 1,
              updated_at = statement_timestamp()
        WHERE id = $1`,
      [fixtureA.journeyId],
    );
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: managerA },
        `INSERT INTO app.conversion_journey_milestones
           (workspace_id, journey_version_id, milestone_key, name,
            position, semantic, is_completion)
         VALUES ($1, $2, 'late-append', 'Late append', 3, 'custom', false)`,
        [workspaceA, fixtureA.journeyVersionId],
      ),
      '55000',
    );
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.conversion_journey_triggers
           (workspace_id, journey_version_id, milestone_id, trigger_kind, source_key)
         VALUES ($1, $2, $3, 'event', 'product.analysis.completed')`,
        [workspaceA, fixtureA.journeyVersionId, fixtureA.leadMilestoneId],
      ),
      '55000',
    );
    assert.deepEqual(await scopedQuery<{ id: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `UPDATE app.conversion_journeys
          SET status = 'active', active_version_id = $1,
              row_version = row_version + 1, updated_at = statement_timestamp()
        WHERE id = $2
        RETURNING id`,
      [fixtureA.journeyVersionId, fixtureA.journeyId],
    ), [{ id: fixtureA.journeyId }]);
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `INSERT INTO app.lead_score_model_versions
         (id, workspace_id, model_id, version_no, definition,
          definition_sha256, created_by_user_id)
       VALUES ($1, $2, $3, 2, $4::jsonb, $5, $6)`,
      [
        alternateScoreVersionA,
        workspaceA,
        fixtureA.scoreModelId,
        JSON.stringify({ components: [], bands: [], rules: [], alternate: true }),
        randomBytes(32),
        managerA,
      ],
    );
    assert.deepEqual(await scopedQuery<{ id: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `UPDATE app.lead_score_models
          SET status = 'active', active_version_id = $1,
              row_version = row_version + 1, updated_at = statement_timestamp()
        WHERE id = $2
        RETURNING id`,
      [alternateScoreVersionA, fixtureA.scoreModelId],
    ), [{ id: fixtureA.scoreModelId }]);
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: managerA },
        `UPDATE app.lead_score_models
            SET active_version_id = $1, row_version = row_version + 1,
                updated_at = statement_timestamp()
          WHERE id = $2`,
        [fixtureA.scoreModelVersionId, fixtureA.scoreModelId],
      ),
      '23514',
    );

    for (const [roleUserId, attemptedSlug] of [
      [salesA, `sales-model-${suffix}`],
      [viewerA, `viewer-model-${suffix}`],
    ] as const) {
      await expectPostgresError(
        scopedQuery(
          pool,
          'r72_crm_command',
          { workspaceId: workspaceA, userId: roleUserId },
          `INSERT INTO app.lead_score_models
             (workspace_id, slug, name, created_by_user_id)
           VALUES ($1, $2, 'Unauthorized model', $3)`,
          [workspaceA, attemptedSlug, roleUserId],
        ),
        '42501',
      );
      assert.deepEqual(await scopedQuery<{ id: string }>(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: roleUserId },
        `UPDATE app.conversion_journeys
            SET status = 'active', active_version_id = $1,
                row_version = row_version + 1, updated_at = statement_timestamp()
          WHERE id = $2
          RETURNING id`,
        [fixtureA.journeyVersionId, fixtureA.journeyId],
      ), []);
    }

    const mismatchedCommandEnrollmentId = randomUUID();
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: managerA },
        `INSERT INTO app.conversion_enrollments
           (id, workspace_id, journey_id, journey_version_id,
            score_model_version_id, contact_id, enrollment_key,
            current_milestone_id, source, enrolled_by_kind, enrolled_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 'integration-test', 'user', $9)`,
        [
          mismatchedCommandEnrollmentId,
          workspaceA,
          fixtureA.journeyId,
          fixtureA.journeyVersionId,
          alternateScoreVersionA,
          contactA,
          `mismatched-command:${mismatchedCommandEnrollmentId}`,
          fixtureA.leadMilestoneId,
          managerA,
        ],
      ),
      '42501',
    );
    const mismatchedWebhookEnrollmentId = randomUUID();
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_webhook',
        { workspaceId: workspaceA },
        `INSERT INTO app.conversion_enrollments
           (id, workspace_id, journey_id, journey_version_id,
            score_model_version_id, contact_id, enrollment_key,
            current_milestone_id, source, enrolled_by_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 'integration-test', 'webhook')`,
        [
          mismatchedWebhookEnrollmentId,
          workspaceA,
          fixtureA.journeyId,
          fixtureA.journeyVersionId,
          alternateScoreVersionA,
          contactA,
          `mismatched-webhook:${mismatchedWebhookEnrollmentId}`,
          fixtureA.leadMilestoneId,
        ],
      ),
      '42501',
    );

    await createEnrollment(pool, fixtureA);
    await createEnrollment(pool, fixtureB);
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.conversion_enrollments
           (workspace_id, journey_id, journey_version_id, score_model_version_id,
            contact_id, enrollment_key, current_milestone_id, source,
            enrolled_by_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'integration-test', 'system')`,
        [
          workspaceA,
          fixtureA.journeyId,
          fixtureA.journeyVersionId,
          fixtureA.scoreModelVersionId,
          contactB,
          `cross-workspace:${randomUUID()}`,
          fixtureA.leadMilestoneId,
        ],
      ),
      '23503',
    );

    for (const [role, context] of [
      ['r72_crm_command', { workspaceId: workspaceA, userId: managerA }],
      ['r72_webhook', { workspaceId: workspaceA }],
    ] as const) {
      await expectPostgresError(
        scopedQuery(
          pool,
          role,
          context,
          `UPDATE app.conversion_enrollments
              SET current_milestone_id = $1, row_version = row_version + 1,
                  updated_at = statement_timestamp()
            WHERE id = $2`,
          [fixtureA.saleMilestoneId, fixtureA.enrollmentId],
        ),
        '42501',
      );
    }

    await recordConsent(pool, fixtureA);
    await recordConsent(pool, fixtureB);
    await recordSuppression(pool, fixtureA);
    await recordSuppression(pool, fixtureB);
    await recordScore(pool, fixtureA);
    await recordScore(pool, fixtureB);

    const rejectedWebhookReleaseId = randomUUID();
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_webhook',
        { workspaceId: workspaceA },
        `INSERT INTO app.communication_suppression_events
           (id, workspace_id, contact_id, contact_point_id, channel, purpose,
            state, reason, source, source_event_id, actor_kind, occurred_at)
         VALUES ($1, $2, $3, $4, 'email', 'marketing', 'released',
                 'provider-release', 'integration-test', $5, 'webhook',
                 statement_timestamp())`,
        [
          rejectedWebhookReleaseId,
          workspaceA,
          contactA,
          contactPointA,
          `release:${rejectedWebhookReleaseId}`,
        ],
      ),
      '42501',
    );
    const rejectedSalesReleaseId = randomUUID();
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: salesA },
        `INSERT INTO app.communication_suppression_events
           (id, workspace_id, contact_id, contact_point_id, channel, purpose,
            state, reason, source, source_event_id, actor_kind, actor_user_id,
            occurred_at)
         VALUES ($1, $2, $3, $4, 'email', 'marketing', 'released',
                 'manual-review', 'integration-test', $5, 'user', $6,
                 statement_timestamp())`,
        [
          rejectedSalesReleaseId,
          workspaceA,
          contactA,
          contactPointA,
          `release:${rejectedSalesReleaseId}`,
          salesA,
        ],
      ),
      '42501',
    );
    const managerReleaseId = randomUUID();
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `INSERT INTO app.communication_suppression_events
         (id, workspace_id, contact_id, contact_point_id, channel, purpose,
          state, reason, source, source_event_id, actor_kind, actor_user_id,
          occurred_at)
       VALUES ($1, $2, $3, $4, 'email', 'marketing', 'released',
               'manual-review', 'integration-test', $5, 'user', $6,
               statement_timestamp())`,
      [
        managerReleaseId,
        workspaceA,
        contactA,
        contactPointA,
        `release:${managerReleaseId}`,
        managerA,
      ],
    );

    assert.deepEqual(await ownerQuery<{
      consent_digest_bytes: number;
      suppression_digest_bytes: number;
    }>(
      pool,
      `SELECT octet_length(consent.endpoint_identity_sha256) AS consent_digest_bytes,
              octet_length(suppression.endpoint_identity_sha256) AS suppression_digest_bytes
         FROM app.communication_consent_events AS consent
         CROSS JOIN app.communication_suppression_events AS suppression
        WHERE consent.id = $1 AND suppression.id = $2`,
      [fixtureA.consentId, managerReleaseId],
    ), [{ consent_digest_bytes: 32, suppression_digest_bytes: 32 }]);
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: managerA },
        `UPDATE app.contact_points
            SET value = $1, normalized_value = $1,
                row_version = row_version + 1, updated_at = statement_timestamp()
          WHERE id = $2`,
        [`manager-retarget-${suffix}@example.test`, contactPointA],
      ),
      '42501',
    );
    await ownerQuery(
      pool,
      `UPDATE app.contact_points
          SET value = $1, normalized_value = $1,
              row_version = row_version + 1, updated_at = statement_timestamp()
        WHERE id = $2`,
      [`owner-retarget-${suffix}@example.test`, contactPointA],
    );
    assert.deepEqual(await ownerQuery<{
      consent_matches_current_endpoint: boolean;
      suppression_matches_current_endpoint: boolean;
    }>(
      pool,
      `SELECT consent.endpoint_identity_sha256 = public.digest(
                point.kind || pg_catalog.chr(31)
                  || point.value || pg_catalog.chr(31)
                  || point.normalized_value,
                'sha256'
              ) AS consent_matches_current_endpoint,
              suppression.endpoint_identity_sha256 = public.digest(
                point.kind || pg_catalog.chr(31)
                  || point.value || pg_catalog.chr(31)
                  || point.normalized_value,
                'sha256'
              ) AS suppression_matches_current_endpoint
         FROM app.contact_points AS point
         CROSS JOIN app.communication_consent_events AS consent
         CROSS JOIN app.communication_suppression_events AS suppression
        WHERE point.id = $1 AND consent.id = $2 AND suppression.id = $3`,
      [contactPointA, fixtureA.consentId, managerReleaseId],
    ), [{
      consent_matches_current_endpoint: false,
      suppression_matches_current_endpoint: false,
    }]);

    await recordPaidSale(pool, fixtureA);
    await recordPaidSale(pool, fixtureB);

    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `INSERT INTO app.conversion_journey_versions
         (id, workspace_id, journey_id, version_no, score_model_version_id,
          settings, definition_sha256, created_by_user_id)
       VALUES ($1, $2, $3, 2, $4, '{}'::jsonb, $5, $6)`,
      [
        alternateJourneyVersionA,
        workspaceA,
        fixtureA.journeyId,
        alternateScoreVersionA,
        randomBytes(32),
        managerA,
      ],
    );
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `INSERT INTO app.conversion_journey_milestones
         (id, workspace_id, journey_version_id, milestone_key, name,
          position, semantic, is_completion)
       VALUES ($1, $2, $3, 'sale', 'Sale', 1, 'sale', true)`,
      [alternateJourneyCompletionA, workspaceA, alternateJourneyVersionA],
    );
    assert.deepEqual(await scopedQuery<{ id: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      `UPDATE app.conversion_journeys
          SET status = 'active', active_version_id = $1,
              row_version = row_version + 1, updated_at = statement_timestamp()
        WHERE id = $2
        RETURNING id`,
      [alternateJourneyVersionA, fixtureA.journeyId],
    ), [{ id: fixtureA.journeyId }]);
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: managerA },
        `UPDATE app.conversion_journeys
            SET active_version_id = $1, row_version = row_version + 1,
                updated_at = statement_timestamp()
          WHERE id = $2`,
        [fixtureA.journeyVersionId, fixtureA.journeyId],
      ),
      '23514',
    );
    assert.deepEqual(await ownerQuery<{ published: boolean }>(
      pool,
      `SELECT published_at IS NOT NULL AS published
         FROM app.conversion_journey_versions
        WHERE id = $1`,
      [alternateJourneyVersionA],
    ), [{ published: true }]);

    const expectedA = [{
      score_models: 1,
      journeys: 1,
      enrollments: 1,
      consent_facts: 1,
      suppression_facts: 2,
      commerce_facts: 1,
      milestone_facts: 1,
      score_facts: 1,
    }];
    for (const [role, context] of [
      ['r72_web', { workspaceId: workspaceA, userId: managerA }],
      ['r72_crm_command', { workspaceId: workspaceA, userId: managerA }],
      ['r72_worker', { workspaceId: workspaceA }],
    ] as const) {
      assert.deepEqual(await scopedQuery<{
        score_models: number;
        journeys: number;
        enrollments: number;
        consent_facts: number;
        suppression_facts: number;
        commerce_facts: number;
        milestone_facts: number;
        score_facts: number;
      }>(
        pool,
        role,
        context,
        `SELECT
           (SELECT count(*)::integer FROM app.lead_score_models) AS score_models,
           (SELECT count(*)::integer FROM app.conversion_journeys) AS journeys,
           (SELECT count(*)::integer FROM app.conversion_enrollments) AS enrollments,
           (SELECT count(*)::integer FROM app.communication_consent_events) AS consent_facts,
           (SELECT count(*)::integer FROM app.communication_suppression_events) AS suppression_facts,
           (SELECT count(*)::integer FROM app.conversion_commerce_facts) AS commerce_facts,
           (SELECT count(*)::integer FROM app.conversion_milestone_facts) AS milestone_facts,
           (SELECT count(*)::integer FROM app.lead_score_snapshots) AS score_facts`,
      ), expectedA, `${role} sees only the selected tenant's definitions and facts`);
      assert.deepEqual(await scopedQuery<{ id: string }>(
        pool,
        role,
        context,
        `SELECT id FROM app.conversion_journeys WHERE id = $1
         UNION ALL
         SELECT id FROM app.conversion_commerce_facts WHERE id = $2`,
        [fixtureB.journeyId, fixtureB.commerceFactId],
      ), []);
    }

    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_webhook',
        { workspaceId: workspaceA },
        'SELECT count(*) FROM app.conversion_journeys',
      ),
      '42501',
    );

    for (const fact of [
      {
        table: 'conversion_commerce_facts',
        column: 'metadata',
        id: fixtureA.commerceFactId,
        role: 'r72_webhook',
        context: { workspaceId: workspaceA },
      },
      {
        table: 'conversion_milestone_facts',
        column: 'evidence',
        id: fixtureA.milestoneFactId,
        role: 'r72_webhook',
        context: { workspaceId: workspaceA },
      },
      {
        table: 'lead_score_snapshots',
        column: 'reasons',
        id: fixtureA.scoreSnapshotId,
        role: 'r72_webhook',
        context: { workspaceId: workspaceA },
      },
      {
        table: 'communication_consent_events',
        column: 'evidence',
        id: fixtureA.consentId,
        role: 'r72_crm_command',
        context: { workspaceId: workspaceA, userId: managerA },
      },
      {
        table: 'communication_suppression_events',
        column: 'evidence',
        id: managerReleaseId,
        role: 'r72_crm_command',
        context: { workspaceId: workspaceA, userId: managerA },
      },
    ] as const) {
      await expectPostgresError(
        scopedQuery(
          pool,
          fact.role,
          fact.context,
          `UPDATE app.${fact.table} SET ${fact.column} = ${fact.column} WHERE id = $1`,
          [fact.id],
        ),
        '42501',
      );
      await expectPostgresError(
        scopedQuery(
          pool,
          fact.role,
          fact.context,
          `DELETE FROM app.${fact.table} WHERE id = $1`,
          [fact.id],
        ),
        '42501',
      );
    }

    await ownerQuery(
      pool,
      `UPDATE app.workspace_memberships
          SET status = 'revoked', revoked_at = statement_timestamp(),
              updated_at = statement_timestamp()
        WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceA, managerA],
    );
    assert.deepEqual(await scopedQuery<{ id: string }>(
      pool,
      'r72_web',
      { workspaceId: workspaceA, userId: managerA },
      'SELECT id FROM app.conversion_journeys WHERE id = $1',
      [fixtureA.journeyId],
    ), []);
    assert.deepEqual(await scopedQuery<{ id: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: managerA },
      'SELECT id FROM app.conversion_journeys WHERE id = $1',
      [fixtureA.journeyId],
    ), []);
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: managerA },
        `INSERT INTO app.communication_consent_events
           (workspace_id, contact_id, contact_point_id, channel, purpose,
            state, lawful_basis, source, actor_kind, actor_user_id, occurred_at)
         VALUES ($1, $2, $3, 'email', 'marketing', 'granted', 'consent',
                 'integration-test', 'user', $4, statement_timestamp())`,
        [workspaceA, contactA, contactPointA, managerA],
      ),
      '42501',
    );
  } finally {
    try {
      await cleanupConversionFixtures(pool, workspaceIds, organizationIds, userIds);
    } finally {
      await pool.end();
    }
  }
});
