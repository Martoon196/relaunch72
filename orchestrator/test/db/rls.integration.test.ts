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

test('real PostgreSQL proves two-workspace RLS, same-workspace FKs, and immediate session revocation', {
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
  const tokenHash = createHash('sha256').update(randomBytes(32)).digest();
  const csrfHash = createHash('sha256').update(randomBytes(32)).digest();

  try {
    await resetIdentityTables(pool);
    const unsafeMemberships = await pool.query<{ member: string; parent: string }>(
      `SELECT member.rolname AS member, parent.rolname AS parent
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
       WHERE member.rolname = ANY ($1::text[])`,
      [['r72_security_definer', 'r72_web', 'r72_public', 'r72_worker', 'r72_webhook', 'r72_readonly']],
    );
    assert.deepEqual(unsafeMemberships.rows, []);
    await withOwnerClient(pool, async (client) => {
      await client.query(
        `INSERT INTO app.organizations (id, name, slug, kind)
         VALUES ($1, 'Agency A', 'agency-a', 'agency'), ($2, 'Direct B', 'direct-b', 'direct_customer')`,
        [organizationA, organizationB],
      );
      await client.query(
        `INSERT INTO app.users (id, email, status, email_verified_at)
         VALUES ($1, 'owner-a@example.test', 'active', clock_timestamp()),
                ($2, 'owner-b@example.test', 'active', clock_timestamp())`,
        [userA, userB],
      );
      await client.query(
        `INSERT INTO app.workspaces (id, organization_id, name, slug)
         VALUES ($1, $2, 'Workspace A', 'workspace-a'), ($3, $4, 'Workspace B', 'workspace-b')`,
        [workspaceA, organizationA, workspaceB, organizationB],
      );
      await client.query(
        `INSERT INTO app.organization_memberships (organization_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active'), ($3, $4, 'owner', 'active')`,
        [organizationA, userA, organizationB, userB],
      );
      await client.query(
        `INSERT INTO app.workspace_memberships
           (workspace_id, organization_id, user_id, role, status, source_organization_id)
         VALUES ($1, $2, $3, 'owner', 'active', $2), ($4, $5, $6, 'owner', 'active', NULL)`,
        [workspaceA, organizationA, userA, workspaceB, organizationB, userB],
      );
      await client.query(
        `INSERT INTO app.user_sessions
           (token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at)
         VALUES ($1, $2, $3, $4, clock_timestamp() + interval '1 hour')`,
        [tokenHash, csrfHash, userA, workspaceA],
      );
    });

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
