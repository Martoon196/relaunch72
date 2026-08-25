import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import type { CrmTransactionRunner } from '../../src/crm-pg/types.js';
import { GrowthIntelligenceReadService } from '../../src/conversion-pg/index.js';
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
