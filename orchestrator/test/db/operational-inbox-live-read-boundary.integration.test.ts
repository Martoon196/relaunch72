import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import '../../src/config.js';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  scopedQuery,
  testDatabaseSkipReason,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

/** The four tables whose missing r72_web grant took the whole Inbox down. */
const PROTECTED_TABLES = [
  'property_predator_customer_email_jobs',
  'property_predator_whatsapp_live_inbox_projections',
  'property_predator_sms_inbox_projections',
  'property_predator_sms_jobs',
] as const;

interface Identity {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly userId: string;
  readonly strangerId: string;
}

async function seedIdentity(pool: Pool): Promise<Identity> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const userId = randomUUID();
  const strangerId = randomUUID();
  await ownerQuery(pool,
    `INSERT INTO app.organizations (id, name, slug, kind, status)
     VALUES ($1, '0062 disposable proof', $2, 'direct_customer', 'active')`,
    [organizationId, `inbox-0062-${organizationId.slice(0, 8)}`]);
  for (const [id, label] of [[userId, 'member'], [strangerId, 'stranger']] as const) {
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [id, `inbox-0062-${label}-${id.slice(0, 8)}@example.test`]);
    await ownerQuery(pool,
      `INSERT INTO app.organization_memberships (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`, [organizationId, id]);
  }
  for (const [id, label] of [
    [workspaceId, 'primary'], [otherWorkspaceId, 'other'],
  ] as const) {
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [id, organizationId, `0062 ${label}`, `inbox-0062-${id.slice(0, 8)}`]);
  }
  // Only the primary workspace has an active membership for the acting user.
  await ownerQuery(pool,
    `INSERT INTO app.workspace_memberships (
       workspace_id, organization_id, user_id, role, status
     ) VALUES ($1, $2, $3, 'owner', 'active')`,
    [workspaceId, organizationId, userId]);
  return { organizationId, workspaceId, otherWorkspaceId, userId, strangerId };
}

async function visible(
  pool: Pool,
  identity: Identity,
  context: { workspaceId: string; userId?: string },
  args: { workspaceId: string; conversationId: string; channel: string },
): Promise<boolean> {
  const rows = await scopedQuery<{ visible: boolean | null }>(
    pool, 'r72_web', context,
    `SELECT app_private.operational_inbox_live_conversation_visible($1, $2, $3) AS visible`,
    [args.workspaceId, args.conversationId, args.channel],
  );
  return rows[0]?.visible === true;
}

