import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { DatabaseRequestContext } from '../src/db/rls.js';
import {
  PgConversionInboxThreadReadService,
} from '../src/portal/conversion-inbox-thread-pg-service.js';
import { CONVERSION_INBOX_MAX_MESSAGE_BYTES } from '../src/portal/conversion-inbox-presenter.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const POINT = '55555555-5555-4555-8555-555555555555';
const INBOUND = '66666666-6666-4666-8666-666666666666';
const DRAFT = '77777777-7777-4777-8777-777777777777';
const APPROVAL = '88888888-8888-4888-8888-888888888888';
const NEWER_DRAFT = '99999999-9999-4999-8999-999999999999';
const DRAFT_POINT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORRELATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INBOUND_RECEIPT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function result<TRow extends QueryResultRow>(rows: TRow[]): QueryResult<TRow> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

const context: DatabaseRequestContext = Object.freeze({
  actorKind: 'user',
  workspaceId: WORKSPACE,
  userId: USER,
  requestId: 'portal-inbox-thread-read-1',
  portalSessionTokenHash: createHash('sha256').update('opaque-session').digest(),
});

function core(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    conversationId: CONVERSATION,
    environment: 'test',
    contactId: CONTACT,
    contactPointId: POINT,
    displayName: 'Aisha Demo',
    companyName: 'Fictional Developments',
    lifecycleStatus: 'lead',
    source: 'affiliate',
    stageName: 'Presentation watched',
    score: '82',
    referralCode: 'PARTNER_17',
    nextMove: 'Qualified appointment',
    draftMessageId: DRAFT,
    draftBody: 'Exact immutable TEST draft.',
    draftLifecycle: 'approval_pending',
    draftVersionNumber: '2',
    draftRowVersion: '3',
    draftUpdatedAt: new Date('2026-08-26T09:05:00.000Z'),
    approvalRequestId: APPROVAL,
    approvalDecision: null,
    approvalNote: 'Check the promise.',
    deliveryStatus: null,
    deliveryPurpose: null,
    consentPurpose: 'property_predator_follow_up',
    railDeliveryStatus: null,
    railOperationState: null,
    railCorrelationId: null,
    railAttemptKind: null,
    railAttemptState: null,
    railOccurredAt: null,
    ...overrides,
  };
}

function transcript(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    sourceKind: 'test_fixture',
    inboundReceiptId: null,
    inboundProviderFamily: null,
    inboundNetwork: null,
    inboundVerifiedAt: null,
    ...overrides,
  };
}

class ThreadReadClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  coreRows: QueryResultRow[] = [core()];
  transcriptRows: QueryResultRow[] = [
    transcript({
      messageId: DRAFT,
      direction: 'outbound',
      lifecycle: 'approval_pending',
      body: 'Exact immutable TEST draft.',
      occurredAt: new Date('2026-08-26T09:04:00.000Z'),
      deliveryStatus: null,
    }),
    transcript({
      messageId: INBOUND,
      direction: 'inbound',
      lifecycle: 'received',
      body: 'Can you show me the comparison?',
      occurredAt: new Date('2026-08-26T09:00:00.000Z'),
      deliveryStatus: null,
    }),
  ];
  consentRows: QueryResultRow[] = [{
    channel: 'email',
    consentState: 'granted',
    lawfulBasis: 'consent',
    purpose: 'property_predator_follow_up',
    consentAt: new Date('2026-08-26T08:50:00.000Z'),
    suppressionState: null,
    suppressionAt: null,
    endpointAvailable: true,
  }];

  async query<TRow extends QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<TRow>> {
    this.calls.push({ sql, values });
    if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK'
        || sql.includes("set_config('app.user_id'")) return result([]);
    if (sql.includes('database.lock-portal-session')) return result([
      { active: true },
    ] as unknown as TRow[]);
    if (sql.includes('portal.conversion-inbox.thread-core')) {
      return result(this.coreRows as TRow[]);
    }
    if (sql.includes('portal.conversion-inbox.thread-transcript')) {
      return result(this.transcriptRows as TRow[]);
    }
    if (sql.includes('portal.conversion-inbox.thread-consent')) {
      return result(this.consentRows as TRow[]);
    }
    throw new Error(`Unexpected thread read SQL: ${sql}`);
  }

  release(): void {}
}

