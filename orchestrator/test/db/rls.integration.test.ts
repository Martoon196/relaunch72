import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
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
  const storedPasswordHash = createHash('sha256').update('integration-password').digest('hex');
  const legacyTenantKey = 'integration-workspace-a';

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
         VALUES ($1, $2, $5, 'Workspace A', 'workspace-a'),
                ($3, $4, NULL, 'Workspace B', 'workspace-b'),
                ($6, $2, NULL, 'Unbridged priority workspace', 'workspace-unbridged')`,
        [workspaceA, organizationA, workspaceB, organizationB, legacyTenantKey, workspaceUnbridged],
      );
      await client.query(
        `INSERT INTO app.organization_memberships (organization_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active'), ($3, $4, 'owner', 'active')`,
        [organizationA, userA, organizationB, userB],
      );
      await client.query(
        `INSERT INTO app.workspace_memberships
           (workspace_id, organization_id, user_id, role, status, source_organization_id)
         VALUES ($1, $2, $3, 'owner', 'active', $2),
                ($4, $5, $6, 'owner', 'active', NULL),
                ($1, $2, $7, 'viewer', 'active', NULL),
                ($1, $2, $8, 'sales', 'active', NULL),
                ($9, $2, $3, 'owner', 'active', $2)`,
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
      legacy_tenant_key: string;
    }>(
      pool,
      'r72_identity_command',
      `SELECT user_id, user_email, password_hash, selected_workspace_id, legacy_tenant_key
       FROM app_private.portal_login_credential($1)`,
      [' owner-a@example.test '],
    );
    assert.deepEqual(credential, [{
      user_id: userA,
      user_email: 'Owner-A@Example.Test',
      password_hash: storedPasswordHash,
      selected_workspace_id: workspaceA,
      legacy_tenant_key: legacyTenantKey,
    }], 'login skips a higher-ranked membership until it has a valid legacy bridge');

    const issued = await roleQuery<{
      user_id: string;
      user_email: string;
      selected_workspace_id: string;
      legacy_tenant_key: string;
    }>(
      pool,
      'r72_identity_command',
      `SELECT user_id, user_email, selected_workspace_id, legacy_tenant_key
       FROM app_private.create_portal_session($1, $2, $3, $4, $5, NULL, NULL)`,
      [userA, workspaceA, storedPasswordHash, tokenHash, csrfHash],
    );
    assert.deepEqual(issued, [{
      user_id: userA,
      user_email: 'Owner-A@Example.Test',
      selected_workspace_id: workspaceA,
      legacy_tenant_key: legacyTenantKey,
    }]);
    await expectPostgresError(
      roleQuery(pool, 'r72_identity_command', 'SELECT token_hash FROM app.user_sessions'),
      '42501',
    );
    await expectPostgresError(
      roleQuery(pool, 'r72_web', 'SELECT * FROM app_private.portal_login_credential($1)', ['owner-a@example.test']),
      '42501',
    );
    const nullUpgrade = await roleQuery<{ upgraded: boolean }>(
      pool,
      'r72_identity_command',
      'SELECT app_private.upgrade_portal_password_hash($1, $2, $3) AS upgraded',
      [userA, storedPasswordHash, null],
    );
    assert.deepEqual(nullUpgrade, [{ upgraded: false }]);

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
      legacy_tenant_key: string;
    }>(
      pool,
      'r72_web',
      `SELECT user_id, user_email, selected_workspace_id, legacy_tenant_key
       FROM app_private.resolve_portal_session($1)`,
      [tokenHash],
    );
    assert.deepEqual(portalResolved, [{
      user_id: userA,
      user_email: 'Owner-A@Example.Test',
      selected_workspace_id: workspaceA,
      legacy_tenant_key: legacyTenantKey,
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
