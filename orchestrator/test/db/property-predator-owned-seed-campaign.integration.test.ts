import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { InactivePortalSessionError } from '../../src/db/transaction.js';
import { canonicalCompanyContentEmailDraft } from '../../src/company-content-pg/index.js';
import { PropertyPredatorOwnedSeedCampaignService } from '../../src/property-predator-owned-seed-campaign-pg/index.js';
import {
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
  withOwnerClient,
} from './database-helper.js';

const skip = testDatabaseSkipReason();

async function openCommandLoginPool(ownerPool: Pool): Promise<Pool> {
  const rawUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!rawUrl) throw new Error('TEST_DATABASE_URL is required');
  const password = `owned-seed-${randomUUID()}`;
  const ownerClient = await ownerPool.connect();
  try {
    const statement = await ownerClient.query<{ sql: string }>(
      `SELECT pg_catalog.format(
         'ALTER ROLE r72_owned_seed_campaign_command PASSWORD %L', $1::text
       ) AS sql`,
      [password],
    );
    await ownerClient.query(statement.rows[0]!.sql);
  } finally {
    ownerClient.release();
  }
  const url = new URL(rawUrl);
  url.username = 'r72_owned_seed_campaign_command';
  url.password = password;
  return new Pool({
    connectionString: url.toString(), max: 2,
    application_name: 'relaunch72-owned-seed-campaign-integration',
  });
}

async function clearCommandPassword(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('ALTER ROLE r72_owned_seed_campaign_command PASSWORD NULL');
  } finally {
    client.release();
  }
}