test('PostgreSQL thread projection is session-guarded, bounded and maps exact TEST state', async () => {
  const client = new ThreadReadClient();
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const snapshot = await service.thread(context, CONVERSATION);

  assert.ok(snapshot);
  assert.equal(snapshot.conversationId, CONVERSATION);
  assert.equal(snapshot.contactPointId, POINT);
  assert.deepEqual(snapshot.messages.map((message) => message.messageId), [INBOUND, DRAFT]);
  assert.equal(snapshot.messages[0]!.authorLabel, 'Aisha Demo');
  assert.equal(snapshot.messages[1]!.authorLabel, 'Growth team');
  assert.deepEqual(snapshot.lead, {
    contactId: CONTACT,
    displayName: 'Aisha Demo',
    companyName: 'Fictional Developments',
    stageLabel: 'Presentation watched',
    score: 82,
    sourceLabel: 'affiliate',
    affiliateLabel: 'Referral PARTNER_17',
    nextMove: 'Advance to Qualified appointment',
  });
  assert.deepEqual(snapshot.consents, [{
    channel: 'email',
    state: 'permitted',
    basis: 'consent · property_predator_follow_up',
    updatedAt: '2026-08-26T08:50:00.000Z',
  }]);
  assert.deepEqual(snapshot.draft, {
    messageId: DRAFT,
    body: 'Exact immutable TEST draft.',
    lifecycle: 'approval_pending',
    versionNumber: 2,
    approvalState: 'pending',
    approvalNote: 'Check the promise.',
    deliveryState: 'not_queued',
    updatedAt: '2026-08-26T09:05:00.000Z',
    rowVersion: 3,
    approvalRequestId: APPROVAL,
    purpose: 'property_predator_follow_up',
  });
  assert.equal(snapshot.railActivity, null);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.messages));
  assert.equal(JSON.stringify(snapshot).includes('@'), false);
  assert.equal(JSON.stringify(snapshot).includes('normalized'), false);

  const guardIndex = client.calls.findIndex((call) => call.sql.includes('database.lock-portal-session'));
  const contextIndex = client.calls.findIndex((call) => call.sql.includes("set_config('app.user_id'"));
  const coreIndex = client.calls.findIndex((call) => call.sql.includes('thread-core'));
  assert.ok(guardIndex > 0 && contextIndex > guardIndex && coreIndex > contextIndex);
  assert.deepEqual(client.calls[coreIndex]!.values, [CONVERSATION]);
  const transcript = client.calls.find((call) => call.sql.includes('thread-transcript'))!;
  assert.deepEqual(transcript.values, [CONVERSATION, 81]);
  const consent = client.calls.find((call) => call.sql.includes('thread-consent'))!;
  assert.deepEqual(consent.values, [CONVERSATION, POINT, 8]);
});