test('0062 restores the Inbox read boundary for r72_web', { skip }, async (t) => {
  const pool = await openTestDatabase();
  t.after(async () => { await pool.end(); });
  await resetIdentityTables(pool);
  const identity = await seedIdentity(pool);
  const context = { workspaceId: identity.workspaceId, userId: identity.userId };

  await t.test('an empty inbox plans and runs under r72_web instead of failing closed', async () => {
    // This is the regression itself. Before 0062 the planner rejected the whole
    // statement with 42501 because r72_web could not read the live evidence
    // tables, so even a workspace with no conversation at all returned 503.
    const rows = await scopedQuery<{ id: string }>(
      pool, 'r72_web', context,
      `SELECT conversation.id
       FROM app.conversations AS conversation
       WHERE conversation.workspace_id = $1
         AND (
           conversation.environment = 'test'
           OR (
             conversation.environment = 'live'
             AND app_private.operational_inbox_live_conversation_visible(
               conversation.workspace_id, conversation.id, conversation.channel
             )
           )
         )`,
      [identity.workspaceId],
    );
    assert.deepEqual(rows, []);
  });

  await t.test('r72_web stays table-blind on every live evidence table', async () => {
    for (const table of PROTECTED_TABLES) {
      await expectPostgresError(
        scopedQuery(pool, 'r72_web', context, `SELECT 1 FROM app.${table} LIMIT 1`),
        '42501',
      );
    }
  });

  await t.test('r72_web cannot call the shared gate directly', async () => {
    await expectPostgresError(
      scopedQuery(pool, 'r72_web', context,
        'SELECT app_private.operational_inbox_live_read_allowed($1)',
        [identity.workspaceId]),
      '42501',
    );
  });

  await t.test('a live conversation is invisible without exact rail evidence', async () => {
    for (const channel of ['email', 'whatsapp', 'sms']) {
      assert.equal(
        await visible(pool, identity, context, {
          workspaceId: identity.workspaceId,
          conversationId: randomUUID(),
          channel,
        }),
        false,
        `${channel} must not be visible without evidence`,
      );
    }
  });

  await t.test('an unknown channel never falls through to visible', async () => {
    assert.equal(
      await visible(pool, identity, context, {
        workspaceId: identity.workspaceId,
        conversationId: randomUUID(),
        channel: 'social_dm',
      }),
      false,
    );
  });

  await t.test('a forged workspace argument cannot outrun the session context', async () => {
    // The argument disagrees with app.workspace_id, which is the shape a
    // cross-tenant read would take.
    assert.equal(
      await visible(pool, identity, context, {
        workspaceId: identity.otherWorkspaceId,
        conversationId: randomUUID(),
        channel: 'sms',
      }),
      false,
    );
  });

  await t.test('a workspace without active membership reads nothing', async () => {
    assert.equal(
      await visible(pool, identity,
        { workspaceId: identity.otherWorkspaceId, userId: identity.userId },
        {
          workspaceId: identity.otherWorkspaceId,
          conversationId: randomUUID(),
          channel: 'sms',
        }),
      false,
    );
    assert.equal(
      await visible(pool, identity,
        { workspaceId: identity.workspaceId, userId: identity.strangerId },
        {
          workspaceId: identity.workspaceId,
          conversationId: randomUUID(),
          channel: 'sms',
        }),
      false,
    );
  });

  await t.test('a missing user context reads nothing', async () => {
    assert.equal(
      await visible(pool, identity, { workspaceId: identity.workspaceId },
        {
          workspaceId: identity.workspaceId,
          conversationId: randomUUID(),
          channel: 'sms',
        }),
      false,
    );
  });

  await t.test('provenance and delivery linkage stay empty without evidence', async () => {
    const provenance = await scopedQuery(
      pool, 'r72_web', context,
      `SELECT receipt_id, provider_family, network, verified_at
       FROM app_private.operational_inbox_live_message_provenance($1, $2, $3)`,
      [identity.workspaceId, randomUUID(), randomUUID()],
    );
    assert.deepEqual(provenance, []);
    for (const channel of ['email', 'sms', 'whatsapp']) {
      const linked = await scopedQuery<{ linked: boolean | null }>(
        pool, 'r72_web', context,
        `SELECT app_private.operational_inbox_live_delivery_linked($1, $2, $3, $4) AS linked`,
        [identity.workspaceId, randomUUID(), randomUUID(), channel],
      );
      assert.notEqual(linked[0]?.linked, true, `${channel} must not link without evidence`);
    }
  });

  await t.test('the definer cannot read evidence payload columns', async () => {
    const [row] = await ownerQuery<{ leaked: number }>(
      pool,
      `SELECT count(*)::int AS leaked
       FROM (
         VALUES
           ('property_predator_sms_inbox_projections', 'body_sha256'),
           ('property_predator_sms_inbox_projections', 'sender_identity_sha256'),
           ('property_predator_sms_jobs', 'recipient_sha256'),
           ('property_predator_whatsapp_live_inbox_projections', 'body_sha256')
       ) AS candidate(table_name, column_name)
       WHERE pg_catalog.has_column_privilege(
         'r72_operational_inbox_definer',
         format('app.%I', candidate.table_name),
         candidate.column_name,
         'SELECT'
       )`,
    );
    assert.equal(row?.leaked, 0);
  });
});
