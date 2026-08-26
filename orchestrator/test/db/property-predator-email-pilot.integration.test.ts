import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  PgMailgunWebhookRepository,
  MailgunWebhookIngressService,
} from '../../src/mailgun-webhook-pg/index.js';
import { PgControlledEmailPilotBoundary } from '../../src/property-predator-email-pilot-pg/index.js';
import {
  propertyPredatorEmailContentSha256,
  type ControlledEmailPilotBoundaryInput,
} from '../../src/providers/controlled-property-predator-email-pilot.js';
import {
  openTestDatabase,
  ownerQuery,
  resetIdentityTables,
  testDatabaseSkipReason,
  withOwnerClient,
} from './database-helper.js';

const skip = testDatabaseSkipReason();
const SIGNING_KEY = Buffer.from('property-predator-integration-signing-key', 'utf8');

function roleConnectPool(pool: Pool, role: string): Pick<Pool, 'connect'> {
  return {
    connect: (async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: readonly unknown[]) => {
          const result = await client.query(sql, values ? [...values] : undefined);
          if (/^BEGIN\b/.test(sql)) await client.query(`SET LOCAL ROLE ${role}`);
          return result;
        },
        release: (destroy?: boolean) => client.release(destroy),
      } as unknown as PoolClient;
    }) as Pool['connect'],
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface ApprovedEmailFixture {
  messageVersionId: string;
  approvalRequestId: string;
  approvalDecisionId: string;
  approvedContentSha256: string;
}

async function createApprovedEmailFixture(
  pool: Pool,
  fixture: Readonly<{
    workspaceId: string;
    conversationId: string;
    contactId: string;
    contactPointId: string;
    ownerId: string;
    subject: string;
    body: string;
  }>,
): Promise<ApprovedEmailFixture> {
  const messageId = randomUUID();
  const messageVersionId = randomUUID();
  const approvalRequestId = randomUUID();
  const approvalDecisionId = randomUUID();
  const requestNonce = randomUUID();
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
      [messageId, fixture.workspaceId, fixture.conversationId, fixture.contactId,
        fixture.contactPointId, messageVersionId, fixture.body, fixture.ownerId],
    );
    await client.query(
      `INSERT INTO app.message_versions (
         id, workspace_id, conversation_id, message_id, channel, environment,
         version_number, body_text, created_by_actor_kind, created_by_user_id,
         created_request_id
       ) VALUES ($1, $2, $3, $4, 'email', 'live', 1, $5, 'user', $6, $7)`,
      [messageVersionId, fixture.workspaceId, fixture.conversationId, messageId,
        fixture.body, fixture.ownerId, `pilot-version-${requestNonce}`],
    );
    await client.query(
      `INSERT INTO app.message_approval_requests (
         id, workspace_id, conversation_id, message_id, message_version_id,
         version_number, body_sha256, request_number, requested_by_user_id,
         requested_request_id
       ) VALUES ($1, $2, $3, $4, $5, 1, digest($6, 'sha256'), 1, $7, $8)`,
      [approvalRequestId, fixture.workspaceId, fixture.conversationId, messageId,
        messageVersionId, fixture.body, fixture.ownerId,
        `pilot-approval-request-${requestNonce}`],
    );
    await client.query(
      `UPDATE app.messages SET lifecycle = 'approval_pending', row_version = 2
       WHERE workspace_id = $1 AND id = $2`,
      [fixture.workspaceId, messageId],
    );
    await client.query(
      `INSERT INTO app.message_approval_decisions (
         id, workspace_id, conversation_id, message_id, message_version_id,
         approval_request_id, version_number, body_sha256, decision,
         decided_by_user_id, decided_request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, digest($7, 'sha256'),
                 'approved', $8, $9)`,
      [approvalDecisionId, fixture.workspaceId, fixture.conversationId, messageId,
        messageVersionId, approvalRequestId, fixture.body, fixture.ownerId,
        `pilot-approval-decision-${requestNonce}`],
    );
    await client.query(
      `UPDATE app.messages SET lifecycle = 'approved', row_version = 3
       WHERE workspace_id = $1 AND id = $2`,
      [fixture.workspaceId, messageId],
    );
  });
  return {
    messageVersionId,
    approvalRequestId,
    approvalDecisionId,
    approvedContentSha256: propertyPredatorEmailContentSha256(
      fixture.subject,
      fixture.body,
    ),
  };
}

