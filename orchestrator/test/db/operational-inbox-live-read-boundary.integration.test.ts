import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type QueryResultRow } from 'pg';
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

const LOGIN_ROLES = [
  'r72_whatsapp_live_webhook_command',
  'r72_sms_webhook_command',
] as const;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function eventIdentity(parts: readonly string[]): Buffer {
  return digest(parts.join(String.fromCharCode(31)));
}

/**
 * The inbound recording functions gate on session_user, which SET LOCAL ROLE
 * does not change, so the webhook rails need a genuine login as their role.
 */
async function openRoleLoginPool(
  ownerPool: Pool,
  role: typeof LOGIN_ROLES[number],
): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `inbox-boundary-${randomUUID()}`;
  const client = await ownerPool.connect();
  try {
    const statement = await client.query<{ sql: string }>(
      `SELECT pg_catalog.format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql`,
      [role, password],
    );
    await client.query(statement.rows[0]!.sql);
  } finally {
    client.release();
  }
  const roleUrl = new URL(rawUrl);
  roleUrl.username = role;
  roleUrl.password = password;
  return new Pool({ connectionString: roleUrl.toString(), max: 1 });
}

async function clearRoleLoginPasswords(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    for (const role of LOGIN_ROLES) {
      const statement = await client.query<{ sql: string }>(
        `SELECT pg_catalog.format('ALTER ROLE %I PASSWORD NULL', $1::text) AS sql`,
        [role],
      );
      await client.query(statement.rows[0]!.sql);
    }
  } finally {
    client.release();
  }
}