async function createApprovedMessage(
  pool: Pool,
  input: Readonly<{
    workspaceId: string;
    conversationId: string;
    contactId: string;
    contactPointId: string;
    userId: string;
    body: string;
    sourceContentVersionId: string;
    sourceContentApprovalDecisionId: string;
    canonicalSourceContent: string;
  }>,
): Promise<string> {
  const messageId = randomUUID();
  const versionId = randomUUID();
  const requestId = randomUUID();
  const decisionId = randomUUID();
  await withOwnerClient(pool, async (client) => {
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO app.messages (
         id, workspace_id, conversation_id, contact_id, contact_point_id,
         channel, environment, direction, lifecycle, source_kind,
         current_version_id, current_version_number, current_body_sha256,
         created_by_actor_kind, created_by_user_id, occurred_at
       ) VALUES (
         $1, $2, $3, $4, $5, 'email', 'live', 'outbound', 'draft', 'user',
         $6, 1, digest($7, 'sha256'), 'user', $8, statement_timestamp()
       )`,
      [messageId, input.workspaceId, input.conversationId, input.contactId,
        input.contactPointId, versionId, input.body, input.userId],
    );
    await client.query(
      `INSERT INTO app.message_versions (
         id, workspace_id, conversation_id, message_id, channel, environment,
         version_number, body_text, source_content_version_ref,
         source_content_sha256, source_content_approval_ref,
         created_by_actor_kind, created_by_user_id, created_request_id
       ) VALUES (
         $1, $2, $3, $4, 'email', 'live', 1, $5,
         'app.company_content_versions:' || $6::text, digest($7, 'sha256'),
         'app.company_content_approval_decisions:' || $8::text,
         'user', $9, $10
       )`,
      [versionId, input.workspaceId, input.conversationId, messageId,
        input.body, input.sourceContentVersionId, input.canonicalSourceContent,
        input.sourceContentApprovalDecisionId, input.userId,
        `owned-seed-version-${versionId}`],
    );
    await client.query(
      `INSERT INTO app.message_approval_requests (
         id, workspace_id, conversation_id, message_id, message_version_id,
         version_number, body_sha256, request_number, requested_by_user_id,
         requested_request_id
       ) VALUES ($1, $2, $3, $4, $5, 1, digest($6, 'sha256'), 1, $7, $8)`,
      [requestId, input.workspaceId, input.conversationId, messageId,
        versionId, input.body, input.userId, `owned-seed-request-${requestId}`],
    );
    await client.query(
      `UPDATE app.messages SET lifecycle = 'approval_pending', row_version = 2
       WHERE workspace_id = $1 AND id = $2`,
      [input.workspaceId, messageId],
    );
    await client.query(
      `INSERT INTO app.message_approval_decisions (
         id, workspace_id, conversation_id, message_id, message_version_id,
         approval_request_id, version_number, body_sha256, decision,
         decided_by_user_id, decided_request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, digest($7, 'sha256'),
                 'approved', $8, $9)`,
      [decisionId, input.workspaceId, input.conversationId, messageId,
        versionId, requestId, input.body, input.userId,
        `owned-seed-decision-${decisionId}`],
    );
    await client.query(
      `UPDATE app.messages SET lifecycle = 'approved', row_version = 3
       WHERE workspace_id = $1 AND id = $2`,
      [input.workspaceId, messageId],
    );
  });
  return versionId;
}

interface ApprovedCompanyContentSource {
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalDecisionId: string;
  readonly sourceItemId: string;
  readonly canonicalContent: string;
}

async function createApprovedCompanyContentSource(
  pool: Pool,
  input: Readonly<{
    workspaceId: string;
    userId: string;
    subject: string;
    body: string;
    attestationLifetime: string;
  }>,
): Promise<ApprovedCompanyContentSource> {
  const contentItemId = randomUUID();
  const contentVersionId = randomUUID();
  const approvalRequestId = randomUUID();
  const approvalDecisionId = randomUUID();
  const sourceItemId = `owned-seed-stage-${contentItemId}`;
  const canonicalContent = canonicalCompanyContentEmailDraft(input.subject, input.body);
  await withOwnerClient(pool, async (client) => {
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', 'owned-seed-stage-source', true)`,
      [input.userId, input.workspaceId],
    );
    await client.query(
      `INSERT INTO app.company_content_items (
         id, workspace_id, source_system, source_item_id,
         created_by_user_id, created_request_id
       ) VALUES ($1, $2, 'property_predator.campaign_wizard', $3, $4, 'overwritten')`,
      [contentItemId, input.workspaceId, sourceItemId, input.userId],
    );
    await client.query(
      `INSERT INTO app.company_content_versions (
         id, workspace_id, content_item_id, version_number, origin,
         content_kind, title, source_system, source_item_id, source_version,
         content_mime_type, content_body, blob_storage_key, blob_sha256,
         brand_snapshot_ref, brand_sha256, metadata,
         created_by_user_id, created_request_id
       ) VALUES (
         $1, $2, $3, 1, 'generated', 'email', 'Owned-seed stage proof',
         'property_predator.campaign_wizard', $4, 'v1',
         'application/vnd.propertypredator.email-draft+json', $5,
         $6, digest($5, 'sha256'), 'brand-brain:test',
         digest('brand-brain:test', 'sha256'), '{"fixture":true}'::jsonb,
         $7, 'overwritten'
       )`,
      [contentVersionId, input.workspaceId, contentItemId, sourceItemId,
        canonicalContent, `company-content/${contentItemId}/v1`, input.userId],
    );
    await client.query(
      `INSERT INTO app.company_content_source_attestations (
         workspace_id, content_item_id, content_version_id,
         source_system, source_item_id, source_version,
         content_sha256, blob_sha256, brand_sha256, source_catalog_sha256,
         checked_at, expires_at, attested_by_user_id, attested_request_id
       ) VALUES (
         $1, $2, $3, 'property_predator.campaign_wizard', $4, 'v1',
         digest($5, 'sha256'), digest($5, 'sha256'),
         digest('brand-brain:test', 'sha256'), digest('stage-catalog-v1', 'sha256'),
         statement_timestamp(), statement_timestamp() + $6::interval,
         $7, 'overwritten'
       )`,
      [input.workspaceId, contentItemId, contentVersionId, sourceItemId,
        canonicalContent, input.attestationLifetime, input.userId],
    );
    await client.query(
      `INSERT INTO app.company_content_approval_requests (
         id, workspace_id, content_item_id, content_version_id,
         content_sha256, request_number, requested_by_user_id,
         requested_request_id
       ) VALUES ($1, $2, $3, $4, digest($5, 'sha256'), 1, $6, 'overwritten')`,
      [approvalRequestId, input.workspaceId, contentItemId,
        contentVersionId, canonicalContent, input.userId],
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
      [approvalDecisionId, input.workspaceId, contentItemId,
        contentVersionId, approvalRequestId, canonicalContent, input.userId],
    );
  });
  return Object.freeze({
    contentItemId, contentVersionId, approvalDecisionId,
    sourceItemId, canonicalContent,
  });
}

