import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  PgZernioInboundRepository,
  ZernioInboundContractError,
  assertZernioInboundCommandBoundaryReady,
  createZernioInboundWebhookCredential,
  verifyZernioInboundWebhook,
} from '../src/zernio-inbound-pg/index.js';
import {
  PropertyPredatorZernioInboundIngress,
  createPropertyPredatorZernioInboundHandler,
  loadPropertyPredatorZernioInboundConfig,
} from '../src/integrations/zernio-inbound/index.js';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const CONNECTION_ID = '10000000-0000-4000-8000-000000000002';
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'property-predator-profile';
const SECRET = 'zernio-test-secret-with-enough-entropy';
const VERIFIED_AT = new Date('2026-09-02T10:00:05.000Z');

function credential() {
  return createZernioInboundWebhookCredential({
    workspaceId: WORKSPACE_ID,
    providerConnectionId: CONNECTION_ID,
    providerProfileId: PROFILE_ID,
    credentialVersion: 'v1',
    webhookSecret: SECRET,
  });
}

function signed(payload: Record<string, unknown>) {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    rawBody,
    signatureHeader: createHmac('sha256', SECRET).update(rawBody).digest('hex'),
    eventIdHeader: String(payload.id),
  };
}

function request(input: ReturnType<typeof signed>): IncomingMessage {
  const stream = Readable.from([input.rawBody]) as unknown as IncomingMessage;
  return Object.assign(stream, {
    method: 'POST', url: '/webhooks/zernio/inbound',
    headers: {
      'content-type': 'application/json',
      'content-length': String(input.rawBody.byteLength),
      'x-zernio-signature': input.signatureHeader,
      'x-zernio-event-id': input.eventIdHeader,
    },
  });
}

function response(): ServerResponse & { statusCode: number; body: string } {
  const state = {
    statusCode: 0, body: '', headers: {} as Record<string, string>,
    writeHead(code: number, headers: Record<string, string> = {}) {
      state.statusCode = code; Object.assign(state.headers, headers); return state;
    },
    end(bodyValue = '') { state.body = bodyValue; return state; },
  };
  return state as unknown as ServerResponse & { statusCode: number; body: string };
}

function messagePayload(): Record<string, unknown> {
  return {
    id: 'evt-instagram-001',
    event: 'message.received',
    message: {
      id: 'message-internal-1',
      conversationId: 'conversation-internal-1',
      platform: 'instagram',
      platformMessageId: 'ig-message-1',
      direction: 'incoming',
      text: 'Hi — can I see how the deal analyser works?',
      attachments: [],
      sender: { id: 'ig-person-1', username: 'fixture.person' },
      sentAt: '2026-09-02T10:00:00.000Z',
      isRead: false,
    },
    conversation: {
      id: 'conversation-internal-1',
      platformConversationId: 'ig-thread-1',
      participantId: 'ig-person-1',
      status: 'active',
    },
    account: {
      id: 'ig-account-1', accountId: 'ig-account-1', profileId: PROFILE_ID,
      platform: 'instagram', username: 'propertypredator',
    },
    timestamp: '2026-09-02T10:00:01.000Z',
  };
}

function commentPayload(platform: 'instagram' | 'linkedin' = 'linkedin'):
Record<string, unknown> {
  return {
    id: `evt-${platform}-comment-001`,
    event: 'comment.received',
    comment: {
      id: `${platform}-comment-1`,
      postId: null,
      platformPostId: `${platform}-post-1`,
      platform,
      text: 'Useful walkthrough — does this work for refurb deals too?',
      author: { id: `${platform}-person-1`, username: 'fixture.person' },
      createdAt: '2026-09-02T10:00:00Z',
      isReply: false,
      parentCommentId: null,
    },
    post: {
      id: null,
      platformPostId: `${platform}-post-1`,
      content: null,
      imageUrl: null,
      permalink: null,
    },
    account: {
      id: `${platform}-account-1`, accountId: `${platform}-account-1`,
      platform, username: 'propertypredator',
    },
    timestamp: '2026-09-02T10:00:01.000Z',
  };
}

