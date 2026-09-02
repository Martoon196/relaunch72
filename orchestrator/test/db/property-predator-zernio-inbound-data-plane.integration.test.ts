import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  expectPostgresError,
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
} from './database-helper.js';
import {
  PgZernioInboundRepository,
  createZernioInboundWebhookCredential,
  verifyZernioInboundWebhook,
} from '../../src/zernio-inbound-pg/index.js';

const skip = testDatabaseSkipReason();
const ROLE = 'r72_zernio_inbound_webhook_command' as const;
const INSTAGRAM_SECRET = 'zernio-instagram-inbound-integration-secret';
const LINKEDIN_SECRET = 'zernio-linkedin-inbound-integration-secret';

async function openWebhookPool(ownerPool: Pool): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `zernio-inbound-${randomUUID()}`;
  const client = await ownerPool.connect();
  try {
    const statement = await client.query<{ sql: string }>(
      `SELECT pg_catalog.format(
         'ALTER ROLE %I PASSWORD %L', $1::text, $2::text
       ) AS sql`,
      [ROLE, password],
    );
    await client.query(statement.rows[0]!.sql);
  } finally {
    client.release();
  }
  const roleUrl = new URL(rawUrl);
  roleUrl.username = ROLE;
  roleUrl.password = password;
  return new Pool({
    connectionString: roleUrl.toString(),
    max: 2,
    application_name: 'relaunch72-disposable-zernio-inbound-test',
  });
}

async function clearRolePassword(ownerPool: Pool): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query(`ALTER ROLE ${ROLE} PASSWORD NULL`);
  } finally {
    client.release();
  }
}

async function webhookQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  requestId: string,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', '', true),
              set_config('app.workspace_id', $1, true),
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

interface Fixture {
  workspaceId: string;
  ownerId: string;
  connectionId: string;
  instagramAccountId: string;
  linkedinAccountId: string;
  contactId: string;
  instagramCredential: ReturnType<typeof createZernioInboundWebhookCredential>;
  linkedinCredential: ReturnType<typeof createZernioInboundWebhookCredential>;
}

