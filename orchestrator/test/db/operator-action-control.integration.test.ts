import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { createPgOperatorActionCentreReadService } from '../../src/portal/operator-action-centre-pg-service.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

interface CommandRow {
  control_id: string;
  action_key: string;
  action_kind: string;
  source_reference: string;
  assignment_overridden: boolean;
  assigned_user_id: string | null;
  snoozed_until: Date | null;
  row_version: string;
  changed: boolean;
  event_id: string | null;
  command_receipt_id: string;
  replayed: boolean;
}

function assignment(
  pool: Pool,
  context: { workspaceId: string; userId: string; requestId: string },
  input: Readonly<{
    actionKey: string;
    actionKind: string;
    sourceReference: string;
    assignedUserId: string | null;
    expectedRowVersion: number;
    idempotencyKey: string;
  }>,
): Promise<CommandRow[]> {
  return scopedQuery<CommandRow>(
    pool,
    'r72_crm_command',
    context,
    `SELECT control_id, action_key, action_kind, source_reference,
            assignment_overridden, assigned_user_id, snoozed_until,
            row_version, changed, event_id, command_receipt_id, replayed
     FROM app_private.set_operator_action_assignment(
       $1, $2, $3, $4::uuid, $5, $6
     )`,
    [
      input.actionKey,
      input.actionKind,
      input.sourceReference,
      input.assignedUserId,
      input.expectedRowVersion,
      input.idempotencyKey,
    ],
  );
}

function snooze(
  pool: Pool,
  context: { workspaceId: string; userId: string; requestId: string },
  input: Readonly<{
    actionKey: string;
    actionKind: string;
    sourceReference: string;
    snoozedUntil: string | null;
    expectedRowVersion: number;
    idempotencyKey: string;
  }>,
): Promise<CommandRow[]> {
  return scopedQuery<CommandRow>(
    pool,
    'r72_crm_command',
    context,
    `SELECT control_id, action_key, action_kind, source_reference,
            assignment_overridden, assigned_user_id, snoozed_until,
            row_version, changed, event_id, command_receipt_id, replayed
     FROM app_private.set_operator_action_snooze(
       $1, $2, $3, $4::timestamptz, $5, $6
     )`,
    [
      input.actionKey,
      input.actionKind,
      input.sourceReference,
      input.snoozedUntil,
      input.expectedRowVersion,
      input.idempotencyKey,
    ],
  );
}