test('controlled live email is subject-pinned, policy-capped, singular and webhook-correlated', {
  skip,
}, async () => {
  const pool = await openTestDatabase();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const contactId = randomUUID();
  const contactPointId = randomUUID();
  const connectionId = randomUUID();
  const endpointId = randomUUID();
  const inboxId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const versionId = randomUUID();
  const approvalRequestId = randomUUID();
  const approvalDecisionId = randomUUID();
  const consentId = randomUUID();
  const subject = 'Your owned Property Predator seed briefing';
  const body = 'This approved integration message can reach only one owned internal seed.';
  const recipient = `owned-seed-${contactId.slice(0, 8)}@propertypredator.co.uk`;
  const contentSha = propertyPredatorEmailContentSha256(subject, body);
  const emailSha = sha(recipient);

  try {
    await resetIdentityTables(pool);
    await ownerQuery(pool,
      `INSERT INTO app.organizations (id, name, slug, kind, status)
       VALUES ($1, 'Property Predator pilot integration', $2, 'direct_customer', 'active')`,
      [organizationId, `pp-pilot-${organizationId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.users (id, email, status, email_verified_at)
       VALUES ($1, $2, 'active', statement_timestamp())`,
      [ownerId, `pilot-owner-${ownerId.slice(0, 8)}@propertypredator.co.uk`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspaces (id, organization_id, name, slug, status)
       VALUES ($1, $2, 'Property Predator pilot', $3, 'active')`,
      [workspaceId, organizationId, `pp-pilot-${workspaceId.slice(0, 8)}`]);
    await ownerQuery(pool,
      `INSERT INTO app.workspace_memberships (
         workspace_id, organization_id, user_id, role, status
       ) VALUES ($1, $2, $3, 'owner', 'active')`,
      [workspaceId, organizationId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.contacts (
         id, workspace_id, display_name, lifecycle_status, source
       ) VALUES ($1, $2, 'Owned internal seed', 'lead', 'internal_seed')`,
      [contactId, workspaceId]);
    await ownerQuery(pool,
      `INSERT INTO app.contact_points (
         id, workspace_id, contact_id, kind, label, value,
         normalized_value, is_primary, is_verified, dedupe_state
       ) VALUES ($1, $2, $3, 'email', 'Owned seed', $4, $4, true, true, 'normal')`,
      [contactPointId, workspaceId, contactId, recipient]);
    await ownerQuery(pool,
      `INSERT INTO app.provider_connections (
         id, workspace_id, provider_id, provider_kind, environment, status,
         display_name, capabilities, created_by_user_id
       ) VALUES (
         $1, $2, 'mailgun_eu', 'email', 'live', 'active',
         'Property Predator Mailgun EU', '["email.send"]'::jsonb, $3
       )`,
      [connectionId, workspaceId, ownerId]);
    await ownerQuery(pool,
      `INSERT INTO app.channel_endpoints (
         id, workspace_id, provider_connection_id, channel, environment,
         direction, address, normalized_address, display_name, status
       ) VALUES (
         $1, $2, $3, 'email', 'live', 'bidirectional',
         'mail.propertypredator.co.uk', 'mail.propertypredator.co.uk',
         'Property Predator email', 'active'
       )`,
      [endpointId, workspaceId, connectionId]);
    await ownerQuery(pool,
      `INSERT INTO app.inboxes (
         id, workspace_id, channel_endpoint_id, provider_connection_id,
         channel, environment, name, status
       ) VALUES ($1, $2, $3, $4, 'email', 'live', 'Pilot inbox', 'active')`,
      [inboxId, workspaceId, endpointId, connectionId]);
    await ownerQuery(pool,
      `INSERT INTO app.conversations (
         id, workspace_id, inbox_id, channel, environment, contact_id,
         state, subject
       ) VALUES ($1, $2, $3, 'email', 'live', $4, 'open', $5)`,
      [conversationId, workspaceId, inboxId, contactId, subject]);
    await ownerQuery(pool,
      `INSERT INTO app.communication_consent_events (
         id, workspace_id, contact_id, contact_point_id, channel, purpose,
         state, lawful_basis, source, policy_version, actor_kind,
         actor_user_id, evidence, endpoint_identity_sha256, occurred_at
       ) VALUES (
         $1, $2, $3, $4, 'email', 'marketing', 'granted', 'consent',
         'internal.seed.attestation', 'pilot-v1', 'user', $5, '{}'::jsonb,
         decode(repeat('00', 32), 'hex'), statement_timestamp()
       )`,
      [consentId, workspaceId, contactId, contactPointId, ownerId]);

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
        [messageId, workspaceId, conversationId, contactId, contactPointId,
          versionId, body, ownerId],
      );
      await client.query(
        `INSERT INTO app.message_versions (
           id, workspace_id, conversation_id, message_id, channel, environment,
           version_number, body_text, created_by_actor_kind, created_by_user_id,
           created_request_id
         ) VALUES ($1, $2, $3, $4, 'email', 'live', 1, $5, 'user', $6, $7)`,
        [versionId, workspaceId, conversationId, messageId, body, ownerId, 'pilot-version'],
      );
      await client.query(
        `INSERT INTO app.message_approval_requests (
           id, workspace_id, conversation_id, message_id, message_version_id,
           version_number, body_sha256, request_number, requested_by_user_id,
           requested_request_id
         ) VALUES ($1, $2, $3, $4, $5, 1, digest($6, 'sha256'), 1, $7, $8)`,
        [approvalRequestId, workspaceId, conversationId, messageId, versionId,
          body, ownerId, 'pilot-approval-request'],
      );
      await client.query(
        `UPDATE app.messages SET lifecycle = 'approval_pending', row_version = 2
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, messageId],
      );
      await client.query(
        `INSERT INTO app.message_approval_decisions (
           id, workspace_id, conversation_id, message_id, message_version_id,
           approval_request_id, version_number, body_sha256, decision,
           decided_by_user_id, decided_request_id
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, digest($7, 'sha256'),
                   'approved', $8, $9)`,
        [approvalDecisionId, workspaceId, conversationId, messageId, versionId,
          approvalRequestId, body, ownerId, 'pilot-approval-decision'],
      );
      await client.query(
        `UPDATE app.messages SET lifecycle = 'approved', row_version = 3
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, messageId],
      );
    });

    await ownerQuery(pool,
      `INSERT INTO app.property_predator_email_pilot_seed_events (
         workspace_id, email_sha256, state, attestation, recorded_by, occurred_at
       ) VALUES ($1, decode($2, 'hex'), 'owned',
                 'Owned and controlled Property Predator seed mailbox',
                 'integration-owner', statement_timestamp())`,
      [workspaceId, emailSha]);
    await ownerQuery(pool,
      `INSERT INTO app.property_predator_email_pilot_control_events (
         workspace_id, provider_connection_id, provider_effects_enabled,
         email_delivery_enabled, emergency_paused, max_recipients,
         estimated_recipient_cost_usd_micros, run_message_cap,
         monthly_message_cap, run_spend_cap_usd_micros,
         monthly_spend_cap_usd_micros, reason, recorded_by, occurred_at
       ) VALUES (
         $1, $2, true, true, false, 10, 1500, 10, 100, 15000, 150000,
         'integration_activation', 'integration-owner', statement_timestamp()
       )`,
      [workspaceId, connectionId]);

    const boundary = new PgControlledEmailPilotBoundary({
      commandPool: roleConnectPool(pool, 'r72_mailgun_worker_command'),
      workspaceId,
      runtimeEvidence: {
        providerEffectsEnabled: true,
        emailDeliveryEnabled: true,
        emergencyPaused: false,
      },
    });
    const makeInput = (
      operationId: string,
      requestSuffix: string,
      overrides: Partial<ControlledEmailPilotBoundaryInput> = {},
    ): ControlledEmailPilotBoundaryInput => ({
      workspaceId, providerConnectionId: connectionId, operationId,
      correlationId: randomUUID(), idempotencyKeySha256: sha(`key-${requestSuffix}`),
      requestSha256: sha(`request-${requestSuffix}`), runId: randomUUID(),
      utcMonth: new Date().toISOString().slice(0, 7),
      stage: 'internal-seed', recipientScope: 'owned-internal-seeds-only',
      approval: {
        messageVersionId: versionId, approvalRequestId,
        approvalDecisionId, approvedContentSha256: contentSha,
      },
      recipients: [{ email: recipient, emailSha256: emailSha, contactPointId, consentEventId: consentId }],
      requestedMessages: 1, estimatedSpendUsdMicros: 1500,
      limits: {
        maxMessagesPerRun: 10, maxMessagesPerUtcMonth: 100,
        maxSpendUsdMicrosPerRun: 15000, maxSpendUsdMicrosPerUtcMonth: 150000,
      },
      ...overrides,
    });

    await ownerQuery(pool,
      `UPDATE app.conversations
       SET subject = 'Changed after approval', row_version = row_version + 1
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, conversationId]);
    const staleApprovedSubject = await boundary.authorizeImmediatelyBeforeProviderCall(
      makeInput(randomUUID(), 'stale-approved-subject'),
    );
    assert.deepEqual(staleApprovedSubject, { disposition: 'blocked', reason: 'approval_not_current' });
    const changedSubject = await boundary.authorizeImmediatelyBeforeProviderCall(
      makeInput(randomUUID(), 'unapproved-changed-subject', {
        approval: {
          messageVersionId: versionId, approvalRequestId, approvalDecisionId,
          approvedContentSha256: propertyPredatorEmailContentSha256('Changed after approval', body),
        },
      }),
    );
    assert.deepEqual(changedSubject, { disposition: 'blocked', reason: 'approval_not_current' });
    await ownerQuery(pool,
      `UPDATE app.conversations SET subject = $3, row_version = row_version + 1
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, conversationId, subject]);

    assert.deepEqual(await boundary.authorizeImmediatelyBeforeProviderCall(
      makeInput(randomUUID(), 'inflated-cap', {
        limits: {
          maxMessagesPerRun: 10, maxMessagesPerUtcMonth: 101,
          maxSpendUsdMicrosPerRun: 15000, maxSpendUsdMicrosPerUtcMonth: 150000,
        },
      }),
    ), { disposition: 'blocked', reason: 'operator_policy_mismatch' });
    assert.deepEqual(await boundary.authorizeImmediatelyBeforeProviderCall(
      makeInput(randomUUID(), 'understated-cost', { estimatedSpendUsdMicros: 1 }),
    ), { disposition: 'blocked', reason: 'operator_policy_mismatch' });
    const secondRecipient = {
      email: `second-${recipient}`,
      emailSha256: sha(`second-${recipient}`),
      contactPointId: randomUUID(), consentEventId: randomUUID(),
    };
    assert.deepEqual(await boundary.authorizeImmediatelyBeforeProviderCall(
      makeInput(randomUUID(), 'batch', {
        recipients: [
          { email: recipient, emailSha256: emailSha, contactPointId, consentEventId: consentId },
          secondRecipient,
        ],
        requestedMessages: 2,
        estimatedSpendUsdMicros: 3000,
      }),
    ), { disposition: 'blocked', reason: 'single_recipient_required' });

    const operationId = randomUUID();
    const authorized = await boundary.authorizeImmediatelyBeforeProviderCall(
      makeInput(operationId, 'accepted'),
    );
    assert.equal(authorized.disposition, 'authorized');
    if (authorized.disposition !== 'authorized') throw new Error('Pilot was not authorized');
    const providerMessageId = `pilot-${operationId}@mail.propertypredator.co.uk`;
    await boundary.settleProviderCall(authorized.reservationId, authorized.requestSha256, {
      status: 'accepted', externalId: `<${providerMessageId}>`,
      occurredAt: new Date().toISOString(), retryable: false,
      errorCode: null, summary: 'Mailgun accepted the controlled seed message',
    });
    assert.deepEqual(await ownerQuery<{ state: string; provider_reference: string; status: string }>(
      pool,
      `SELECT operation.state, operation.provider_reference, delivery.status
       FROM app.provider_operations AS operation
       JOIN app.message_deliveries AS delivery
         ON delivery.workspace_id = operation.workspace_id
        AND delivery.provider_operation_id = operation.id
       WHERE operation.workspace_id = $1 AND operation.id = $2`,
      [workspaceId, operationId],
    ), [{ state: 'accepted', provider_reference: `<${providerMessageId}>`, status: 'accepted' }]);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = `integration-token-${operationId}`;
    const rawEvent = Buffer.from(JSON.stringify({
      signature: {
        timestamp, token,
        signature: createHmac('sha256', SIGNING_KEY)
          .update(timestamp + token, 'ascii').digest('hex'),
      },
      'event-data': {
        id: `evt_${operationId}`, event: 'delivered',
        timestamp: Number(timestamp) + 0.25, recipient,
        message: { headers: { 'message-id': providerMessageId } },
      },
    }));
    const webhook = new MailgunWebhookIngressService({
      repository: new PgMailgunWebhookRepository({
        commandPool: roleConnectPool(pool, 'r72_mailgun_webhook_command'),
        workspaceId, providerConnectionId: connectionId,
      }),
      signingKey: SIGNING_KEY,
      nowSeconds: () => Number(timestamp),
    });
    const recorded = await webhook.handle(rawEvent);
    assert.equal(recorded.effectiveDeliveryStatus, 'delivered');
    assert.deepEqual(await ownerQuery<{ status: string; receipts: number }>(
      pool,
      `SELECT delivery.status,
              count(event.id)::integer AS receipts
       FROM app.message_deliveries AS delivery
       LEFT JOIN app.mailgun_webhook_events AS event
         ON event.workspace_id = delivery.workspace_id
        AND event.message_delivery_id = delivery.id
       WHERE delivery.workspace_id = $1 AND delivery.provider_operation_id = $2
       GROUP BY delivery.status`,
      [workspaceId, operationId],
    ), [{ status: 'delivered', receipts: 1 }]);

    assert.deepEqual(await ownerQuery<{ count: number }>(
      pool,
      `SELECT count(*)::integer AS count FROM app.provider_operations
       WHERE workspace_id = $1`,
      [workspaceId],
    ), [{ count: 1 }]);

    const cancellationApproval = await createApprovedEmailFixture(pool, {
      workspaceId, conversationId, contactId, contactPointId, ownerId, subject,
      body: 'This second approved message proves cancel-before-call refunds only unspent capacity.',
    });
    const cancellationInput = makeInput(randomUUID(), 'cancel-before-call', {
      approval: cancellationApproval,
    });
    const cancellable = await boundary.authorizeImmediatelyBeforeProviderCall(cancellationInput);
    assert.equal(cancellable.disposition, 'authorized');
    if (cancellable.disposition !== 'authorized') throw new Error('Cancellation fixture was not authorized');
    await boundary.cancelBeforeProviderCall(
      cancellable.reservationId,
      cancellable.requestSha256,
      'transport_not_called',
    );
    await boundary.cancelBeforeProviderCall(
      cancellable.reservationId,
      cancellable.requestSha256,
      'transport_not_called',
    );
    assert.deepEqual(await ownerQuery<{
      reservation_state: string;
      operation_state: string;
      delivery_status: string;
      run_messages: number;
      month_messages: number;
      month_spend: string;
    }>(pool,
      `SELECT reservation.state AS reservation_state,
              operation.state AS operation_state,
              delivery.status AS delivery_status,
              run_usage.reserved_messages AS run_messages,
              month_usage.reserved_messages AS month_messages,
              month_usage.reserved_spend_usd_micros::text AS month_spend
       FROM app.property_predator_email_pilot_reservations AS reservation
       JOIN app.provider_operations AS operation
         ON operation.workspace_id = reservation.workspace_id
        AND operation.id = reservation.operation_id
       JOIN app.message_deliveries AS delivery
         ON delivery.workspace_id = reservation.workspace_id
        AND delivery.id = reservation.message_delivery_id
       JOIN app.property_predator_email_pilot_run_usage AS run_usage
         ON run_usage.workspace_id = reservation.workspace_id
        AND run_usage.run_id = reservation.run_id
       JOIN app.property_predator_email_pilot_month_usage AS month_usage
         ON month_usage.workspace_id = reservation.workspace_id
        AND month_usage.utc_month = reservation.utc_month
       WHERE reservation.workspace_id = $1 AND reservation.id = $2`,
      [workspaceId, cancellable.reservationId],
    ), [{
      reservation_state: 'cancelled', operation_state: 'cancelled',
      delivery_status: 'cancelled', run_messages: 0, month_messages: 1,
      month_spend: '1500',
    }]);

    const ambiguousApproval = await createApprovedEmailFixture(pool, {
      workspaceId, conversationId, contactId, contactPointId, ownerId, subject,
      body: 'This third approved message proves an ambiguous result is retained and cannot retry.',
    });
    const ambiguousInput = makeInput(randomUUID(), 'ambiguous-provider-outcome', {
      approval: ambiguousApproval,
    });
    const ambiguous = await boundary.authorizeImmediatelyBeforeProviderCall(ambiguousInput);
    assert.equal(ambiguous.disposition, 'authorized');
    if (ambiguous.disposition !== 'authorized') throw new Error('Ambiguous fixture was not authorized');
    await boundary.settleProviderCall(ambiguous.reservationId, ambiguous.requestSha256, {
      status: 'needs_attention', externalId: null,
      occurredAt: new Date().toISOString(), retryable: false,
      errorCode: 'mailgun_outcome_unknown', summary: 'Manual reconciliation required',
    });
    const ambiguousReplay = await boundary.authorizeImmediatelyBeforeProviderCall(ambiguousInput);
    assert.equal(ambiguousReplay.disposition, 'replay');
    if (ambiguousReplay.disposition !== 'replay') throw new Error('Ambiguous result did not replay');
    assert.equal(ambiguousReplay.result.status, 'needs_attention');
    assert.deepEqual(await boundary.authorizeImmediatelyBeforeProviderCall({
      ...ambiguousInput,
      requestSha256: sha('conflicting-ambiguous-request'),
    }), {
      disposition: 'blocked',
      reason: 'idempotency_conflict',
    });
    assert.deepEqual(await ownerQuery<{
      operation_state: string;
      delivery_status: string;
      month_messages: number;
      month_spend: string;
      operation_count: number;
    }>(pool,
      `SELECT operation.state AS operation_state,
              delivery.status AS delivery_status,
              month_usage.reserved_messages AS month_messages,
              month_usage.reserved_spend_usd_micros::text AS month_spend,
              (SELECT count(*)::integer FROM app.provider_operations
               WHERE workspace_id = $1) AS operation_count
       FROM app.property_predator_email_pilot_reservations AS reservation
       JOIN app.provider_operations AS operation
         ON operation.workspace_id = reservation.workspace_id
        AND operation.id = reservation.operation_id
       JOIN app.message_deliveries AS delivery
         ON delivery.workspace_id = reservation.workspace_id
        AND delivery.id = reservation.message_delivery_id
       JOIN app.property_predator_email_pilot_month_usage AS month_usage
         ON month_usage.workspace_id = reservation.workspace_id
        AND month_usage.utc_month = reservation.utc_month
       WHERE reservation.workspace_id = $1 AND reservation.id = $2`,
      [workspaceId, ambiguous.reservationId],
    ), [{
      operation_state: 'reconciliation_required',
      delivery_status: 'reconciliation_required',
      month_messages: 2,
      month_spend: '3000',
      operation_count: 3,
    }]);
  } finally {
    await pool.end();
  }
});
