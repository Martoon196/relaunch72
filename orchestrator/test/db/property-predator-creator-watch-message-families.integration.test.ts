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
  const password = `creator-watch-${randomUUID()}`;
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
    application_name: `relaunch72-disposable-${role}-creator-watch-test`,
  });
}

async function clearRolePasswords(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    for (const role of loginRoles) await client.query(`ALTER ROLE ${role} PASSWORD NULL`);
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
  workspaceId: string;
  otherWorkspaceId: string;
  ownerId: string;
  otherOwnerId: string;
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
  const contentItemId = randomUUID();
  const contentVersionId = randomUUID();
  const approvalRequestId = randomUUID();
  const approvalDecisionId = randomUUID();
  const body = 'Approved fictional Creator Watch comment fixture.';
  const contentSha256 = digest(body);
  const suffix = organizationId.replaceAll('-', '').slice(0, 10);

  await resetIdentityTables(pool);
  await ownerQuery(pool,
    `INSERT INTO app.organizations (id, name, slug, kind, status)
     VALUES ($1, 'Creator Watch integration', $2, 'direct_customer', 'active')`,
    [organizationId, `creator-watch-${suffix}`]);
  await ownerQuery(pool,
    `INSERT INTO app.users (id, email, status, email_verified_at)
     VALUES
       ($1, $2, 'active', statement_timestamp()),
       ($3, $4, 'active', statement_timestamp())`,
    [
      ownerId, `creator-${ownerId.slice(0, 8)}@example.test`,
      otherOwnerId, `creator-${otherOwnerId.slice(0, 8)}@example.test`,
    ]);
  await ownerQuery(pool,
    `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
     VALUES
       ($1, $2, 'Creator Watch A', $3, 'active'),
       ($4, $2, 'Creator Watch B', $5, 'active')`,
    [
      workspaceId, organizationId, `creator-a-${workspaceId.slice(0, 8)}`,
      otherWorkspaceId, `creator-b-${otherWorkspaceId.slice(0, 8)}`,
    ]);
  await ownerQuery(pool,
    `INSERT INTO app.workspace_memberships (
       workspace_id, organization_id, user_id, role, status
     ) VALUES
       ($1, $2, $3, 'owner', 'active'),
       ($4, $2, $5, 'owner', 'active')`,
    [workspaceId, organizationId, ownerId, otherWorkspaceId, otherOwnerId]);

  await withOwnerClient(pool, async (client) => {
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', 'creator-watch-content-fixture', true)`,
      [ownerId, workspaceId],
    );
    await client.query(
      `INSERT INTO app.company_content_items (
         id, workspace_id, source_system, source_item_id,
         created_by_user_id, created_request_id
       ) VALUES ($1, $2, 'creator_watch_fixture', $3, $4, 'overwritten')`,
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
         'Creator Watch fixture', 'creator_watch_fixture', $4, 'v1',
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
    workspaceId, otherWorkspaceId, ownerId, otherOwnerId,
    contentItemId, contentVersionId, approvalRequestId,
    approvalDecisionId, contentSha256,
  };
}

test('0091 disposable proof keeps Creator Watch human-reviewed, capped and table-blind', {
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
      requestId: 'creator-watch-integration',
    };

    await expectPostgresError(roleQuery(
      commandPool, context,
      'SELECT * FROM app_private.daily_outreach_creator_watch_observed_posts',
    ), '42501');
    await expectPostgresError(roleQuery(
      readPool, context,
      'SELECT * FROM app_private.daily_outreach_message_family_versions',
    ), '42501');

    const programme = await roleQuery<{ programme_version_id: string }>(
      commandPool, { ...context, requestId: 'creator-programme' },
      `SELECT programme_version_id
       FROM app_private.publish_daily_outreach_programme_version(
         $1, 'creator_watch_linkedin', 1, NULL, 'linkedin', 'creator_watch',
         10, 20, 20, 3600, $2, CURRENT_DATE, NULL
       )`,
      [fixture.workspaceId, digest('creator-watch-programme')],
    );
    const programmeId = programme[0]!.programme_version_id;

    const familySql = `SELECT *
      FROM app_private.publish_daily_outreach_message_family_version(
        $1, $2, 'authority_evidence', 1, NULL, 'authority_comment',
        'prospect', 'property_educators', 'open_conversation',
        ARRAY['post_topic','observed_problem']::text[], 'evidence_led',
        $3, $4, $5, $6, $7, 3600, 10, 200, 20,
        $8, $9::timestamptz, NULL
      )`;
    const familyValues = [
      fixture.workspaceId, programmeId, fixture.contentItemId,
      fixture.contentVersionId, fixture.contentSha256,
      fixture.approvalRequestId, fixture.approvalDecisionId,
      digest('authority-evidence-family'), new Date(Date.now() - 60_000),
    ] as const;
    const families = await roleQuery<{
      disposition: string;
      message_family_version_id: string;
    }>(commandPool, { ...context, requestId: 'creator-family' },
      familySql, familyValues);
    assert.equal(families[0]?.disposition, 'recorded');
    const familyId = families[0]!.message_family_version_id;
    assert.equal((await roleQuery<{ disposition: string }>(
      commandPool, { ...context, requestId: 'creator-family-replay' },
      familySql, familyValues,
    ))[0]?.disposition, 'replayed');

    const publishSubject = async (
      subjectKey: string,
      maximumDaily: number,
    ): Promise<string> => {
      const rows = await roleQuery<{ subject_version_id: string }>(
        commandPool, { ...context, requestId: `subject-${subjectKey}` },
        `SELECT subject_version_id
         FROM app_private.publish_daily_outreach_creator_watch_subject_version(
           $1, $2, 1, NULL, 'linkedin', $3, 'founder_watchlist', $4,
           'active_review', 3600, $5, 10, 3600, $6
         )`,
        [
          fixture.workspaceId, subjectKey, digest(`${subjectKey}-provider-ref`),
          digest(`${subjectKey}-provenance`), maximumDaily,
          digest(`${subjectKey}-configuration`),
        ],
      );
      return rows[0]!.subject_version_id;
    };

    const cooldownSubjectId = await publishSubject('creator_cooldown', 10);
    const cappedSubjectId = await publishSubject('creator_capped', 1);
    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'cross-workspace-subject' },
      `SELECT *
       FROM app_private.publish_daily_outreach_creator_watch_subject_version(
         $1, 'cross_workspace', 1, NULL, 'linkedin', $2,
         'manual', $3, 'active_review', 3600, 1, 1, 3600, $4
       )`,
      [
        fixture.otherWorkspaceId, digest('cross-ref'),
        digest('cross-provenance'), digest('cross-config'),
      ],
    ), '42501');

    const recordPost = async (
      subjectId: string,
      key: string,
    ): Promise<string> => {
      const rows = await roleQuery<{ observed_post_id: string }>(
        commandPool, { ...context, requestId: `post-${key}` },
        `SELECT observed_post_id
         FROM app_private.record_daily_outreach_creator_watch_post(
           $1, $2, 'operator_supplied_reference', $3, $4, $5, $6,
           statement_timestamp() - interval '1 minute',
           statement_timestamp() + interval '30 minutes', $7
         )`,
        [
          fixture.workspaceId, subjectId, digest(`${key}-provider-post`),
          digest(`${key}-source-reference`), digest(`${key}-content`),
          digest(`${key}-observation`), digest(`${key}-command`),
        ],
      );
      return rows[0]!.observed_post_id;
    };

    const decide = async (
      postId: string,
      key: string,
      decision: 'comment' | 'no_comment',
    ): Promise<string> => {
      const rows = await roleQuery<{ relevance_decision_id: string }>(
        commandPool, { ...context, requestId: `decision-${key}` },
        `SELECT relevance_decision_id
         FROM app_private.record_daily_outreach_creator_watch_relevance(
           $1, $2, NULL, $3,
           CASE WHEN $3 = 'comment' THEN 'add_useful_evidence' ELSE NULL END,
           CASE WHEN $3 = 'no_comment' THEN 'no_useful_contribution' ELSE NULL END,
           'brand_brain_assist', $4, $5, $6
         )`,
        [
          fixture.workspaceId, postId, decision,
          digest(`${key}-grounding`), digest(`${key}-decision-evidence`),
          digest(`${key}-decision-command`),
        ],
      );
      return rows[0]!.relevance_decision_id;
    };

    const assign = async (
      postId: string,
      decisionId: string,
      key: string,
    ): Promise<readonly {
      disposition: string;
      comment_assignment_id: string;
      effect_state: string;
    }[]> => roleQuery(
      commandPool, { ...context, requestId: `assignment-${key}` },
      `SELECT disposition, comment_assignment_id, effect_state
       FROM app_private.assign_current_daily_outreach_creator_watch_comment(
         $1, $2, $3, $4, $5, $6
       )`,
      [
        fixture.workspaceId, postId, decisionId, familyId,
        digest(`${key}-assignment-evidence`), digest(`${key}-assignment-command`),
      ],
    );

    const noCommentPost = await recordPost(cooldownSubjectId, 'no-comment');
    const noCommentDecision = await decide(noCommentPost, 'no-comment', 'no_comment');
    await expectPostgresError(
      assign(noCommentPost, noCommentDecision, 'no-comment'),
      '55000',
    );

    const firstPost = await recordPost(cooldownSubjectId, 'cooldown-first');
    const firstDecision = await decide(firstPost, 'cooldown-first', 'comment');
    await expectPostgresError(roleQuery(
      commandPool, { ...context, requestId: 'raw-assignment-boundary-denied' },
      `SELECT *
       FROM app_private.assign_daily_outreach_creator_watch_comment(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       )`,
      [
        fixture.workspaceId, firstPost, firstDecision, familyId,
        fixture.contentItemId, fixture.contentVersionId, fixture.contentSha256,
        fixture.approvalRequestId, fixture.approvalDecisionId,
        digest('raw-boundary-evidence'), digest('raw-boundary-command'),
      ],
    ), '42501');
    const firstAssignment = await assign(firstPost, firstDecision, 'cooldown-first');
    assert.equal(firstAssignment[0]?.disposition, 'recorded');
    assert.equal(firstAssignment[0]?.effect_state, 'review_only');
    assert.equal((await assign(firstPost, firstDecision, 'cooldown-first'))[0]?.disposition,
      'replayed');
    const resolvedReplay = await roleQuery<{
      disposition: string;
      observed_post_id: string;
      previous_decision_id: string | null;
      decision: string;
      comment_purpose: string | null;
      no_comment_reason: string | null;
      decision_source: string;
      relevance_decision_id: string;
      decided_by_user_id: string;
      message_family_version_id: string | null;
      comment_assignment_id: string | null;
      assigned_by_user_id: string | null;
      effect_state: string | null;
    }>(commandPool, { ...context, requestId: 'resolve-creator-watch-replay' },
      `SELECT *
       FROM app_private.resolve_daily_outreach_creator_watch_replay($1,$2)`,
      [fixture.workspaceId, digest('cooldown-first-decision-command')]);
    assert.deepEqual(resolvedReplay, [{
      disposition: 'replayed',
      observed_post_id: firstPost,
      previous_decision_id: null,
      decision: 'comment',
      comment_purpose: 'add_useful_evidence',
      no_comment_reason: null,
      decision_source: 'human_review',
      relevance_decision_id: firstDecision,
      decided_by_user_id: fixture.ownerId,
      message_family_version_id: familyId,
      comment_assignment_id: firstAssignment[0]!.comment_assignment_id,
      assigned_by_user_id: fixture.ownerId,
      effect_state: 'review_only',
    }]);
    await expectPostgresError(roleQuery(
      readPool, { ...context, requestId: 'creator-replay-read-role-denied' },
      `SELECT *
       FROM app_private.resolve_daily_outreach_creator_watch_replay($1,$2)`,
      [fixture.workspaceId, digest('cooldown-first-decision-command')],
    ), '42501');

    const secondPost = await recordPost(cooldownSubjectId, 'cooldown-second');
    const secondDecision = await decide(secondPost, 'cooldown-second', 'comment');
    await expectPostgresError(
      assign(secondPost, secondDecision, 'cooldown-second'),
      '55000',
    );

    const cappedFirstPost = await recordPost(cappedSubjectId, 'cap-first');
    const cappedFirstDecision = await decide(cappedFirstPost, 'cap-first', 'comment');
    assert.equal((await assign(
      cappedFirstPost, cappedFirstDecision, 'cap-first',
    ))[0]?.effect_state, 'review_only');
    const cappedSecondPost = await recordPost(cappedSubjectId, 'cap-second');
    const cappedSecondDecision = await decide(cappedSecondPost, 'cap-second', 'comment');
    await expectPostgresError(
      assign(cappedSecondPost, cappedSecondDecision, 'cap-second'),
      '54000',
    );

    const readableFamilies = await roleQuery<{
      message_family_version_id: string;
      execution_state: string;
    }>(readPool, { ...context, requestId: 'family-read' },
      `SELECT message_family_version_id, execution_state
       FROM app_private.read_daily_outreach_message_families($1, 'linkedin')`,
      [fixture.workspaceId]);
    assert.equal(readableFamilies[0]?.message_family_version_id, familyId);
    assert.equal(readableFamilies[0]?.execution_state, 'approved_review_only');

    const queue = await roleQuery<{
      observed_post_id: string;
      relevance_decision: string;
      effect_state: string;
    }>(readPool, { ...context, requestId: 'creator-queue-read' },
      `SELECT observed_post_id, relevance_decision, effect_state
       FROM app_private.read_daily_outreach_creator_watch_queue($1, 20)`,
      [fixture.workspaceId]);
    assert.ok(queue.some((row) => row.observed_post_id === noCommentPost
      && row.relevance_decision === 'no_comment'));
    assert.ok(queue.some((row) => row.observed_post_id === firstPost
      && row.effect_state === 'review_only'));

    await expectPostgresError(roleQuery(
      readPool, context,
      `SELECT * FROM app_private.read_daily_outreach_creator_watch_queue($1, 20)`,
      [fixture.otherWorkspaceId],
    ), '42501');
    await expectPostgresError(ownerQuery(
      pool,
      `UPDATE app_private.daily_outreach_creator_watch_subject_versions
       SET status = 'paused' WHERE id = $1`,
      [cooldownSubjectId],
    ), '42501');

    const privileges = await ownerQuery<{
      command_provider_insert: boolean;
      definer_delivery_insert: boolean;
      server_assignment_execute: boolean;
      replay_execute: boolean;
      raw_assignment_execute: boolean;
    }>(pool,
      `SELECT
         has_table_privilege(
           'r72_daily_outreach_command', 'app.provider_operations', 'INSERT'
         ) AS command_provider_insert,
         has_table_privilege(
           'r72_daily_outreach_definer',
           'app.property_predator_zernio_reply_deliveries', 'INSERT'
         ) AS definer_delivery_insert,
         has_function_privilege(
           'r72_daily_outreach_command',
           'app_private.assign_current_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,bytea,bytea)',
           'EXECUTE'
         ) AS server_assignment_execute,
         has_function_privilege(
           'r72_daily_outreach_command',
           'app_private.resolve_daily_outreach_creator_watch_replay(uuid,bytea)',
           'EXECUTE'
         ) AS replay_execute,
         has_function_privilege(
           'r72_daily_outreach_command',
           'app_private.assign_daily_outreach_creator_watch_comment(uuid,uuid,uuid,uuid,uuid,uuid,bytea,uuid,uuid,bytea,bytea)',
           'EXECUTE'
         ) AS raw_assignment_execute`);
    assert.equal(privileges[0]?.command_provider_insert, false);
    assert.equal(privileges[0]?.definer_delivery_insert, false);
    assert.equal(privileges[0]?.server_assignment_execute, true);
    assert.equal(privileges[0]?.replay_execute, true);
    assert.equal(privileges[0]?.raw_assignment_execute, false);
  } finally {
    await Promise.all(rolePools.map((rolePool) => rolePool.end().catch(() => undefined)));
    await clearRolePasswords(pool).catch(() => undefined);
    await pool.end();
  }
});