async function seedFixture(pool: Pool): Promise<Fixture> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const connectionId = randomUUID();
  const instagramAccountId = randomUUID();
  const linkedinAccountId = randomUUID();
  const contactId = randomUUID();
  const instagramInboxId = randomUUID();
  const linkedinInboxId = randomUUID();
  const instagramPointId = randomUUID();
  const linkedinPointId = randomUUID();
  const suffix = organizationId.replaceAll('-', '').slice(0, 10);
  const instagramCredential = createZernioInboundWebhookCredential({
    workspaceId,
    providerConnectionId: connectionId,
    providerProfileId: 'profile-instagram',
    credentialVersion: 'integration-v1',
    webhookSecret: INSTAGRAM_SECRET,
  });
  const linkedinCredential = createZernioInboundWebhookCredential({
    workspaceId,
    providerConnectionId: connectionId,
    providerProfileId: 'profile-linkedin',
    credentialVersion: 'integration-v1',
    webhookSecret: LINKEDIN_SECRET,
  });

  await resetIdentityTables(pool);
  await ownerQuery(pool,
    `INSERT INTO app.organizations (id, name, slug, kind, status)
     VALUES ($1, 'Zernio inbound integration', $2, 'direct_customer', 'active')`,
    [organizationId, `zernio-inbound-${suffix}`]);
  await ownerQuery(pool,
    `INSERT INTO app.users (id, email, status, email_verified_at)
     VALUES ($1, $2, 'active', statement_timestamp())`,
    [ownerId, `zernio-inbound-${ownerId.slice(0, 8)}@example.test`]);
  await ownerQuery(pool,
    `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
     VALUES ($1, $2, 'Zernio inbound', $3, 'active')`,
    [workspaceId, organizationId, `zernio-inbound-${workspaceId.slice(0, 8)}`]);
  await ownerQuery(pool,
    `INSERT INTO app.workspace_memberships (
       workspace_id, organization_id, user_id, role, status
     ) VALUES ($1, $2, $3, 'owner', 'active')`,
    [workspaceId, organizationId, ownerId]);
  await ownerQuery(pool,
    `INSERT INTO app.provider_connections (
       id, workspace_id, provider_id, provider_kind, environment,
       status, display_name, capabilities, created_by_user_id
     ) VALUES (
       $1, $2, 'zernio', 'social', 'live', 'active',
       'Zernio fixture', '["social.comments.read","social.dm.read"]'::jsonb, $3
     )`,
    [connectionId, workspaceId, ownerId]);
  await ownerQuery(pool,
    `INSERT INTO app.property_predator_zernio_accounts (
       id, workspace_id, provider_connection_id,
       provider_profile_id_sha256, provider_account_id_sha256,
       network, username, display_name, status,
       linked_at, last_event_at, created_by_user_id
     ) VALUES
       ($1, $3, $4, digest('profile-instagram', 'sha256'),
        digest('account-instagram', 'sha256'), 'instagram',
        'fixture.instagram', 'Fixture Instagram', 'active',
        statement_timestamp(), statement_timestamp(), $5),
       ($2, $3, $4, digest('profile-linkedin', 'sha256'),
        digest('account-linkedin', 'sha256'), 'linkedin',
        'fixture.linkedin', 'Fixture LinkedIn', 'active',
        statement_timestamp(), statement_timestamp(), $5)`,
    [instagramAccountId, linkedinAccountId, workspaceId, connectionId, ownerId]);

  for (const [network, accountId, inboxId] of [
    ['instagram', instagramAccountId, instagramInboxId],
    ['linkedin', linkedinAccountId, linkedinInboxId],
  ] as const) {
    const endpointId = randomUUID();
    await ownerQuery(pool,
      `INSERT INTO app.channel_endpoints (
         id, workspace_id, provider_connection_id, channel, environment,
         direction, address, normalized_address, display_name,
         provider_endpoint_ref, status
       ) VALUES (
         $1, $2, $3, $4, 'live', 'bidirectional', $5, $5,
         $6, $7, 'active'
       )`,
      [
        endpointId, workspaceId, connectionId, network,
        `zernio:${network}:${accountId}`,
        `Zernio ${network}`, accountId,
      ]);
    await ownerQuery(pool,
      `INSERT INTO app.inboxes (
         id, workspace_id, channel_endpoint_id, provider_connection_id,
         channel, environment, name, status
       ) VALUES ($1, $2, $3, $4, $5, 'live', $6, 'active')`,
      [inboxId, workspaceId, endpointId, connectionId, network, `Zernio ${network}`]);
  }

  await ownerQuery(pool,
    `INSERT INTO app.contacts (
       id, workspace_id, display_name, source, owner_user_id
     ) VALUES ($1, $2, 'Fictional Zernio person', 'integration_fixture', $3)`,
    [contactId, workspaceId, ownerId]);
  await ownerQuery(pool,
    `INSERT INTO app.contact_points (
       id, workspace_id, contact_id, kind, label, value, normalized_value,
       is_primary, is_verified, dedupe_state
     ) VALUES
       ($3, $1, $2, 'social', 'instagram', 'ig-person-1', 'ig-person-1',
        false, true, 'normal'),
       ($4, $1, $2, 'social', 'linkedin', 'li-person-1', 'li-person-1',
        false, true, 'normal')`,
    [workspaceId, contactId, instagramPointId, linkedinPointId]);

  await ownerQuery(pool,
    `INSERT INTO app.property_predator_zernio_inbound_credential_bindings (
       workspace_id, provider_connection_id, provider_profile_id_sha256,
       credential_version_sha256, credential_binding_sha256
     ) VALUES
       ($1, $2, decode($3, 'hex'), decode($4, 'hex'), decode($5, 'hex')),
       ($1, $2, decode($6, 'hex'), decode($7, 'hex'), decode($8, 'hex'))`,
    [
      workspaceId, connectionId,
      instagramCredential.providerProfileIdSha256,
      instagramCredential.credentialVersionSha256,
      instagramCredential.bindingSha256,
      linkedinCredential.providerProfileIdSha256,
      linkedinCredential.credentialVersionSha256,
      linkedinCredential.bindingSha256,
    ]);
  await ownerQuery(pool,
    `INSERT INTO app.property_predator_zernio_inbound_inbox_bindings (
       workspace_id, zernio_account_id, provider_connection_id, network,
       provider_profile_id_sha256, provider_account_id_sha256, inbox_id
     ) VALUES
       ($1, $2, $4, 'instagram', decode($5, 'hex'),
        digest('account-instagram', 'sha256'), $6),
       ($1, $3, $4, 'linkedin', decode($7, 'hex'),
        digest('account-linkedin', 'sha256'), $8)`,
    [
      workspaceId, instagramAccountId, linkedinAccountId, connectionId,
      instagramCredential.providerProfileIdSha256, instagramInboxId,
      linkedinCredential.providerProfileIdSha256, linkedinInboxId,
    ]);
  await ownerQuery(pool,
    `INSERT INTO app.property_predator_zernio_inbound_person_bindings (
       workspace_id, zernio_account_id, provider_connection_id, network,
       provider_profile_id_sha256, provider_account_id_sha256,
       provider_person_id_sha256, contact_id, contact_point_id
     ) VALUES
       ($1, $2, $4, 'instagram', decode($5, 'hex'),
        digest('account-instagram', 'sha256'), digest('ig-person-1', 'sha256'),
        $6, $7),
       ($1, $3, $4, 'linkedin', decode($8, 'hex'),
        digest('account-linkedin', 'sha256'), digest('li-person-1', 'sha256'),
        $6, $9)`,
    [
      workspaceId, instagramAccountId, linkedinAccountId, connectionId,
      instagramCredential.providerProfileIdSha256, contactId,
      instagramPointId, linkedinCredential.providerProfileIdSha256,
      linkedinPointId,
    ]);
  await ownerQuery(pool,
    `INSERT INTO app.property_predator_zernio_inbound_owned_author_bindings (
       workspace_id, zernio_account_id, provider_connection_id, network,
       provider_profile_id_sha256, provider_account_id_sha256,
       provider_owned_author_id_sha256
     ) VALUES (
       $1, $2, $3, 'instagram', decode($4, 'hex'),
       digest('account-instagram', 'sha256'), digest('ig-owned-author', 'sha256')
     )`,
    [workspaceId, instagramAccountId, connectionId,
      instagramCredential.providerProfileIdSha256]);

  return {
    workspaceId, ownerId, connectionId,
    instagramAccountId, linkedinAccountId, contactId,
    instagramCredential, linkedinCredential,
  };
}