async function loadOperatorActionsAsWeb(
  pool: Pool,
  context: { workspaceId: string; userId: string; requestId: string },
) {
  const client = await pool.connect();
  await client.query('SET ROLE r72_web');
  const scopedClient = {
    query: client.query.bind(client),
    release: () => undefined,
  } as unknown as PoolClient;
  try {
    return await createPgOperatorActionCentreReadService({
      connect: async () => scopedClient,
    } as Pick<Pool, 'connect'>, 'production').load({
      ...context,
      actorKind: 'user',
    }, { limit: 1 });
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
}

test('Operator Action controls are workspace-isolated, permissioned, replay-safe and source-truth preserving', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const ownerA = randomUUID();
  const marketerA = randomUUID();
  const salesA = randomUUID();
  const viewerA = randomUUID();
  const ownerB = randomUUID();
  const ownerContext = {
    workspaceId: workspaceA,
    userId: ownerA,
    requestId: 'operator-action-owner-request',
  };
  const marketerContext = {
    workspaceId: workspaceA,
    userId: marketerA,
    requestId: 'operator-action-marketer-request',
  };
  const salesContext = {
    workspaceId: workspaceA,
    userId: salesA,
    requestId: 'operator-action-sales-request',
  };
  const viewerContext = {
    workspaceId: workspaceA,
    userId: viewerA,
    requestId: 'operator-action-viewer-request',
  };
  const otherContext = {
    workspaceId: workspaceB,
    userId: ownerB,
    requestId: 'operator-action-other-request',
  };

  try {
    await resetIdentityTables(pool);
    const suffix = organizationId.replaceAll('-', '').slice(0, 10);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Operator Action integration', $2, 'direct_customer', 'active')`,
      [organizationId, `operator-action-${suffix}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (
         id, email, display_name, status, email_verified_at
       )
       VALUES
         ($1, $2, 'Owner A', 'active', statement_timestamp()),
         ($3, $4, 'Marketer A', 'active', statement_timestamp()),
         ($5, $6, NULL, 'active', statement_timestamp()),
         ($7, $8, 'Viewer A', 'active', statement_timestamp()),
         ($9, $10, 'Owner B', 'active', statement_timestamp())`,
      [
        ownerA, `owner-${ownerA.slice(0, 8)}@example.test`,
        marketerA, `marketer-${marketerA.slice(0, 8)}@example.test`,
        salesA, `sales-${salesA.slice(0, 8)}@example.test`,
        viewerA, `viewer-${viewerA.slice(0, 8)}@example.test`,
        ownerB, `other-${ownerB.slice(0, 8)}@example.test`,
      ]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES
         ($1, $2, 'Operator Action A', $3, 'active'),
         ($4, $2, 'Operator Action B', $5, 'active')`,
      [
        workspaceA, organizationId, `operator-a-${workspaceA.slice(0, 8)}`,
        workspaceB, `operator-b-${workspaceB.slice(0, 8)}`,
      ]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES
         ($1, $2, $3, 'owner', 'active'),
         ($1, $2, $4, 'marketer', 'active'),
         ($1, $2, $5, 'sales', 'active'),
         ($1, $2, $6, 'viewer', 'active'),
         ($7, $2, $8, 'owner', 'active')`,
      [
        workspaceA, organizationId, ownerA, marketerA, salesA, viewerA,
        workspaceB, ownerB,
      ]);

    const memberDirectorySql = `
      SELECT user_id, display_name, role
      FROM app_private.list_operator_action_assignable_members($1)
    `;
    assert.deepEqual(await scopedQuery(
      pool, 'r72_web', ownerContext, memberDirectorySql, [101],
    ), [
      { user_id: ownerA, display_name: 'Owner A', role: 'owner' },
      { user_id: marketerA, display_name: 'Marketer A', role: 'marketer' },
      {
        user_id: salesA,
        display_name: `Member ${salesA.slice(0, 8)}`,
        role: 'sales',
      },
    ]);
    assert.deepEqual(await scopedQuery(
      pool, 'r72_web', marketerContext, memberDirectorySql, [101],
    ), [{ user_id: marketerA, display_name: 'Marketer A', role: 'marketer' }]);
    assert.deepEqual(await scopedQuery(
      pool, 'r72_web', viewerContext, memberDirectorySql, [101],
    ), []);
    assert.deepEqual(await scopedQuery(
      pool, 'r72_web', otherContext, memberDirectorySql, [101],
    ), [{ user_id: ownerB, display_name: 'Owner B', role: 'owner' }]);
    assert.deepEqual(await scopedQuery(
      pool,
      'r72_web',
      ownerContext,
      'SELECT id FROM app.users ORDER BY id',
    ), [{ id: ownerA }], 'ordinary app.users RLS remains self-only');
    await expectPostgresError(scopedQuery(
      pool, 'r72_web', ownerContext, memberDirectorySql, [102],
    ), '22023');
    await expectPostgresError(scopedQuery(
      pool, 'r72_crm_command', ownerContext, memberDirectorySql, [101],
    ), '42501');

    const assignInput = {
      actionKey: 'journey-laila-stall',
      actionKind: 'journey',
      sourceReference: 'conversion-enrollment:fixture-laila',
      assignedUserId: marketerA,
      expectedRowVersion: 0,
      idempotencyKey: 'assign-laila-0001',
    };
    const assigned = (await assignment(pool, ownerContext, assignInput))[0]!;
    assert.deepEqual({
      assignmentOverridden: assigned.assignment_overridden,
      assignedUserId: assigned.assigned_user_id,
      rowVersion: Number(assigned.row_version),
      changed: assigned.changed,
      replayed: assigned.replayed,
    }, {
      assignmentOverridden: true,
      assignedUserId: marketerA,
      rowVersion: 1,
      changed: true,
      replayed: false,
    });

    const replay = (await assignment(pool, ownerContext, assignInput))[0]!;
    assert.equal(replay.command_receipt_id, assigned.command_receipt_id);
    assert.equal(replay.event_id, assigned.event_id);
    assert.equal(replay.replayed, true);
    await expectPostgresError(assignment(pool, ownerContext, {
      ...assignInput,
      assignedUserId: salesA,
    }), '22023');
    await expectPostgresError(assignment(pool, ownerContext, {
      ...assignInput,
      idempotencyKey: 'assign-laila-stale',
      expectedRowVersion: 0,
    }), '40001');
    await expectPostgresError(assignment(pool, ownerContext, {
      ...assignInput,
      idempotencyKey: 'assign-laila-source-mismatch',
      sourceReference: 'conversion-enrollment:forged',
      expectedRowVersion: 1,
    }), '22023');

    const released = (await assignment(pool, marketerContext, {
      ...assignInput,
      assignedUserId: null,
      expectedRowVersion: 1,
      idempotencyKey: 'release-laila-self',
    }))[0]!;
    assert.equal(released.assignment_overridden, true);
    assert.equal(released.assigned_user_id, null);
    assert.equal(Number(released.row_version), 2);
    const reclaimed = (await assignment(pool, marketerContext, {
      ...assignInput,
      assignedUserId: marketerA,
      expectedRowVersion: 2,
      idempotencyKey: 'reclaim-laila-self',
    }))[0]!;
    assert.equal(Number(reclaimed.row_version), 3);
    const confirmed = (await assignment(pool, marketerContext, {
      ...assignInput,
      assignedUserId: marketerA,
      expectedRowVersion: 3,
      idempotencyKey: 'confirm-laila-noop',
    }))[0]!;
    assert.equal(confirmed.changed, false);
    assert.equal(confirmed.event_id, null);
    assert.equal(Number(confirmed.row_version), 3);
    await expectPostgresError(assignment(pool, marketerContext, {
      ...assignInput,
      assignedUserId: salesA,
      expectedRowVersion: 3,
      idempotencyKey: 'marketer-assigns-sales',
    }), '42501');

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const snoozed = (await snooze(pool, salesContext, {
      actionKey: assignInput.actionKey,
      actionKind: assignInput.actionKind,
      sourceReference: assignInput.sourceReference,
      snoozedUntil: future,
      expectedRowVersion: 3,
      idempotencyKey: 'sales-snoozes-laila',
    }))[0]!;
    assert.equal(Number(snoozed.row_version), 4);
    assert.equal(snoozed.assignment_overridden, true);
    assert.equal(snoozed.assigned_user_id, marketerA);

    const snoozeFirst = (await snooze(pool, marketerContext, {
      actionKey: 'crm-source-cleanup',
      actionKind: 'crm',
      sourceReference: 'crm-task:affiliate-source-fixture',
      snoozedUntil: future,
      expectedRowVersion: 0,
      idempotencyKey: 'snooze-first-crm-action',
    }))[0]!;
    assert.equal(snoozeFirst.assignment_overridden, false,
      'snooze-first must preserve the source-derived owner');
    assert.equal(snoozeFirst.assigned_user_id, null);
    const explicitUnassign = (await assignment(pool, ownerContext, {
      actionKey: 'crm-source-cleanup',
      actionKind: 'crm',
      sourceReference: 'crm-task:affiliate-source-fixture',
      assignedUserId: null,
      expectedRowVersion: 1,
      idempotencyKey: 'manager-explicit-unassign',
    }))[0]!;
    assert.equal(explicitUnassign.assignment_overridden, true,
      'explicit unassign must override a source-derived owner');
    assert.equal(explicitUnassign.assigned_user_id, null);
    assert.equal(Number(explicitUnassign.row_version), 2);

    const managerUnassignsSourceOwner = (await assignment(pool, ownerContext, {
      actionKey: 'crm-manager-unassigns-source-owner',
      actionKind: 'crm',
      sourceReference: 'crm-task:manager-unassigns-source-owner',
      assignedUserId: null,
      expectedRowVersion: 0,
      idempotencyKey: 'manager-unassigns-source-owner',
    }))[0]!;
    assert.equal(managerUnassignsSourceOwner.assignment_overridden, true,
      'a manager explicit unassignment must override source ownership even without an earlier overlay');
    assert.equal(managerUnassignsSourceOwner.assigned_user_id, null);
    assert.equal(Number(managerUnassignsSourceOwner.row_version), 1);
    assert.equal(managerUnassignsSourceOwner.changed, true);
    assert.ok(managerUnassignsSourceOwner.event_id);

    await expectPostgresError(assignment(pool, salesContext, {
      actionKey: 'crm-member-cannot-unassign-source-owner',
      actionKind: 'crm',
      sourceReference: 'crm-task:member-cannot-unassign-source-owner',
      assignedUserId: null,
      expectedRowVersion: 0,
      idempotencyKey: 'member-cannot-unassign-source-owner',
    }), '42501');

    await expectPostgresError(snooze(pool, viewerContext, {
      actionKey: assignInput.actionKey,
      actionKind: assignInput.actionKind,
      sourceReference: assignInput.sourceReference,
      snoozedUntil: future,
      expectedRowVersion: 4,
      idempotencyKey: 'viewer-cannot-snooze',
    }), '42501');

    assert.deepEqual(await scopedQuery(
      pool,
      'r72_web',
      otherContext,
      'SELECT count(*)::integer AS count FROM app.operator_action_controls',
    ), [{ count: 0 }]);
    assert.deepEqual(await scopedQuery(
      pool,
      'r72_web',
      ownerContext,
      `SELECT action_key, assignment_overridden, assigned_user_id
       FROM app.operator_action_controls ORDER BY action_key`,
    ), [
      {
        action_key: 'crm-manager-unassigns-source-owner',
        assignment_overridden: true,
        assigned_user_id: null,
      },
      {
        action_key: 'crm-source-cleanup',
        assignment_overridden: true,
        assigned_user_id: null,
      },
      {
        action_key: 'journey-laila-stall',
        assignment_overridden: true,
        assigned_user_id: marketerA,
      },
    ]);

    await expectPostgresError(scopedQuery(
      pool,
      'r72_web',
      marketerContext,
      `SELECT command_name FROM app.operator_action_command_receipts
       ORDER BY created_at, id`,
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool,
      'r72_web',
      ownerContext,
      'SELECT command_name FROM app.operator_action_command_receipts',
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool,
      'r72_web',
      ownerContext,
      'SELECT event_kind FROM app.operator_action_control_events',
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool,
      'r72_crm_command',
      ownerContext,
      'SELECT action_key FROM app.operator_action_controls',
    ), '42501');
    assert.deepEqual(await ownerQuery<{ count: number }>(pool,
      'SELECT count(*)::integer AS count FROM app.operator_action_command_receipts'),
    [{ count: 8 }]);

    await expectPostgresError(scopedQuery(
      pool,
      'r72_crm_command',
      ownerContext,
      `UPDATE app.operator_action_controls
       SET snoozed_until = NULL WHERE action_key = $1`,
      [assignInput.actionKey],
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool,
      'r72_web',
      ownerContext,
      `INSERT INTO app.operator_action_controls (
         workspace_id, action_key, action_kind, source_reference,
         created_by_user_id, updated_by_user_id,
         created_request_id, updated_request_id
       ) VALUES ($1, 'forged-web-action', 'crm', 'forged', $2, $2, 'forged', 'forged')`,
      [workspaceA, ownerA],
    ), '42501');
    await expectPostgresError(scopedQuery(
      pool,
      'r72_worker',
      ownerContext,
      'SELECT count(*) FROM app.operator_action_controls',
    ), '42501');

    await expectPostgresError(ownerQuery(
      pool,
      `UPDATE app.operator_action_control_events
       SET request_id = request_id WHERE id = $1`,
      [assigned.event_id],
    ), '55000');
    await expectPostgresError(ownerQuery(
      pool,
      `DELETE FROM app.operator_action_command_receipts
       WHERE id = $1`,
      [assigned.command_receipt_id],
    ), '55000');

    const forbiddenComplete = await ownerQuery<{ count: number }>(pool,
      `SELECT count(*)::integer AS count
       FROM pg_catalog.pg_proc AS procedure
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'app_private'
         AND procedure.proname LIKE '%operator_action%complete%'`);
    assert.deepEqual(forbiddenComplete, [{ count: 0 }]);

    // Exercise the production read service against real PostgreSQL rather than
    // a SQL-aware mock. The unified six-source query must parse under r72_web,
    // an active snooze must be removed before the global LIMIT, and the narrow
    // member directory must enrich a manager without exposing names to viewers.
    const snoozedTaskId = randomUUID();
    const visibleTaskId = randomUUID();
    await ownerQuery(pool,
      `INSERT INTO app.tasks (
         id, workspace_id, title, assignee_user_id, priority, status, due_at
       ) VALUES
         ($1, $2, 'Snoozed urgent service smoke', $3, 'urgent', 'open',
          statement_timestamp() - interval '1 hour'),
         ($4, $2, 'Visible service smoke', $3, 'normal', 'open',
          statement_timestamp() + interval '1 day')`,
      [snoozedTaskId, workspaceA, marketerA, visibleTaskId]);
    await snooze(pool, ownerContext, {
      actionKey: `crm.task:${snoozedTaskId}`,
      actionKind: 'crm',
      sourceReference: `app.tasks:${snoozedTaskId}`,
      snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      expectedRowVersion: 0,
      idempotencyKey: 'service-smoke-snoozed-task',
    });

    const managerSnapshot = await loadOperatorActionsAsWeb(pool, {
      ...ownerContext,
      requestId: 'operator-action-service-manager-read',
    });
    assert.equal(managerSnapshot.actions.length, 1);
    assert.equal(managerSnapshot.actions[0]?.actionId, `crm.task:${visibleTaskId}`,
      'the snoozed higher-priority action must not starve the next visible action');
    assert.equal(managerSnapshot.actions[0]?.ownerLabel, 'Marketer A');

    const viewerSnapshot = await loadOperatorActionsAsWeb(pool, {
      ...viewerContext,
      requestId: 'operator-action-service-viewer-read',
    });
    assert.equal(viewerSnapshot.actions[0]?.actionId, `crm.task:${visibleTaskId}`);
    assert.equal(viewerSnapshot.actions[0]?.ownerLabel, 'Assigned workspace member',
      'viewer reads must not expand the teammate directory');
  } finally {
    await resetIdentityTables(pool);
    await pool.end();
  }
});
