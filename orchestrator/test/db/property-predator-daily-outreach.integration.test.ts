import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
  withOwnerClient,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const loginRoles = [
  'r72_daily_outreach_command',
  'r72_daily_outreach_read',
] as const;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

async function openRoleLoginPool(
  ownerPool: Pool,
  role: typeof loginRoles[number],
): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `daily-outreach-${randomUUID()}`;
  const client = await ownerPool.connect();
  try {
    const statement = await client.query<{ sql: string }>(
      `SELECT pg_catalog.format(
         'ALTER ROLE %I PASSWORD %L', $1::text, $2::text
       ) AS sql`,
      [role, password],
    );
    await client.query(statement.rows[0]!.sql);
  } finally {
    client.release();
  }
  const roleUrl = new URL(rawUrl);
  roleUrl.username = role;
  roleUrl.password = password;
  return new Pool({
    connectionString: roleUrl.toString(),
    max: 2,
    application_name: `relaunch72-disposable-${role}-test`,
  });
}

async function clearRolePasswords(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    for (const role of loginRoles) {
      await client.query(`ALTER ROLE ${role} PASSWORD NULL`);
    }
  } finally {
    client.release();
  }
}

async function roleQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  context: { workspaceId: string; userId: string; requestId: string },
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', $3, true)`,
      [context.userId, context.workspaceId, context.requestId],
    );
    const result = await client.query<T>(sql, [...values]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface Fixture {
  organizationId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  ownerId: string;
  otherOwnerId: string;
  contactIds: string[];
  pointIds: string[];
  contentItemId: string;
  contentVersionId: string;
  approvalRequestId: string;
  approvalDecisionId: string;
  contentSha256: Buffer;
}

async function seedFixture(pool: Pool): Promise<Fixture> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const contactIds = [randomUUID(), randomUUID(), randomUUID()];
  const pointIds = [randomUUID(), randomUUID(), randomUUID()];
  const contentItemId = randomUUID();
  const contentVersionId = randomUUID();
  const approvalRequestId = randomUUID();
  const approvalDecisionId = randomUUID();
  const body = 'Approved fictional Daily Outreach fixture copy.';
  const contentSha256 = digest(body);
  const suffix = organizationId.replaceAll('-', '').slice(0, 10);

  await resetIdentityTables(pool);
  await ownerQuery(pool,
    `INSERT INTO app.organizations (id, name, slug, kind, status)
     VALUES ($1, 'Daily Outreach integration', $2, 'direct_customer', 'active')`,
    [organizationId, `daily-outreach-${suffix}`]);
  await ownerQuery(pool,
    `INSERT INTO app.users (id, email, status, email_verified_at)
     VALUES
       ($1, $2, 'active', statement_timestamp()),
       ($3, $4, 'active', statement_timestamp())`,
    [
      ownerId, `outreach-${ownerId.slice(0, 8)}@example.test`,
      otherOwnerId, `outreach-${otherOwnerId.slice(0, 8)}@example.test`,
    ]);
  await ownerQuery(pool,
    `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
     VALUES
       ($1, $2, 'Daily Outreach A', $3, 'active'),
       ($4, $2, 'Daily Outreach B', $5, 'active')`,
    [
      workspaceId, organizationId, `outreach-a-${workspaceId.slice(0, 8)}`,
      otherWorkspaceId, `outreach-b-${otherWorkspaceId.slice(0, 8)}`,
    ]);
  await ownerQuery(pool,
    `INSERT INTO app.workspace_memberships (
       workspace_id, organization_id, user_id, role, status
     ) VALUES
       ($1, $2, $3, 'owner', 'active'),
       ($4, $2, $5, 'owner', 'active')`,
    [workspaceId, organizationId, ownerId, otherWorkspaceId, otherOwnerId]);

  await ownerQuery(pool,
    `INSERT INTO app.contacts (id, workspace_id, display_name, source)
     VALUES
       ($1, $4, 'Fictional prospect one', 'integration_fixture'),
       ($2, $4, 'Fictional prospect two', 'integration_fixture'),
       ($3, $4, 'Fictional prospect three', 'integration_fixture')`,
    [...contactIds, workspaceId]);
  await ownerQuery(pool,
    `INSERT INTO app.contact_points (
       id, workspace_id, contact_id, kind, value, normalized_value
     ) VALUES
       ($1, $7, $4, 'social', 'fixture:linkedin:one', 'fixture:linkedin:one'),
       ($2, $7, $5, 'social', 'fixture:linkedin:two', 'fixture:linkedin:two'),
       ($3, $7, $6, 'social', 'fixture:linkedin:three', 'fixture:linkedin:three')`,
    [...pointIds, ...contactIds, workspaceId]);

  await withOwnerClient(pool, async (client) => {
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', 'daily-outreach-content-fixture', true)`,
      [ownerId, workspaceId],
    );
    await client.query(
      `INSERT INTO app.company_content_items (
         id, workspace_id, source_system, source_item_id,
         created_by_user_id, created_request_id
       ) VALUES ($1, $2, 'daily_outreach_fixture', $3, $4, 'overwritten')`,
      [contentItemId, workspaceId, `fixture-${contentItemId}`, ownerId],
    );
    await client.query(
      `INSERT INTO app.company_content_versions (
         id, workspace_id, content_item_id, version_number, origin,
         content_kind, title, source_system, source_item_id, source_version,
         content_mime_type, content_body, blob_storage_key, blob_sha256,
         brand_snapshot_ref, brand_sha256, metadata,
         created_by_user_id, created_request_id
       ) VALUES (
         $1, $2, $3, 1, 'generated', 'social_post',
         'Daily Outreach fixture', 'daily_outreach_fixture', $4, 'v1',
         'text/plain', $5, $6, digest($5, 'sha256'),
         'brand-brain:fixture', digest('brand-brain:fixture', 'sha256'),
         '{"fixture":true}'::jsonb, $7, 'overwritten'
       )`,
      [
        contentVersionId, workspaceId, contentItemId,
        `fixture-${contentItemId}`, body,
        `company-content/${contentItemId}/v1`, ownerId,
      ],
    );
    await client.query(
      `INSERT INTO app.company_content_approval_requests (
         id, workspace_id, content_item_id, content_version_id,
         content_sha256, request_number, requested_by_user_id,
         requested_request_id
       ) VALUES ($1, $2, $3, $4, digest($5, 'sha256'), 1, $6, 'overwritten')`,
      [approvalRequestId, workspaceId, contentItemId, contentVersionId, body, ownerId],
    );
    await client.query(
      `INSERT INTO app.company_content_approval_decisions (
         id, workspace_id, content_item_id, content_version_id,
         approval_request_id, content_sha256, decision,
         decided_by_user_id, decided_request_id
       ) VALUES (
         $1, $2, $3, $4, $5, digest($6, 'sha256'),
         'approved', $7, 'overwritten'
       )`,
      [
        approvalDecisionId, workspaceId, contentItemId,
        contentVersionId, approvalRequestId, body, ownerId,
      ],
    );
  });

  return {
    organizationId, workspaceId, otherWorkspaceId, ownerId, otherOwnerId,
    contactIds, pointIds, contentItemId, contentVersionId,
    approvalRequestId, approvalDecisionId, contentSha256,
  };
}