interface InboundResult extends QueryResultRow {
  disposition: string;
  transport_receipt_id: string;
  event_id: string;
  quarantine_id: string | null;
  projection_id: string | null;
  conversation_id: string | null;
  inbound_message_id: string | null;
  admin_review_task_id: string | null;
  outreach_attempt_receipt_id: string | null;
  outreach_candidate_disposition: string | null;
}

interface AccountBindingResult extends QueryResultRow {
  zernio_account_id: string;
}

const RECORD_SQL = `
  WITH evidence AS (
    SELECT
      digest($6::text, 'sha256') AS profile_sha,
      decode($7::text, 'hex') AS credential_version_sha,
      decode($8::text, 'hex') AS credential_binding_sha,
      digest($9::text, 'sha256') AS account_sha,
      digest($10::text, 'sha256') AS person_sha,
      digest($11::text, 'sha256') AS thread_sha,
      digest($12::text, 'sha256') AS event_sha,
      digest($13::text, 'sha256') AS body_sha,
      digest($14::text, 'sha256') AS payload_sha,
      digest($15::text, 'sha256') AS signature_sha,
      $17::timestamptz AS occurred_at,
      $18::timestamptz AS verified_at
  ), event_key AS (
    SELECT evidence.*, event_sha AS key_sha
    FROM evidence
  ), bound AS (
    SELECT event_key.*,
      digest(
        encode(key_sha, 'hex') || chr(31)
          || $4::text || chr(31)
          || $5::text || chr(31)
          || encode(account_sha, 'hex') || chr(31)
          || encode(person_sha, 'hex') || chr(31)
          || encode(thread_sha, 'hex') || chr(31)
          || encode(body_sha, 'hex') || chr(31)
          || encode(payload_sha, 'hex') || chr(31)
          || to_char(
            occurred_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
        'sha256'
      ) AS identity_sha
    FROM event_key
  )
  SELECT result.*
  FROM bound
  CROSS JOIN LATERAL app_private.record_zernio_signed_inbound(
    $1, $2, $3, $4, $5,
    profile_sha, credential_version_sha, credential_binding_sha,
    account_sha, person_sha, thread_sha, event_sha,
    $13, body_sha, payload_sha, signature_sha,
    identity_sha, $16, occurred_at, verified_at
  ) AS result`;