test('verifies exact raw bytes and maps an incoming Instagram DM without provider effects', () => {
  const verified = verifyZernioInboundWebhook(
    credential(), signed(messagePayload()), () => VERIFIED_AT,
  );
  assert.equal(verified.network, 'instagram');
  assert.equal(verified.inboundKind, 'instagram_dm');
  assert.equal(verified.bodyText, 'Hi — can I see how the deal analyser works?');
  assert.equal(verified.occurredAt, '2026-09-02T10:00:00.000Z');
  assert.equal(verified.providerEffects, 'none');
  for (const hash of [
    verified.providerProfileIdSha256, verified.credentialVersionSha256,
    verified.credentialBindingSha256, verified.providerAccountIdSha256,
    verified.providerPersonIdSha256, verified.providerThreadIdSha256,
    verified.providerEventIdSha256, verified.bodySha256, verified.payloadSha256,
    verified.signatureSha256, verified.eventIdentitySha256,
  ]) assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.equal(verified.providerOwnershipAssertion, 'not_applicable');
  assert.doesNotMatch(JSON.stringify(credential()), /zernio-test-secret/u);
});

test('maps Instagram and LinkedIn comments with their real network truth', () => {
  for (const network of ['instagram', 'linkedin'] as const) {
    const verified = verifyZernioInboundWebhook(
      credential(), signed(commentPayload(network)), () => VERIFIED_AT,
    );
    assert.equal(verified.network, network);
    assert.equal(verified.inboundKind, 'owned_post_comment');
    assert.equal(verified.providerOwnershipAssertion, 'unknown');
    assert.equal(verified.providerEffects, 'none');
  }

  const explicitExternal = commentPayload('linkedin');
  const explicitExternalComment = explicitExternal.comment as Record<string, unknown>;
  const explicitExternalAuthor = explicitExternalComment.author as Record<string, unknown>;
  explicitExternalAuthor.isOwnAccount = false;
  assert.equal(verifyZernioInboundWebhook(
    credential(), signed(explicitExternal), () => VERIFIED_AT,
  ).providerOwnershipAssertion, 'not_owned');
});

test('preserves signed whitespace, validates attachments and uses provider event id globally', () => {
  const spaced = messagePayload();
  (spaced.message as Record<string, unknown>).text = '  Keep the intentional spacing.  ';
  const spacedVerified = verifyZernioInboundWebhook(
    credential(), signed(spaced), () => VERIFIED_AT,
  );
  assert.equal(spacedVerified.bodyText, '  Keep the intentional spacing.  ');

  const attachmentOnly = messagePayload();
  (attachmentOnly.message as Record<string, unknown>).text = null;
  (attachmentOnly.message as Record<string, unknown>).attachments = [{
    type: 'image', url: 'https://cdn.example.test/evidence.png',
  }];
  assert.equal(verifyZernioInboundWebhook(
    credential(), signed(attachmentOnly), () => VERIFIED_AT,
  ).bodyText, '[Instagram attachment received]');

  const unsafeAttachment = messagePayload();
  (unsafeAttachment.message as Record<string, unknown>).text = null;
  (unsafeAttachment.message as Record<string, unknown>).attachments = [{
    type: 'image', url: 'http://cdn.example.test/evidence.png',
  }];
  assert.throws(
    () => verifyZernioInboundWebhook(
      credential(), signed(unsafeAttachment), () => VERIFIED_AT,
    ),
    (error: unknown) => error instanceof ZernioInboundContractError
      && error.kind === 'payload',
  );

  const crossed = commentPayload('linkedin');
  crossed.id = messagePayload().id;
  const crossedVerified = verifyZernioInboundWebhook(
    credential(), signed(crossed), () => VERIFIED_AT,
  );
  assert.equal(crossedVerified.providerEventIdSha256, spacedVerified.providerEventIdSha256);
  assert.notEqual(crossedVerified.eventIdentitySha256, spacedVerified.eventIdentitySha256);
});