test('0090 disposable proof completes only a fresh, unsuppressed, evidence-bound manual task', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const rolePools: Pool[] = [];
  try {
    const fixture = await seedFixture(pool);
    const commandPool = await openRoleLoginPool(pool, 'r72_daily_outreach_command');
    const readPool = await openRoleLoginPool(pool, 'r72_daily_outreach_read');
    rolePools.push(commandPool, readPool);
    const context = {
      workspaceId: fixture.workspaceId,
      userId: fixture.ownerId,
      requestId: 'daily-outreach-integration',
    };

    await expectPostgresError(roleQuery(
      commandPool, context,
      'SELECT * FROM app_private.daily_outreach_programme_versions',
    ), '42501');
    await expectPostgresError(roleQuery(
      readPool, context,
      'SELECT * FROM app_private.daily_outreach_queue_allocations',
    ), '42501');
    const directCapabilities = await ownerQuery<{
      role_name: string;
      any_column: boolean;
      any_table: boolean;
    }>(pool,
      `SELECT role_name,
              bool_or(has_any_column_privilege(
                role_name, relation.oid, 'SELECT,INSERT,UPDATE,REFERENCES'
              )) AS any_column,
              bool_or(has_table_privilege(
                role_name, relation.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              )) AS any_table
       FROM unnest(ARRAY[
         'r72_daily_outreach_command', 'r72_daily_outreach_read'
       ]) AS role_name
       CROSS JOIN pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname IN ('app', 'app_private')
         AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
       GROUP BY role_name
       ORDER BY role_name`);
    assert.deepEqual(directCapabilities, [
      { role_name: 'r72_daily_outreach_command', any_column: false, any_table: false },
      { role_name: 'r72_daily_outreach_read', any_column: false, any_table: false },
    ]);

    const programmes = await roleQuery<{
      disposition: string;
      programme_version_id: string;
    }>(commandPool, context,
      `SELECT * FROM app_private.publish_daily_outreach_programme_version(
         $1, 'founder_daily_linkedin', 1, NULL, 'linkedin', 'fictional',
         2, 2, 2, 3600, $2, CURRENT_DATE, NULL
       )`,
      [fixture.workspaceId, digest('daily-outreach-programme-v1')]);
    assert.equal(programmes[0]?.disposition, 'recorded');
    const programmeId = programmes[0]!.programme_version_id;

    const isolationClient = await commandPool.connect();
    try {
      await isolationClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await isolationClient.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.workspace_id', $2, true),
                set_config('app.actor_kind', 'user', true),
                set_config('app.request_id', 'repeatable-read-attack', true)`,
        [fixture.ownerId, fixture.workspaceId],
      );
      await expectPostgresError(isolationClient.query(
        `SELECT * FROM app_private.publish_daily_outreach_programme_version(
           $1, 'founder_daily_linkedin', 1, NULL, 'linkedin', 'fictional',
           2, 2, 2, 3600, $2, CURRENT_DATE, NULL
         )`,
        [fixture.workspaceId, digest('daily-outreach-programme-v1')],
      ), '25001');
    } finally {
      await isolationClient.query('ROLLBACK').catch(() => undefined);
      isolationClient.release();
    }
    await expectPostgresError(roleQuery(
      readPool, { ...context, requestId: 'read-role-command-attack' },
      `SELECT * FROM app_private.publish_daily_outreach_programme_version(
         $1, 'founder_daily_linkedin', 1, NULL, 'linkedin', 'fictional',
         2, 2, 2, 3600, $2, CURRENT_DATE, NULL
       )`,
      [fixture.workspaceId, digest('daily-outreach-programme-v1')],
    ), '42501');
    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'command-role-read-attack' },
      `SELECT app_private.read_daily_outreach_cockpit_snapshot(
         $1, 'founder_daily_linkedin', $2, CURRENT_DATE, 10, 10
       )`,
      [fixture.workspaceId, fixture.ownerId],
    ), '42501');

    await expectPostgresError(roleQuery(
      commandPool, context,
      `SELECT * FROM app_private.publish_daily_outreach_programme_version(
         $1, 'cross_workspace_attack', 1, NULL, 'linkedin', 'fictional',
         1, 1, 1, 3600, $2, CURRENT_DATE, NULL
       )`,
      [fixture.otherWorkspaceId, digest('cross-workspace')],
    ), '42501');

    const membershipIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const memberships = await roleQuery<{
        disposition: string;
        prospect_membership_id: string;
      }>(commandPool, { ...context, requestId: `membership-${index}` },
        `WITH evidence AS (
           SELECT statement_timestamp() - interval '1 minute' AS observed_at,
                  statement_timestamp() + interval '1 day' AS expires_at,
                  digest($5::text, 'sha256') AS source_sha,
                  digest($6::text, 'sha256') AS provenance_sha,
                  digest($7::text, 'sha256') AS audience_sha
         ), bound AS (
           SELECT evidence.*,
                  digest(format(
                    'propertypredator.daily-outreach-membership/v2|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
                    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'manual',
                    encode(source_sha, 'hex'), encode(provenance_sha, 'hex'),
                    encode(audience_sha, 'hex'),
                    to_char(observed_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                    to_char(expires_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                  ), 'sha256') AS membership_sha
           FROM evidence
         )
         SELECT result.*
         FROM bound
         CROSS JOIN LATERAL app_private.record_daily_outreach_prospect_membership(
           $1, $2, $3, $4, 'manual', source_sha, provenance_sha,
           audience_sha, membership_sha, observed_at, expires_at
         ) AS result`,
        [
          fixture.workspaceId, programmeId, fixture.contactIds[index],
          fixture.pointIds[index], `source-${index}`,
          `provenance-${index}`, `audience-${index}`,
        ]);
      assert.equal(memberships[0]?.disposition, 'recorded');
      membershipIds.push(memberships[0]!.prospect_membership_id);
    }

    const allocationIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const allocations = await roleQuery<{
        disposition: string;
        allocation_id: string;
        priority_rank: number;
      }>(commandPool, { ...context, requestId: `allocation-${index}` },
        `WITH bound AS (
           SELECT digest(format(
             'propertypredator.daily-outreach-allocation/v2|%s|%s|%s|%s|%s',
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             to_char(CURRENT_DATE, 'YYYY-MM-DD')
           ), 'sha256') AS allocation_sha
         )
         SELECT result.*
         FROM bound
         CROSS JOIN LATERAL app_private.allocate_daily_outreach_queue_item(
           $1, $2, $3, $4, CURRENT_DATE, allocation_sha
         ) AS result`,
        [fixture.workspaceId, programmeId, membershipIds[index], fixture.ownerId]);
      assert.equal(allocations[0]?.disposition, 'recorded');
      assert.equal(allocations[0]?.priority_rank, index + 1);
      allocationIds.push(allocations[0]!.allocation_id);
    }

    const eligibilityIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const decisions = await roleQuery<{ eligibility_decision_id: string }>(
        commandPool, { ...context, requestId: `eligibility-${index}` },
        `SELECT eligibility_decision_id
         FROM app_private.record_daily_outreach_channel_eligibility(
           $1, $2, 'manual_first_touch', 'manual_review_confirmed',
           $3, NULL, statement_timestamp() + interval '4 minutes'
         )`,
        [fixture.workspaceId, allocationIds[index], digest(`eligibility-${index}`)],
      );
      eligibilityIds.push(decisions[0]!.eligibility_decision_id);
    }

    const assignmentIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const assignments = await roleQuery<{
        disposition: string;
        content_assignment_id: string;
      }>(commandPool, { ...context, requestId: `assignment-${index}` },
        `SELECT *
         FROM app_private.assign_daily_outreach_approved_content(
           $1, $2, $3, $4, $5, $6, $7, $8, $9
         )`,
        [
          fixture.workspaceId, allocationIds[index], fixture.contentItemId,
          fixture.contentVersionId, fixture.contentSha256,
          fixture.approvalRequestId, fixture.approvalDecisionId,
          digest(`assignment-evidence-${index}`),
          digest(`assignment-command-${index}`),
        ]);
      assert.equal(assignments[0]?.disposition, 'recorded');
      assignmentIds.push(assignments[0]!.content_assignment_id);
    }

    const leaseToken = digest('daily-outreach-lease-token');
    const claims = await roleQuery<{
      allocation_id: string;
      queue_lease_id: string;
      eligibility_decision_id: string;
      content_assignment_id: string;
    }>(commandPool, { ...context, requestId: 'claim-first' },
      `SELECT allocation_id, queue_lease_id, eligibility_decision_id,
              content_assignment_id
       FROM app_private.claim_next_manual_daily_outreach(
         $1, $2, 'founder_daily_linkedin', CURRENT_DATE, 'linkedin', $3, 600
       )`,
      [fixture.workspaceId, fixture.ownerId, leaseToken]);
    assert.equal(claims[0]?.allocation_id, allocationIds[0]);
    assert.equal(claims[0]?.eligibility_decision_id, eligibilityIds[0]);
    assert.equal(claims[0]?.content_assignment_id, assignmentIds[0]);

    const attemptedAt = new Date();
    const commandKey = digest('manual-attempt-command');
    const attemptValues = [
      fixture.workspaceId, allocationIds[0], eligibilityIds[0],
      claims[0]!.queue_lease_id, leaseToken, fixture.contentItemId,
      fixture.contentVersionId, fixture.contentSha256,
      fixture.approvalRequestId, fixture.approvalDecisionId,
      digest('manual-attempt-evidence'), attemptedAt, commandKey,
    ] as const;
    const attemptSql = `SELECT *
      FROM app_private.record_daily_outreach_manual_attempt(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, 'attempted', $12, $13
      )`;
    const attempts = await roleQuery<{
      disposition: string;
      attempt_receipt_id: string;
      outcome_event_id: string;
    }>(commandPool, { ...context, requestId: 'attempt-first' }, attemptSql, attemptValues);
    assert.equal(attempts[0]?.disposition, 'recorded');
    const replay = await roleQuery<{
      disposition: string;
      attempt_receipt_id: string;
      outcome_event_id: string;
    }>(commandPool, { ...context, requestId: 'attempt-replay' }, attemptSql, attemptValues);
    assert.equal(replay[0]?.disposition, 'replayed');
    assert.equal(replay[0]?.attempt_receipt_id, attempts[0]?.attempt_receipt_id);

    const volatileReplayValues = [
      fixture.workspaceId, allocationIds[0], randomUUID(),
      randomUUID(), digest('replacement-retry-lease-token'),
      fixture.contentItemId, fixture.contentVersionId,
      fixture.contentSha256, fixture.approvalRequestId,
      fixture.approvalDecisionId, digest('replacement-derived-evidence'),
      new Date(), commandKey,
    ] as const;
    const volatileReplay = await roleQuery<{
      disposition: string;
      attempt_receipt_id: string;
    }>(commandPool, { ...context, requestId: 'attempt-volatile-replay' },
      attemptSql, volatileReplayValues);
    assert.equal(volatileReplay[0]?.disposition, 'replayed');
    assert.equal(volatileReplay[0]?.attempt_receipt_id,
      attempts[0]?.attempt_receipt_id);

    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'outcome-on-attempt-rejected' },
      `SELECT * FROM app_private.record_daily_outreach_manual_attempt(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, 'no_response', $12, $13
      )`, [
        ...attemptValues.slice(0, -1),
        digest('invalid-manual-outcome-command'),
      ],
    ), '22023');

    const conflictValues = [
      fixture.workspaceId, allocationIds[0], eligibilityIds[0],
      claims[0]!.queue_lease_id, leaseToken, fixture.contentItemId,
      fixture.contentVersionId, fixture.contentSha256,
      fixture.approvalRequestId, randomUUID(),
      digest('conflicting-manual-attempt-evidence'), attemptedAt, commandKey,
    ] as const;
    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'attempt-command-conflict' },
      attemptSql, conflictValues,
    ), '23505');

    await roleQuery(
      commandPool, { ...context, requestId: 'eligibility-short-lived' },
      `SELECT * FROM app_private.record_daily_outreach_channel_eligibility(
         $1, $2, 'manual_first_touch', 'manual_review_confirmed',
         $3, NULL, statement_timestamp() + interval '100 milliseconds'
       )`,
      [fixture.workspaceId, allocationIds[1], digest('short-lived-eligibility')],
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const fallbackLeaseToken = digest('stale-eligibility-fallback-lease');
    const fallbackClaim = await roleQuery<{
      allocation_id: string;
      queue_lease_id: string;
      eligibility_decision_id: string;
    }>(
      commandPool, { ...context, requestId: 'stale-eligibility-claim' },
      `SELECT * FROM app_private.claim_next_manual_daily_outreach(
         $1, $2, 'founder_daily_linkedin', CURRENT_DATE, 'linkedin', $3, 600
       )`,
      [fixture.workspaceId, fixture.ownerId, fallbackLeaseToken],
    );
    assert.equal(fallbackClaim[0]?.allocation_id, allocationIds[2]);
    const refreshed = await roleQuery<{ eligibility_decision_id: string }>(
      commandPool, { ...context, requestId: 'eligibility-refreshed' },
      `SELECT eligibility_decision_id
       FROM app_private.record_daily_outreach_channel_eligibility(
         $1, $2, 'manual_first_touch', 'manual_review_confirmed',
         $3, NULL, statement_timestamp() + interval '4 minutes'
       )`,
      [fixture.workspaceId, allocationIds[1], digest('refreshed-eligibility')],
    );
    eligibilityIds[1] = refreshed[0]!.eligibility_decision_id;

    const secondLeaseToken = digest('daily-outreach-second-lease-token');
    const secondClaims = await roleQuery<{
      allocation_id: string;
      queue_lease_id: string;
      eligibility_decision_id: string;
    }>(commandPool, { ...context, requestId: 'claim-second' },
      `SELECT allocation_id, queue_lease_id, eligibility_decision_id
       FROM app_private.claim_next_manual_daily_outreach(
         $1, $2, 'founder_daily_linkedin', CURRENT_DATE, 'linkedin', $3, 600
       )`,
      [fixture.workspaceId, fixture.ownerId, secondLeaseToken]);
    assert.equal(secondClaims[0]?.allocation_id, allocationIds[1]);
    const secondAttemptedAt = new Date();
    const secondAttempts = await roleQuery<{
      disposition: string;
      attempt_receipt_id: string;
      outcome_event_id: string;
    }>(commandPool, { ...context, requestId: 'attempt-second' },
      `SELECT * FROM app_private.record_daily_outreach_manual_attempt(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, 'attempted', $12, $13
       )`,
      [
        fixture.workspaceId, allocationIds[1], eligibilityIds[1],
        secondClaims[0]!.queue_lease_id, secondLeaseToken,
        fixture.contentItemId, fixture.contentVersionId,
        fixture.contentSha256, fixture.approvalRequestId,
        fixture.approvalDecisionId, digest('second-attempt-evidence'),
        secondAttemptedAt, digest('second-attempt-command'),
      ]);
    assert.equal(secondAttempts[0]?.disposition, 'recorded');

    const quotaAttemptedAt = new Date();
    const quotaAttemptValues = [
      fixture.workspaceId, allocationIds[2], eligibilityIds[2],
      fallbackClaim[0]!.queue_lease_id, fallbackLeaseToken,
      fixture.contentItemId, fixture.contentVersionId,
      fixture.contentSha256, fixture.approvalRequestId,
      fixture.approvalDecisionId, digest('quota-attempt-evidence'),
      quotaAttemptedAt, digest('quota-attempt-command'),
    ] as const;
    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'attempt-quota-blocked' },
      attemptSql, quotaAttemptValues,
    ), '54000');

    const postCapClaim = await roleQuery(
      commandPool, { ...context, requestId: 'claim-after-quota' },
      `SELECT * FROM app_private.claim_next_manual_daily_outreach(
         $1, $2, 'founder_daily_linkedin', CURRENT_DATE, 'linkedin', $3, 600
       )`,
      [fixture.workspaceId, fixture.ownerId, digest('post-cap-lease-token')],
    );
    assert.deepEqual(postCapClaim, []);

    const projectionKey = digest('attempt-projection');
    const projectionDue = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const projectionValues = [
      fixture.workspaceId, attempts[0]!.outcome_event_id,
      projectionKey, projectionDue, digest('projection-evidence'),
    ] as const;
    const projectionSql = `SELECT *
      FROM app_private.project_daily_outreach_outcome(
        $1, $2, $3, $4, NULL, $5
      )`;
    const projections = await roleQuery<{
      disposition: string;
      projection_receipt_id: string;
      task_id: string;
      laps_disposition: string;
    }>(commandPool, { ...context, requestId: 'project-first' },
      projectionSql, projectionValues);
    assert.equal(projections[0]?.disposition, 'recorded');
    assert.equal(projections[0]?.laps_disposition, 'cold_attempt_not_eligible');
    assert.ok(projections[0]?.task_id);
    assert.equal((await roleQuery<{ disposition: string }>(
      commandPool, { ...context, requestId: 'project-replay' },
      projectionSql, projectionValues,
    ))[0]?.disposition, 'replayed');
    const volatileProjectionReplay = await roleQuery<{ disposition: string }>(
      commandPool, { ...context, requestId: 'project-volatile-replay' },
      projectionSql,
      [
        fixture.workspaceId, attempts[0]!.outcome_event_id,
        projectionKey, new Date(Date.now() + 26 * 60 * 60 * 1000),
        digest('replacement-projection-evidence'),
      ],
    );
    assert.equal(volatileProjectionReplay[0]?.disposition, 'replayed');

    const manualReplayReceipt = await roleQuery<{
      disposition: string;
      command_kind: string;
      allocation_id: string;
      attempt_receipt_id: string;
      previous_outcome_event_id: string | null;
      outcome: string;
      outcome_event_id: string;
      projection_receipt_id: string;
      task_id: string;
      laps_disposition: string;
    }>(commandPool, { ...context, requestId: 'resolve-manual-replay' },
      `SELECT * FROM app_private.resolve_daily_outreach_command_replay(
         $1, 'manual_attempt', $2
       )`,
      [fixture.workspaceId, commandKey]);
    assert.equal(manualReplayReceipt[0]?.disposition, 'replayed');
    assert.equal(manualReplayReceipt[0]?.command_kind, 'manual_attempt');
    assert.equal(manualReplayReceipt[0]?.allocation_id,
      allocationIds[0]);
    assert.equal(manualReplayReceipt[0]?.attempt_receipt_id,
      attempts[0]?.attempt_receipt_id);
    assert.equal(manualReplayReceipt[0]?.previous_outcome_event_id, null);
    assert.equal(manualReplayReceipt[0]?.outcome, 'attempted');
    assert.equal(manualReplayReceipt[0]?.outcome_event_id,
      attempts[0]?.outcome_event_id);
    assert.equal(manualReplayReceipt[0]?.projection_receipt_id,
      projections[0]?.projection_receipt_id);
    assert.equal(manualReplayReceipt[0]?.task_id, projections[0]?.task_id);

    const responseOutcomeCommand = digest('response-outcome-command');
    const responseEvents = await roleQuery<{
      disposition: string;
      outcome_event_id: string;
      control_event_id: string;
    }>(commandPool, { ...context, requestId: 'record-response-outcome' },
      `SELECT * FROM app_private.record_daily_outreach_outcome_event(
         $1, $2, $3, 'replied', statement_timestamp(), $4, $5
       )`,
      [
        fixture.workspaceId, attempts[0]!.attempt_receipt_id,
        attempts[0]!.outcome_event_id, digest('response-outcome-evidence'),
        responseOutcomeCommand,
      ]);
    assert.equal(responseEvents[0]?.disposition, 'recorded');
    const responseReplay = await roleQuery<{
      disposition: string;
      outcome_event_id: string;
    }>(commandPool, { ...context, requestId: 'record-response-replay' },
      `SELECT * FROM app_private.record_daily_outreach_outcome_event(
         $1, $2, $3, 'replied', statement_timestamp(), $4, $5
       )`,
      [
        fixture.workspaceId, attempts[0]!.attempt_receipt_id,
        attempts[0]!.outcome_event_id,
        digest('replacement-response-derived-evidence'),
        responseOutcomeCommand,
      ]);
    assert.equal(responseReplay[0]?.disposition, 'replayed');
    assert.equal(responseReplay[0]?.outcome_event_id,
      responseEvents[0]?.outcome_event_id);
    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'stale-outcome-lineage' },
      `SELECT * FROM app_private.record_daily_outreach_outcome_event(
         $1, $2, $3, 'positive', statement_timestamp(), $4, $5
       )`,
      [
        fixture.workspaceId, attempts[0]!.attempt_receipt_id,
        attempts[0]!.outcome_event_id, digest('stale-outcome-evidence'),
        digest('stale-outcome-command'),
      ],
    ), '40001');
    const responseProjectionKey = digest('response-projection-command');
    const responseProjection = await roleQuery<{
      disposition: string;
      projection_receipt_id: string;
      task_id: string;
      laps_disposition: string;
    }>(commandPool, { ...context, requestId: 'project-response' },
      `SELECT * FROM app_private.project_daily_outreach_outcome(
         $1, $2, $3, statement_timestamp() + interval '2 hours', NULL, $4
       )`,
      [
        fixture.workspaceId, responseEvents[0]!.outcome_event_id,
        responseProjectionKey,
        digest('response-projection-evidence'),
      ]);
    assert.equal(responseProjection[0]?.laps_disposition, 'response_evidence_pending');

    const outcomeReplayReceipt = await roleQuery<{
      disposition: string;
      command_kind: string;
      allocation_id: string;
      attempt_receipt_id: string;
      previous_outcome_event_id: string;
      outcome: string;
      outcome_event_id: string;
      projection_receipt_id: string;
      task_id: string;
      laps_disposition: string;
    }>(commandPool, { ...context, requestId: 'resolve-outcome-replay' },
      `SELECT * FROM app_private.resolve_daily_outreach_command_replay(
         $1, 'outcome', $2
       )`,
      [fixture.workspaceId, responseOutcomeCommand]);
    assert.equal(outcomeReplayReceipt[0]?.disposition, 'replayed');
    assert.equal(outcomeReplayReceipt[0]?.command_kind, 'outcome');
    assert.equal(outcomeReplayReceipt[0]?.allocation_id,
      allocationIds[0]);
    assert.equal(outcomeReplayReceipt[0]?.attempt_receipt_id,
      attempts[0]?.attempt_receipt_id);
    assert.equal(outcomeReplayReceipt[0]?.previous_outcome_event_id,
      attempts[0]?.outcome_event_id);
    assert.equal(outcomeReplayReceipt[0]?.outcome, 'replied');
    assert.equal(outcomeReplayReceipt[0]?.outcome_event_id,
      responseEvents[0]?.outcome_event_id);
    assert.equal(outcomeReplayReceipt[0]?.projection_receipt_id,
      responseProjection[0]?.projection_receipt_id);
    assert.equal(outcomeReplayReceipt[0]?.task_id,
      responseProjection[0]?.task_id);

    const cockpit = await roleQuery<{
      snapshot: {
        schemaVersion: number;
        quotaTimezone: string;
        programme: { id: string; dailyTarget: number };
        manager: { prospectsReviewed: number; validAttempts: number; responses: number };
        queue: Array<{
          allocationId: string;
          contact: { displayName: string };
          contentAssignment: { id: string; contentSha256: string };
          actionState: string;
        }>;
        recentOutcomes: Array<{ id: string; outcome: string }>;
      };
    }>(readPool, { ...context, requestId: 'cockpit-read' },
      `SELECT app_private.read_daily_outreach_cockpit_snapshot(
         $1, 'founder_daily_linkedin', $2, CURRENT_DATE, 50, 50
       ) AS snapshot`,
      [fixture.workspaceId, fixture.ownerId]);
    assert.equal(cockpit[0]?.snapshot.schemaVersion, 1);
    assert.equal(cockpit[0]?.snapshot.quotaTimezone, 'UTC');
    assert.equal(cockpit[0]?.snapshot.programme.id, programmeId);
    assert.equal(cockpit[0]?.snapshot.programme.dailyTarget, 2);
    assert.equal(cockpit[0]?.snapshot.manager.prospectsReviewed, 3);
    assert.equal(cockpit[0]?.snapshot.manager.validAttempts, 2);
    assert.equal(cockpit[0]?.snapshot.manager.responses, 1);
    assert.equal(cockpit[0]?.snapshot.queue.length, 3);
    assert.equal(cockpit[0]?.snapshot.queue[0]?.contact.displayName,
      'Fictional prospect one');
    assert.equal(cockpit[0]?.snapshot.queue[0]?.contentAssignment.id,
      assignmentIds[0]);
    assert.equal(cockpit[0]?.snapshot.queue[0]?.contentAssignment.contentSha256,
      fixture.contentSha256.toString('hex'));
    assert.ok(cockpit[0]?.snapshot.recentOutcomes.some(
      (outcome) => outcome.outcome === 'replied',
    ));

    await ownerQuery(pool,
      `INSERT INTO app.communication_suppression_events (
         workspace_id, contact_id, contact_point_id, channel, purpose,
         state, reason, source, source_event_id, actor_kind, actor_user_id,
         evidence, endpoint_identity_sha256, occurred_at
       ) VALUES (
         $1, $2, $3, 'social', 'daily_outreach', 'suppressed',
         'integration_suppression', 'integration_fixture', $4,
         'user', $5, '{}'::jsonb, digest('placeholder', 'sha256'),
         statement_timestamp()
       )`,
      [
        fixture.workspaceId, fixture.contactIds[2], fixture.pointIds[2],
        `suppression-${randomUUID()}`, fixture.ownerId,
      ]);
    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'attempt-suppressed' },
      attemptSql,
      quotaAttemptValues,
    ), '55000');

    await expectPostgresError(ownerQuery(
      pool,
      `UPDATE app_private.daily_outreach_programme_versions
       SET daily_target = 1 WHERE id = $1`,
      [programmeId],
    ), '42501');
  } finally {
    await Promise.all(rolePools.map((rolePool) => rolePool.end().catch(() => undefined)));
    await clearRolePasswords(pool).catch(() => undefined);
    await pool.end();
  }
});