test('0092 disposable proof projects, replays, quarantines and preserves LinkedIn truth', {
  skip,
}, async () => {
  const ownerPool = await openTestDatabase();
  let webhookPool: Pool | undefined;
  try {
    const fixture = await seedFixture(ownerPool);
    webhookPool = await openWebhookPool(ownerPool);

    await expectPostgresError(webhookQuery(
      webhookPool, fixture.workspaceId, 'table-blindness',
      'SELECT * FROM app.property_predator_zernio_inbound_events',
    ), '42501');

    const binding = await webhookQuery<AccountBindingResult>(
      webhookPool, fixture.workspaceId, 'resolve-instagram-account',
      `SELECT * FROM app_private.resolve_zernio_inbound_account(
         $1::uuid,$2::uuid,$3::text,digest($4::text,'sha256'),
         digest($5::text,'sha256'),decode($6::text,'hex'),decode($7::text,'hex')
       )`,
      [fixture.workspaceId, fixture.connectionId, 'instagram',
        'profile-instagram', 'account-instagram',
        fixture.instagramCredential.credentialVersionSha256,
        fixture.instagramCredential.bindingSha256],
    );
    assert.deepEqual(binding, [{ zernio_account_id: fixture.instagramAccountId }]);

    const occurredAt = new Date();
    const verifiedAt = new Date();
    const instagramValues = [
      fixture.workspaceId, fixture.connectionId, fixture.instagramAccountId,
      'instagram', 'instagram_dm', 'profile-instagram',
      fixture.instagramCredential.credentialVersionSha256,
      fixture.instagramCredential.bindingSha256,
      'account-instagram', 'ig-person-1', 'ig-thread-1', 'ig-event-1',
      'Hello from the fictional Instagram fixture.',
      'ig-payload-1', 'ig-signature-1', 'not_applicable', occurredAt, verifiedAt,
    ] as const;
    const applied = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'instagram-applied',
      RECORD_SQL, instagramValues,
    );
    assert.equal(applied[0]?.disposition, 'applied');
    assert.ok(applied[0]?.projection_id);
    assert.ok(applied[0]?.conversation_id);
    assert.ok(applied[0]?.admin_review_task_id);
    assert.equal(applied[0]?.outreach_candidate_disposition, 'unlinked');

    const replayed = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'instagram-replayed',
      RECORD_SQL, instagramValues,
    );
    assert.equal(replayed[0]?.disposition, 'replayed');
    assert.equal(replayed[0]?.event_id, applied[0]?.event_id);
    assert.equal(replayed[0]?.projection_id, applied[0]?.projection_id);

    const wrongCredential = [...instagramValues] as unknown[];
    wrongCredential[7] = '0'.repeat(64);
    wrongCredential[11] = 'ig-event-wrong-credential';
    await expectPostgresError(webhookQuery(
      webhookPool, fixture.workspaceId, 'credential-binding-denied',
      RECORD_SQL, wrongCredential,
    ), '42501');

    const crossedIdentity = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'crossed-provider-event-conflict',
      RECORD_SQL,
      [
        fixture.workspaceId, fixture.connectionId, fixture.linkedinAccountId,
        'linkedin', 'owned_post_comment', 'profile-linkedin',
        fixture.linkedinCredential.credentialVersionSha256,
        fixture.linkedinCredential.bindingSha256,
        'account-linkedin', 'li-person-1', 'li-owned-post-crossed', 'ig-event-1',
        'Crossed fictional event identity.', 'crossed-payload', 'crossed-signature',
        'unknown', new Date(), new Date(),
      ],
    );
    assert.equal(crossedIdentity[0]?.disposition, 'conflict');
    assert.equal(crossedIdentity[0]?.event_id, applied[0]?.event_id);
    assert.ok(crossedIdentity[0]?.quarantine_id);

    const conflictValues = [
      ...instagramValues.slice(0, 12),
      'Conflicting fictional body.', 'ig-payload-conflict',
      'ig-signature-conflict', 'not_applicable', new Date(), new Date(),
    ] as const;
    const conflict = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'instagram-conflict',
      RECORD_SQL, conflictValues,
    );
    assert.equal(conflict[0]?.disposition, 'conflict');
    assert.ok(conflict[0]?.quarantine_id);

    const unmatched = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'instagram-unmatched',
      RECORD_SQL,
      [
        fixture.workspaceId, fixture.connectionId, fixture.instagramAccountId,
        'instagram', 'instagram_dm', 'profile-instagram',
        fixture.instagramCredential.credentialVersionSha256,
        fixture.instagramCredential.bindingSha256,
        'account-instagram', 'missing-person', 'ig-thread-2', 'ig-event-2',
        'Unmatched fictional person.', 'ig-payload-2', 'ig-signature-2',
        'not_applicable', new Date(), new Date(),
      ],
    );
    assert.equal(unmatched[0]?.disposition, 'quarantined');
    assert.ok(unmatched[0]?.quarantine_id);
    assert.equal(unmatched[0]?.projection_id, null);

    const missingLinkedinOwnership = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'linkedin-ownership-unknown',
      RECORD_SQL,
      [
        fixture.workspaceId, fixture.connectionId, fixture.linkedinAccountId,
        'linkedin', 'owned_post_comment', 'profile-linkedin',
        fixture.linkedinCredential.credentialVersionSha256,
        fixture.linkedinCredential.bindingSha256,
        'account-linkedin', 'li-person-1', 'li-owned-post-missing-binding',
        'li-comment-missing-binding', 'Unknown ownership is quarantined.',
        'li-payload-missing-binding', 'li-signature-missing-binding',
        'unknown', new Date(), new Date(),
      ],
    );
    assert.equal(missingLinkedinOwnership[0]?.disposition, 'quarantined');
    const missingOwnershipReason = await ownerQuery<{ reason_code: string }>(
      ownerPool,
      `SELECT reason_code
       FROM app.property_predator_zernio_inbound_quarantine
       WHERE workspace_id = $1 AND id = $2`,
      [fixture.workspaceId, missingLinkedinOwnership[0]?.quarantine_id],
    );
    assert.equal(missingOwnershipReason[0]?.reason_code, 'owned_author_binding_missing');

    await ownerQuery(ownerPool,
      `INSERT INTO app.property_predator_zernio_inbound_owned_author_bindings (
         workspace_id, zernio_account_id, provider_connection_id, network,
         provider_profile_id_sha256, provider_account_id_sha256,
         provider_owned_author_id_sha256
       ) VALUES (
         $1, $2, $3, 'linkedin', decode($4, 'hex'),
         digest('account-linkedin', 'sha256'), digest('li-owned-author', 'sha256')
       )`,
      [fixture.workspaceId, fixture.linkedinAccountId, fixture.connectionId,
        fixture.linkedinCredential.providerProfileIdSha256]);

    const ownedLinkedinAuthor = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'linkedin-owned-author',
      RECORD_SQL,
      [
        fixture.workspaceId, fixture.connectionId, fixture.linkedinAccountId,
        'linkedin', 'owned_post_comment', 'profile-linkedin',
        fixture.linkedinCredential.credentialVersionSha256,
        fixture.linkedinCredential.bindingSha256,
        'account-linkedin', 'li-owned-author', 'li-owned-post-own-comment',
        'li-comment-own-author', 'An owned-account comment must not project.',
        'li-payload-own-author', 'li-signature-own-author',
        'unknown', new Date(), new Date(),
      ],
    );
    assert.equal(ownedLinkedinAuthor[0]?.disposition, 'quarantined');
    const ownedAuthorReason = await ownerQuery<{ reason_code: string }>(
      ownerPool,
      `SELECT reason_code
       FROM app.property_predator_zernio_inbound_quarantine
       WHERE workspace_id = $1 AND id = $2`,
      [fixture.workspaceId, ownedLinkedinAuthor[0]?.quarantine_id],
    );
    assert.equal(ownedAuthorReason[0]?.reason_code, 'owned_author_comment');

    const linkedin = await webhookQuery<InboundResult>(
      webhookPool, fixture.workspaceId, 'linkedin-applied',
      RECORD_SQL,
      [
        fixture.workspaceId, fixture.connectionId, fixture.linkedinAccountId,
        'linkedin', 'owned_post_comment', 'profile-linkedin',
        fixture.linkedinCredential.credentialVersionSha256,
        fixture.linkedinCredential.bindingSha256,
        'account-linkedin', 'li-person-1', 'li-owned-post-1', 'li-comment-1',
        'Useful fictional LinkedIn comment.', 'li-payload-1', 'li-signature-1',
        'unknown', new Date(), new Date(),
      ],
    );
    assert.equal(linkedin[0]?.disposition, 'applied');

    const runtimePayload = {
      id: 'ig-event-runtime-parity',
      event: 'message.received',
      message: {
        id: 'runtime-message', conversationId: 'runtime-conversation',
        platform: 'instagram', platformMessageId: 'runtime-provider-message',
        direction: 'incoming', text: 'Runtime-produced hash reaches SQL.',
        attachments: [], sender: { id: 'ig-person-1' },
        sentAt: new Date().toISOString(), isRead: false,
      },
      conversation: {
        id: 'runtime-conversation', platformConversationId: 'runtime-thread',
        participantId: 'ig-person-1', status: 'active',
      },
      account: {
        id: 'account-instagram', accountId: 'account-instagram',
        profileId: 'profile-instagram', platform: 'instagram',
        username: 'fixture.instagram',
      },
      timestamp: new Date().toISOString(),
    };
    const runtimeRaw = Buffer.from(JSON.stringify(runtimePayload), 'utf8');
    const runtimeVerified = verifyZernioInboundWebhook(
      fixture.instagramCredential,
      {
        rawBody: runtimeRaw,
        signatureHeader: createHmac('sha256', INSTAGRAM_SECRET)
          .update(runtimeRaw).digest('hex'),
        eventIdHeader: runtimePayload.id,
      },
    );
    const repository = new PgZernioInboundRepository(webhookPool);
    const concurrentRuntime = await Promise.all([
      repository.record(runtimeVerified), repository.record(runtimeVerified),
    ]);
    assert.deepEqual(
      concurrentRuntime.map((receipt) => receipt.disposition).sort(),
      ['applied', 'replayed'],
    );
    assert.equal(concurrentRuntime[0]!.eventId, concurrentRuntime[1]!.eventId);
    assert.equal(concurrentRuntime[0]!.projectionId, concurrentRuntime[1]!.projectionId);
    const channel = await ownerQuery<{ channel: string; source_provider: string }>(
      ownerPool,
      `SELECT conversation.channel, origin.source_provider
       FROM app.conversations AS conversation
       JOIN app.property_predator_admin_call_task_origins AS origin
         ON origin.workspace_id = conversation.workspace_id
        AND origin.conversation_id = conversation.id
       WHERE conversation.workspace_id = $1 AND conversation.id = $2`,
      [fixture.workspaceId, linkedin[0]?.conversation_id],
    );
    assert.deepEqual(channel[0], { channel: 'linkedin', source_provider: 'zernio' });

    const counts = await ownerQuery<{
      contacts: string; projections: string; quarantines: string; activities: string;
    }>(ownerPool,
      `SELECT
         (SELECT count(*) FROM app.contacts WHERE workspace_id = $1) AS contacts,
         (SELECT count(*) FROM app.property_predator_zernio_inbound_projections
           WHERE workspace_id = $1) AS projections,
         (SELECT count(*) FROM app.property_predator_zernio_inbound_quarantine
           WHERE workspace_id = $1) AS quarantines,
         (SELECT count(*) FROM app.activities
           WHERE workspace_id = $1 AND activity_type = 'inbox.zernio.reply_received') AS activities`,
      [fixture.workspaceId],
    );
    assert.equal(Number(counts[0]?.contacts), 1);
    assert.equal(Number(counts[0]?.projections), 3);
    assert.equal(Number(counts[0]?.quarantines), 5);
    assert.equal(Number(counts[0]?.activities), 3);

    await expectPostgresError(ownerQuery(
      ownerPool,
      `UPDATE app.property_predator_zernio_inbound_events
       SET admission_disposition = 'quarantined'
       WHERE workspace_id = $1 AND id = $2`,
      [fixture.workspaceId, applied[0]?.event_id],
    ), '55000');
  } finally {
    if (webhookPool) await webhookPool.end().catch(() => undefined);
    await clearRolePassword(ownerPool).catch(() => undefined);
    await ownerPool.end();
  }
});
