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
  created_now: boolean;
}

const provisionCustomerSql = `
  SELECT organization_id, workspace_id, owner_user_id,
         setup_action_token_id, setup_expires_at, created_now
  FROM app_private.provision_customer_workspace(
    $1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
    $7::text, $8::bytea, $9::text, $10::text, $11::text
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
  const replayTokenHash = createHash('sha256').update(randomBytes(32)).digest();
  const provisioningInput: unknown[] = [
    idempotencyKey,
    'Native Customer',
    organizationSlug,
    'Native Customer Sales',
    workspaceSlug,
    ownerEmail,
    'Native Owner',
    setupTokenHash,
    'Europe/London',
    'en-GB',
    'GBP',
  ];
  const completeSetupSql = `
    SELECT session_id, user_id, user_email, selected_workspace_id, expires_at
    FROM app_private.complete_native_account_setup(
      $1::bytea, $2::text, $3::bytea, $4::bytea, $5::bytea, $6::bytea
    )`;

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

    await expectPostgresError(
      roleQuery(pool, 'r72_identity_command', provisionCustomerSql, provisioningInput),
      '42501',
    );
    await expectPostgresError(
      provisioningQuery(pool, 'SELECT id FROM app.organizations'),
      '42501',
    );

    const first = await provisioningQuery<ProvisionedCustomerRow>(
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
    const replay = await provisioningQuery<ProvisionedCustomerRow>(
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
      createdNow: row.created_now,
    })), [{
      organizationId: provisioned.organization_id,
      workspaceId: provisioned.workspace_id,
      ownerUserId: provisioned.owner_user_id,
      setupTokenId: provisioned.setup_action_token_id,
      setupExpiresAt: provisioned.setup_expires_at.toISOString(),
      createdNow: false,
    }]);

    const changedInput = [...provisioningInput];
    changedInput[3] = 'Changed workspace name';
    await expectPostgresError(
      provisioningQuery(pool, provisionCustomerSql, changedInput),
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
      raw_columns: number;
    }>(
      pool,
      `SELECT encode(action_token.token_hash, 'hex') AS token_hash_hex,
              action_token.request_id,
              receipt.receipt_json,
              raw_column_count.raw_columns
       FROM app.identity_action_tokens AS action_token
       JOIN LATERAL (
         SELECT to_jsonb(provisioning_receipt)::text AS receipt_json
         FROM app_private.customer_provisioning_receipts AS provisioning_receipt
         WHERE provisioning_receipt.setup_token_id = action_token.id
       ) AS receipt ON true
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS raw_columns
         FROM information_schema.columns
         WHERE table_schema IN ('app', 'app_private')
           AND table_name IN ('identity_action_tokens', 'customer_provisioning_receipts')
           AND column_name LIKE '%raw%'
       ) AS raw_column_count
       WHERE action_token.id = $1`,
      [provisioned.setup_action_token_id],
    );
    assert.equal(storedCredential[0]!.token_hash_hex, setupTokenHash.toString('hex'));
    assert.notEqual(storedCredential[0]!.token_hash_hex, setupToken.toString('hex'));
    assert.equal(storedCredential[0]!.request_id, idempotencyKey);
    assert.equal(storedCredential[0]!.raw_columns, 0);
    assert.doesNotMatch(storedCredential[0]!.receipt_json, new RegExp(setupToken.toString('hex'), 'i'));
    assert.doesNotMatch(storedCredential[0]!.receipt_json, new RegExp(setupToken.toString('base64url'), 'i'));

    const collisionKey = `collision-${suffix}`;
    const collisionSlug = `collision-${suffix}`;
    const collisionInput: unknown[] = [
      collisionKey,
      'Collision Customer',
      collisionSlug,
      'Collision Workspace',
      `workspace-${collisionSlug}`,
      `collision-${suffix}@example.test`,
      'Collision Owner',
      setupTokenHash,
      'Europe/London',
      'en-GB',
      'GBP',
    ];
    await expectPostgresError(
      provisioningQuery(pool, provisionCustomerSql, collisionInput),
      '23505',
    );
    const collisionRollback = await ownerQuery<{ organizations: number; receipts: number }>(
      pool,
      `SELECT
         (SELECT count(*)::int FROM app.organizations WHERE slug = $1) AS organizations,
         (SELECT count(*)::int FROM app_private.customer_provisioning_receipts WHERE idempotency_key = $2) AS receipts`,
      [collisionSlug, collisionKey],
    );
    assert.deepEqual(collisionRollback, [{ organizations: 0, receipts: 0 }]);

    const passwordHash = await hashPassword('integration-native-password');
    const sessionTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const csrfSecretHash = createHash('sha256').update(randomBytes(32)).digest();
    const wrongSetup = await roleQuery(
      pool,
      'r72_identity_command',
      completeSetupSql,
      [createHash('sha256').update(randomBytes(32)).digest(), passwordHash, sessionTokenHash, csrfSecretHash, null, null],
    );
    assert.deepEqual(wrongSetup, []);
    await expectPostgresError(
      roleQuery(pool, 'r72_web', completeSetupSql, [setupTokenHash, passwordHash, sessionTokenHash, csrfSecretHash, null, null]),
      '42501',
    );
    await expectPostgresError(
      provisioningQuery(pool, completeSetupSql, [setupTokenHash, passwordHash, sessionTokenHash, csrfSecretHash, null, null]),
      '42501',
    );

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
      [setupTokenHash, passwordHash, sessionTokenHash, csrfSecretHash, null, null],
    );
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.user_id, provisioned.owner_user_id);
    assert.equal(completed[0]!.user_email, ownerEmail);
    assert.equal(completed[0]!.selected_workspace_id, provisioned.workspace_id);
    assert.ok(completed[0]!.expires_at instanceof Date);

    const replayedSetup = await roleQuery(
      pool,
      'r72_identity_command',
      completeSetupSql,
      [
        setupTokenHash,
        await hashPassword('replayed-password-must-not-win'),
        createHash('sha256').update(randomBytes(32)).digest(),
        createHash('sha256').update(randomBytes(32)).digest(),
        null,
        null,
      ],
    );
    assert.deepEqual(replayedSetup, []);

    const activatedState = await ownerQuery<{
      status: string;
      password_hash: string;
      email_verified: boolean;
      row_version: string;
      token_consumed: boolean;
      token_revoked: boolean;
      sessions: number;
    }>(
      pool,
      `SELECT person.status,
              person.password_hash,
              person.email_verified_at IS NOT NULL AS email_verified,
              person.row_version::text,
              action_token.consumed_at IS NOT NULL AS token_consumed,
              action_token.revoked_at IS NOT NULL AS token_revoked,
              (SELECT count(*)::int FROM app.user_sessions AS session WHERE session.user_id = person.id) AS sessions
       FROM app.users AS person
       JOIN app.identity_action_tokens AS action_token ON action_token.user_id = person.id
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
    const raceSetupTokenHash = createHash('sha256').update(randomBytes(32)).digest();
    const raceProvisioningInput: unknown[] = [
      `race-${raceSuffix}`,
      'Race Customer',
      `race-${raceSuffix}`,
      'Race Workspace',
      `race-workspace-${raceSuffix}`,
      `race-${raceSuffix}@example.test`,
      'Race Owner',
      raceSetupTokenHash,
      'Europe/London',
      'en-GB',
      'GBP',
    ];
    const raceProvisioned = (await provisioningQuery<ProvisionedCustomerRow>(
      pool,
      provisionCustomerSql,
      raceProvisioningInput,
    ))[0]!;
    const racePasswordHash = await hashPassword('integration-race-password');
    const raceSessionA = createHash('sha256').update(randomBytes(32)).digest();
    const raceSessionB = createHash('sha256').update(randomBytes(32)).digest();
    const [raceA, raceB] = await Promise.all([
      roleQuery<{ session_id: string }>(
        pool,
        'r72_identity_command',
        completeSetupSql,
        [raceSetupTokenHash, racePasswordHash, raceSessionA, createHash('sha256').update(randomBytes(32)).digest(), null, null],
      ),
      roleQuery<{ session_id: string }>(
        pool,
        'r72_identity_command',
        completeSetupSql,
        [raceSetupTokenHash, racePasswordHash, raceSessionB, createHash('sha256').update(randomBytes(32)).digest(), null, null],
      ),
    ]);
    assert.equal(raceA.length + raceB.length, 1, 'exactly one concurrent setup claimant wins');
    const raceState = await ownerQuery<{ sessions: number; consumed: boolean; active: boolean }>(
      pool,
      `SELECT
         (SELECT count(*)::int FROM app.user_sessions WHERE user_id = $1) AS sessions,
         action_token.consumed_at IS NOT NULL AS consumed,
         person.status = 'active' AS active
       FROM app.identity_action_tokens AS action_token
       JOIN app.users AS person ON person.id = action_token.user_id
       WHERE action_token.id = $2`,
      [raceProvisioned.owner_user_id, raceProvisioned.setup_action_token_id],
    );
    assert.deepEqual(raceState, [{ sessions: 1, consumed: true, active: true }]);
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
