import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { PropertyPredatorOwnedSeedMessageService } from '../../src/property-predator-owned-seed-message-pg/index.js';
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
  const password = `owned-seed-message-${randomUUID()}`;
  const client = await ownerPool.connect();
  try {
    const statement = await client.query<{ sql: string }>(
      `SELECT pg_catalog.format(
         'ALTER ROLE r72_owned_seed_message_command PASSWORD %L', $1::text
       ) AS sql`,
      [password],
    );
    await client.query(statement.rows[0]!.sql);
  } finally { client.release(); }
  const url = new URL(rawUrl);
  url.username = 'r72_owned_seed_message_command';
  url.password = password;
  return new Pool({
    connectionString: url.toString(), max: 2,
    application_name: 'relaunch72-owned-seed-message-integration',
  });
}

async function clearCommandPassword(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try { await client.query('ALTER ROLE r72_owned_seed_message_command PASSWORD NULL'); }
  finally { client.release(); }
}

async function insertApprovedEmailSource(
  pool: Pool,
  input: Readonly<{ workspaceId: string; userId: string; canonicalContent: string; label: string }>,
): Promise<Readonly<{
  contentItemId: string;
  contentVersionId: string;
  approvalRequestId: string;
  approvalDecisionId: string;
  sourceItemId: string;
  canonicalContent: string;
}>> {
  const contentItemId = randomUUID();
  const contentVersionId = randomUUID();
  const approvalRequestId = randomUUID();
  const approvalDecisionId = randomUUID();
  const sourceItemId = `owned-seed-attack-${contentItemId}`;
  await withOwnerClient(pool, async (client) => {
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.workspace_id', $2, true),
              set_config('app.actor_kind', 'user', true),
              set_config('app.request_id', $3, true)`,
      [input.userId, input.workspaceId, `owned-seed-attack-${input.label}`],
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
         $1, $2, $3, 1, 'generated', 'email', $4,
         'property_predator.campaign_wizard', $5, 'v1',
         'application/vnd.propertypredator.email-draft+json', $6,
         $7, digest($6, 'sha256'), 'brand-brain:test',
         digest('brand-brain:test', 'sha256'), '{"fixture":true}'::jsonb,
         $8, 'overwritten'
       )`,
      [contentVersionId, input.workspaceId, contentItemId, input.label,
        sourceItemId, input.canonicalContent,
        `company-content/${contentItemId}/v1`, input.userId],
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
         digest('brand-brain:test', 'sha256'), digest($6, 'sha256'),
         statement_timestamp(), statement_timestamp() + interval '14 minutes',
         $7, 'overwritten'
       )`,
      [input.workspaceId, contentItemId, contentVersionId, sourceItemId,
        input.canonicalContent, `catalog:${input.label}`, input.userId],
    );
    await client.query(
      `INSERT INTO app.company_content_approval_requests (
         id, workspace_id, content_item_id, content_version_id,
         content_sha256, request_number, requested_by_user_id,
         requested_request_id
       ) VALUES ($1, $2, $3, $4, digest($5, 'sha256'), 1, $6, 'overwritten')`,
      [approvalRequestId, input.workspaceId, contentItemId,
        contentVersionId, input.canonicalContent, input.userId],
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
        contentVersionId, approvalRequestId, input.canonicalContent, input.userId],
    );
  });
  return Object.freeze({
    contentItemId, contentVersionId, approvalRequestId, approvalDecisionId,
    sourceItemId, canonicalContent: input.canonicalContent,
  });
}

test('approved canonical company email becomes a separate human-approved live owned-seed message with zero provider effects', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  let commandPool: Pool | undefined;
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const connectionId = randomUUID();
  const contentItemId = randomUUID();
  const contentVersionId = randomUUID();
  const contentRequestId = randomUUID();
  const contentDecisionId = randomUUID();
  const sourceApprovalDriftRequestId = randomUUID();
  const subject = 'Property Predator owned-seed proof';
  const body = 'Exact internal proof body. No customer received this message.';
  const canonical = JSON.stringify({
    bodyText: body,
    schema: 'propertypredator.email-draft/v1',
    subject,
  });
  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Owned seed message integration', $2, 'direct_customer', 'active')`,
      [organizationId, `seed-message-${organizationId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [userId, `owner-${userId.slice(0, 8)}@propertypredator.co.uk`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Owned seed message', $3, 'active')`,
      [workspaceId, organizationId, `seed-message-${workspaceId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, userId]);
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
      `INSERT INTO app.property_predator_email_pilot_seed_events (
         workspace_id, email_sha256, state, attestation, recorded_by, occurred_at
       ) VALUES (
         $1, digest('office@propertypredator.com', 'sha256'), 'owned',
         'Owned Property Predator office mailbox', 'integration-owner',
         statement_timestamp()
       )`,
      [workspaceId]);

    await withOwnerClient(pool, async (client) => {
      await client.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.workspace_id', $2, true),
                set_config('app.actor_kind', 'user', true),
                set_config('app.request_id', 'owned-seed-content-fixture', true)`,
        [userId, workspaceId],
      );
      await client.query(
        `INSERT INTO app.company_content_items (
           id, workspace_id, source_system, source_item_id,
           created_by_user_id, created_request_id
         ) VALUES ($1, $2, 'property_predator.campaign_wizard', $3, $4, 'overwritten')`,
        [contentItemId, workspaceId, `owned-seed-${contentItemId}`, userId],
      );
      await client.query(
        `INSERT INTO app.company_content_versions (
           id, workspace_id, content_item_id, version_number, origin,
           content_kind, title, source_system, source_item_id, source_version,
           content_mime_type, content_body, blob_storage_key, blob_sha256,
           brand_snapshot_ref, brand_sha256, metadata,
           created_by_user_id, created_request_id
         ) VALUES (
           $1, $2, $3, 1, 'generated', 'email', 'Owned-seed proof',
           'property_predator.campaign_wizard', $4, 'v1',
           'application/vnd.propertypredator.email-draft+json', $5,
           $6, digest($5, 'sha256'), 'brand-brain:test',
           digest('brand-brain:test', 'sha256'), '{"fixture":true}'::jsonb,
           $7, 'overwritten'
         )`,
        [contentVersionId, workspaceId, contentItemId,
          `owned-seed-${contentItemId}`, canonical,
          `company-content/${contentItemId}/v1`, userId],
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
           digest('owned-seed-catalog-v1', 'sha256'),
           statement_timestamp(), statement_timestamp() + interval '14 minutes',
           $6, 'overwritten'
         )`,
        [workspaceId, contentItemId, contentVersionId,
          `owned-seed-${contentItemId}`, canonical, userId],
      );
      await client.query(
        `INSERT INTO app.company_content_approval_requests (
           id, workspace_id, content_item_id, content_version_id,
           content_sha256, request_number, requested_by_user_id,
           requested_request_id
         ) VALUES (
           $1, $2, $3, $4, digest($5, 'sha256'), 1, $6, 'overwritten'
         )`,
        [contentRequestId, workspaceId, contentItemId,
          contentVersionId, canonical, userId],
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
        [contentDecisionId, workspaceId, contentItemId,
          contentVersionId, contentRequestId, canonical, userId],
      );
    });

    commandPool = await openCommandLoginPool(pool);
    const service = new PropertyPredatorOwnedSeedMessageService({
      commandPool, workspaceId,
    });
    await service.assertReady();
    assert.equal((await commandPool.query<{ installationId: string }>(
      `SELECT app_private.runtime_database_installation_id()::text
         AS "installationId"`,
    )).rows.length, 1);
    assert.ok((await commandPool.query(
      'SELECT filename FROM app_private.runtime_schema_migrations()',
    )).rows.length >= 48);
    const context = Object.freeze({
      actorKind: 'user' as const, workspaceId, userId,
      requestId: 'owned-seed-message-integration',
    });
    const duplicateKeyVersionId = await insertApprovedEmailSource(pool, {
      workspaceId, userId, label: 'Duplicate key attack',
      canonicalContent: '{"bodyText":"Reviewed body","bodyText":"Unreviewed body","schema":"propertypredator.email-draft/v1","subject":"Duplicate key"}',
    });
    await assert.rejects(
      service.createDraft(
        { ...context, requestId: 'owned-seed-duplicate-key-attack' },
        {
          commandKey: 'owned-seed:draft:duplicate-key-attack',
          companyContentVersionId: duplicateKeyVersionId.contentVersionId,
        },
      ),
      (error: unknown) => (error as { code?: string }).code === '22023',
    );
    const noncanonicalVersionId = await insertApprovedEmailSource(pool, {
      workspaceId, userId, label: 'Noncanonical spacing attack',
      canonicalContent: '{ "bodyText": "Spacing attack", "schema": "propertypredator.email-draft/v1", "subject": "Noncanonical" }',
    });
    await assert.rejects(
      service.createDraft(
        { ...context, requestId: 'owned-seed-noncanonical-attack' },
        {
          commandKey: 'owned-seed:draft:noncanonical-attack',
          companyContentVersionId: noncanonicalVersionId.contentVersionId,
        },
      ),
      (error: unknown) => (error as { code?: string }).code === '22023',
    );
    const draft = await service.createDraft(context, {
      commandKey: 'owned-seed:draft:001', companyContentVersionId: contentVersionId,
    });
    assert.equal(draft.lifecycleAtCommand, 'draft');
    assert.equal(draft.recipient, 'office@propertypredator.com');
    assert.equal(draft.providerEffects, false);
    assert.equal((await ownerQuery<{ count: string }>(pool,
      `SELECT count(*)::text AS count FROM app.message_approval_requests
       WHERE workspace_id = $1 AND message_id = $2`,
      [workspaceId, draft.messageId]))[0]!.count, '0');
    assert.deepEqual(await service.resume(
      { ...context, requestId: 'owned-seed-message-resume-draft' },
      { companyContentVersionId: contentVersionId },
    ), {
      messageId: draft.messageId,
      messageVersionId: draft.messageVersionId,
      companyContentVersionId: contentVersionId,
      phase: 'drafted', approvalRequestId: null,
      subjectSha256: draft.subjectSha256,
      bodySha256: draft.bodySha256,
      sourceContentSha256: draft.sourceContentSha256,
      recipient: 'office@propertypredator.com',
    });

    // An office-bound live email is not automatically part of this bridge.
    // Even with the same immutable company source and an approval-pending
    // request, every decision must prove the message was created by the
    // append-only owned-seed command ledger.
    const unrelatedMessageId = randomUUID();
    const unrelatedVersionId = randomUUID();
    const unrelatedRequestId = randomUUID();
    await withOwnerClient(pool, async (client) => {
      const boundary = await client.query<{
        conversationId: string;
        contactId: string;
        contactPointId: string;
      }>(
        `SELECT message.conversation_id AS "conversationId",
                message.contact_id AS "contactId",
                message.contact_point_id AS "contactPointId"
         FROM app.messages AS message
         WHERE message.workspace_id = $1 AND message.id = $2`,
        [workspaceId, draft.messageId],
      );
      const existing = boundary.rows[0]!;
      await client.query(
        `INSERT INTO app.messages (
           id, workspace_id, conversation_id, contact_id, contact_point_id,
           channel, environment, direction, lifecycle, source_kind,
           current_version_id, current_version_number, current_body_sha256,
           created_by_actor_kind, created_by_user_id, occurred_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'email', 'live', 'outbound', 'draft',
           'automation', $6, 1, digest($7, 'sha256'), 'user', $8,
           statement_timestamp()
         )`,
        [unrelatedMessageId, workspaceId, existing.conversationId,
          existing.contactId, existing.contactPointId, unrelatedVersionId,
          body, userId],
      );
      await client.query(
        `INSERT INTO app.message_versions (
           id, workspace_id, conversation_id, message_id, channel,
           environment, version_number, body_text,
           source_content_version_ref, source_content_sha256,
           source_content_approval_ref, created_by_actor_kind,
           created_by_user_id, created_request_id
         ) VALUES (
           $1, $2, $3, $4, 'email', 'live', 1, $5,
           'app.company_content_versions:' || $6::text, digest($7, 'sha256'),
           'app.company_content_approval_decisions:' || $8::text,
           'user', $9, 'unrelated-office-message'
         )`,
        [unrelatedVersionId, workspaceId, existing.conversationId,
          unrelatedMessageId, body, contentVersionId, canonical,
          contentDecisionId, userId],
      );
      await client.query(
        `INSERT INTO app.message_approval_requests (
           id, workspace_id, conversation_id, message_id,
           message_version_id, version_number, body_sha256, request_number,
           review_note, requested_by_user_id, requested_request_id
         ) VALUES (
           $1, $2, $3, $4, $5, 1, digest($6, 'sha256'), 1,
           'Unrelated office message attack fixture', $7,
           'unrelated-office-message'
         )`,
        [unrelatedRequestId, workspaceId, existing.conversationId,
          unrelatedMessageId, unrelatedVersionId, body, userId],
      );
      await client.query(
        `UPDATE app.messages SET lifecycle = 'approval_pending',
           row_version = row_version + 1
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, unrelatedMessageId],
      );
    });
    await assert.rejects(
      service.decideApproval(
        { ...context, requestId: 'owned-seed-unrelated-office-reject' },
        {
          commandKey: 'owned-seed:decision:unrelated-office-reject',
          approvalRequestId: unrelatedRequestId,
          decision: 'rejected',
          decisionNote: 'This unrelated message must remain outside the bridge.',
        },
      ),
      /evidence changed|conflicted/,
    );
    assert.deepEqual(await ownerQuery<{ lifecycle: string; decisions: string }>(
      pool,
      `SELECT message.lifecycle,
              (SELECT count(*)::text
               FROM app.message_approval_decisions AS decision
               WHERE decision.workspace_id = message.workspace_id
                 AND decision.approval_request_id = $3) AS decisions
       FROM app.messages AS message
       WHERE message.workspace_id = $1 AND message.id = $2`,
      [workspaceId, unrelatedMessageId, unrelatedRequestId],
    ), [{ lifecycle: 'approval_pending', decisions: '0' }]);

    const requested = await service.requestApproval(
      { ...context, requestId: 'owned-seed-message-request' },
      { commandKey: 'owned-seed:request:001', messageId: draft.messageId },
    );
    assert.equal(requested.lifecycleAtCommand, 'approval_pending');
    assert.equal((await service.resume(
      { ...context, requestId: 'owned-seed-message-resume-pending' },
      { companyContentVersionId: contentVersionId },
    ))?.phase, 'approval_pending');
    const approved = await service.decideApproval(
      { ...context, requestId: 'owned-seed-message-decision' },
      {
        commandKey: 'owned-seed:decision:001',
        approvalRequestId: requested.approvalRequestId,
        decision: 'approved',
      },
    );
    assert.equal(approved.lifecycleAtCommand, 'approved');
    assert.equal(approved.bodySha256, draft.bodySha256);
    assert.equal(approved.sourceContentSha256, draft.sourceContentSha256);
    const resumedApproved = await service.resume(
      { ...context, requestId: 'owned-seed-message-resume-approved' },
      { companyContentVersionId: contentVersionId },
    );
    assert.equal(resumedApproved?.phase, 'approved');
    assert.equal(resumedApproved?.approvalRequestId, requested.approvalRequestId);

    // Each immutable company-content version owns one workflow even when two
    // tabs race with different command keys.
    const concurrentCanonical = JSON.stringify({
      bodyText: 'Concurrent exact owned-seed draft.',
      schema: 'propertypredator.email-draft/v1',
      subject: 'Property Predator concurrent owned-seed proof',
    });
    const concurrentSource = await insertApprovedEmailSource(pool, {
      workspaceId, userId, label: 'Concurrent create proof',
      canonicalContent: concurrentCanonical,
    });
    const concurrent = await Promise.all([
      service.createDraft(
        { ...context, requestId: 'owned-seed-concurrent-a' },
        {
          commandKey: 'owned-seed:draft:concurrent-a',
          companyContentVersionId: concurrentSource.contentVersionId,
        },
      ),
      service.createDraft(
        { ...context, requestId: 'owned-seed-concurrent-b' },
        {
          commandKey: 'owned-seed:draft:concurrent-b',
          companyContentVersionId: concurrentSource.contentVersionId,
        },
      ),
    ]);
    assert.equal(concurrent[0]!.messageId, concurrent[1]!.messageId);
    assert.deepEqual(
      concurrent.map((result) => result.disposition).sort(),
      ['created', 'replayed'],
    );
    await ownerQuery(pool,
       `UPDATE app.conversations AS conversation
       SET subject = 'Tampered outside the reviewed source',
           updated_at = statement_timestamp(),
           row_version = conversation.row_version + 1
       FROM app.messages AS message
       WHERE message.workspace_id = $1 AND message.id = $2
         AND conversation.workspace_id = message.workspace_id
         AND conversation.id = message.conversation_id`,
      [workspaceId, concurrent[0]!.messageId]);
    await assert.rejects(
      service.requestApproval(
        { ...context, requestId: 'owned-seed-concurrent-tamper-request' },
        {
          commandKey: 'owned-seed:request:concurrent-tamper',
          messageId: concurrent[0]!.messageId,
        },
      ),
      /evidence changed|conflicted/,
    );

    // Keep two independently pending messages while each exact source
    // approval is current. One exercises approval-request drift; the other a
    // genuinely newer content version.
    const approvalDriftCanonical = JSON.stringify({
      bodyText: 'Approval drift exact owned-seed body.',
      schema: 'propertypredator.email-draft/v1',
      subject: 'Property Predator approval drift proof',
    });
    const approvalDriftSource = await insertApprovedEmailSource(pool, {
      workspaceId, userId, label: 'Approval drift proof',
      canonicalContent: approvalDriftCanonical,
    });
    const approvalDriftDraft = await service.createDraft(
      { ...context, requestId: 'owned-seed-approval-drift-draft' },
      {
        commandKey: 'owned-seed:draft:approval-drift',
        companyContentVersionId: approvalDriftSource.contentVersionId,
      },
    );
    const approvalDriftRequest = await service.requestApproval(
      { ...context, requestId: 'owned-seed-approval-drift-request' },
      { commandKey: 'owned-seed:request:approval-drift', messageId: approvalDriftDraft.messageId },
    );
    await ownerQuery(pool,
       `UPDATE app.conversations AS conversation
       SET subject = 'Tampered after exact message review request',
           updated_at = statement_timestamp(),
           row_version = conversation.row_version + 1
       FROM app.messages AS message
       WHERE message.workspace_id = $1 AND message.id = $2
         AND conversation.workspace_id = message.workspace_id
         AND conversation.id = message.conversation_id`,
      [workspaceId, approvalDriftDraft.messageId]);
    await assert.rejects(
      service.decideApproval(
        { ...context, requestId: 'owned-seed-tampered-approve' },
        {
          commandKey: 'owned-seed:decision:tampered-approve',
          approvalRequestId: approvalDriftRequest.approvalRequestId,
          decision: 'approved',
        },
      ),
      /evidence changed|conflicted/,
    );
    const sourceApprovalDriftCanonical = JSON.stringify({
      bodyText: 'Source approval drift exact owned-seed body.',
      schema: 'propertypredator.email-draft/v1',
      subject: 'Property Predator source approval drift proof',
    });
    const sourceApprovalDriftSource = await insertApprovedEmailSource(pool, {
      workspaceId, userId, label: 'Source approval drift proof',
      canonicalContent: sourceApprovalDriftCanonical,
    });
    const sourceApprovalDriftDraft = await service.createDraft(
      { ...context, requestId: 'owned-seed-source-approval-drift-draft' },
      {
        commandKey: 'owned-seed:draft:source-approval-drift',
        companyContentVersionId: sourceApprovalDriftSource.contentVersionId,
      },
    );
    const sourceApprovalDriftMessageRequest = await service.requestApproval(
      { ...context, requestId: 'owned-seed-source-approval-drift-request' },
      {
        commandKey: 'owned-seed:request:source-approval-drift',
        messageId: sourceApprovalDriftDraft.messageId,
      },
    );
    const staleCanonical = JSON.stringify({
      bodyText: 'Stale source exact owned-seed body.',
      schema: 'propertypredator.email-draft/v1',
      subject: 'Property Predator stale source proof',
    });
    const staleSource = await insertApprovedEmailSource(pool, {
      workspaceId, userId, label: 'Stale source proof',
      canonicalContent: staleCanonical,
    });
    const staleDraft = await service.createDraft(
      { ...context, requestId: 'owned-seed-stale-draft' },
      {
        commandKey: 'owned-seed:draft:stale',
        companyContentVersionId: staleSource.contentVersionId,
      },
    );
    const staleRequest = await service.requestApproval(
      { ...context, requestId: 'owned-seed-stale-request' },
      { commandKey: 'owned-seed:request:stale', messageId: staleDraft.messageId },
    );

    // 0021 normally prevents a newer request after an approval. Simulate
    // privilege/schema drift in the disposable database by bypassing only its
    // insert guard for this transaction. A non-approval decision must still
    // unwind the exact pending message; an approval would remain fail-closed.
    await withOwnerClient(pool, async (client) => {
      await client.query(
        `ALTER TABLE app.company_content_approval_requests
         DISABLE TRIGGER company_content_approval_requests_guard_insert`,
      );
      await client.query(
        `INSERT INTO app.company_content_approval_requests (
           id, workspace_id, content_item_id, content_version_id,
           content_sha256, request_number, review_note,
           requested_by_user_id, requested_request_id
         ) VALUES (
           $1, $2, $3, $4, digest($5, 'sha256'), 2,
           'Disposable drift proof', $6, 'owned-seed-source-approval-drift'
        )`,
        [sourceApprovalDriftRequestId, workspaceId,
          sourceApprovalDriftSource.contentItemId,
          sourceApprovalDriftSource.contentVersionId,
          sourceApprovalDriftSource.canonicalContent, userId],
      );
      await client.query(
        `ALTER TABLE app.company_content_approval_requests
         ENABLE TRIGGER company_content_approval_requests_guard_insert`,
      );
    });
    const driftRejected = await service.decideApproval(
      { ...context, requestId: 'owned-seed-approval-drift-reject' },
      {
        commandKey: 'owned-seed:decision:approval-drift-reject',
        approvalRequestId: sourceApprovalDriftMessageRequest.approvalRequestId,
        decision: 'rejected',
        decisionNote: 'The source approval evidence changed; return this message to draft.',
      },
    );
    assert.equal(driftRejected.lifecycleAtCommand, 'draft');
    assert.equal(driftRejected.decision, 'rejected');

    const nextCanonical = JSON.stringify({
      bodyText: 'Stale source exact owned-seed body. Revised.',
      schema: 'propertypredator.email-draft/v1',
      subject: 'Property Predator stale source proof',
    });
    await withOwnerClient(pool, async (client) => {
      await client.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.workspace_id', $2, true),
                set_config('app.actor_kind', 'user', true),
                set_config('app.request_id', 'owned-seed-content-v2', true)`,
        [userId, workspaceId],
      );
      await client.query(
        `INSERT INTO app.company_content_versions (
           workspace_id, content_item_id, version_number, previous_version_id,
           origin, content_kind, title, source_system, source_item_id,
           source_version, content_mime_type, content_body, blob_storage_key,
           blob_sha256, brand_snapshot_ref, brand_sha256, metadata,
           created_by_user_id, created_request_id
         ) VALUES (
           $1, $2, 2, $3, 'edited', 'email', 'Owned-seed proof v2',
           'property_predator.campaign_wizard', $4, 'v2',
           'application/vnd.propertypredator.email-draft+json', $5, $6,
           digest($5, 'sha256'), 'brand-brain:test',
           digest('brand-brain:test', 'sha256'), '{"fixture":true}'::jsonb,
           $7, 'overwritten'
         )`,
        [workspaceId, staleSource.contentItemId,
          staleSource.contentVersionId, staleSource.sourceItemId,
          nextCanonical,
          `company-content/${staleSource.contentItemId}/v2`, userId],
      );
    });
    await assert.rejects(
      service.decideApproval(
        { ...context, requestId: 'owned-seed-stale-approve' },
        {
          commandKey: 'owned-seed:decision:stale-approve',
          approvalRequestId: staleRequest.approvalRequestId,
          decision: 'approved',
        },
      ),
      /evidence changed|conflicted/,
    );
    const changes = await service.decideApproval(
      { ...context, requestId: 'owned-seed-stale-changes' },
      {
        commandKey: 'owned-seed:decision:stale-changes',
        approvalRequestId: staleRequest.approvalRequestId,
        decision: 'changes_requested',
        decisionNote: 'The source changed; review the latest approved version.',
      },
    );
    assert.equal(changes.lifecycleAtCommand, 'draft');
    assert.equal(changes.decision, 'changes_requested');

    const state = await ownerQuery<{
      lifecycle: string;
      recipient: string;
      approvedContent: string;
      operations: string;
      deliveries: string;
      jobs: string;
    }>(pool,
      `SELECT message.lifecycle,
              point.normalized_value AS recipient,
              (SELECT count(*) FROM app.property_predator_email_pilot_approved_content
               WHERE workspace_id = $1 AND message_version_id = $3)::text AS "approvedContent",
              (SELECT count(*) FROM app.provider_operations WHERE workspace_id = $1)::text AS operations,
              (SELECT count(*) FROM app.message_deliveries WHERE workspace_id = $1)::text AS deliveries,
              (SELECT count(*) FROM app.property_predator_mailgun_jobs WHERE workspace_id = $1)::text AS jobs
       FROM app.messages AS message
       JOIN app.contact_points AS point ON point.workspace_id = message.workspace_id
        AND point.id = message.contact_point_id
       WHERE message.workspace_id = $1 AND message.id = $2`,
      [workspaceId, draft.messageId, draft.messageVersionId]);
    assert.deepEqual(state[0], {
      lifecycle: 'approved', recipient: 'office@propertypredator.com',
      approvedContent: '1', operations: '0', deliveries: '0', jobs: '0',
    });

    const replay = await service.createDraft(context, {
      commandKey: 'owned-seed:draft:001', companyContentVersionId: contentVersionId,
    });
    assert.equal(replay.disposition, 'replayed');
    assert.equal(replay.messageId, draft.messageId);
    await assert.rejects(
      ownerQuery(pool,
        `UPDATE app_private.property_predator_owned_seed_message_commands
         SET recorded_at = recorded_at
         WHERE workspace_id = $1 AND message_id = $2`,
        [workspaceId, draft.messageId]),
      (error: unknown) => (error as { code?: string }).code === '55000',
    );
    await assert.rejects(
      ownerQuery(pool,
        `DELETE FROM app_private.property_predator_owned_seed_message_commands
         WHERE workspace_id = $1 AND message_id = $2`,
        [workspaceId, draft.messageId]),
      (error: unknown) => (error as { code?: string }).code === '55000',
    );
    await assert.rejects(
      commandPool.query('SELECT * FROM app.messages'),
      (error: unknown) => (error as { code?: string }).code === '42501',
    );
  } finally {
    await commandPool?.end().catch(() => undefined);
    await clearCommandPassword(pool).catch(() => undefined);
    await pool.end();
  }
});