test('inbound config is isolated from outbound Zernio keys and account-lifecycle secrets', () => {
  const config = loadPropertyPredatorZernioInboundConfig({
    PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED: 'true',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_ZERNIO_INBOUND_CONNECTION_ID: CONNECTION_ID,
    PROPERTY_PREDATOR_ZERNIO_INBOUND_PROVIDER_PROFILE_ID: PROFILE_ID,
    ZERNIO_INBOUND_WEBHOOK_CREDENTIAL_VERSION: 'inbound-v1',
    ZERNIO_INBOUND_WEBHOOK_SECRET: SECRET,
    DATABASE_ZERNIO_INBOUND_WEBHOOK_URL: 'postgresql://inbound-only.invalid/db',
  });
  assert.equal(config.configurationReady, true);
  assert.equal(config.providerConnectionId, CONNECTION_ID);
  assert.equal(config.providerProfileId, PROFILE_ID);
  const crossed = loadPropertyPredatorZernioInboundConfig({
    PROPERTY_PREDATOR_ZERNIO_INBOUND_ENABLED: 'true',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE_ID,
    ZERNIO_WEBHOOK_CREDENTIAL_VERSION: 'account-lifecycle-v1',
    ZERNIO_WEBHOOK_SECRET: SECRET,
    ZERNIO_API_KEY: 'must-not-compose-inbound',
    DATABASE_ZERNIO_INBOUND_WEBHOOK_URL: 'postgresql://inbound-only.invalid/db',
  });
  assert.equal(crossed.configurationReady, false);
});

test('HTTP ingress acknowledges only verified bounded evidence and exposes no identities', async () => {
  let recorded = 0;
  const handler = createPropertyPredatorZernioInboundHandler(
    new PropertyPredatorZernioInboundIngress({
      credential: credential(),
      repository: {
        record: async () => {
          recorded += 1;
          return {
            disposition: 'applied' as const,
            transportReceiptId: '20000000-0000-4000-8000-000000000001',
            eventId: '20000000-0000-4000-8000-000000000002',
            quarantineId: null, projectionId: '20000000-0000-4000-8000-000000000003',
            conversationId: '20000000-0000-4000-8000-000000000004',
            inboundMessageId: '20000000-0000-4000-8000-000000000005',
            adminReviewTaskId: '20000000-0000-4000-8000-000000000006',
            outreachAttemptReceiptId: null,
            outreachCandidateDisposition: 'unlinked' as const,
            providerEffects: 'none' as const,
          };
        },
      },
    }),
  );
  const accepted = response();
  await handler(request(signed(messagePayload())), accepted);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(JSON.parse(accepted.body), {
    received: true, disposition: 'applied', provider_effects: false,
  });
  assert.equal(recorded, 1);
  assert.doesNotMatch(accepted.body, /workspace|account|person|conversation|message/u);

  const tampered = signed(messagePayload());
  tampered.signatureHeader = '0'.repeat(64);
  const rejected = response();
  await handler(request(tampered), rejected);
  assert.equal(rejected.statusCode, 401);
  assert.equal(recorded, 1);

  const irrelevantPayload = { ...messagePayload(), event: 'post.published' };
  const ignored = response();
  await handler(request(signed(irrelevantPayload)), ignored);
  assert.equal(ignored.statusCode, 200);
  assert.deepEqual(JSON.parse(ignored.body), {
    received: false, disposition: 'ignored',
  });
  assert.equal(recorded, 1);
});

test('rejects tampering, crossed identities, outgoing messages and own comments', () => {
  const tampered = signed(messagePayload());
  tampered.signatureHeader = '0'.repeat(64);
  assert.throws(
    () => verifyZernioInboundWebhook(credential(), tampered, () => VERIFIED_AT),
    (error: unknown) => error instanceof ZernioInboundContractError
      && error.kind === 'authentication',
  );
  const crossed = signed(messagePayload());
  crossed.eventIdHeader = 'other-event';
  assert.throws(
    () => verifyZernioInboundWebhook(credential(), crossed, () => VERIFIED_AT),
    (error: unknown) => error instanceof ZernioInboundContractError
      && error.kind === 'authentication',
  );
  const outgoing = messagePayload();
  (outgoing.message as Record<string, unknown>).direction = 'outgoing';
  assert.throws(
    () => verifyZernioInboundWebhook(credential(), signed(outgoing), () => VERIFIED_AT),
    (error: unknown) => error instanceof ZernioInboundContractError
      && error.kind === 'not_applicable',
  );
  const malformedOwnership = commentPayload('linkedin');
  const malformedComment = malformedOwnership.comment as Record<string, unknown>;
  const malformedAuthor = malformedComment.author as Record<string, unknown>;
  malformedAuthor.isOwnAccount = 'false';
  assert.throws(
    () => verifyZernioInboundWebhook(
      credential(), signed(malformedOwnership), () => VERIFIED_AT,
    ),
    (error: unknown) => error instanceof ZernioInboundContractError
      && error.kind === 'payload',
  );
  const own = commentPayload('instagram');
  ((own.comment as Record<string, unknown>).author as Record<string, unknown>).isOwnAccount = true;
  assert.throws(
    () => verifyZernioInboundWebhook(credential(), signed(own), () => VERIFIED_AT),
    (error: unknown) => error instanceof ZernioInboundContractError
      && error.kind === 'not_applicable',
  );
});