async function webhookQuery<T extends QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  requestId: string,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.workspace_id', $1, true),
              set_config('app.user_id', '', true),
              set_config('app.actor_kind', 'webhook', true),
              set_config('app.request_id', $2, true)`,
      [workspaceId, requestId],
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

/** Provider connection, owned endpoint, inbox and verified contact point per rail. */
async function seedRail(
  pool: Pool,
  identity: Identity,
  rail: {
    providerId: string;
    providerKind: string;
    channel: string;
    pointKind: string;
    capabilities: string;
    sender: string;
    owned: string;
  },
): Promise<{ connectionId: string; endpointId: string; inboxId: string; contactId: string }> {
  const connectionId = randomUUID();
  const endpointId = randomUUID();
  const inboxId = randomUUID();
  const contactId = randomUUID();
  const contactPointId = randomUUID();
  await ownerQuery(pool,
    `INSERT INTO app.contacts (
       id, workspace_id, display_name, lifecycle_status, source, owner_user_id
     ) VALUES ($1, $2, $3, 'lead', 'inbound', $4)`,
    [contactId, identity.workspaceId, `0062 ${rail.channel} lead`, identity.userId]);
  await ownerQuery(pool,
    `INSERT INTO app.contact_points (
       id, workspace_id, contact_id, kind, label, value, normalized_value,
       is_primary, is_verified, dedupe_state
     ) VALUES ($1, $2, $3, $4, '0062 verified', $5, $5, true, true, 'normal')`,
    [contactPointId, identity.workspaceId, contactId, rail.pointKind, rail.sender]);
  await ownerQuery(pool,
    `INSERT INTO app.provider_connections (
       id, workspace_id, provider_id, provider_kind, environment,
       status, display_name, capabilities, created_by_user_id
     ) VALUES ($1, $2, $3, $4, 'live', 'active', '0062 proof', $5, $6)`,
    [connectionId, identity.workspaceId, rail.providerId, rail.providerKind,
      rail.capabilities, identity.userId]);
  await ownerQuery(pool,
    `INSERT INTO app.channel_endpoints (
       id, workspace_id, provider_connection_id, channel, environment,
       direction, address, normalized_address, display_name, status
     ) VALUES ($1, $2, $3, $4, 'live', 'bidirectional', $5, $5, '0062 owned', 'active')`,
    [endpointId, identity.workspaceId, connectionId, rail.channel, rail.owned]);
  await ownerQuery(pool,
    `INSERT INTO app.inboxes (
       id, workspace_id, channel_endpoint_id, provider_connection_id,
       channel, environment, name, status
     ) VALUES ($1, $2, $3, $4, $5, 'live', '0062 inbox', 'active')`,
    [inboxId, identity.workspaceId, endpointId, connectionId, rail.channel]);
  return { connectionId, endpointId, inboxId, contactId };
}

interface Recorded {
  readonly conversationId: string;
  readonly messageId: string;
  readonly receiptId: string;
}

async function visible(
  pool: Pool,
  context: { workspaceId: string; userId?: string },
  args: { workspaceId: string; conversationId: string; channel: string },
): Promise<boolean> {
  const rows = await scopedQuery<{ visible: boolean | null }>(
    pool, 'r72_web', context,
    'SELECT app_private.operational_inbox_live_conversation_visible($1, $2, $3) AS visible',
    [args.workspaceId, args.conversationId, args.channel],
  );
  return rows[0]?.visible === true;
}

async function provenance(
  pool: Pool,
  context: { workspaceId: string; userId?: string },
  args: { workspaceId: string; conversationId: string; messageId: string },
): Promise<QueryResultRow[]> {
  return scopedQuery(
    pool, 'r72_web', context,
    `SELECT receipt_id::text, provider_family, network, verified_at
     FROM app_private.operational_inbox_live_message_provenance($1, $2, $3)`,
    [args.workspaceId, args.conversationId, args.messageId],
  );
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
        await visible(pool, context, {
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
      await visible(pool, context, {
        workspaceId: identity.workspaceId,
        conversationId: randomUUID(),
        channel: 'social_dm',
      }),
      false,
    );
  });

  await t.test('a forged workspace argument cannot outrun the session context', async () => {
    assert.equal(
      await visible(pool, context, {
        workspaceId: identity.otherWorkspaceId,
        conversationId: randomUUID(),
        channel: 'sms',
      }),
      false,
    );
  });

  await t.test('a workspace without active membership reads nothing', async () => {
    assert.equal(
      await visible(pool,
        { workspaceId: identity.otherWorkspaceId, userId: identity.userId },
        {
          workspaceId: identity.otherWorkspaceId,
          conversationId: randomUUID(),
          channel: 'sms',
        }),
      false,
    );
    assert.equal(
      await visible(pool,
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
      await visible(pool, { workspaceId: identity.workspaceId },
        {
          workspaceId: identity.workspaceId,
          conversationId: randomUUID(),
          channel: 'sms',
        }),
      false,
    );
  });

  await t.test('provenance and delivery linkage stay empty without evidence', async () => {
    assert.deepEqual(
      await provenance(pool, context, {
        workspaceId: identity.workspaceId,
        conversationId: randomUUID(),
        messageId: randomUUID(),
      }),
      [],
    );
    for (const channel of ['email', 'sms', 'whatsapp']) {
      const linked = await scopedQuery<{ linked: boolean | null }>(
        pool, 'r72_web', context,
        'SELECT app_private.operational_inbox_live_delivery_linked($1, $2, $3, $4) AS linked',
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
           ('property_predator_mailgun_inbound_receipts', 'signature_token_sha256'),
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

test('0062 exposes exact live rail evidence and nothing beside it', { skip }, async (t) => {
  const pool = await openTestDatabase();
  let whatsappPool: Pool | undefined;
  let smsPool: Pool | undefined;
  t.after(async () => {
    await whatsappPool?.end();
    await smsPool?.end();
    await clearRoleLoginPasswords(pool);
    await pool.end();
  });
  await resetIdentityTables(pool);
  const identity = await seedIdentity(pool);
  const context = { workspaceId: identity.workspaceId, userId: identity.userId };

  const whatsappRail = await seedRail(pool, identity, {
    providerId: 'meta_whatsapp_cloud',
    providerKind: 'messaging',
    channel: 'whatsapp',
    pointKind: 'whatsapp',
    capabilities: '["whatsapp"]',
    sender: '447700900111',
    owned: '447700900999',
  });
  const bindingId = randomUUID();
  await ownerQuery(pool,
    `INSERT INTO app.property_predator_whatsapp_live_bindings (
       id, workspace_id, provider_connection_id, environment, provider_id,
       app_id, waba_id, phone_number_id, owned_phone_sha256,
       graph_api_version, secret_algorithm, secret_key_version,
       secret_iv, secret_ciphertext, secret_auth_tag,
       secret_aad_sha256, secret_payload_sha256,
       ownership_evidence_sha256, ownership_observed_at, created_by_user_id
     ) VALUES ($1, $2, $3, 'live', 'meta_whatsapp_cloud',
       '12345', '23456', '34567', $4, 'v24.0', 'aes-256-gcm-v1', 'test-v1',
       $5, $6, $7, $8, $9, $10, statement_timestamp(), $11)`,
    [bindingId, identity.workspaceId, whatsappRail.connectionId, digest('owned-phone'),
      Buffer.alloc(12, 1), Buffer.alloc(38, 2), Buffer.alloc(16, 3),
      digest('aad'), digest('secret-payload'), digest('ownership'), identity.userId]);

  const smsRail = await seedRail(pool, identity, {
    providerId: 'twilio_messaging',
    // 0061 widened provider_kind to admit 'sms'; before it, no row could exist.
    providerKind: 'sms',
    channel: 'sms',
    pointKind: 'phone',
    capabilities: '["sms.send"]',
    sender: '447700900222',
    owned: '447700900888',
  });

  whatsappPool = await openRoleLoginPool(pool, 'r72_whatsapp_live_webhook_command');
  smsPool = await openRoleLoginPool(pool, 'r72_sms_webhook_command');

  async function recordWhatsApp(): Promise<Recorded> {
    const externalEventId = `evt-${randomUUID()}`;
    const providerMessageId = `wamid.${'A'.repeat(32)}`;
    const body = 'Signed WhatsApp reply for the 0062 boundary proof.';
    const sender = '447700900111';
    const senderSha = digest(sender);
    const bodySha = digest(body);
    const payloadSha = digest(`0062-whatsapp-payload-${externalEventId}`);
    const signatureSha = digest(`0062-whatsapp-signature-${externalEventId}`);
    const rows = await webhookQuery<{
      disposition: string; receipt_id: string;
      conversation_id: string; message_id: string;
    }>(whatsappPool!, identity.workspaceId, '0062-whatsapp',
      `SELECT disposition, receipt_id::text, conversation_id::text, message_id::text
       FROM app_private.record_whatsapp_live_inbound_projection(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text,
         $7::bytea, $8::bytea, $9::bytea, $10::bytea, $11::bytea, $12::timestamptz
       )`,
      [identity.workspaceId, bindingId, externalEventId, providerMessageId,
        sender, body, senderSha, bodySha, payloadSha, signatureSha,
        eventIdentity([externalEventId, providerMessageId, senderSha.toString('hex'),
          bodySha.toString('hex'), payloadSha.toString('hex'),
          signatureSha.toString('hex')]),
        new Date().toISOString()]);
    assert.equal(rows[0]?.disposition, 'applied');
    return {
      conversationId: rows[0]!.conversation_id,
      messageId: rows[0]!.message_id,
      receiptId: rows[0]!.receipt_id,
    };
  }

  async function recordSms(): Promise<Recorded> {
    const providerMessageId = `SM${'a'.repeat(32)}`;
    const externalEventId = `inbound:${providerMessageId}`;
    const body = 'Signed SMS reply for the 0062 boundary proof.';
    const sender = '447700900222';
    const senderSha = digest(sender);
    const bodySha = digest(body);
    const payloadSha = digest(`0062-sms-payload-${providerMessageId}`);
    const signatureSha = digest(`0062-sms-signature-${providerMessageId}`);
    const rows = await webhookQuery<{
      disposition: string; receipt_id: string;
      conversation_id: string; message_id: string;
    }>(smsPool!, identity.workspaceId, '0062-sms',
      `SELECT disposition, receipt_id::text, conversation_id::text, message_id::text
       FROM app_private.record_sms_live_inbound_projection(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text,
         $8::bytea, $9::bytea, $10::bytea, $11::bytea, $12::bytea, $13::timestamptz
       )`,
      [identity.workspaceId, smsRail.connectionId, externalEventId, providerMessageId,
        sender, '', body, senderSha, bodySha, payloadSha, signatureSha,
        eventIdentity([externalEventId, providerMessageId, senderSha.toString('hex'),
          bodySha.toString('hex'), payloadSha.toString('hex'),
          signatureSha.toString('hex')]),
        new Date().toISOString()]);
    assert.equal(rows[0]?.disposition, 'applied');
    return {
      conversationId: rows[0]!.conversation_id,
      messageId: rows[0]!.message_id,
      receiptId: rows[0]!.receipt_id,
    };
  }

  // Recorded once per rail. Each rail's evidence is unique by provider message
  // id and event identity, so recording again would be a replay rather than a
  // second conversation, and the assertions below all read the same evidence.
  const rails = [
    {
      name: 'whatsapp',
      channel: 'whatsapp',
      family: 'meta_whatsapp_live',
      recorded: await recordWhatsApp(),
    },
    {
      name: 'sms',
      channel: 'sms',
      family: 'twilio_sms_live',
      recorded: await recordSms(),
    },
  ] as const;

  for (const rail of rails) {
    const { recorded } = rail;
    await t.test(`exact ${rail.name} evidence makes its conversation visible`, async () => {
      assert.equal(
        await visible(pool, context, {
          workspaceId: identity.workspaceId,
          conversationId: recorded.conversationId,
          channel: rail.channel,
        }),
        true,
      );
      // The channel argument is part of the evidence test, not decoration: the
      // same conversation must not become visible through another rail's branch.
      for (const wrong of ['email', 'whatsapp', 'sms', 'social_dm']
        .filter((channel) => channel !== rail.channel)) {
        assert.equal(
          await visible(pool, context, {
            workspaceId: identity.workspaceId,
            conversationId: recorded.conversationId,
            channel: wrong,
          }),
          false,
          `${rail.name} evidence must not satisfy the ${wrong} branch`,
        );
      }
    });

    await t.test(`${rail.name} provenance is exact, bounded and free of payload`, async () => {
      const rows = await provenance(pool, context, {
        workspaceId: identity.workspaceId,
        conversationId: recorded.conversationId,
        messageId: recorded.messageId,
      });
      assert.equal(rows.length, 1, 'provenance must return exactly one bounded row');
      const [row] = rows;
      assert.equal(row!.receipt_id, recorded.receiptId, 'receipt linkage must be exact');
      assert.equal(row!.provider_family, rail.family);
      assert.equal(row!.network, rail.channel);
      assert.ok(row!.verified_at instanceof Date);
      // Only the four bounded columns may cross, so no body, sender, recipient,
      // signature or payload digest can reach r72_web through this boundary.
      assert.deepEqual(
        Object.keys(row!).sort(),
        ['network', 'provider_family', 'receipt_id', 'verified_at'],
      );
    });

    await t.test(`${rail.name} provenance rejects every wrong identifier`, async () => {
      const wrong = [
        {
          label: 'workspace',
          args: {
            workspaceId: identity.otherWorkspaceId,
            conversationId: recorded.conversationId,
            messageId: recorded.messageId,
          },
        },
        {
          label: 'conversation',
          args: {
            workspaceId: identity.workspaceId,
            conversationId: randomUUID(),
            messageId: recorded.messageId,
          },
        },
        {
          label: 'message',
          args: {
            workspaceId: identity.workspaceId,
            conversationId: recorded.conversationId,
            messageId: randomUUID(),
          },
        },
      ];
      for (const candidate of wrong) {
        assert.deepEqual(
          await provenance(pool, context, candidate.args), [],
          `a wrong ${candidate.label} must return no provenance`,
        );
      }
      // A real conversation in the wrong workspace is invisible too.
      assert.equal(
        await visible(pool, context, {
          workspaceId: identity.otherWorkspaceId,
          conversationId: recorded.conversationId,
          channel: rail.channel,
        }),
        false,
      );
    });

    await t.test(`${rail.name} evidence never links an unrelated delivery`, async () => {
      for (const channel of ['email', 'sms']) {
        const linked = await scopedQuery<{ linked: boolean | null }>(
          pool, 'r72_web', context,
          'SELECT app_private.operational_inbox_live_delivery_linked($1, $2, $3, $4) AS linked',
          [identity.workspaceId, randomUUID(), randomUUID(), channel],
        );
        assert.notEqual(linked[0]?.linked, true);
      }
      assert.ok(recorded.receiptId);
    });
  }

  await t.test('r72_web is still table-blind after all live evidence exists', async () => {
    for (const table of PROTECTED_TABLES) {
      await expectPostgresError(
        scopedQuery(pool, 'r72_web', context, `SELECT 1 FROM app.${table} LIMIT 1`),
        '42501',
      );
    }
    await expectPostgresError(
      scopedQuery(pool, 'r72_web', context,
        'SELECT app_private.operational_inbox_live_read_allowed($1)',
        [identity.workspaceId]),
      '42501',
    );
  });

  await t.test('the whole inbox list query returns the seeded live rails', async () => {
    const rows = await scopedQuery<{ channel: string }>(
      pool, 'r72_web', context,
      `SELECT conversation.channel
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
         )
       ORDER BY conversation.channel`,
      [identity.workspaceId],
    );
    assert.deepEqual(rows.map((row) => row.channel), ['sms', 'whatsapp']);
  });
});
