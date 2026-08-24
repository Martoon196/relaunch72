import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import { hashPassword } from '../../src/portal/accounts.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  roleQuery,
  scopedQuery,
  testDatabaseSkipReason,
  withOwnerClient,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

interface ProvisionedCustomerRow extends QueryResultRow {
  organization_id: string;
  workspace_id: string;
  owner_user_id: string;
  setup_action_token_id: string;
  setup_expires_at: Date;
  setup_delivery_id: string;
  setup_delivery_generation: number;
  created_now: boolean;
}

const provisionCustomerSql = `
  SELECT organization_id, workspace_id, owner_user_id,
         setup_action_token_id, setup_expires_at, setup_delivery_id,
         setup_delivery_generation, created_now
  FROM app_private.provision_customer_workspace_with_setup_delivery(
    $1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
    $7::text, $8::bytea, $9::bytea, $10::text, $11::text, $12::text,
    $13::uuid, $14::smallint, $15::text, $16::bytea, $17::bytea, $18::bytea
  )`;

/** Exercise the exact function-only runtime role without broadening shared helpers. */
async function provisioningQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_provisioning_command');
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Exercise the legacy inner provisioning primitive as its NOLOGIN owner.
 * Runtime code must never use this seam: migration 0012 deliberately revokes
 * the direct grant from r72_provisioning_command.
 */
async function onboardingDefinerQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE r72_onboarding_definer');
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type CommerceRuntimeRole = 'r72_public' | 'r72_webhook' | 'r72_provisioning_command';

/** Exercise each commerce function through the exact production command role. */
async function commerceRuntimeQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  role: CommerceRuntimeRole,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

type SetupRuntimeRole = 'r72_setup_delivery_command' | 'r72_setup_reissue_command';

async function setupRuntimeQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  role: SetupRuntimeRole,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await client.query<T>(sql, values);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('real PostgreSQL proves identity and CRM RLS, same-workspace FKs, append-only facts, and immediate revocation', {
  skip,
  timeout: 90_000,
}, async () => {
  const pool = await openTestDatabase();
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const workspaceUnbridged = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const viewerA = randomUUID();
  const salesA = randomUUID();
  const tokenHash = createHash('sha256').update(randomBytes(32)).digest();
  const csrfHash = createHash('sha256').update(randomBytes(32)).digest();
  const storedPasswordHash = await hashPassword('integration-password');

  try {
    await resetIdentityTables(pool);
    const unsafeMemberships = await pool.query<{ member: string; parent: string }>(
      `SELECT member.rolname AS member, parent.rolname AS parent
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       WHERE member.rolname = ANY ($1::text[])`,
      [[
        'r72_security_definer', 'r72_web', 'r72_identity_command', 'r72_crm_command',
        'r72_public', 'r72_worker', 'r72_webhook', 'r72_readonly',
      ]],
    );
    assert.deepEqual(unsafeMemberships.rows, []);
    const unsafeCommandGrants = await pool.query<{ member: string }>(
      `SELECT member.rolname AS member
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       WHERE parent.rolname = 'r72_crm_command'
         AND member.rolname <> current_user`,
    );
    assert.deepEqual(unsafeCommandGrants.rows, []);
    const publicSchemaCreators = await pool.query<{ role_name: string }>(
      `SELECT role_name
       FROM unnest($1::text[]) AS candidate(role_name)
       WHERE pg_catalog.has_schema_privilege(candidate.role_name, 'public', 'CREATE')
       ORDER BY role_name`,
      [[
        'r72_owner', 'r72_security_definer', 'r72_web', 'r72_public',
        'r72_worker', 'r72_webhook', 'r72_readonly', 'r72_crm_command',
        'r72_identity_command', 'r72_provisioning_command',
      ]],
    );
    assert.deepEqual(publicSchemaCreators.rows, []);
    await withOwnerClient(pool, async (client) => {
      await client.query(
        `INSERT INTO app.organizations (id, name, slug, kind)
         VALUES ($1, 'Agency A', 'agency-a', 'agency'), ($2, 'Direct B', 'direct-b', 'direct_customer')`,
        [organizationA, organizationB],
      );
      await client.query(
        `INSERT INTO app.users (id, email, password_hash, status, email_verified_at)
         VALUES ($1, 'Owner-A@Example.Test', $5, 'active', clock_timestamp()),
                ($2, 'owner-b@example.test', NULL, 'active', clock_timestamp()),
                ($3, 'viewer-a@example.test', NULL, 'active', clock_timestamp()),
                ($4, 'sales-a@example.test', NULL, 'active', clock_timestamp())`,
        [userA, userB, viewerA, salesA, storedPasswordHash],
      );
      await client.query(
        `INSERT INTO app.workspaces (id, organization_id, legacy_tenant_key, name, slug)
         VALUES ($1, $2, NULL, 'Workspace A', 'workspace-a'),
                ($3, $4, NULL, 'Workspace B', 'workspace-b'),
                ($5, $2, NULL, 'Second native workspace', 'workspace-second')`,
        [workspaceA, organizationA, workspaceB, organizationB, workspaceUnbridged],
      );
      await client.query(
        `INSERT INTO app.organization_memberships (organization_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active'), ($3, $4, 'owner', 'active')`,
        [organizationA, userA, organizationB, userB],
      );
      await client.query(
        `INSERT INTO app.workspace_memberships
           (workspace_id, organization_id, user_id, role, status, source_organization_id, granted_at)
         VALUES ($1, $2, $3, 'owner', 'active', $2, statement_timestamp() - interval '1 minute'),
                ($4, $5, $6, 'owner', 'active', NULL, statement_timestamp()),
                ($1, $2, $7, 'viewer', 'active', NULL, statement_timestamp()),
                ($1, $2, $8, 'sales', 'active', NULL, statement_timestamp()),
                ($9, $2, $3, 'owner', 'active', $2, statement_timestamp())`,
        [
          workspaceA, organizationA, userA, workspaceB, organizationB, userB,
          viewerA, salesA, workspaceUnbridged,
        ],
      );
    });

    const credential = await roleQuery<{
      user_id: string;
      user_email: string;
      password_hash: string;
      selected_workspace_id: string;
    }>(
      pool,
      'r72_identity_command',
      `SELECT user_id, user_email, password_hash, selected_workspace_id
       FROM app_private.portal_login_credential($1)`,
      [' owner-a@example.test '],
    );
    assert.deepEqual(credential, [{
      user_id: userA,
      user_email: 'Owner-A@Example.Test',
      password_hash: storedPasswordHash,
      selected_workspace_id: workspaceA,
    }], 'login selects the earliest equally ranked native workspace without a legacy bridge');

    const issued = await roleQuery<{
      user_id: string;
      user_email: string;
      selected_workspace_id: string;
    }>(
      pool,
      'r72_identity_command',
      `SELECT user_id, user_email, selected_workspace_id
       FROM app_private.create_portal_session($1, $2, $3, $4, $5, NULL, NULL)`,
      [userA, workspaceA, storedPasswordHash, tokenHash, csrfHash],
    );
    assert.deepEqual(issued, [{
      user_id: userA,
      user_email: 'Owner-A@Example.Test',
      selected_workspace_id: workspaceA,
    }]);
    await expectPostgresError(
      roleQuery(pool, 'r72_identity_command', 'SELECT token_hash FROM app.user_sessions'),
      '42501',
    );
    await expectPostgresError(
      roleQuery(pool, 'r72_web', 'SELECT * FROM app_private.portal_login_credential($1)', ['owner-a@example.test']),
      '42501',
    );
    await expectPostgresError(
      roleQuery(
        pool,
        'r72_identity_command',
        'SELECT app_private.upgrade_portal_password_hash($1, $2, $3)',
        [userA, storedPasswordHash, storedPasswordHash],
      ),
      '42883',
    );

    const visibleA = await scopedQuery<{ id: string }>(
      pool,
      'r72_web',
      { workspaceId: workspaceA, userId: userA },
      'SELECT id FROM app.workspaces ORDER BY id',
    );
    assert.deepEqual(visibleA.map((row) => row.id), [workspaceA]);
    const suppliedB = await scopedQuery<{ id: string }>(
      pool,
      'r72_web',
      { workspaceId: workspaceA, userId: userA },
      'SELECT id FROM app.workspaces WHERE id = $1',
      [workspaceB],
    );
    assert.equal(suppliedB.length, 0);

    const nestedHelper = await scopedQuery<{ can_write: boolean; can_manage: boolean }>(
      pool,
      'r72_web',
      { workspaceId: workspaceA, userId: userA },
      `SELECT
         app_private.can_write_workspace(app_private.current_user_id(), app_private.current_workspace_id()) AS can_write,
         app_private.can_manage_workspace(app_private.current_user_id(), app_private.current_workspace_id()) AS can_manage`,
    );
    assert.deepEqual(nestedHelper, [{ can_write: true, can_manage: true }]);

    const workerVisible = await scopedQuery<{ id: string }>(
      pool,
      'r72_worker',
      { workspaceId: workspaceA },
      'SELECT id FROM app.workspaces ORDER BY id',
    );
    assert.deepEqual(workerVisible.map((row) => row.id), [workspaceA]);

    const pipelineA = randomUUID();
    const pipelineB = randomUUID();
    const openStageA = randomUUID();
    const wonStageA = randomUUID();
    const openStageB = randomUUID();
    const contactA = randomUUID();
    const contactB = randomUUID();
    const opportunityA = randomUUID();
    const taskA = randomUUID();
    const historyA = randomUUID();
    const activityA = randomUUID();
    const outboxA = randomUUID();
    const receiptA = randomUUID();

    await withOwnerClient(pool, async (client) => {
      await client.query(
        `INSERT INTO app.pipelines (id, workspace_id, name, slug, is_default)
         VALUES ($1, $2, 'Sales A', 'sales-a', true),
                ($3, $4, 'Sales B', 'sales-b', true)`,
        [pipelineA, workspaceA, pipelineB, workspaceB],
      );
      await client.query(
        `INSERT INTO app.pipeline_stages
           (id, workspace_id, pipeline_id, name, slug, position, stage_type, is_terminal)
         VALUES ($1, $2, $3, 'Open', 'open', 1, 'open', false),
                ($4, $2, $3, 'Won', 'won', 2, 'won', true),
                ($5, $6, $7, 'Open', 'open', 1, 'open', false)`,
        [openStageA, workspaceA, pipelineA, wonStageA, openStageB, workspaceB, pipelineB],
      );
    });

    const salesStage = await scopedQuery<{ id: string; pipeline_id: string; status: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: salesA },
      'SELECT id, pipeline_id, status FROM app_private.lock_active_default_pipeline_stage($1, $2)',
      [openStageA, pipelineA],
    );
    assert.deepEqual(salesStage, [{ id: openStageA, pipeline_id: pipelineA, status: 'open' }]);
    const viewerStage = await scopedQuery<{ id: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: viewerA },
      'SELECT id FROM app_private.lock_active_default_pipeline_stage($1, $2)',
      [openStageA, pipelineA],
    );
    assert.deepEqual(viewerStage, []);

    // The portal's ordinary web connection is physically read-only for CRM.
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_web',
        { workspaceId: workspaceA, userId: userA },
        `INSERT INTO app.contacts
           (id, workspace_id, display_name, owner_user_id, source)
         VALUES ($1, $2, 'Web bypass attempt', $3, 'integration-test')`,
        [contactA, workspaceA, userA],
      ),
      '42501',
    );
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `INSERT INTO app.contacts
         (id, workspace_id, display_name, owner_user_id, source)
       VALUES ($1, $2, 'Lead A', $3, 'integration-test')`,
      [contactA, workspaceA, userA],
    );
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceB, userId: userB },
      `INSERT INTO app.contacts
         (id, workspace_id, display_name, owner_user_id, source)
       VALUES ($1, $2, 'Lead B', $3, 'integration-test')`,
      [contactB, workspaceB, userB],
    );

    const contactRowsA = await scopedQuery<{ id: string }>(
      pool,
      'r72_web',
      { workspaceId: workspaceA, userId: userA },
      'SELECT id FROM app.contacts ORDER BY id',
    );
    assert.deepEqual(contactRowsA, [{ id: contactA }]);
    const commandRowsA = await scopedQuery<{ id: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      'SELECT id FROM app.contacts ORDER BY id',
    );
    assert.deepEqual(commandRowsA, [{ id: contactA }]);
    const contactRowsViewer = await scopedQuery<{ id: string }>(
      pool,
      'r72_web',
      { workspaceId: workspaceA, userId: viewerA },
      'SELECT id FROM app.contacts ORDER BY id',
    );
    assert.deepEqual(contactRowsViewer, [{ id: contactA }]);

    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: userA },
        `INSERT INTO app.contacts (workspace_id, display_name)
         VALUES ($1, 'Cross-tenant injection')`,
        [workspaceB],
      ),
      '42501',
    );
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: viewerA },
        `INSERT INTO app.contacts (workspace_id, display_name)
         VALUES ($1, 'Viewer write')`,
        [workspaceA],
      ),
      '42501',
    );
    const viewerUpdated = await scopedQuery<{ id: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: viewerA },
      `UPDATE app.contacts
       SET display_name = 'Viewer rewrite', row_version = row_version + 1,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING id`,
      [contactA],
    );
    assert.deepEqual(viewerUpdated, []);
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: viewerA },
        `INSERT INTO app.pipelines (workspace_id, name, slug)
         VALUES ($1, 'Viewer pipeline', 'viewer-pipeline')`,
        [workspaceA],
      ),
      '42501',
    );

    // Composite foreign keys reject cross-workspace references even through
    // the migration owner, proving correctness does not depend on RLS alone.
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.contact_points
           (workspace_id, contact_id, kind, value, normalized_value)
         VALUES ($1, $2, 'email', 'cross@example.test', 'cross@example.test')`,
        [workspaceA, contactB],
      ),
      '23503',
    );

    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `INSERT INTO app.opportunities
         (id, workspace_id, contact_id, pipeline_id, stage_id, name, status, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, 'Lead A opportunity', 'open', $6)`,
      [opportunityA, workspaceA, contactA, pipelineA, openStageA, userA],
    );
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.opportunities
           (workspace_id, contact_id, pipeline_id, stage_id, name, status)
         VALUES ($1, $2, $3, $4, 'Cross-stage opportunity', 'open')`,
        [workspaceA, contactA, pipelineA, openStageB],
      ),
      '23503',
    );
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.opportunities
           (workspace_id, contact_id, pipeline_id, stage_id, name, status, closed_at)
         VALUES ($1, $2, $3, $4, 'Wrong semantic stage', 'won', clock_timestamp())`,
        [workspaceA, contactA, pipelineA, openStageA],
      ),
      '23503',
    );
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.opportunities
           (workspace_id, contact_id, pipeline_id, stage_id, name, status, closed_at)
         VALUES ($1, $2, $3, $4, 'Open but closed', 'open', clock_timestamp())`,
        [workspaceA, contactA, pipelineA, openStageA],
      ),
      '23514',
    );
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `INSERT INTO app.tasks
         (id, workspace_id, contact_id, opportunity_id, title, assignee_user_id)
       VALUES ($1, $2, $3, $4, 'Follow up', $5)`,
      [taskA, workspaceA, contactA, opportunityA, userA],
    );
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: userA },
        `UPDATE app.tasks
         SET status = 'completed', completed_by_user_id = $1,
             row_version = row_version + 1, updated_at = clock_timestamp()
         WHERE id = $2`,
        [userA, taskA],
      ),
      '23514',
    );
    const completedTask = await scopedQuery<{ status: string; row_version: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `UPDATE app.tasks
       SET status = 'completed', completed_at = clock_timestamp(),
           completed_by_user_id = $1, row_version = row_version + 1,
           updated_at = clock_timestamp()
       WHERE id = $2 AND row_version = 1
       RETURNING status, row_version::text`,
      [userA, taskA],
    );
    assert.deepEqual(completedTask, [{ status: 'completed', row_version: '2' }]);

    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `INSERT INTO app.opportunity_stage_history
         (id, workspace_id, pipeline_id, opportunity_id, to_stage_id,
          actor_kind, changed_by_user_id, request_id)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, 'crm-create')`,
      [historyA, workspaceA, pipelineA, opportunityA, openStageA, userA],
    );
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `INSERT INTO app.activities
         (id, workspace_id, contact_id, opportunity_id, activity_type, channel,
          actor_kind, actor_user_id, subject, request_id)
       VALUES ($1, $2, $3, $4, 'crm.contact.created', 'crm',
               'user', $5, 'Lead created', 'crm-create')`,
      [activityA, workspaceA, contactA, opportunityA, userA],
    );
    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `INSERT INTO app.outbox_events
         (id, workspace_id, aggregate_type, aggregate_id, event_type,
          idempotency_key, payload, request_id)
       VALUES ($1, $2, 'contact', $3, 'crm.contact.created',
               'crm-create-outbox', '{"version":1}'::jsonb, 'crm-create')`,
      [outboxA, workspaceA, contactA],
    );

    await scopedQuery(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `INSERT INTO app.command_receipts
         (id, workspace_id, command_name, idempotency_key, request_id,
          actor_user_id, payload_hash)
       VALUES ($1, $2, 'crm.createLead', 'integration-receipt',
               'integration-test', $3, digest('receipt-payload', 'sha256'))`,
      [receiptA, workspaceA, userA],
    );
    const completedReceipt = await scopedQuery<{ status: string }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      `UPDATE app.command_receipts
       SET status = 'succeeded', result = '{"ok":true}'::jsonb,
           response_status = 200, completed_at = clock_timestamp()
       WHERE id = $1
       RETURNING status`,
      [receiptA],
    );
    assert.deepEqual(completedReceipt, [{ status: 'succeeded' }]);
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_web',
        { workspaceId: workspaceA, userId: userA },
        'SELECT id FROM app.command_receipts WHERE id = $1',
        [receiptA],
      ),
      '42501',
    );

    // These facts are append-only even for the dedicated command identity.
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: userA },
        `UPDATE app.opportunity_stage_history SET note = 'rewritten' WHERE id = $1`,
        [historyA],
      ),
      '42501',
    );
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: userA },
        `UPDATE app.activities SET subject = 'rewritten' WHERE id = $1`,
        [activityA],
      ),
      '42501',
    );
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_crm_command',
        { workspaceId: workspaceA, userId: userA },
        `DELETE FROM app.outbox_events WHERE id = $1`,
        [outboxA],
      ),
      '42501',
    );

    // Invitation mutation is deliberately behind an audited command boundary;
    // the ordinary web role cannot write invitation rows directly.
    await expectPostgresError(
      scopedQuery(
        pool,
        'r72_web',
        { workspaceId: workspaceA, userId: userA },
        `INSERT INTO app.membership_invitations
           (organization_id, workspace_id, invited_email, workspace_role, invited_by_user_id, expires_at)
         VALUES ($1, $2, 'cross-b@example.test', 'sales', $3, clock_timestamp() + interval '1 day')`,
        [organizationA, workspaceA, userA],
      ),
      '42501',
    );
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.membership_invitations
           (organization_id, workspace_id, invited_email, workspace_role, invited_by_user_id, expires_at)
         VALUES ($1, $2, ' padded@example.test', 'sales', $3, clock_timestamp() + interval '1 day')`,
        [organizationA, workspaceA, userA],
      ),
      '23514',
    );
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.users (email) VALUES ('not-an-email')`,
      ),
      '23514',
    );

    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.user_sessions
           (token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at)
         VALUES (digest('cross-session', 'sha256'), digest('cross-csrf', 'sha256'), $1, $2, clock_timestamp() + interval '1 hour')`,
        [userA, workspaceB],
      ),
      '23503',
    );
    await expectPostgresError(
      ownerQuery(
        pool,
        `INSERT INTO app.workspace_memberships (workspace_id, organization_id, user_id, role, status)
         VALUES ($1, $2, $3, 'viewer', 'active')`,
        [workspaceB, organizationA, userA],
      ),
      '23503',
    );

    const resolved = await roleQuery<{ user_id: string; selected_workspace_id: string }>(
      pool,
      'r72_web',
      'SELECT user_id, selected_workspace_id FROM app_private.resolve_session($1)',
      [tokenHash],
    );
    assert.deepEqual(resolved, [{ user_id: userA, selected_workspace_id: workspaceA }]);
    const portalResolved = await roleQuery<{
      user_id: string;
      user_email: string;
      selected_workspace_id: string;
    }>(
      pool,
      'r72_web',
      `SELECT user_id, user_email, selected_workspace_id
       FROM app_private.resolve_portal_session($1)`,
      [tokenHash],
    );
    assert.deepEqual(portalResolved, [{
      user_id: userA,
      user_email: 'Owner-A@Example.Test',
      selected_workspace_id: workspaceA,
    }]);
    const commandSessionActive = await scopedQuery<{ active: boolean }>(
      pool,
      'r72_crm_command',
      { workspaceId: workspaceA, userId: userA },
      'SELECT app_private.lock_active_portal_session($1, $2, $3) AS active',
      [tokenHash, userA, workspaceA],
    );
    assert.deepEqual(commandSessionActive, [{ active: true }]);
    await expectPostgresError(
      roleQuery(pool, 'r72_web', 'SELECT token_hash FROM app.user_sessions'),
      '42501',
    );

    // Revoking the source organisation grant invalidates the derived workspace
    // grant and the already-issued session on its very next lookup.
    await ownerQuery(
      pool,
      `UPDATE app.organization_memberships
       SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationA, userA],
    );
    const afterRevocation = await roleQuery(
      pool,
      'r72_web',
      'SELECT * FROM app_private.resolve_session($1)',
      [tokenHash],
    );
    assert.equal(afterRevocation.length, 0);
    const staleContextRows = await scopedQuery(
      pool,
      'r72_web',
      { workspaceId: workspaceA, userId: userA },
      'SELECT id FROM app.workspaces',
    );
    assert.equal(staleContextRows.length, 0);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});