test('uses one serializable table-blind transaction to resolve and record the receipt', async () => {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (text.includes('resolve_zernio_inbound_account')) {
        return { rows: [{ zernio_account_id: ACCOUNT_ID }] };
      }
      if (text.includes('record_zernio_signed_inbound')) {
        return { rows: [{
          disposition: 'applied',
          transport_receipt_id: '20000000-0000-4000-8000-000000000001',
          event_id: '20000000-0000-4000-8000-000000000002',
          quarantine_id: null,
          projection_id: '20000000-0000-4000-8000-000000000003',
          conversation_id: '20000000-0000-4000-8000-000000000004',
          inbound_message_id: '20000000-0000-4000-8000-000000000005',
          admin_review_task_id: '20000000-0000-4000-8000-000000000006',
          outreach_attempt_receipt_id: null,
          outreach_candidate_disposition: 'unlinked',
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pick<Pool, 'connect'>;
  const repository = new PgZernioInboundRepository(pool);
  const verified = verifyZernioInboundWebhook(
    credential(), signed(messagePayload()), () => VERIFIED_AT,
  );
  const result = await repository.record(verified);
  assert.equal(result.disposition, 'applied');
  assert.equal(result.outreachCandidateDisposition, 'unlinked');
  assert.equal(result.providerEffects, 'none');
  assert.match(queries[0]!.text, /BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE/u);
  assert.ok(queries.some((query) => query.text.includes('set_config')));
  assert.ok(queries.some((query) => query.text.includes('resolve_zernio_inbound_account')));
  assert.ok(queries.some((query) => query.text.includes('record_zernio_signed_inbound')));
  const resolveQuery = queries.find((query) =>
    query.text.includes('resolve_zernio_inbound_account'))!;
  const recordQuery = queries.find((query) =>
    query.text.includes('record_zernio_signed_inbound'))!;
  assert.equal(resolveQuery.values?.length, 7);
  assert.equal(recordQuery.values?.length, 20);
  assert.equal(recordQuery.values?.[17], 'not_applicable');
  assert.equal(queries.at(-1)!.text, 'COMMIT');
});

test('retries retryable failures in bounded fresh serializable transactions', async () => {
  for (const transientError of [
    { code: '40001' },
    { code: '40P01' },
    { code: '23505', constraint: 'conversations_open_contact_inbox_uq' },
    { code: '23505', constraint: 'zernio_inbound_transport_delivery_uq' },
    { code: '23505', constraint: 'zernio_inbound_event_key_uq' },
  ]) {
    let connections = 0;
    let recordCalls = 0;
    const transactionStatements: string[] = [];
    const pool = {
      async connect() {
        connections += 1;
        return {
          async query(sql: string) {
            transactionStatements.push(sql);
            if (sql.includes('resolve_zernio_inbound_account')) {
              return { rows: [{ zernio_account_id: ACCOUNT_ID }] };
            }
            if (sql.includes('record_zernio_signed_inbound')) {
              recordCalls += 1;
              if (recordCalls === 1) throw transientError;
              return { rows: [{
                disposition: 'applied',
                transport_receipt_id: '20000000-0000-4000-8000-000000000001',
                event_id: '20000000-0000-4000-8000-000000000002',
                quarantine_id: null,
                projection_id: '20000000-0000-4000-8000-000000000003',
                conversation_id: '20000000-0000-4000-8000-000000000004',
                inbound_message_id: '20000000-0000-4000-8000-000000000005',
                admin_review_task_id: '20000000-0000-4000-8000-000000000006',
                outreach_attempt_receipt_id: null,
                outreach_candidate_disposition: 'unlinked',
              }] };
            }
            return { rows: [] };
          },
          release() {},
        };
      },
    } as unknown as Pick<Pool, 'connect'>;
    const repository = new PgZernioInboundRepository(pool);
    const result = await repository.record(verifyZernioInboundWebhook(
      credential(), signed(messagePayload()), () => VERIFIED_AT,
    ));
    assert.equal(result.disposition, 'applied');
    assert.equal(connections, 2);
    assert.equal(recordCalls, 2);
    assert.equal(transactionStatements.filter((sql) =>
      sql.startsWith('BEGIN ISOLATION LEVEL SERIALIZABLE')).length, 2);
    assert.equal(transactionStatements.filter((sql) => sql === 'ROLLBACK').length, 1);
    assert.equal(transactionStatements.filter((sql) => sql === 'COMMIT').length, 1);
  }
});

test('bounds retries and does not retry unrelated uniqueness failures', async () => {
  for (const scenario of [
    { failure: { code: '40001' }, expectedAttempts: 3 },
    {
      failure: { code: '23505', constraint: 'unrelated_unique_constraint' },
      expectedAttempts: 1,
    },
  ]) {
    let connections = 0;
    const pool = {
      async connect() {
        connections += 1;
        return {
          async query(sql: string) {
            if (sql.includes('resolve_zernio_inbound_account')) {
              return { rows: [{ zernio_account_id: ACCOUNT_ID }] };
            }
            if (sql.includes('record_zernio_signed_inbound')) throw scenario.failure;
            return { rows: [] };
          },
          release() {},
        };
      },
    } as unknown as Pick<Pool, 'connect'>;
    const repository = new PgZernioInboundRepository(pool);
    await assert.rejects(repository.record(verifyZernioInboundWebhook(
      credential(), signed(messagePayload()), () => VERIFIED_AT,
    )), (error: unknown) => error === scenario.failure);
    assert.equal(connections, scenario.expectedAttempts);
  }
});

test('live readiness continuously proves exact role, function and table blindness', async () => {
  let statement = '';
  await assert.doesNotReject(assertZernioInboundCommandBoundaryReady({
    query: async (sql: string) => {
      statement = sql;
      return { rows: [{
        exactRole: true, exactRoleAttributes: true, schemaUsage: true,
        requiredFunctions: true, exactFunctionsOnly: true, tableBlind: true,
        elevatedRolesDenied: true, parentRolesDenied: true,
        reverseMembersExact: true,
      }] };
    },
  } as never));
  assert.match(statement, /procedure\.oid::regprocedure::text NOT IN/u);
  assert.match(statement, /has_any_column_privilege/u);
  assert.match(statement, /pg_catalog\.pg_auth_members/u);
  assert.match(statement, /r72_zernio_inbound_definer/u);
  await assert.rejects(assertZernioInboundCommandBoundaryReady({
    query: async () => ({ rows: [{
      exactRole: true, exactRoleAttributes: true, schemaUsage: true,
      requiredFunctions: true, exactFunctionsOnly: false, tableBlind: true,
      elevatedRolesDenied: true, parentRolesDenied: true,
      reverseMembersExact: true,
    }] }),
  } as never), /boundary is not exact/u);
});

test('repository rejects contradictory projected and quarantined receipt shapes', async () => {
  for (const row of [
    {
      disposition: 'applied',
      transport_receipt_id: '20000000-0000-4000-8000-000000000001',
      event_id: '20000000-0000-4000-8000-000000000002',
      quarantine_id: null, projection_id: null, conversation_id: null,
      inbound_message_id: null, admin_review_task_id: null,
      outreach_attempt_receipt_id: null,
      outreach_candidate_disposition: 'unlinked',
    },
    {
      disposition: 'quarantined',
      transport_receipt_id: '20000000-0000-4000-8000-000000000001',
      event_id: '20000000-0000-4000-8000-000000000002',
      quarantine_id: null, projection_id: null, conversation_id: null,
      inbound_message_id: null, admin_review_task_id: null,
      outreach_attempt_receipt_id: null,
      outreach_candidate_disposition: null,
    },
  ]) {
    const client = {
      async query(sql: string) {
        if (sql.includes('resolve_zernio_inbound_account')) {
          return { rows: [{ zernio_account_id: ACCOUNT_ID }] };
        }
        if (sql.includes('record_zernio_signed_inbound')) return { rows: [row] };
        return { rows: [] };
      },
      release() {},
    };
    const repository = new PgZernioInboundRepository({
      async connect() { return client; },
    } as never);
    const verified = verifyZernioInboundWebhook(
      credential(), signed(messagePayload()), () => VERIFIED_AT,
    );
    await assert.rejects(repository.record(verified), /receipt shape is invalid/u);
  }
});