async function refreshCompanyContentSourceAttestation(
  pool: Pool,
  input: Readonly<{
    workspaceId: string;
    userId: string;
    source: ApprovedCompanyContentSource;
  }>,
): Promise<void> {
  await withOwnerClient(pool, async (client) => {
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', 'owned-seed-stage-refresh', true)`,
      [input.userId, input.workspaceId],
    );
    await client.query(
      `INSERT INTO app.company_content_source_attestations (
         workspace_id, content_item_id, content_version_id,
         source_system, source_item_id, source_version,
         content_sha256, blob_sha256, brand_sha256, source_catalog_sha256,
         checked_at, expires_at, attested_by_user_id, attested_request_id
       ) VALUES (
         $1, $2, $3, 'property_predator.campaign_wizard', $4, 'v1',
         digest($5, 'sha256'), digest($5, 'sha256'),
         digest('brand-brain:test', 'sha256'), digest('stage-catalog-v2', 'sha256'),
         statement_timestamp(), statement_timestamp() + interval '14 minutes',
         $6, 'overwritten'
       )`,
      [input.workspaceId, input.source.contentItemId,
        input.source.contentVersionId, input.source.sourceItemId,
        input.source.canonicalContent, input.userId],
    );
  });
}

test('owned-seed command queues only exact office evidence without making a provider call', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  let commandPool: Pool | undefined;
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  const contactPointId = randomUUID();
  const connectionId = randomUUID();
  const endpointId = randomUUID();
  const inboxId = randomUUID();
  const conversationId = randomUUID();
  const consentId = randomUUID();
  const portalSessionTokenHash = Buffer.alloc(32, 47);
  const subject = 'Property Predator owned seed campaign';
  const body = 'Owned internal seed proof for the first Property Predator campaign loop.';
  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Owned seed integration', $2, 'direct_customer', 'active')`,
      [organizationId, `owned-seed-${organizationId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [userId, `owner-${userId.slice(0, 8)}@propertypredator.co.uk`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Owned seed workspace', $3, 'active')`,
      [workspaceId, organizationId, `owned-seed-${workspaceId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, userId]);
    await ownerQuery(pool,
      `INSERT INTO app.user_sessions (
         token_hash, csrf_secret_hash, user_id, selected_workspace_id, expires_at
       ) VALUES ($1, $2, $3, $4, statement_timestamp() + interval '1 hour')`,
      [portalSessionTokenHash, Buffer.alloc(32, 48), userId, workspaceId]);
    await ownerQuery(pool,
      `INSERT INTO app.contacts (
         id, workspace_id, display_name, lifecycle_status, source
       ) VALUES ($1, $2, 'Owned office seed', 'lead', 'internal_seed')`,
      [contactId, workspaceId]);
    await ownerQuery(pool,
      `INSERT INTO app.contact_points (
         id, workspace_id, contact_id, kind, label, value, normalized_value,
         is_primary, is_verified, dedupe_state
       ) VALUES (
         $1, $2, $3, 'email', 'Owned office seed',
         'office@propertypredator.com', 'office@propertypredator.com',
         true, true, 'normal'
       )`,
      [contactPointId, workspaceId, contactId]);
    await ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment, status,
         display_name, capabilities, created_by_user_id
       ) VALUES (
         $1, $2, 'mailgun_eu', 'email', 'live', 'active',
         'Property Predator Mailgun EU', '["email.send"]'::jsonb, $3
       )`,
      [connectionId, workspaceId, userId]);
    await ownerQuery(pool,
      `INSERT INTO app.channel_endpoints (
         id, workspace_id, provider_connection_id, channel, environment,
         direction, address, normalized_address, display_name, status
       ) VALUES (
         $1, $2, $3, 'email', 'live', 'bidirectional',
         'mg.propertypredator.com', 'mg.propertypredator.com',
         'Property Predator email', 'active'
       )`,
      [endpointId, workspaceId, connectionId]);
    await ownerQuery(pool,
      `INSERT INTO app.inboxes (
         id, workspace_id, channel_endpoint_id, provider_connection_id,
         channel, environment, name, status
       ) VALUES ($1, $2, $3, $4, 'email', 'live', 'Owned seed', 'active')`,
      [inboxId, workspaceId, endpointId, connectionId]);
    await ownerQuery(pool,
      `INSERT INTO app.conversations (
         id, workspace_id, inbox_id, channel, environment, contact_id,
         state, subject
      ) VALUES ($1, $2, $3, 'email', 'live', $4, 'open', $5)`,
      [conversationId, workspaceId, inboxId, contactId,
        subject],
    );
    await ownerQuery(pool,
      `INSERT INTO app.communication_consent_events (
         id, workspace_id, contact_id, contact_point_id, channel, purpose,
         state, lawful_basis, source, policy_version, actor_kind,
         actor_user_id, evidence, endpoint_identity_sha256, occurred_at
       ) VALUES (
         $1, $2, $3, $4, 'email', 'marketing', 'granted', 'consent',
         'internal.seed.attestation', 'owned-seed-v1', 'user', $5,
         '{}'::jsonb, decode(repeat('00', 32), 'hex'), statement_timestamp()
       )`,
      [consentId, workspaceId, contactId, contactPointId, userId],
    );
    const source = await createApprovedCompanyContentSource(pool, {
      workspaceId, userId, subject, body, attestationLifetime: '2 seconds',
    });
    const versionId = await createApprovedMessage(pool, {
      workspaceId, conversationId, contactId, contactPointId, userId, body,
      sourceContentVersionId: source.contentVersionId,
      sourceContentApprovalDecisionId: source.approvalDecisionId,
      canonicalSourceContent: source.canonicalContent,
    });
    await ownerQuery(pool,
      `INSERT INTO app.property_predator_email_pilot_seed_events (
         workspace_id, email_sha256, state, attestation, recorded_by, occurred_at
       ) VALUES (
         $1, digest('office@propertypredator.com', 'sha256'), 'owned',
         'Owned and controlled Property Predator office mailbox',
         'integration-owner', statement_timestamp()
       )`,
      [workspaceId]);
    await ownerQuery(pool,
      `INSERT INTO app.property_predator_email_pilot_control_events (
         workspace_id, provider_connection_id, provider_effects_enabled,
         email_delivery_enabled, emergency_paused, max_recipients,
         estimated_recipient_cost_usd_micros, run_message_cap,
         monthly_message_cap, run_spend_cap_usd_micros,
         monthly_spend_cap_usd_micros, reason, recorded_by, occurred_at
       ) VALUES (
         $1, $2, true, true, false, 1, 1500, 1, 3, 1500, 4500,
         'owned_seed_integration', 'integration-owner', statement_timestamp()
       )`,
      [workspaceId, connectionId]);

    commandPool = await openCommandLoginPool(pool);
    const service = new PropertyPredatorOwnedSeedCampaignService({
      commandPool, workspaceId,
    });
    await service.assertReady();
    const context = {
      actorKind: 'user' as const, workspaceId, userId,
      requestId: 'owned-seed-integration-stage',
      portalSessionTokenHash,
    };
    const runId = randomUUID();
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const expired = await service.stage(
      { ...context, requestId: 'owned-seed-expired-source-stage' },
      {
        commandKey: 'owned-seed-integration:expired-source',
        messageVersionId: versionId, runId,
      },
    );
    assert.deepEqual(
      {
        disposition: expired.disposition,
        reason: expired.reason,
        providerCallMadeByThisCommand: expired.providerCallMadeByThisCommand,
        deliveryIntentCreated: expired.deliveryIntentCreated,
        deliveryState: expired.deliveryState,
      },
      {
        disposition: 'blocked', reason: 'source_evidence_not_current',
        providerCallMadeByThisCommand: false, deliveryIntentCreated: false,
        deliveryState: 'blocked',
      },
    );
    assert.equal((await ownerQuery<{ count: string }>(pool,
      `SELECT count(*)::text AS count
       FROM app.property_predator_mailgun_jobs WHERE workspace_id = $1`,
      [workspaceId]))[0]!.count, '0');

    await refreshCompanyContentSourceAttestation(pool, {
      workspaceId, userId, source,
    });
    const staged = await service.stage(context, {
      commandKey: 'owned-seed-integration:001',
      messageVersionId: versionId, runId,
    });
    assert.equal(staged.disposition, 'staged');
    assert.equal(staged.providerCallMadeByThisCommand, false);
    assert.equal(staged.deliveryIntentCreated, true);
    assert.equal(staged.deliveryState, 'queued');
    assert.equal(staged.recipient, 'office@propertypredator.com');
    const jobs = await ownerQuery<{
      state: string;
      email: string;
      versionId: string;
    }>(pool,
      `SELECT state, encode(email_sha256, 'hex') AS email,
              message_version_id AS "versionId"
       FROM app.property_predator_mailgun_jobs
       WHERE workspace_id = $1`,
      [workspaceId]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.state, 'queued');
    assert.equal(jobs[0]!.versionId, versionId);
    const noEffects = await ownerQuery<{
      operations: string;
      deliveries: string;
      reservations: string;
    }>(pool,
      `SELECT
         (SELECT count(*) FROM app.provider_operations
          WHERE workspace_id = $1)::text AS operations,
         (SELECT count(*) FROM app.message_deliveries
          WHERE workspace_id = $1)::text AS deliveries,
         (SELECT count(*) FROM app.property_predator_email_pilot_reservations
          WHERE workspace_id = $1)::text AS reservations`,
      [workspaceId]);
    assert.deepEqual(noEffects[0], {
      operations: '0', deliveries: '0', reservations: '0',
    });
    const replay = await service.stage(context, {
      commandKey: 'owned-seed-integration:001',
      messageVersionId: versionId, runId,
    });
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.jobId, staged.jobId);
    assert.equal(replay.providerCallMadeByThisCommand, false);
    assert.equal(replay.deliveryIntentCreated, true);
    assert.equal(replay.deliveryState, 'queued');

    await assert.rejects(
      commandPool.query('SELECT * FROM app.property_predator_mailgun_jobs'),
      (error: unknown) => (error as { code?: string }).code === '42501',
    );

    await ownerQuery(pool,
      `INSERT INTO app.communication_suppression_events (
         workspace_id, contact_id, contact_point_id, channel, purpose, state,
         reason, source, actor_kind, actor_user_id, evidence,
         endpoint_identity_sha256, occurred_at
       ) VALUES (
         $1, $2, $3, 'email', 'marketing', 'suppressed', 'operator_test',
         'integration.test', 'user', $4, '{}'::jsonb,
         decode(repeat('00', 32), 'hex'), statement_timestamp()
       )`,
      [workspaceId, contactId, contactPointId, userId]);

    // Drift every mutable gate after the immutable job exists. The latest
    // source attestation is deliberately not current yet, and the newest
    // provider policy is paused. Neither may rewrite an existing queued
    // delivery intent as a fresh block on retry.
    await withOwnerClient(pool, async (client) => {
      await client.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.workspace_id', $2, true),
                set_config('app.actor_kind', 'user', true),
                set_config('app.request_id', 'owned-seed-stage-drift', true)`,
        [userId, workspaceId],
      );
      await client.query(
        `INSERT INTO app.company_content_source_attestations (
           workspace_id, content_item_id, content_version_id,
           source_system, source_item_id, source_version,
           content_sha256, blob_sha256, brand_sha256, source_catalog_sha256,
           checked_at, expires_at, attested_by_user_id, attested_request_id
         ) VALUES (
           $1, $2, $3, 'property_predator.campaign_wizard', $4, 'v1',
           digest($5, 'sha256'), digest($5, 'sha256'),
           digest('brand-brain:test', 'sha256'),
           digest('stage-catalog-future', 'sha256'),
           statement_timestamp() + interval '20 seconds',
           statement_timestamp() + interval '1 minute',
           $6, 'overwritten'
         )`,
        [workspaceId, source.contentItemId, source.contentVersionId,
          source.sourceItemId, source.canonicalContent, userId],
      );
    });
    await ownerQuery(pool,
      `INSERT INTO app.property_predator_email_pilot_control_events (
         workspace_id, provider_connection_id, provider_effects_enabled,
         email_delivery_enabled, emergency_paused, max_recipients,
         estimated_recipient_cost_usd_micros, run_message_cap,
         monthly_message_cap, run_spend_cap_usd_micros,
         monthly_spend_cap_usd_micros, reason, recorded_by, occurred_at
       ) VALUES (
         $1, $2, false, false, true, 1, 1500, 1, 3, 1500, 4500,
         'owned_seed_post_stage_pause', 'integration-owner',
         statement_timestamp()
       )`,
      [workspaceId, connectionId]);
    await ownerQuery(pool,
      `UPDATE app.property_predator_mailgun_jobs
       SET state = 'cancelled', updated_at = statement_timestamp()
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, staged.jobId]);

    const sameKeyAfterDrift = await service.stage(
      { ...context, requestId: 'owned-seed-replay-after-drift' },
      {
        commandKey: 'owned-seed-integration:001',
        messageVersionId: versionId, runId,
      },
    );
    assert.deepEqual(
      {
        disposition: sameKeyAfterDrift.disposition,
        jobId: sameKeyAfterDrift.jobId,
        providerCallMadeByThisCommand:
          sameKeyAfterDrift.providerCallMadeByThisCommand,
        deliveryIntentCreated: sameKeyAfterDrift.deliveryIntentCreated,
        deliveryState: sameKeyAfterDrift.deliveryState,
      },
      {
        disposition: 'replayed', jobId: staged.jobId,
        providerCallMadeByThisCommand: false, deliveryIntentCreated: true,
        deliveryState: 'cancelled',
      },
    );
    const newKeyAfterDrift = await service.stage(
      { ...context, requestId: 'owned-seed-cross-key-replay-after-drift' },
      {
        commandKey: 'owned-seed-integration:retry',
        messageVersionId: versionId, runId: randomUUID(),
      },
    );
    assert.deepEqual(
      {
        disposition: newKeyAfterDrift.disposition,
        jobId: newKeyAfterDrift.jobId,
        providerCallMadeByThisCommand:
          newKeyAfterDrift.providerCallMadeByThisCommand,
        deliveryIntentCreated: newKeyAfterDrift.deliveryIntentCreated,
        deliveryState: newKeyAfterDrift.deliveryState,
      },
      {
        disposition: 'replayed', jobId: staged.jobId,
        providerCallMadeByThisCommand: false, deliveryIntentCreated: true,
        deliveryState: 'cancelled',
      },
    );
    assert.equal((await ownerQuery<{ count: string }>(pool,
      `SELECT count(*)::text AS count
       FROM app.property_predator_mailgun_jobs WHERE workspace_id = $1`,
      [workspaceId]))[0]!.count, '1');

    await ownerQuery(pool,
      `UPDATE app.user_sessions
       SET revoked_at = statement_timestamp()
       WHERE token_hash = $1 AND user_id = $2 AND selected_workspace_id = $3`,
      [portalSessionTokenHash, userId, workspaceId]);
    await assert.rejects(
      service.stage({ ...context, requestId: 'owned-seed-revoked-session' }, {
        commandKey: 'owned-seed-integration:revoked',
        messageVersionId: versionId,
        runId,
      }),
      (error: unknown) => error instanceof InactivePortalSessionError,
    );
  } finally {
    await commandPool?.end().catch(() => undefined);
    await clearCommandPassword(pool).catch(() => undefined);
    await pool.end();
  }
});