test('real PostgreSQL proves atomic native customer provisioning and one-use account setup', {
  skip,
  timeout: 120_000,
}, async () => {
  const pool = await openTestDatabase();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const idempotencyKey = `checkout-${suffix}`;
  const organizationSlug = `native-${suffix}`;
  const workspaceSlug = `sales-${suffix}`;
  const ownerEmail = `owner-${suffix}@example.test`;
  const setupToken = randomBytes(32);
  const setupTokenHash = createHash('sha256').update(setupToken).digest();
  const recipientEmailHash = createHash('sha256').update(ownerEmail).digest();
  const replayTokenHash = createHash('sha256').update(randomBytes(32)).digest();
  const deliveryId = randomUUID();
  const deliveryIv = randomBytes(12);
  const encryptedDelivery = randomBytes(96);
  const deliveryTag = randomBytes(16);
  const provisioningInput: unknown[] = [
    idempotencyKey,
    'Native Customer',
    organizationSlug,
    'Native Customer Sales',
    workspaceSlug,
    ownerEmail,
    'Native Owner',
    setupTokenHash,
    recipientEmailHash,
    'Europe/London',
    'en-GB',
    'GBP',
    deliveryId,
    1,
    'integration-key-v1',
    deliveryIv,
    encryptedDelivery,
    deliveryTag,
  ];
  const bareProvisioningInput = [
    ...provisioningInput.slice(0, 8),
    ...provisioningInput.slice(9, 12),
  ];
  const reserveSetupSql = `
    SELECT claim_expires_at
    FROM app_private.reserve_native_account_setup($1::bytea, $2::bytea, $3::bytea)`;
  const releaseSetupSql = `
    SELECT app_private.release_native_account_setup_claim(
      $1::bytea, $2::bytea, $3::bytea
    ) AS released`;
  const completeSetupSql = `
    SELECT session_id, user_id, user_email, selected_workspace_id, expires_at
    FROM app_private.complete_native_account_setup(
      $1::bytea, $2::bytea, $3::bytea, $4::text,
      $5::bytea, $6::bytea, $7::bytea, $8::bytea
    )`;
  const claimDeliverySql = `
    SELECT delivery_id, user_id, workspace_id, action_token_id,
           payload_version, encryption_key_id, encryption_iv,
           encrypted_payload, authentication_tag, recipient_email_hash,
           aad_context,
           attempt_count, lease_expires_at
    FROM app_private.claim_account_setup_deliveries($1::bytea, $2::integer, $3::integer)`;

  try {
    await resetIdentityTables(pool);

    const unsafeProvisioningMemberships = await pool.query<{ member: string; parent: string }>(
      `SELECT member.rolname AS member, parent.rolname AS parent
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       WHERE member.rolname = 'r72_provisioning_command'
          OR (parent.rolname = 'r72_provisioning_command' AND member.rolname <> current_user)`,
    );
    assert.deepEqual(unsafeProvisioningMemberships.rows, []);

    const unsafeSetupDeliveryMemberships = await pool.query<{ member: string; parent: string }>(
      `SELECT member.rolname AS member, parent.rolname AS parent
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       WHERE member.rolname = ANY ($1::text[])
          OR (parent.rolname = ANY ($2::text[]) AND member.rolname <> current_user
            AND NOT (member.rolname = 'r72_owner' AND parent.rolname = ANY ($3::text[])))`,
      [[
        'r72_onboarding_definer', 'r72_setup_delivery_definer',
        'r72_setup_delivery_command', 'r72_setup_reissue_command',
      ], [
        'r72_setup_delivery_command', 'r72_setup_reissue_command',
        'r72_onboarding_definer', 'r72_setup_delivery_definer',
      ], ['r72_onboarding_definer', 'r72_setup_delivery_definer']],
    );
    assert.deepEqual(unsafeSetupDeliveryMemberships.rows, []);

    await expectPostgresError(
      roleQuery(pool, 'r72_identity_command', provisionCustomerSql, provisioningInput),
      '42501',
    );
    await expectPostgresError(
      provisioningQuery(pool, 'SELECT id FROM app.organizations'),
      '42501',
    );
    await expectPostgresError(
      setupRuntimeQuery(pool, 'r72_setup_delivery_command', 'SELECT id FROM app_private.account_setup_deliveries'),
      '42501',
    );
    await expectPostgresError(
      setupRuntimeQuery(pool, 'r72_setup_reissue_command', 'SELECT id FROM app.users'),
      '42501',
    );
    await expectPostgresError(
      provisioningQuery(
        pool,
        `SELECT * FROM app_private.provision_customer_workspace(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )`,
        bareProvisioningInput,
      ),
      '42501',
    );

    const first = await onboardingDefinerQuery<ProvisionedCustomerRow>(
      pool,
      provisionCustomerSql,
      provisioningInput,
    );
    assert.equal(first.length, 1);
    assert.equal(first[0]!.created_now, true);
    assert.ok(first[0]!.setup_expires_at instanceof Date);
    const provisioned = first[0]!;

    const replayInput = [...provisioningInput];
    replayInput[7] = replayTokenHash;
    replayInput[12] = randomUUID();
    replayInput[16] = randomBytes(96);
    const replay = await onboardingDefinerQuery<ProvisionedCustomerRow>(
      pool,
      provisionCustomerSql,
      replayInput,
    );
    assert.deepEqual(replay.map((row) => ({
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerUserId: row.owner_user_id,
      setupTokenId: row.setup_action_token_id,
      setupExpiresAt: row.setup_expires_at.toISOString(),
      setupDeliveryId: row.setup_delivery_id,
      setupDeliveryGeneration: row.setup_delivery_generation,
      createdNow: row.created_now,
    })), [{
      organizationId: provisioned.organization_id,
      workspaceId: provisioned.workspace_id,
      ownerUserId: provisioned.owner_user_id,
      setupTokenId: provisioned.setup_action_token_id,
      setupExpiresAt: provisioned.setup_expires_at.toISOString(),
      setupDeliveryId: provisioned.setup_delivery_id,
      setupDeliveryGeneration: 1,
      createdNow: false,
    }]);

    const changedInput = [...provisioningInput];
    changedInput[3] = 'Changed workspace name';
    await expectPostgresError(
      onboardingDefinerQuery(pool, provisionCustomerSql, changedInput),
      '22023',
    );

    const canonicalCounts = await ownerQuery<{
      organizations: number;
      users: number;
      workspaces: number;
      organization_memberships: number;
      workspace_memberships: number;
      setup_tokens: number;
      receipts: number;
      setup_deliveries: number;
      pipelines: number;
      stages: number;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::int FROM app.organizations) AS organizations,
         (SELECT count(*)::int FROM app.users) AS users,
         (SELECT count(*)::int FROM app.workspaces) AS workspaces,
         (SELECT count(*)::int FROM app.organization_memberships) AS organization_memberships,
         (SELECT count(*)::int FROM app.workspace_memberships) AS workspace_memberships,
         (SELECT count(*)::int FROM app.identity_action_tokens WHERE purpose = 'account_setup') AS setup_tokens,
         (SELECT count(*)::int FROM app_private.customer_provisioning_receipts) AS receipts,
         (SELECT count(*)::int FROM app_private.account_setup_deliveries) AS setup_deliveries,
         (SELECT count(*)::int FROM app.pipelines) AS pipelines,
         (SELECT count(*)::int FROM app.pipeline_stages) AS stages`,
    );
    assert.deepEqual(canonicalCounts, [{
      organizations: 1,
      users: 1,
      workspaces: 1,
      organization_memberships: 1,
      workspace_memberships: 1,
      setup_tokens: 1,
      receipts: 1,
      setup_deliveries: 1,
      pipelines: 1,
      stages: 5,
    }]);

    const pendingIdentity = await ownerQuery<{
      email: string;
      status: string;
      password_hash: string | null;
      email_verified_at: Date | null;
      legacy_tenant_key: string | null;
      organization_role: string;
      workspace_role: string;
      organization_membership_status: string;
      workspace_membership_status: string;
    }>(
      pool,
      `SELECT person.email::text,
              person.status,
              person.password_hash,
              person.email_verified_at,
              workspace.legacy_tenant_key,
              organization_membership.role AS organization_role,
              workspace_membership.role AS workspace_role,
              organization_membership.status AS organization_membership_status,
              workspace_membership.status AS workspace_membership_status
       FROM app.users AS person
       JOIN app.workspace_memberships AS workspace_membership ON workspace_membership.user_id = person.id
       JOIN app.workspaces AS workspace ON workspace.id = workspace_membership.workspace_id
       JOIN app.organization_memberships AS organization_membership
         ON organization_membership.organization_id = workspace.organization_id
        AND organization_membership.user_id = person.id
       WHERE person.id = $1`,
      [provisioned.owner_user_id],
    );
    assert.deepEqual(pendingIdentity, [{
      email: ownerEmail,
      status: 'pending',
      password_hash: null,
      email_verified_at: null,
      legacy_tenant_key: null,
      organization_role: 'owner',
      workspace_role: 'owner',
      organization_membership_status: 'active',
      workspace_membership_status: 'active',
    }]);

    const defaultStages = await ownerQuery<{
      pipeline_name: string;
      pipeline_slug: string;
      is_default: boolean;
      stage_name: string;
      stage_slug: string;
      position: number;
      stage_type: string;
      is_terminal: boolean;
    }>(
      pool,
      `SELECT pipeline.name AS pipeline_name,
              pipeline.slug::text AS pipeline_slug,
              pipeline.is_default,
              stage.name AS stage_name,
              stage.slug::text AS stage_slug,
              stage.position,
              stage.stage_type,
              stage.is_terminal
       FROM app.pipelines AS pipeline
       JOIN app.pipeline_stages AS stage
         ON stage.workspace_id = pipeline.workspace_id
        AND stage.pipeline_id = pipeline.id
       WHERE pipeline.workspace_id = $1
       ORDER BY stage.position`,
      [provisioned.workspace_id],
    );
    assert.deepEqual(defaultStages, [
      { pipeline_name: 'Sales', pipeline_slug: 'sales', is_default: true, stage_name: 'New lead', stage_slug: 'new-lead', position: 1, stage_type: 'open', is_terminal: false },
      { pipeline_name: 'Sales', pipeline_slug: 'sales', is_default: true, stage_name: 'Qualified', stage_slug: 'qualified', position: 2, stage_type: 'open', is_terminal: false },
      { pipeline_name: 'Sales', pipeline_slug: 'sales', is_default: true, stage_name: 'Proposal', stage_slug: 'proposal', position: 3, stage_type: 'open', is_terminal: false },
      { pipeline_name: 'Sales', pipeline_slug: 'sales', is_default: true, stage_name: 'Won', stage_slug: 'won', position: 4, stage_type: 'won', is_terminal: true },
      { pipeline_name: 'Sales', pipeline_slug: 'sales', is_default: true, stage_name: 'Lost', stage_slug: 'lost', position: 5, stage_type: 'lost', is_terminal: true },
    ]);

    const storedCredential = await ownerQuery<{
      token_hash_hex: string;
      request_id: string;
      receipt_json: string;
      delivery_json: string;
      delivery_cipher_hex: string;
      recipient_email_hash_hex: string;
      encryption_key_id: string;
      delivery_state: string;
      raw_columns: number;
    }>(
      pool,
      `SELECT encode(action_token.token_hash, 'hex') AS token_hash_hex,
              action_token.request_id,
              receipt.receipt_json,
              to_jsonb(delivery)::text AS delivery_json,
              encode(delivery.encrypted_payload, 'hex') AS delivery_cipher_hex,
              encode(delivery.recipient_email_hash, 'hex') AS recipient_email_hash_hex,
              delivery.encryption_key_id,
              delivery.state AS delivery_state,
              raw_column_count.raw_columns
       FROM app.identity_action_tokens AS action_token
       JOIN app_private.account_setup_deliveries AS delivery
         ON delivery.action_token_id = action_token.id
       JOIN LATERAL (
         SELECT to_jsonb(provisioning_receipt)::text AS receipt_json
         FROM app_private.customer_provisioning_receipts AS provisioning_receipt
         WHERE provisioning_receipt.setup_token_id = action_token.id
       ) AS receipt ON true
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS raw_columns
         FROM information_schema.columns
         WHERE table_schema IN ('app', 'app_private')
           AND table_name IN (
             'identity_action_tokens', 'customer_provisioning_receipts',
             'account_setup_deliveries', 'account_setup_reissue_receipts',
             'account_setup_claims'
           )
           AND column_name LIKE '%raw%'
       ) AS raw_column_count
       WHERE action_token.id = $1`,
      [provisioned.setup_action_token_id],
    );
    assert.equal(storedCredential[0]!.token_hash_hex, setupTokenHash.toString('hex'));
    assert.notEqual(storedCredential[0]!.token_hash_hex, setupToken.toString('hex'));
    assert.equal(storedCredential[0]!.request_id, idempotencyKey);
    assert.equal(storedCredential[0]!.delivery_cipher_hex, encryptedDelivery.toString('hex'));
    assert.equal(storedCredential[0]!.recipient_email_hash_hex, recipientEmailHash.toString('hex'));
    assert.equal(storedCredential[0]!.encryption_key_id, 'integration-key-v1');
    assert.equal(storedCredential[0]!.delivery_state, 'pending');
    assert.equal(storedCredential[0]!.raw_columns, 0);
    assert.doesNotMatch(storedCredential[0]!.receipt_json, new RegExp(setupToken.toString('hex'), 'i'));
    assert.doesNotMatch(storedCredential[0]!.receipt_json, new RegExp(setupToken.toString('base64url'), 'i'));
    assert.doesNotMatch(storedCredential[0]!.delivery_json, new RegExp(setupToken.toString('hex'), 'i'));
    assert.doesNotMatch(storedCredential[0]!.delivery_json, new RegExp(setupToken.toString('base64url'), 'i'));

    const collisionKey = `collision-${suffix}`;
    const collisionSlug = `collision-${suffix}`;
    const collisionEmail = `collision-${suffix}@example.test`;
    const collisionInput: unknown[] = [
      collisionKey,
      'Collision Customer',
      collisionSlug,
      'Collision Workspace',
      `workspace-${collisionSlug}`,
      collisionEmail,
      'Collision Owner',
      setupTokenHash,
      createHash('sha256').update(collisionEmail).digest(),
      'Europe/London',
      'en-GB',
      'GBP',
      randomUUID(),
      1,
      'integration-key-v1',
      randomBytes(12),
      randomBytes(96),
      randomBytes(16),
    ];
    await expectPostgresError(
      onboardingDefinerQuery(pool, provisionCustomerSql, collisionInput),
      '23505',
    );
    const collisionRollback = await ownerQuery<{ organizations: number; receipts: number; deliveries: number }>(
      pool,
      `SELECT
         (SELECT count(*)::int FROM app.organizations WHERE slug = $1) AS organizations,
         (SELECT count(*)::int FROM app_private.customer_provisioning_receipts WHERE idempotency_key = $2) AS receipts,
         (SELECT count(*)::int FROM app_private.account_setup_deliveries WHERE user_id IN (
           SELECT id FROM app.users WHERE email::text = $3
         )) AS deliveries`,
      [collisionSlug, collisionKey, collisionEmail],
    );
    assert.deepEqual(collisionRollback, [{ organizations: 0, receipts: 0, deliveries: 0 }]);

    const passwordHash = await hashPassword('integration-native-password');
    const sessionTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const csrfSecretHash = createHash('sha256').update(randomBytes(32)).digest();
    const leaseTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const claimedDelivery = await setupRuntimeQuery<{
      delivery_id: string;
      action_token_id: string;
      encryption_key_id: string;
      encrypted_payload: Buffer;
      recipient_email_hash: Buffer;
      aad_context: Buffer;
      attempt_count: number;
    }>(pool, 'r72_setup_delivery_command', claimDeliverySql, [leaseTokenHash, 1, 60]);
    assert.equal(claimedDelivery.length, 1);
    assert.equal(claimedDelivery[0]!.delivery_id, provisioned.setup_delivery_id);
    assert.equal(claimedDelivery[0]!.action_token_id, provisioned.setup_action_token_id);
    assert.equal(claimedDelivery[0]!.encryption_key_id, 'integration-key-v1');
    assert.deepEqual(claimedDelivery[0]!.encrypted_payload, encryptedDelivery);
    assert.deepEqual(claimedDelivery[0]!.recipient_email_hash, recipientEmailHash);
    assert.deepEqual(
      claimedDelivery[0]!.aad_context,
      Buffer.concat([
        Buffer.from('r72/setup-link/v1'),
        Buffer.from([0]),
        Buffer.from(provisioned.setup_delivery_id.toLowerCase()),
      ]),
    );
    assert.equal(claimedDelivery[0]!.attempt_count, 1);

    await expectPostgresError(
      setupRuntimeQuery(
        pool,
        'r72_setup_delivery_command',
        `SELECT app_private.acknowledge_account_setup_delivery($1, $2)`,
        [provisioned.setup_delivery_id, leaseTokenHash],
      ),
      '42501',
    );
    const providerAcceptedAt = new Date();
    const acknowledged = await setupRuntimeQuery<{
      delivered_at: Date;
      provider_id: string;
      provider_reference_id: string;
    }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT delivered_at, provider_id, provider_reference_id
       FROM app_private.acknowledge_account_setup_delivery_acceptance(
         $1, $2, $3, $4, $5
       )`,
      [
        provisioned.setup_delivery_id,
        leaseTokenHash,
        'memory',
        'memory_integration_acceptance',
        providerAcceptedAt,
      ],
    );
    assert.equal(acknowledged.length, 1);
    assert.ok(acknowledged[0]!.delivered_at instanceof Date);
    assert.equal(acknowledged[0]!.provider_id, 'memory');
    assert.equal(acknowledged[0]!.provider_reference_id, 'memory_integration_acceptance');

    const persistedAcceptance = await ownerQuery<{
      state: string;
      provider_id: string;
      provider_reference_id: string;
      provider_accepted_at: Date;
      acceptance_recorded_at: Date;
      delivered_at: Date;
      payload_erased: boolean;
      lease_erased: boolean;
    }>(
      pool,
      `SELECT state, provider_id, provider_reference_id,
              provider_accepted_at, acceptance_recorded_at, delivered_at,
              encrypted_payload IS NULL AS payload_erased,
              lease_token_hash IS NULL AND lease_expires_at IS NULL AS lease_erased
       FROM app_private.account_setup_deliveries
       WHERE id = $1`,
      [provisioned.setup_delivery_id],
    );
    assert.deepEqual(persistedAcceptance, [{
      state: 'delivered',
      provider_id: 'memory',
      provider_reference_id: 'memory_integration_acceptance',
      provider_accepted_at: providerAcceptedAt,
      acceptance_recorded_at: acknowledged[0]!.delivered_at,
      delivered_at: acknowledged[0]!.delivered_at,
      payload_erased: true,
      lease_erased: true,
    }]);

    const poisonSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const poisonEmail = `poison-${poisonSuffix}@example.test`;
    const poisonDeliveryPayload = randomBytes(96);
    const poisonProvisioned = (await onboardingDefinerQuery<ProvisionedCustomerRow>(
      pool,
      provisionCustomerSql,
      [
        `poison-${poisonSuffix}`,
        'Poison Settlement Customer',
        `poison-${poisonSuffix}`,
        'Poison Settlement Workspace',
        `poison-workspace-${poisonSuffix}`,
        poisonEmail,
        'Poison Settlement Owner',
        createHash('sha256').update(randomBytes(32)).digest(),
        createHash('sha256').update(poisonEmail).digest(),
        'Europe/London',
        'en-GB',
        'GBP',
        randomUUID(),
        1,
        'integration-key-v1',
        randomBytes(12),
        poisonDeliveryPayload,
        randomBytes(16),
      ],
    ))[0]!;
    const poisonLeaseHash = createHash('sha256').update(randomBytes(32)).digest();
    const poisonClaim = await setupRuntimeQuery<{ delivery_id: string }>(
      pool,
      'r72_setup_delivery_command',
      claimDeliverySql,
      [poisonLeaseHash, 1, 60],
    );
    assert.deepEqual(poisonClaim.map((row) => row.delivery_id), [poisonProvisioned.setup_delivery_id]);

    await expectPostgresError(
      roleQuery(
        pool,
        'r72_web',
        `SELECT * FROM app_private.acknowledge_account_setup_delivery_acceptance(
          $1, $2, $3, $4, $5
        )`,
        [
          poisonProvisioned.setup_delivery_id,
          poisonLeaseHash,
          'memory',
          'unauthorized_acceptance',
          new Date(),
        ],
      ),
      '42501',
    );
    await expectPostgresError(
      roleQuery(
        pool,
        'r72_identity_command',
        `SELECT * FROM app_private.reject_account_setup_delivery_permanently(
          $1, $2, $3
        )`,
        [poisonProvisioned.setup_delivery_id, poisonLeaseHash, 'unauthorized_rejection'],
      ),
      '42501',
    );
    await expectPostgresError(
      setupRuntimeQuery(
        pool,
        'r72_setup_delivery_command',
        `SELECT * FROM app_private.acknowledge_account_setup_delivery_acceptance(
          $1, $2, $3, $4, $5
        )`,
        [
          poisonProvisioned.setup_delivery_id,
          poisonLeaseHash,
          'memory\npoison',
          'poison_reference',
          new Date(),
        ],
      ),
      '22023',
    );
    assert.deepEqual(await setupRuntimeQuery(
      pool,
      'r72_setup_delivery_command',
      `SELECT dead_lettered_at
       FROM app_private.reject_account_setup_delivery_permanently($1, $2, $3)`,
      [
        poisonProvisioned.setup_delivery_id,
        createHash('sha256').update(randomBytes(32)).digest(),
        'provider_recipient_rejected',
      ],
    ), [], 'a poison worker cannot settle another lease');

    const poisonBeforeSettlement = await ownerQuery<{
      state: string;
      payload_preserved: boolean;
      provider_id: string | null;
    }>(
      pool,
      `SELECT state,
              encrypted_payload = $2::bytea AS payload_preserved,
              provider_id
       FROM app_private.account_setup_deliveries
       WHERE id = $1`,
      [poisonProvisioned.setup_delivery_id, poisonDeliveryPayload],
    );
    assert.deepEqual(poisonBeforeSettlement, [{
      state: 'leased',
      payload_preserved: true,
      provider_id: null,
    }]);

    const permanentlyRejected = await setupRuntimeQuery<{ dead_lettered_at: Date }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT dead_lettered_at
       FROM app_private.reject_account_setup_delivery_permanently($1, $2, $3)`,
      [poisonProvisioned.setup_delivery_id, poisonLeaseHash, 'provider_recipient_rejected'],
    );
    assert.equal(permanentlyRejected.length, 1);
    assert.ok(permanentlyRejected[0]!.dead_lettered_at instanceof Date);

    const poisonAfterSettlement = await ownerQuery<{
      state: string;
      payload_erased: boolean;
      lease_erased: boolean;
      last_error_code: string;
      dead_lettered_at: Date;
      provider_id: string | null;
      provider_reference_id: string | null;
    }>(
      pool,
      `SELECT state,
              encrypted_payload IS NULL AS payload_erased,
              lease_token_hash IS NULL AND lease_expires_at IS NULL AS lease_erased,
              last_error_code, dead_lettered_at, provider_id, provider_reference_id
       FROM app_private.account_setup_deliveries
       WHERE id = $1`,
      [poisonProvisioned.setup_delivery_id],
    );
    assert.deepEqual(poisonAfterSettlement, [{
      state: 'dead_letter',
      payload_erased: true,
      lease_erased: true,
      last_error_code: 'provider_recipient_rejected',
      dead_lettered_at: permanentlyRejected[0]!.dead_lettered_at,
      provider_id: null,
      provider_reference_id: null,
    }]);

    const outageSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const outageEmail = `outage-${outageSuffix}@example.test`;
    const outageProvisioned = (await onboardingDefinerQuery<ProvisionedCustomerRow>(
      pool,
      provisionCustomerSql,
      [
        `outage-${outageSuffix}`,
        'Delayed Acceptance Customer',
        `outage-${outageSuffix}`,
        'Delayed Acceptance Workspace',
        `outage-workspace-${outageSuffix}`,
        outageEmail,
        'Delayed Acceptance Owner',
        createHash('sha256').update(randomBytes(32)).digest(),
        createHash('sha256').update(outageEmail).digest(),
        'Europe/London',
        'en-GB',
        'GBP',
        randomUUID(),
        1,
        'integration-key-v1',
        randomBytes(12),
        randomBytes(96),
        randomBytes(16),
      ],
    ))[0]!;
    const outageTimeline = await ownerQuery<{ provider_accepted_at: Date }>(
      pool,
      `UPDATE app_private.account_setup_deliveries
       SET created_at = statement_timestamp() - interval '30 minutes',
           updated_at = statement_timestamp() - interval '30 minutes',
           available_at = statement_timestamp() - interval '30 minutes'
       WHERE id = $1
       RETURNING created_at + interval '10 minutes' AS provider_accepted_at`,
      [outageProvisioned.setup_delivery_id],
    );
    const delayedProviderAcceptedAt = outageTimeline[0]!.provider_accepted_at;
    const outageLeaseHash = createHash('sha256').update(randomBytes(32)).digest();
    const outageClaim = await setupRuntimeQuery<{ delivery_id: string }>(
      pool,
      'r72_setup_delivery_command',
      claimDeliverySql,
      [outageLeaseHash, 1, 60],
    );
    assert.deepEqual(outageClaim.map((row) => row.delivery_id), [outageProvisioned.setup_delivery_id]);
    const delayedAcceptance = await setupRuntimeQuery<{
      delivered_at: Date;
      provider_id: string;
      provider_reference_id: string;
    }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT delivered_at, provider_id, provider_reference_id
       FROM app_private.acknowledge_account_setup_delivery_acceptance(
         $1, $2, $3, $4, $5
       )`,
      [
        outageProvisioned.setup_delivery_id,
        outageLeaseHash,
        'memory',
        'memory_delayed_database_settlement',
        delayedProviderAcceptedAt,
      ],
    );
    assert.equal(delayedAcceptance.length, 1);
    assert.ok(delayedAcceptance[0]!.delivered_at instanceof Date);
    assert.equal(delayedAcceptance[0]!.provider_id, 'memory');
    assert.equal(
      delayedAcceptance[0]!.provider_reference_id,
      'memory_delayed_database_settlement',
    );
    assert.deepEqual(await ownerQuery<{
      state: string;
      provider_accepted_at: Date;
      acceptance_recorded_after_outage: boolean;
    }>(
      pool,
      `SELECT state, provider_accepted_at,
              acceptance_recorded_at > provider_accepted_at + interval '10 minutes'
                AS acceptance_recorded_after_outage
       FROM app_private.account_setup_deliveries
       WHERE id = $1`,
      [outageProvisioned.setup_delivery_id],
    ), [{
      state: 'delivered',
      provider_accepted_at: delayedProviderAcceptedAt,
      acceptance_recorded_after_outage: true,
    }], 'a provider acceptance survives a database outage longer than ten minutes');

    const invalidTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const invalidClaimHash = createHash('sha256').update(randomBytes(32)).digest();
    const invalidSourceHash = createHash('sha256').update(randomBytes(32)).digest();
    assert.deepEqual(await roleQuery(
      pool,
      'r72_identity_command',
      reserveSetupSql,
      [invalidTokenHash, invalidClaimHash, invalidSourceHash],
    ), []);

    const claimHash = createHash('sha256').update(randomBytes(32)).digest();
    const sourceHash = createHash('sha256').update(randomBytes(32)).digest();
    const wrongSourceHash = createHash('sha256').update(randomBytes(32)).digest();
    await expectPostgresError(
      roleQuery(pool, 'r72_web', reserveSetupSql, [setupTokenHash, claimHash, sourceHash]),
      '42501',
    );
    await expectPostgresError(
      provisioningQuery(pool, completeSetupSql, [
        setupTokenHash, claimHash, sourceHash, passwordHash,
        sessionTokenHash, csrfSecretHash, null, null,
      ]),
      '42501',
    );

    const reserved = await roleQuery<{ claim_expires_at: Date }>(
      pool,
      'r72_identity_command',
      reserveSetupSql,
      [setupTokenHash, claimHash, sourceHash],
    );
    assert.equal(reserved.length, 1);
    assert.ok(reserved[0]!.claim_expires_at instanceof Date);
    assert.deepEqual(await roleQuery(
      pool,
      'r72_identity_command',
      reserveSetupSql,
      [setupTokenHash, createHash('sha256').update(randomBytes(32)).digest(), sourceHash],
    ), [], 'one live token has exactly one claimant');
    assert.deepEqual(await roleQuery(
      pool,
      'r72_identity_command',
      completeSetupSql,
      [
        setupTokenHash, claimHash, wrongSourceHash, passwordHash,
        sessionTokenHash, csrfSecretHash, null, null,
      ],
    ), [], 'a claim is bound to its source hash');

    const completed = await roleQuery<{
      session_id: string;
      user_id: string;
      user_email: string;
      selected_workspace_id: string;
      expires_at: Date;
    }>(
      pool,
      'r72_identity_command',
      completeSetupSql,
      [
        setupTokenHash, claimHash, sourceHash, passwordHash,
        sessionTokenHash, csrfSecretHash, null, null,
      ],
    );
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.user_id, provisioned.owner_user_id);
    assert.equal(completed[0]!.user_email, ownerEmail);
    assert.equal(completed[0]!.selected_workspace_id, provisioned.workspace_id);
    assert.ok(completed[0]!.expires_at instanceof Date);

    assert.deepEqual(await roleQuery(
      pool,
      'r72_identity_command',
      reserveSetupSql,
      [setupTokenHash, createHash('sha256').update(randomBytes(32)).digest(), sourceHash],
    ), []);

    const activatedState = await ownerQuery<{
      status: string;
      password_hash: string;
      email_verified: boolean;
      row_version: string;
      token_consumed: boolean;
      token_revoked: boolean;
      sessions: number;
      setup_claims: number;
      delivery_state: string;
      delivery_payload_erased: boolean;
      delivery_superseded: boolean;
    }>(
      pool,
      `SELECT person.status,
              person.password_hash,
              person.email_verified_at IS NOT NULL AS email_verified,
              person.row_version::text,
              action_token.consumed_at IS NOT NULL AS token_consumed,
              action_token.revoked_at IS NOT NULL AS token_revoked,
              (SELECT count(*)::int FROM app.user_sessions AS session WHERE session.user_id = person.id) AS sessions,
              (SELECT count(*)::int FROM app_private.account_setup_claims AS claim WHERE claim.user_id = person.id) AS setup_claims,
              delivery.state AS delivery_state,
              delivery.encrypted_payload IS NULL AS delivery_payload_erased,
              delivery.superseded_at IS NOT NULL AS delivery_superseded
       FROM app.users AS person
       JOIN app.identity_action_tokens AS action_token ON action_token.user_id = person.id
       JOIN app_private.account_setup_deliveries AS delivery
         ON delivery.action_token_id = action_token.id
       WHERE person.id = $1 AND action_token.id = $2`,
      [provisioned.owner_user_id, provisioned.setup_action_token_id],
    );
    assert.deepEqual(activatedState, [{
      status: 'active',
      password_hash: passwordHash,
      email_verified: true,
      row_version: '2',
      token_consumed: true,
      token_revoked: false,
      sessions: 1,
      setup_claims: 0,
      delivery_state: 'delivered',
      delivery_payload_erased: true,
      delivery_superseded: false,
    }]);

    const resolved = await roleQuery<{
      session_id: string;
      user_id: string;
      user_email: string;
      selected_workspace_id: string;
    }>(
      pool,
      'r72_web',
      `SELECT session_id, user_id, user_email, selected_workspace_id
       FROM app_private.resolve_portal_session($1)`,
      [sessionTokenHash],
    );
    assert.deepEqual(resolved, [{
      session_id: completed[0]!.session_id,
      user_id: provisioned.owner_user_id,
      user_email: ownerEmail,
      selected_workspace_id: provisioned.workspace_id,
    }]);

    const raceSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const raceEmail = `race-${raceSuffix}@example.test`;
    const raceSetupTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const raceRecipientHash = createHash('sha256').update(raceEmail).digest();
    const raceProvisioningInput: unknown[] = [
      `race-${raceSuffix}`,
      'Race Customer',
      `race-${raceSuffix}`,
      'Race Workspace',
      `race-workspace-${raceSuffix}`,
      raceEmail,
      'Race Owner',
      raceSetupTokenHash,
      raceRecipientHash,
      'Europe/London',
      'en-GB',
      'GBP',
      randomUUID(),
      1,
      'integration-key-v1',
      randomBytes(12),
      randomBytes(96),
      randomBytes(16),
    ];
    const raceProvisioned = (await onboardingDefinerQuery<ProvisionedCustomerRow>(
      pool,
      provisionCustomerSql,
      raceProvisioningInput,
    ))[0]!;
    const releaseClaimHash = createHash('sha256').update(randomBytes(32)).digest();
    const raceSourceHash = createHash('sha256').update(randomBytes(32)).digest();
    assert.equal((await roleQuery(
      pool,
      'r72_identity_command',
      reserveSetupSql,
      [raceSetupTokenHash, releaseClaimHash, raceSourceHash],
    )).length, 1);
    assert.deepEqual(await roleQuery<{ released: boolean }>(
      pool,
      'r72_identity_command',
      releaseSetupSql,
      [raceSetupTokenHash, releaseClaimHash, createHash('sha256').update(randomBytes(32)).digest()],
    ), [{ released: false }]);
    assert.deepEqual(await roleQuery<{ released: boolean }>(
      pool,
      'r72_identity_command',
      releaseSetupSql,
      [raceSetupTokenHash, releaseClaimHash, raceSourceHash],
    ), [{ released: true }]);

    const firstRaceLeaseHash = createHash('sha256').update(randomBytes(32)).digest();
    assert.equal((await setupRuntimeQuery(
      pool,
      'r72_setup_delivery_command',
      claimDeliverySql,
      [firstRaceLeaseHash, 1, 60],
    )).length, 1);
    const renewed = await setupRuntimeQuery<{ lease_expires_at: Date }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT lease_expires_at
       FROM app_private.renew_account_setup_delivery_lease($1, $2, 60)`,
      [raceProvisioned.setup_delivery_id, firstRaceLeaseHash],
    );
    assert.equal(renewed.length, 1);
    const retryAt = new Date(Date.now() + 60_000);
    assert.deepEqual((await setupRuntimeQuery<{ delivery_state: string }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT delivery_state
       FROM app_private.fail_account_setup_delivery($1, $2, $3, $4)`,
      [raceProvisioned.setup_delivery_id, firstRaceLeaseHash, 'provider_unavailable', retryAt],
    )).map((row) => row.delivery_state), ['retry']);
    await ownerQuery(
      pool,
      `UPDATE app_private.account_setup_deliveries
       SET available_at = statement_timestamp()
       WHERE id = $1`,
      [raceProvisioned.setup_delivery_id],
    );
    const staleLeaseHash = createHash('sha256').update(randomBytes(32)).digest();
    assert.equal((await setupRuntimeQuery(
      pool,
      'r72_setup_delivery_command',
      claimDeliverySql,
      [staleLeaseHash, 1, 60],
    )).length, 1);

    const oldClaimHash = createHash('sha256').update(randomBytes(32)).digest();
    assert.equal((await roleQuery(
      pool,
      'r72_identity_command',
      reserveSetupSql,
      [raceSetupTokenHash, oldClaimHash, raceSourceHash],
    )).length, 1);

    const reissueSql = `
      SELECT setup_action_token_id, setup_expires_at, setup_delivery_id,
             setup_delivery_generation, created_now
      FROM app_private.reissue_native_account_setup(
        $1::text, $2::uuid, $3::uuid, $4::text, $5::bytea, $6::bytea,
        $7::uuid, $8::smallint, $9::text, $10::bytea, $11::bytea, $12::bytea
      )`;
    const reissueKey = `reissue-${raceSuffix}`;
    const reissuedTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const reissuedDeliveryId = randomUUID();
    const reissueInput: unknown[] = [
      reissueKey,
      raceProvisioned.workspace_id,
      raceProvisioned.owner_user_id,
      `support-ticket:${raceSuffix}:owner-request`,
      reissuedTokenHash,
      raceRecipientHash,
      reissuedDeliveryId,
      1,
      'integration-key-v1',
      randomBytes(12),
      randomBytes(96),
      randomBytes(16),
    ];
    const wrongRecipientKey = `wrong-recipient-${raceSuffix}`;
    await expectPostgresError(
      setupRuntimeQuery(
        pool,
        'r72_setup_reissue_command',
        reissueSql,
        [
          wrongRecipientKey,
          raceProvisioned.workspace_id,
          raceProvisioned.owner_user_id,
          `support-ticket:${raceSuffix}:wrong-recipient`,
          createHash('sha256').update(randomBytes(32)).digest(),
          createHash('sha256').update('not-the-owner@example.test').digest(),
          randomUUID(),
          1,
          'integration-key-v1',
          randomBytes(12),
          randomBytes(96),
          randomBytes(16),
        ],
      ),
      '22023',
    );
    const wrongRecipientRollback = await ownerQuery<{
      live_setup_tokens: number;
      deliveries: number;
      reissue_receipts: number;
      max_generation: number;
    }>(
      pool,
      `SELECT
         (SELECT count(*)::int
          FROM app.identity_action_tokens
          WHERE user_id = $1 AND purpose = 'account_setup'
            AND consumed_at IS NULL AND revoked_at IS NULL) AS live_setup_tokens,
         (SELECT count(*)::int
          FROM app_private.account_setup_deliveries
          WHERE user_id = $1) AS deliveries,
         (SELECT count(*)::int
          FROM app_private.account_setup_reissue_receipts
          WHERE idempotency_key = $2) AS reissue_receipts,
         (SELECT max(generation)::int
          FROM app_private.account_setup_deliveries
          WHERE user_id = $1) AS max_generation`,
      [raceProvisioned.owner_user_id, wrongRecipientKey],
    );
    assert.deepEqual(wrongRecipientRollback, [{
      live_setup_tokens: 1,
      deliveries: 1,
      reissue_receipts: 0,
      max_generation: 1,
    }], 'a recipient mismatch rolls back without installing any credential or job');
    const reissued = (await setupRuntimeQuery<{
      setup_action_token_id: string;
      setup_expires_at: Date;
      setup_delivery_id: string;
      setup_delivery_generation: number;
      created_now: boolean;
    }>(pool, 'r72_setup_reissue_command', reissueSql, reissueInput))[0]!;
    assert.equal(reissued.setup_delivery_id, reissuedDeliveryId);
    assert.equal(reissued.setup_delivery_generation, 2);
    assert.equal(reissued.created_now, true);
    assert.ok(reissued.setup_expires_at instanceof Date);

    assert.deepEqual(await setupRuntimeQuery<{
      delivered_at: Date;
      provider_id: string;
      provider_reference_id: string;
    }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT delivered_at, provider_id, provider_reference_id
       FROM app_private.acknowledge_account_setup_delivery_acceptance(
         $1, $2, $3, $4, $5
       )`,
      [
        raceProvisioned.setup_delivery_id,
        staleLeaseHash,
        'memory',
        'memory_stale_acceptance',
        new Date(),
      ],
    ), [], 'reissue fences a stale delivery worker');
    assert.deepEqual(await roleQuery(
      pool,
      'r72_identity_command',
      completeSetupSql,
      [
        raceSetupTokenHash, oldClaimHash, raceSourceHash,
        await hashPassword('revoked-password-must-not-win'),
        createHash('sha256').update(randomBytes(32)).digest(),
        createHash('sha256').update(randomBytes(32)).digest(),
        null,
        null,
      ],
    ), [], 'reissue revokes the prior token and claim atomically');

    const reissueReplay = [...reissueInput];
    reissueReplay[4] = createHash('sha256').update(randomBytes(32)).digest();
    reissueReplay[6] = randomUUID();
    reissueReplay[10] = randomBytes(96);
    const replayedReissue = (await setupRuntimeQuery<{
      setup_action_token_id: string;
      setup_expires_at: Date;
      setup_delivery_id: string;
      setup_delivery_generation: number;
      created_now: boolean;
    }>(pool, 'r72_setup_reissue_command', reissueSql, reissueReplay))[0]!;
    assert.deepEqual(replayedReissue, {
      setup_action_token_id: reissued.setup_action_token_id,
      setup_expires_at: reissued.setup_expires_at,
      setup_delivery_id: reissued.setup_delivery_id,
      setup_delivery_generation: 2,
      created_now: false,
    });

    const superseded = await ownerQuery<{
      token_revoked: boolean;
      state: string;
      payload_erased: boolean;
      superseded: boolean;
      claims: number;
    }>(
      pool,
      `SELECT action_token.revoked_at IS NOT NULL AS token_revoked,
              delivery.state,
              delivery.encrypted_payload IS NULL AS payload_erased,
              delivery.superseded_at IS NOT NULL AS superseded,
              (SELECT count(*)::int FROM app_private.account_setup_claims WHERE user_id = $1) AS claims
       FROM app.identity_action_tokens AS action_token
       JOIN app_private.account_setup_deliveries AS delivery
         ON delivery.action_token_id = action_token.id
       WHERE action_token.id = $2`,
      [raceProvisioned.owner_user_id, raceProvisioned.setup_action_token_id],
    );
    assert.deepEqual(superseded, [{
      token_revoked: true,
      state: 'superseded',
      payload_erased: true,
      superseded: true,
      claims: 0,
    }]);

    const concurrentClaimA = createHash('sha256').update(randomBytes(32)).digest();
    const concurrentClaimB = createHash('sha256').update(randomBytes(32)).digest();
    const [reservedA, reservedB] = await Promise.all([
      roleQuery<{ claim_expires_at: Date }>(
        pool,
        'r72_identity_command',
        reserveSetupSql,
        [reissuedTokenHash, concurrentClaimA, raceSourceHash],
      ),
      roleQuery<{ claim_expires_at: Date }>(
        pool,
        'r72_identity_command',
        reserveSetupSql,
        [reissuedTokenHash, concurrentClaimB, raceSourceHash],
      ),
    ]);
    assert.equal(reservedA.length + reservedB.length, 1, 'exactly one concurrent reservation wins');
    const winningClaim = reservedA.length === 1 ? concurrentClaimA : concurrentClaimB;

    const finalPasswordHash = await hashPassword('integration-concurrent-password');
    const finalSessionHash = createHash('sha256').update(randomBytes(32)).digest();
    const competingReissueInput: unknown[] = [
      `concurrent-reissue-${raceSuffix}`,
      raceProvisioned.workspace_id,
      raceProvisioned.owner_user_id,
      `support-ticket:${raceSuffix}:concurrent-reissue`,
      createHash('sha256').update(randomBytes(32)).digest(),
      raceRecipientHash,
      randomUUID(),
      1,
      'integration-key-v1',
      randomBytes(12),
      randomBytes(96),
      randomBytes(16),
    ];
    const [completionRace, reissueRace] = await Promise.allSettled([
      roleQuery<{ session_id: string }>(
        pool,
        'r72_identity_command',
        completeSetupSql,
        [
          reissuedTokenHash, winningClaim, raceSourceHash, finalPasswordHash,
          finalSessionHash, createHash('sha256').update(randomBytes(32)).digest(),
          null, null,
        ],
      ),
      setupRuntimeQuery<{
        setup_action_token_id: string;
        created_now: boolean;
      }>(pool, 'r72_setup_reissue_command', reissueSql, competingReissueInput),
    ]);
    for (const outcome of [completionRace, reissueRace]) {
      if (outcome.status === 'rejected') {
        assert.notEqual((outcome.reason as { code?: string }).code, '40P01', 'lock order prevents deadlock');
      }
    }
    assert.equal(completionRace.status, 'fulfilled');
    const completionWon = completionRace.value.length === 1;
    const reissueWon = reissueRace.status === 'fulfilled' && reissueRace.value.length === 1;
    assert.notEqual(completionWon, reissueWon, 'completion or reissue wins atomically, never both');
    if (reissueRace.status === 'rejected') {
      assert.equal((reissueRace.reason as { code?: string }).code, '22023');
    }

    const raceState = await ownerQuery<{ sessions: number; active: boolean; live_setup_tokens: number }>(
      pool,
      `SELECT
         (SELECT count(*)::int FROM app.user_sessions WHERE user_id = $1) AS sessions,
         person.status = 'active' AS active,
         (SELECT count(*)::int
          FROM app.identity_action_tokens
          WHERE user_id = $1 AND purpose = 'account_setup'
            AND consumed_at IS NULL AND revoked_at IS NULL) AS live_setup_tokens
       FROM app.users AS person
       WHERE person.id = $1`,
      [raceProvisioned.owner_user_id],
    );
    assert.deepEqual(raceState, completionWon
      ? [{ sessions: 1, active: true, live_setup_tokens: 0 }]
      : [{ sessions: 0, active: false, live_setup_tokens: 1 }]);

    const expiredSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const expiredEmail = `expired-${expiredSuffix}@example.test`;
    const expiredTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const expiredProvisioned = (await onboardingDefinerQuery<ProvisionedCustomerRow>(
      pool,
      provisionCustomerSql,
      [
        `expired-${expiredSuffix}`,
        'Expired Delivery Customer',
        `expired-${expiredSuffix}`,
        'Expired Delivery Workspace',
        `expired-workspace-${expiredSuffix}`,
        expiredEmail,
        'Expired Owner',
        expiredTokenHash,
        createHash('sha256').update(expiredEmail).digest(),
        'Europe/London',
        'en-GB',
        'GBP',
        randomUUID(),
        1,
        'retired-expired-key',
        randomBytes(12),
        randomBytes(96),
        randomBytes(16),
      ],
    ))[0]!;
    const liveRequiredKeys = await setupRuntimeQuery<{ encryption_key_id: string }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT encryption_key_id
       FROM app_private.required_account_setup_delivery_key_ids()`,
    );
    assert.ok(liveRequiredKeys.some((row) => row.encryption_key_id === 'retired-expired-key'));
    await ownerQuery(
      pool,
      `UPDATE app.identity_action_tokens
       SET created_at = statement_timestamp() - interval '2 hours',
           expires_at = statement_timestamp() - interval '1 hour'
       WHERE id = $1`,
      [expiredProvisioned.setup_action_token_id],
    );
    const afterExpiryRequiredKeys = await setupRuntimeQuery<{ encryption_key_id: string }>(
      pool,
      'r72_setup_delivery_command',
      `SELECT encryption_key_id
       FROM app_private.required_account_setup_delivery_key_ids()`,
    );
    assert.equal(
      afterExpiryRequiredKeys.some((row) => row.encryption_key_id === 'retired-expired-key'),
      false,
      'expired work cannot deadlock readiness on a retired key',
    );
    await setupRuntimeQuery(
      pool,
      'r72_setup_delivery_command',
      claimDeliverySql,
      [createHash('sha256').update(randomBytes(32)).digest(), 1, 60],
    );
    const expiredDeliveryState = await ownerQuery<{
      state: string;
      payload_erased: boolean;
      last_error_code: string;
    }>(
      pool,
      `SELECT state,
              encrypted_payload IS NULL AS payload_erased,
              last_error_code
       FROM app_private.account_setup_deliveries
       WHERE id = $1`,
      [expiredProvisioned.setup_delivery_id],
    );
    assert.deepEqual(expiredDeliveryState, [{
      state: 'dead_letter',
      payload_erased: true,
      last_error_code: 'setup_token_expired',
    }]);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});