test('thread projection exposes only authoritative message-linked simulator provenance', async () => {
  const client = new ThreadReadClient();
  client.transcriptRows[1] = transcript({
    ...client.transcriptRows[1],
    sourceKind: 'verified_webhook',
    inboundReceiptId: INBOUND_RECEIPT,
    inboundProviderFamily: 'whatsapp',
    inboundNetwork: 'whatsapp',
    inboundVerifiedAt: new Date('2026-08-26T09:00:01.000Z'),
  });
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const snapshot = await service.thread(context, CONVERSATION);
  assert.deepEqual(snapshot?.messages[0]?.inboundEvidence, {
    kind: 'signed_simulator_event',
    source: 'whatsapp_simulator',
    network: 'whatsapp',
    receiptId: INBOUND_RECEIPT,
    verifiedAt: '2026-08-26T09:00:01.000Z',
  });
  const sql = client.calls.find((call) => call.sql.includes('thread-transcript'))!.sql;
  assert.match(sql, /app_private\.test_inbox_webhook_message_provenance\(/);
  assert.match(sql, /message\.source_kind = 'verified_webhook'/);
  assert.doesNotMatch(sql, /external_event_id|signature_sha256|source_identity_sha256|destination_identity_sha256/);

  client.transcriptRows[1] = transcript({
    ...client.transcriptRows[1],
    inboundProviderFamily: null,
  });
  await assert.rejects(
    service.thread(context, CONVERSATION),
    /signed inbound provenance is inconsistent/,
  );

  client.transcriptRows[1] = transcript({
    ...client.transcriptRows[1],
    inboundProviderFamily: 'social_dm',
  });
  await assert.rejects(
    service.thread(context, CONVERSATION),
    /signed inbound provider is inconsistent/,
  );
});

test('thread projection admits only receipt-gated LIVE owned-office Mailgun provenance', async () => {
  const client = new ThreadReadClient();
  client.coreRows = [core({
    environment: 'live',
    draftMessageId: null,
    draftBody: null,
    draftLifecycle: null,
    draftVersionNumber: null,
    draftRowVersion: null,
    draftUpdatedAt: null,
    approvalRequestId: null,
    approvalDecision: null,
    approvalNote: null,
    deliveryStatus: null,
    deliveryPurpose: null,
    consentPurpose: null,
  })];
  client.transcriptRows = [transcript({
    messageId: INBOUND,
    direction: 'inbound',
    lifecycle: 'received',
    sourceKind: 'verified_webhook',
    body: 'Owned office reply.',
    occurredAt: new Date('2026-08-26T09:00:00.000Z'),
    deliveryStatus: null,
    inboundReceiptId: INBOUND_RECEIPT,
    inboundProviderFamily: 'mailgun_email',
    inboundNetwork: 'email',
    inboundVerifiedAt: new Date('2026-08-26T09:00:01.000Z'),
  })];
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const snapshot = await service.thread(context, CONVERSATION);
  assert.equal(snapshot?.environment, 'live');
  assert.deepEqual(snapshot?.messages[0]?.inboundEvidence, {
    kind: 'signed_mailgun_inbound',
    source: 'mailgun_eu',
    network: 'email',
    receiptId: INBOUND_RECEIPT,
    verifiedAt: '2026-08-26T09:00:01.000Z',
  });
  const sql = client.calls.map((call) => call.sql).join('\n');
  assert.match(sql, /conversation\.environment = 'live'/);
  // Provenance is still receipt-gated, now through the bounded definer function
  // keyed on the exact inbound message rather than a direct table read.
  assert.match(
    sql,
    /app_private\.operational_inbox_live_message_provenance\(\s*message\.workspace_id, message\.conversation_id, message\.id/,
  );
  assert.doesNotMatch(sql, /property_predator_mailgun_inbound_receipts/);
});

test('thread projection admits only receipt-gated LIVE Twilio SMS provenance', async () => {
  const client = new ThreadReadClient();
  client.coreRows = [core({
    environment: 'live',
    draftMessageId: null,
    draftBody: null,
    draftLifecycle: null,
    draftVersionNumber: null,
    draftRowVersion: null,
    draftUpdatedAt: null,
    approvalRequestId: null,
    approvalDecision: null,
    approvalNote: null,
    deliveryStatus: null,
    deliveryPurpose: null,
    consentPurpose: null,
  })];
  client.transcriptRows = [transcript({
    messageId: INBOUND,
    direction: 'inbound',
    lifecycle: 'received',
    sourceKind: 'verified_webhook',
    body: 'STOP',
    occurredAt: new Date('2026-08-26T09:00:00.000Z'),
    deliveryStatus: null,
    inboundReceiptId: INBOUND_RECEIPT,
    inboundProviderFamily: 'twilio_sms_live',
    inboundNetwork: 'sms',
    inboundVerifiedAt: new Date('2026-08-26T09:00:01.000Z'),
  })];
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const snapshot = await service.thread(context, CONVERSATION);
  assert.equal(snapshot?.environment, 'live');
  assert.deepEqual(snapshot?.messages[0]?.inboundEvidence, {
    kind: 'signed_twilio_sms_inbound',
    source: 'twilio_sms',
    network: 'sms',
    receiptId: INBOUND_RECEIPT,
    verifiedAt: '2026-08-26T09:00:01.000Z',
  });
  const sql = client.calls.map((call) => call.sql).join('\n');
  // The SMS rail keeps both gates: provenance is keyed on the exact inbound
  // message, and rail activity pins the exact provider operation. Both now go
  // through the bounded definer functions, so r72_web names no evidence table.
  assert.match(
    sql,
    /app_private\.operational_inbox_live_message_provenance\(\s*message\.workspace_id, message\.conversation_id, message\.id/,
  );
  assert.match(
    sql,
    /app_private\.operational_inbox_live_delivery_linked\(\s*delivery\.workspace_id, delivery\.id, operation\.id, conversation\.channel/,
  );
  assert.doesNotMatch(sql, /property_predator_sms_inbox_projections|property_predator_sms_jobs/);
  assert.doesNotMatch(sql, /signature_sha256|sender_identity_sha256|recipient_identity_sha256/);
});

test('thread projection reduces durable TEST operations to queued, accepted, reconciled or attention', async () => {
  const cases = [
    {
      expected: 'queued',
      row: { railDeliveryStatus: 'queued', railOperationState: 'queued',
        railAttemptKind: null, railAttemptState: null },
    },
    {
      expected: 'queued',
      row: { railDeliveryStatus: 'queued', railOperationState: 'retry_wait',
        railAttemptKind: 'dispatch', railAttemptState: 'failed' },
    },
    {
      expected: 'accepted',
      row: { railDeliveryStatus: 'accepted', railOperationState: 'succeeded',
        railAttemptKind: 'dispatch', railAttemptState: 'succeeded' },
    },
    {
      expected: 'reconciled',
      row: { railDeliveryStatus: 'accepted', railOperationState: 'succeeded',
        railAttemptKind: 'reconcile', railAttemptState: 'succeeded' },
    },
    {
      expected: 'attention',
      row: { railDeliveryStatus: 'reconciliation_required',
        railOperationState: 'reconciliation_required', railAttemptKind: 'dispatch',
        railAttemptState: 'needs_attention' },
    },
  ] as const;

  for (const item of cases) {
    const client = new ThreadReadClient();
    client.coreRows = [core({
      ...item.row,
      railCorrelationId: CORRELATION,
      railOccurredAt: new Date('2026-08-26T09:06:00.000Z'),
    })];
    const service = new PgConversionInboxThreadReadService({
      connect: async () => client,
    } as unknown as Pick<Pool, 'connect'>);

    const snapshot = await service.thread(context, CONVERSATION);

    assert.deepEqual(snapshot?.railActivity, {
      state: item.expected,
      correlationId: CORRELATION,
      occurredAt: '2026-08-26T09:06:00.000Z',
    });
    const sql = client.calls.find((call) => call.sql.includes('thread-core'))!.sql;
    assert.match(sql, /operation\.correlation_id/);
    assert.match(sql, /latest_attempt\.attempt_kind/);
    assert.match(sql, /JOIN app\.provider_connections AS rail_connection/);
    assert.match(sql, /rail_connection\.provider_id = 'test_conversation'/);
    assert.match(sql, /delivery\.environment = conversation\.environment/);
    assert.doesNotMatch(sql, /operation\.provider_reference|operation\.last_summary|operation\.last_error_code/);
  }
});

test('thread projection accepts live channel-specific receipt evidence without a TEST attempt row', async () => {
  const cases = [
    { delivery: 'accepted', operation: 'accepted', expected: 'accepted' },
    { delivery: 'delivered', operation: 'succeeded', expected: 'reconciled' },
    { delivery: 'read', operation: 'succeeded', expected: 'reconciled' },
  ] as const;

  for (const item of cases) {
    const client = new ThreadReadClient();
    client.coreRows = [core({
      environment: 'live',
      railDeliveryStatus: item.delivery,
      railOperationState: item.operation,
      railCorrelationId: CORRELATION,
      railAttemptKind: null,
      railAttemptState: null,
      railOccurredAt: new Date('2026-08-31T11:37:51.000Z'),
    })];
    const service = new PgConversionInboxThreadReadService({
      connect: async () => client,
    } as unknown as Pick<Pool, 'connect'>);

    assert.deepEqual((await service.thread(context, CONVERSATION))?.railActivity, {
      state: item.expected,
      correlationId: CORRELATION,
      occurredAt: '2026-08-31T11:37:51.000Z',
    });
  }
});

test('thread projection rejects partial or contradictory TEST rail evidence', async () => {
  const client = new ThreadReadClient();
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  client.coreRows = [core({
    railDeliveryStatus: 'accepted', railOperationState: 'succeeded',
    railCorrelationId: null, railAttemptKind: 'dispatch', railAttemptState: 'succeeded',
    railOccurredAt: new Date('2026-08-26T09:06:00.000Z'),
  })];
  await assert.rejects(service.thread(context, CONVERSATION), /rail activity is invalid/i);

  client.coreRows = [core({
    railDeliveryStatus: 'queued', railOperationState: 'succeeded',
    railCorrelationId: CORRELATION, railAttemptKind: 'dispatch', railAttemptState: 'succeeded',
    railOccurredAt: new Date('2026-08-26T09:06:00.000Z'),
  })];
  await assert.rejects(service.thread(context, CONVERSATION), /rail activity is inconsistent/i);
});

test('thread projection uses only the exact endpoint current consent and suppression evidence', async () => {
  const client = new ThreadReadClient();
  client.consentRows = [{
    channel: 'email', consentState: 'granted', lawfulBasis: 'consent',
    purpose: 'marketing', consentAt: new Date('2026-08-26T08:50:00.000Z'),
    suppressionState: 'suppressed', suppressionAt: new Date('2026-08-26T09:10:00.000Z'),
    endpointAvailable: true,
  }];
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const suppressed = await service.thread(context, CONVERSATION);
  assert.equal(suppressed?.consents[0]?.state, 'suppressed');
  assert.equal(suppressed?.consents[0]?.updatedAt, '2026-08-26T09:10:00.000Z');

  client.consentRows = [{
    ...client.consentRows[0], suppressionState: null, suppressionAt: null,
    endpointAvailable: false,
  }];
  const unavailable = await service.thread(context, CONVERSATION);
  assert.equal(unavailable?.consents[0]?.state, 'unknown');
});

test('thread projection prioritises the exact pending or rework target over a newer ordinary draft', async () => {
  const client = new ThreadReadClient();
  client.coreRows = [core({
    draftMessageId: DRAFT,
    draftBody: 'Older exact copy returned for rework.',
    draftLifecycle: 'draft',
    approvalDecision: 'changes_requested',
    approvalNote: 'Fix the evidence before approval.',
  })];
  client.transcriptRows = [transcript({
    messageId: NEWER_DRAFT,
    direction: 'outbound',
    lifecycle: 'draft',
    body: 'Newer unrelated ordinary draft.',
    occurredAt: new Date('2026-08-26T09:10:00.000Z'),
    deliveryStatus: null,
  }), transcript({
    messageId: DRAFT,
    direction: 'outbound',
    lifecycle: 'draft',
    body: 'Older exact copy returned for rework.',
    occurredAt: new Date('2026-08-26T09:04:00.000Z'),
    deliveryStatus: null,
  })];
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const snapshot = await service.thread(context, CONVERSATION);

  assert.equal(snapshot?.draft.messageId, DRAFT);
  assert.equal(snapshot?.draft.approvalState, 'changes_requested');
  assert.deepEqual(snapshot?.messages.map((message) => message.messageId), [DRAFT, NEWER_DRAFT]);
  const coreSql = client.calls.find((call) => call.sql.includes('thread-core'))!.sql;
  assert.match(coreSql, /ORDER BY EXISTS \(/);
  assert.match(coreSql, /target_request\.message_id = message\.id/);
  assert.match(coreSql,
    /ORDER BY target_request\.request_number DESC, target_request\.id DESC\s+LIMIT 1/);
  assert.match(coreSql, /message\.lifecycle = 'approval_pending' AND latest_target\.decision_id IS NULL/);
  assert.match(coreSql, /message\.lifecycle = 'draft'[\s\S]*latest_target\.decision = 'changes_requested'/);
  assert.match(coreSql, /\) DESC,\s*message\.occurred_at DESC, message\.id DESC/);
});

test('thread projection binds the displayed consent endpoint to the selected draft endpoint', async () => {
  const client = new ThreadReadClient();
  client.coreRows = [core({ contactPointId: DRAFT_POINT })];
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const snapshot = await service.thread(context, CONVERSATION);

  assert.equal(snapshot?.contactPointId, DRAFT_POINT);
  const coreSql = client.calls.find((call) => call.sql.includes('thread-core'))!.sql;
  assert.match(coreSql, /draft\.id IS NOT NULL AND point\.id = draft\.contact_point_id/);
  assert.match(coreSql, /draft\.id IS NULL[\s\S]*point\.deleted_at IS NULL/);
  const consent = client.calls.find((call) => call.sql.includes('thread-consent'))!;
  assert.deepEqual(consent.values, [CONVERSATION, DRAFT_POINT, 8]);
});

test('thread projection preserves the complete database body for presenter-owned review truncation', async () => {
  const client = new ThreadReadClient();
  const hiddenTail = 'TAIL-MUST-BE-REVIEWED';
  const databaseBody = `${'x'.repeat(65_536 - hiddenTail.length)}${hiddenTail}`;
  assert.equal(Buffer.byteLength(databaseBody, 'utf8'), 65_536);
  assert.ok(Buffer.byteLength(databaseBody, 'utf8') > CONVERSION_INBOX_MAX_MESSAGE_BYTES);
  client.coreRows = [core({ draftBody: databaseBody })];
  client.transcriptRows = [{
    ...client.transcriptRows[0],
    body: databaseBody,
  }];
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  const snapshot = await service.thread(context, CONVERSATION);

  assert.equal(snapshot?.draft.body, databaseBody);
  assert.equal(snapshot?.draft.body.endsWith(hiddenTail), true);
  assert.equal(snapshot?.messages[0]?.body, databaseBody);
  assert.equal(snapshot?.messages[0]?.body.endsWith(hiddenTail), true);
});

test('thread projection fails closed instead of clipping oversized or malformed database bodies', async () => {
  const client = new ThreadReadClient();
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  client.coreRows = [core({ draftBody: 'x'.repeat(65_537) })];
  await assert.rejects(service.thread(context, CONVERSATION), /draftBody is invalid/);

  client.coreRows = [core({ draftBody: 'valid draft' })];
  client.transcriptRows = [{
    ...client.transcriptRows[0],
    body: '',
  }];
  await assert.rejects(service.thread(context, CONVERSATION), /messageBody is invalid/);
});

test('thread projection returns null without inventing detail and fails closed on malformed rows', async () => {
  const client = new ThreadReadClient();
  const service = new PgConversionInboxThreadReadService({
    connect: async () => client,
  } as unknown as Pick<Pool, 'connect'>);

  client.coreRows = [];
  assert.equal(await service.thread(context, CONVERSATION), null);
  assert.equal(client.calls.some((call) => call.sql.includes('thread-transcript')), false);

  client.calls.length = 0;
  client.coreRows = [core({ draftVersionNumber: '9007199254740992' })];
  await assert.rejects(
    service.thread(context, CONVERSATION),
    /draftVersionNumber is invalid/,
  );
  await assert.rejects(
    service.thread(context, 'not-a-conversation'),
    /conversationId is invalid/,
  );
});