test('real PostgreSQL proves paid Checkout provenance, claim-bound fulfilment, and runtime privilege fences', {
  skip,
  timeout: 120_000,
}, async () => {
  const pool = await openTestDatabase();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const requestKey = `paid-checkout-${suffix}`;
  const stripeSessionId = `cs_test_${suffix}`;
  const stripePriceId = `price_core_${suffix}`;
  const receiptEmail = `paid-${suffix}@example.test`;
  const orderClaimHash = createHash('sha256').update(randomBytes(32)).digest();
  const wrongOrderClaimHash = createHash('sha256').update(randomBytes(32)).digest();
  const amountMinor = 7_200;

  const beginCheckoutSql = `
    SELECT checkout_intent_id, provider_idempotency_key, intent_expires_at,
           stripe_session_id, created_now
    FROM app_private.begin_one_off_checkout(
      $1::text, $2::text, $3::smallint, $4::text, $5::boolean,
      $6::text, $7::bigint, $8::text, $9::boolean, $10::bytea
    )`;
  const bindCheckoutSql = `
    SELECT checkout_intent_id, stripe_session_id, bound_now
    FROM app_private.bind_one_off_checkout_session($1::uuid, $2::text, $3::text)`;
  const recordPaidCheckoutSql = `
    SELECT event_disposition, order_id, replayed
    FROM app_private.record_paid_checkout_completed(
      $1::text, $2::text, $3::bytea, $4::timestamptz,
      $5::boolean, $6::boolean, $7::uuid, $8::uuid, $9::smallint,
      $10::text, $11::text, $12::text, $13::text,
      $14::integer, $15::integer, $16::bigint, $17::text,
      $18::text, $19::text, $20::text
    )`;
  const authorizePaidFulfilmentSql = `
    SELECT order_id, product_key, receipt_email, fulfilment_status,
           organization_id, workspace_id, owner_user_id,
           setup_action_token_id, setup_delivery_id
    FROM app_private.authorize_paid_portal_fulfilment($1::text, $2::bytea)`;
  const fulfilPaidCheckoutSql = `
    SELECT organization_id, workspace_id, owner_user_id,
           setup_action_token_id, setup_expires_at, setup_delivery_id,
           setup_delivery_generation, created_now
    FROM app_private.fulfil_paid_portal_checkout_with_setup_delivery(
      $1::text, $2::bytea, $3::text, $4::text, $5::text, $6::text,
      $7::text, $8::bytea, $9::bytea, $10::text, $11::text, $12::text,
      $13::uuid, $14::smallint, $15::text, $16::bytea, $17::bytea,
      $18::bytea
    )`;

  interface BegunCheckoutRow extends QueryResultRow {
    checkout_intent_id: string;
    provider_idempotency_key: string;
    intent_expires_at: Date;
    stripe_session_id: string | null;
    created_now: boolean;
  }
  interface RecordedCheckoutRow extends QueryResultRow {
    event_disposition: string;
    order_id: string | null;
    replayed: boolean;
  }

  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool, 'TRUNCATE app_private.checkout_intents CASCADE');

    const unsafeCommerceMemberships = await pool.query<{ member: string; parent: string }>(
      `SELECT member.rolname AS member, parent.rolname AS parent
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       WHERE member.rolname = 'r72_commerce_definer'
          OR (
            parent.rolname = 'r72_commerce_definer'
            AND member.rolname NOT IN ('r72_owner', current_user)
          )`,
    );
    assert.deepEqual(unsafeCommerceMemberships.rows, []);

    const beginInput: unknown[] = [
      requestKey,
      'core',
      1,
      'S9',
      true,
      stripePriceId,
      amountMinor,
      'gbp',
      false,
      orderClaimHash,
    ];
    await expectPostgresError(
      commerceRuntimeQuery(pool, 'r72_webhook', beginCheckoutSql, beginInput),
      '42501',
    );
    await expectPostgresError(
      commerceRuntimeQuery(pool, 'r72_public', 'SELECT id FROM app_private.checkout_intents'),
      '42501',
    );

    const begun = await commerceRuntimeQuery<BegunCheckoutRow>(
      pool,
      'r72_public',
      beginCheckoutSql,
      beginInput,
    );
    assert.equal(begun.length, 1);
    assert.equal(begun[0]!.created_now, true);
    assert.equal(begun[0]!.stripe_session_id, null);
    assert.ok(begun[0]!.intent_expires_at instanceof Date);
    assert.match(begun[0]!.provider_idempotency_key, /^r72-checkout-v1:/);
    const checkoutIntentId = begun[0]!.checkout_intent_id;
    const providerIdempotencyKey = begun[0]!.provider_idempotency_key;

    const replayedBegin = await commerceRuntimeQuery<BegunCheckoutRow>(
      pool,
      'r72_public',
      beginCheckoutSql,
      beginInput,
    );
    assert.deepEqual(replayedBegin, [{
      ...begun[0]!,
      created_now: false,
    }]);
    const changedBeginInput = [...beginInput];
    changedBeginInput[6] = amountMinor + 1;
    await expectPostgresError(
      commerceRuntimeQuery(pool, 'r72_public', beginCheckoutSql, changedBeginInput),
      '22023',
    );

    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_public',
      bindCheckoutSql,
      [checkoutIntentId, `${providerIdempotencyKey}-wrong`, stripeSessionId],
    ), []);
    const bound = await commerceRuntimeQuery<{
      checkout_intent_id: string;
      stripe_session_id: string;
      bound_now: boolean;
    }>(
      pool,
      'r72_public',
      bindCheckoutSql,
      [checkoutIntentId, providerIdempotencyKey, stripeSessionId],
    );
    assert.deepEqual(bound, [{
      checkout_intent_id: checkoutIntentId,
      stripe_session_id: stripeSessionId,
      bound_now: true,
    }]);
    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_public',
      bindCheckoutSql,
      [checkoutIntentId, providerIdempotencyKey, stripeSessionId],
    ), [{
      checkout_intent_id: checkoutIntentId,
      stripe_session_id: stripeSessionId,
      bound_now: false,
    }]);
    await expectPostgresError(
      commerceRuntimeQuery(
        pool,
        'r72_public',
        bindCheckoutSql,
        [checkoutIntentId, providerIdempotencyKey, `${stripeSessionId}_other`],
      ),
      '22023',
    );

    const exactIntent = await ownerQuery<{
      request_idempotency_key: string;
      product_key: string;
      entitlement_version: number;
      through_stage: string;
      portal_access: boolean;
      expected_price_id: string;
      expected_amount_minor: string;
      expected_currency: string;
      expected_mode: string;
      expected_livemode: boolean;
      stripe_session_id: string;
      status: string;
      request_hash_bytes: number;
      claim_hash_hex: string;
      claim_unconsumed: boolean;
    }>(
      pool,
      `SELECT intent.request_idempotency_key, intent.product_key,
              intent.entitlement_version, intent.through_stage,
              intent.portal_access, intent.expected_price_id,
              intent.expected_amount_minor::text, intent.expected_currency,
              intent.expected_mode, intent.expected_livemode,
              intent.stripe_session_id, intent.status,
              octet_length(intent.request_hash) AS request_hash_bytes,
              encode(claim.token_hash, 'hex') AS claim_hash_hex,
              claim.consumed_at IS NULL AS claim_unconsumed
       FROM app_private.checkout_intents AS intent
       JOIN app_private.order_claim_grants AS claim
         ON claim.checkout_intent_id = intent.id
       WHERE intent.id = $1`,
      [checkoutIntentId],
    );
    assert.deepEqual(exactIntent, [{
      request_idempotency_key: requestKey,
      product_key: 'core',
      entitlement_version: 1,
      through_stage: 'S9',
      portal_access: true,
      expected_price_id: stripePriceId,
      expected_amount_minor: String(amountMinor),
      expected_currency: 'gbp',
      expected_mode: 'payment',
      expected_livemode: false,
      stripe_session_id: stripeSessionId,
      status: 'session_created',
      request_hash_bytes: 32,
      claim_hash_hex: orderClaimHash.toString('hex'),
      claim_unconsumed: true,
    }]);

    const providerCreatedAt = new Date();
    const paidEventInput: unknown[] = [
      `evt_paid_${suffix}`,
      'checkout.session.completed',
      createHash('sha256').update(randomBytes(64)).digest(),
      providerCreatedAt,
      false,
      false,
      checkoutIntentId,
      checkoutIntentId,
      1,
      stripeSessionId,
      'payment',
      'paid',
      stripePriceId,
      1,
      1,
      amountMinor,
      'gbp',
      `pi_paid_${suffix}`,
      `cus_paid_${suffix}`,
      receiptEmail,
    ];
    const tamperedPriceInput = [...paidEventInput];
    tamperedPriceInput[0] = `evt_tampered_price_${suffix}`;
    tamperedPriceInput[2] = createHash('sha256').update(randomBytes(64)).digest();
    tamperedPriceInput[12] = `${stripePriceId}_poison`;
    assert.deepEqual(await commerceRuntimeQuery<RecordedCheckoutRow>(
      pool,
      'r72_webhook',
      recordPaidCheckoutSql,
      tamperedPriceInput,
    ), [{ event_disposition: 'rejected', order_id: null, replayed: false }]);

    const tamperedAmountInput = [...paidEventInput];
    tamperedAmountInput[0] = `evt_tampered_amount_${suffix}`;
    tamperedAmountInput[2] = createHash('sha256').update(randomBytes(64)).digest();
    tamperedAmountInput[15] = amountMinor + 100;
    assert.deepEqual(await commerceRuntimeQuery<RecordedCheckoutRow>(
      pool,
      'r72_webhook',
      recordPaidCheckoutSql,
      tamperedAmountInput,
    ), [{ event_disposition: 'rejected', order_id: null, replayed: false }]);
    const rejectedEvents = await ownerQuery<{
      event_id: string;
      disposition: string;
      reason_code: string;
    }>(
      pool,
      `SELECT event_id, disposition, reason_code
       FROM app_private.stripe_checkout_events
       WHERE event_id = ANY ($1::text[])
       ORDER BY event_id`,
      [[`evt_tampered_amount_${suffix}`, `evt_tampered_price_${suffix}`]],
    );
    assert.deepEqual(rejectedEvents, [
      {
        event_id: `evt_tampered_amount_${suffix}`,
        disposition: 'rejected',
        reason_code: 'checkout_amount_mismatch',
      },
      {
        event_id: `evt_tampered_price_${suffix}`,
        disposition: 'rejected',
        reason_code: 'checkout_price_mismatch',
      },
    ]);
    assert.deepEqual(await ownerQuery(
      pool,
      'SELECT id FROM app_private.platform_orders WHERE checkout_intent_id = $1',
      [checkoutIntentId],
    ), []);

    await expectPostgresError(
      commerceRuntimeQuery(pool, 'r72_public', recordPaidCheckoutSql, paidEventInput),
      '42501',
    );
    await expectPostgresError(
      commerceRuntimeQuery(pool, 'r72_webhook', 'SELECT id FROM app_private.platform_orders'),
      '42501',
    );
    const paid = await commerceRuntimeQuery<RecordedCheckoutRow>(
      pool,
      'r72_webhook',
      recordPaidCheckoutSql,
      paidEventInput,
    );
    assert.equal(paid.length, 1);
    assert.equal(paid[0]!.event_disposition, 'processed');
    assert.equal(paid[0]!.replayed, false);
    assert.ok(paid[0]!.order_id);
    const paidOrderId = paid[0]!.order_id!;
    assert.deepEqual(await commerceRuntimeQuery<RecordedCheckoutRow>(
      pool,
      'r72_webhook',
      recordPaidCheckoutSql,
      paidEventInput,
    ), [{ event_disposition: 'processed', order_id: paidOrderId, replayed: true }]);
    const changedEventDigestReplay = [...paidEventInput];
    changedEventDigestReplay[2] = createHash('sha256').update(randomBytes(64)).digest();
    await expectPostgresError(
      commerceRuntimeQuery(
        pool,
        'r72_webhook',
        recordPaidCheckoutSql,
        changedEventDigestReplay,
      ),
      '22000',
    );

    const blockedClaimHash = createHash('sha256').update(randomBytes(32)).digest();
    const blockedBegin = (await commerceRuntimeQuery<BegunCheckoutRow>(
      pool,
      'r72_public',
      beginCheckoutSql,
      [
        `blocked-checkout-${suffix}`,
        'core',
        1,
        'S9',
        true,
        stripePriceId,
        amountMinor,
        'gbp',
        false,
        blockedClaimHash,
      ],
    ))[0]!;
    const blockedSessionId = `cs_test_blocked_${suffix}`;
    assert.equal((await commerceRuntimeQuery<{
      bound_now: boolean;
    }>(
      pool,
      'r72_public',
      bindCheckoutSql,
      [blockedBegin.checkout_intent_id, blockedBegin.provider_idempotency_key, blockedSessionId],
    ))[0]!.bound_now, true);
    const blockedPaid = await commerceRuntimeQuery<RecordedCheckoutRow>(
      pool,
      'r72_webhook',
      recordPaidCheckoutSql,
      [
        `evt_blocked_${suffix}`,
        'checkout.session.completed',
        createHash('sha256').update(randomBytes(64)).digest(),
        new Date(),
        false,
        false,
        blockedBegin.checkout_intent_id,
        blockedBegin.checkout_intent_id,
        1,
        blockedSessionId,
        'payment',
        'paid',
        stripePriceId,
        1,
        1,
        amountMinor,
        'gbp',
        `pi_blocked_${suffix}`,
        null,
        'not-an-email',
      ],
    );
    assert.equal(blockedPaid[0]!.event_disposition, 'processed');
    assert.ok(blockedPaid[0]!.order_id);
    assert.deepEqual(await ownerQuery<{
      financial_status: string;
      fulfilment_status: string;
      block_reason: string;
      receipt_email: string | null;
    }>(
      pool,
      `SELECT financial_status, fulfilment_status, block_reason,
              receipt_email::text
       FROM app_private.platform_orders
       WHERE id = $1`,
      [blockedPaid[0]!.order_id],
    ), [{
      financial_status: 'paid',
      fulfilment_status: 'blocked',
      block_reason: 'missing_or_invalid_receipt_email',
      receipt_email: null,
    }]);
    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_provisioning_command',
      authorizePaidFulfilmentSql,
      [blockedSessionId, blockedClaimHash],
    ), [], 'a financially paid order with no verified email remains blocked');

    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_provisioning_command',
      authorizePaidFulfilmentSql,
      [stripeSessionId, wrongOrderClaimHash],
    ), [], 'the Stripe Session id is not itself fulfilment authority');
    const authorized = await commerceRuntimeQuery<{
      order_id: string;
      product_key: string;
      receipt_email: string;
      fulfilment_status: string;
      organization_id: string | null;
      workspace_id: string | null;
      owner_user_id: string | null;
      setup_action_token_id: string | null;
      setup_delivery_id: string | null;
    }>(
      pool,
      'r72_provisioning_command',
      authorizePaidFulfilmentSql,
      [stripeSessionId, orderClaimHash],
    );
    assert.deepEqual(authorized, [{
      order_id: paidOrderId,
      product_key: 'core',
      receipt_email: receiptEmail,
      fulfilment_status: 'awaiting_intake',
      organization_id: null,
      workspace_id: null,
      owner_user_id: null,
      setup_action_token_id: null,
      setup_delivery_id: null,
    }]);
    await expectPostgresError(
      commerceRuntimeQuery(
        pool,
        'r72_public',
        authorizePaidFulfilmentSql,
        [stripeSessionId, orderClaimHash],
      ),
      '42501',
    );

    const organizationSlug = `paid-${suffix}`;
    const workspaceSlug = `paid-workspace-${suffix}`;
    const setupTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const recipientEmailHash = createHash('sha256').update(receiptEmail).digest();
    const paidDeliveryId = randomUUID();
    const deliveryIv = randomBytes(12);
    const encryptedDelivery = randomBytes(96);
    const deliveryTag = randomBytes(16);
    const fulfilInput: unknown[] = [
      stripeSessionId,
      orderClaimHash,
      'Paid Customer',
      organizationSlug,
      'Paid Customer Sales',
      workspaceSlug,
      'Paid Owner',
      setupTokenHash,
      recipientEmailHash,
      'Europe/London',
      'en-GB',
      'GBP',
      paidDeliveryId,
      1,
      'integration-key-v1',
      deliveryIv,
      encryptedDelivery,
      deliveryTag,
    ];
    const directInnerInput: unknown[] = [
      stripeSessionId,
      'Paid Customer',
      organizationSlug,
      'Paid Customer Sales',
      workspaceSlug,
      receiptEmail,
      'Paid Owner',
      setupTokenHash,
      recipientEmailHash,
      'Europe/London',
      'en-GB',
      'GBP',
      paidDeliveryId,
      1,
      'integration-key-v1',
      deliveryIv,
      encryptedDelivery,
      deliveryTag,
    ];
    await expectPostgresError(
      provisioningQuery(pool, provisionCustomerSql, directInnerInput),
      '42501',
    );
    await expectPostgresError(
      commerceRuntimeQuery(pool, 'r72_webhook', fulfilPaidCheckoutSql, fulfilInput),
      '42501',
    );
    const wrongClaimFulfilInput = [...fulfilInput];
    wrongClaimFulfilInput[1] = wrongOrderClaimHash;
    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_provisioning_command',
      fulfilPaidCheckoutSql,
      wrongClaimFulfilInput,
    ), []);

    const wrongRecipientFulfilInput = [...fulfilInput];
    wrongRecipientFulfilInput[8] = createHash('sha256').update('poison@example.test').digest();
    await expectPostgresError(
      commerceRuntimeQuery(
        pool,
        'r72_provisioning_command',
        fulfilPaidCheckoutSql,
        wrongRecipientFulfilInput,
      ),
      '22023',
    );
    assert.deepEqual(await ownerQuery<{
      fulfilment_status: string;
      claim_unconsumed: boolean;
      organizations: number;
    }>(
      pool,
      `SELECT platform_order.fulfilment_status,
              claim.consumed_at IS NULL AS claim_unconsumed,
              (SELECT count(*)::int FROM app.organizations WHERE slug = $2) AS organizations
       FROM app_private.platform_orders AS platform_order
       JOIN app_private.order_claim_grants AS claim
         ON claim.checkout_intent_id = platform_order.checkout_intent_id
       WHERE platform_order.id = $1`,
      [paidOrderId, organizationSlug],
    ), [{
      fulfilment_status: 'awaiting_intake',
      claim_unconsumed: true,
      organizations: 0,
    }], 'a failed paid fulfilment consumes nothing and links nothing');

    const [firstFulfilment, concurrentReplay] = await Promise.all([
      commerceRuntimeQuery<ProvisionedCustomerRow>(
        pool,
        'r72_provisioning_command',
        fulfilPaidCheckoutSql,
        fulfilInput,
      ),
      commerceRuntimeQuery<ProvisionedCustomerRow>(
        pool,
        'r72_provisioning_command',
        fulfilPaidCheckoutSql,
        fulfilInput,
      ),
    ]);
    assert.equal(firstFulfilment.length, 1);
    assert.equal(concurrentReplay.length, 1);
    assert.deepEqual(
      [firstFulfilment[0]!.created_now, concurrentReplay[0]!.created_now].sort(),
      [false, true],
      'one transaction provisions and the contender receives the canonical replay',
    );
    const provisioned = firstFulfilment[0]!.created_now
      ? firstFulfilment[0]!
      : concurrentReplay[0]!;
    const replayed = firstFulfilment[0]!.created_now
      ? concurrentReplay[0]!
      : firstFulfilment[0]!;
    assert.deepEqual({
      organization_id: replayed.organization_id,
      workspace_id: replayed.workspace_id,
      owner_user_id: replayed.owner_user_id,
      setup_action_token_id: replayed.setup_action_token_id,
      setup_expires_at: replayed.setup_expires_at,
      setup_delivery_id: replayed.setup_delivery_id,
      setup_delivery_generation: replayed.setup_delivery_generation,
    }, {
      organization_id: provisioned.organization_id,
      workspace_id: provisioned.workspace_id,
      owner_user_id: provisioned.owner_user_id,
      setup_action_token_id: provisioned.setup_action_token_id,
      setup_expires_at: provisioned.setup_expires_at,
      setup_delivery_id: provisioned.setup_delivery_id,
      setup_delivery_generation: provisioned.setup_delivery_generation,
    });

    const changedReplayInput = [...fulfilInput];
    changedReplayInput[2] = 'Ignored Replay Customer';
    changedReplayInput[3] = `ignored-${suffix}`;
    changedReplayInput[7] = createHash('sha256').update(randomBytes(32)).digest();
    changedReplayInput[12] = randomUUID();
    changedReplayInput[16] = randomBytes(96);
    const canonicalReplay = (await commerceRuntimeQuery<ProvisionedCustomerRow>(
      pool,
      'r72_provisioning_command',
      fulfilPaidCheckoutSql,
      changedReplayInput,
    ))[0]!;
    assert.equal(canonicalReplay.created_now, false);
    assert.deepEqual({
      organization_id: canonicalReplay.organization_id,
      workspace_id: canonicalReplay.workspace_id,
      owner_user_id: canonicalReplay.owner_user_id,
      setup_action_token_id: canonicalReplay.setup_action_token_id,
      setup_expires_at: canonicalReplay.setup_expires_at,
      setup_delivery_id: canonicalReplay.setup_delivery_id,
      setup_delivery_generation: canonicalReplay.setup_delivery_generation,
    }, {
      organization_id: provisioned.organization_id,
      workspace_id: provisioned.workspace_id,
      owner_user_id: provisioned.owner_user_id,
      setup_action_token_id: provisioned.setup_action_token_id,
      setup_expires_at: provisioned.setup_expires_at,
      setup_delivery_id: provisioned.setup_delivery_id,
      setup_delivery_generation: provisioned.setup_delivery_generation,
    });

    const settledOrder = await ownerQuery<{
      financial_status: string;
      fulfilment_status: string;
      receipt_email: string;
      organization_id: string;
      workspace_id: string;
      owner_user_id: string;
      setup_action_token_id: string;
      setup_delivery_id: string;
      claim_consumed: boolean;
      provisioning_receipt_key: string;
      setup_delivery_state: string;
    }>(
      pool,
      `SELECT platform_order.financial_status,
              platform_order.fulfilment_status,
              platform_order.receipt_email::text,
              platform_order.organization_id,
              platform_order.workspace_id,
              platform_order.owner_user_id,
              platform_order.setup_action_token_id,
              platform_order.setup_delivery_id,
              claim.consumed_at IS NOT NULL AS claim_consumed,
              receipt.idempotency_key AS provisioning_receipt_key,
              delivery.state AS setup_delivery_state
       FROM app_private.platform_orders AS platform_order
       JOIN app_private.order_claim_grants AS claim
         ON claim.checkout_intent_id = platform_order.checkout_intent_id
       JOIN app_private.customer_provisioning_receipts AS receipt
         ON receipt.organization_id = platform_order.organization_id
        AND receipt.workspace_id = platform_order.workspace_id
        AND receipt.owner_user_id = platform_order.owner_user_id
       JOIN app_private.account_setup_deliveries AS delivery
         ON delivery.id = platform_order.setup_delivery_id
       WHERE platform_order.id = $1`,
      [paidOrderId],
    );
    assert.deepEqual(settledOrder, [{
      financial_status: 'paid',
      fulfilment_status: 'provisioned',
      receipt_email: receiptEmail,
      organization_id: provisioned.organization_id,
      workspace_id: provisioned.workspace_id,
      owner_user_id: provisioned.owner_user_id,
      setup_action_token_id: provisioned.setup_action_token_id,
      setup_delivery_id: provisioned.setup_delivery_id,
      claim_consumed: true,
      provisioning_receipt_key: stripeSessionId,
      setup_delivery_state: 'pending',
    }]);
    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_provisioning_command',
      authorizePaidFulfilmentSql,
      [stripeSessionId, wrongOrderClaimHash],
    ), []);
    const authorizedReplay = await commerceRuntimeQuery<{
      order_id: string;
      product_key: string;
      receipt_email: string;
      fulfilment_status: string;
      organization_id: string;
      workspace_id: string;
      owner_user_id: string;
      setup_action_token_id: string;
      setup_delivery_id: string;
    }>(
      pool,
      'r72_provisioning_command',
      authorizePaidFulfilmentSql,
      [stripeSessionId, orderClaimHash],
    );
    assert.deepEqual(authorizedReplay, [{
      order_id: paidOrderId,
      product_key: 'core',
      receipt_email: receiptEmail,
      fulfilment_status: 'provisioned',
      organization_id: provisioned.organization_id,
      workspace_id: provisioned.workspace_id,
      owner_user_id: provisioned.owner_user_id,
      setup_action_token_id: provisioned.setup_action_token_id,
      setup_delivery_id: provisioned.setup_delivery_id,
    }]);

    await ownerQuery(
      pool,
      `UPDATE app_private.order_claim_grants
          SET created_at = statement_timestamp() - interval '2 days',
              expires_at = statement_timestamp() - interval '1 day'
        WHERE checkout_intent_id = $1`,
      [checkoutIntentId],
    );
    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_provisioning_command',
      authorizePaidFulfilmentSql,
      [stripeSessionId, orderClaimHash],
    ), [], 'a consumed claim loses replay authority when its bounded grant expires');
    assert.deepEqual(await commerceRuntimeQuery(
      pool,
      'r72_provisioning_command',
      fulfilPaidCheckoutSql,
      changedReplayInput,
    ), [], 'the atomic fulfilment command also denies an expired replay claim');
  } finally {
    await ownerQuery(pool, 'TRUNCATE app_private.checkout_intents CASCADE');
    await resetIdentityTables(pool);
    await pool.end();
  }
});
