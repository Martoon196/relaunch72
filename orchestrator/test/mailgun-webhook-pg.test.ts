import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import {
  MAILGUN_WEBHOOK_EVENT_TYPES,
  MAILGUN_WEBHOOK_MAX_BODY_BYTES,
  MailgunWebhookAuthenticationError,
  MailgunWebhookBodyTooLargeError,
  MailgunWebhookEventConflictError,
  MailgunWebhookIngressService,
  MailgunWebhookReplayError,
  MailgunWebhookUnmatchedDeliveryError,
  PgMailgunWebhookRepository,
  type MailgunFailureSeverity,
  type MailgunWebhookEventType,
  type MailgunWebhookRecordInput,
  type MailgunWebhookRepository,
} from '../src/mailgun-webhook-pg/index.js';

const NOW = 1_787_652_000;
const SIGNING_KEY = Buffer.from('mailgun-signing-key-32-byte-minimum-value', 'utf8');
const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = 'token-exactly-as-delivered';
const MESSAGE_ID = 'pilot-message-1@mg.propertypredator.co.uk';
const RECIPIENT = 'Seed.One@PropertyPredator.co.uk';

function signature(timestamp: string, token = TOKEN): string {
  return createHmac('sha256', SIGNING_KEY).update(timestamp + token, 'ascii').digest('hex');
}

function rawEvent(
  type: MailgunWebhookEventType = 'accepted',
  options: Readonly<{
    timestamp?: string;
    token?: string;
    signature?: string;
    recipient?: string;
    eventId?: string;
    messageId?: string;
    severity?: MailgunFailureSeverity;
  }> = {},
): Buffer {
  const timestamp = options.timestamp ?? String(NOW);
  const token = options.token ?? TOKEN;
  const eventData: Record<string, unknown> = {
    id: options.eventId ?? `evt_${type.replaceAll('ed', '')}_1`,
    event: type,
    timestamp: NOW + 0.125,
    recipient: options.recipient ?? RECIPIENT,
    message: { headers: { 'message-id': options.messageId ?? MESSAGE_ID } },
  };
  if (type === 'failed') eventData.severity = options.severity ?? 'permanent';
  return Buffer.from(JSON.stringify({
    signature: {
      timestamp,
      token,
      signature: options.signature ?? signature(timestamp, token),
    },
    'event-data': eventData,
  }));
}

function memoryRepository(
  result: Awaited<ReturnType<MailgunWebhookRepository['record']>> = {
    replayed: false,
    effectiveDeliveryStatus: 'accepted',
    suppressionRecorded: false,
    optOutRecorded: false,
  },
): { repository: MailgunWebhookRepository; records: MailgunWebhookRecordInput[] } {
  const records: MailgunWebhookRecordInput[] = [];
  return {
    records,
    repository: {
      record: async (input) => {
        records.push(input);
        return result;
      },
    },
  };
}

test('valid Mailgun evidence is authenticated before one bounded repository write', async () => {
  const memory = memoryRepository();
  const service = new MailgunWebhookIngressService({
    repository: memory.repository,
    signingKey: SIGNING_KEY,
    nowSeconds: () => NOW,
  });
  const body = rawEvent('accepted');
  const result = await service.handle(body);

  assert.deepEqual(result, {
    disposition: 'recorded',
    replayed: false,
    eventType: 'accepted',
    effectiveDeliveryStatus: 'accepted',
    suppressionRecorded: false,
    optOutRecorded: false,
  });
  assert.ok(Object.isFrozen(result));
  assert.equal(memory.records.length, 1);
  const record = memory.records[0]!;
  assert.equal(record.providerMessageId, MESSAGE_ID);
  assert.equal(record.eventType, 'accepted');
  assert.equal(record.failureSeverity, null);
  assert.deepEqual(Buffer.from(record.payloadSha256), createHash('sha256').update(body).digest());
  assert.deepEqual(
    Buffer.from(record.signatureTokenSha256),
    createHash('sha256').update(TOKEN).digest(),
  );
  assert.deepEqual(
    Buffer.from(record.recipientIdentitySha256),
    createHash('sha256').update(RECIPIENT.toLowerCase()).digest(),
  );
  const publicResult = JSON.stringify(result);
  assert.equal(publicResult.includes(RECIPIENT), false);
  assert.equal(publicResult.includes(TOKEN), false);
  assert.equal(publicResult.includes(SIGNING_KEY.toString('utf8')), false);
  assert.equal(publicResult.includes(record.payloadSha256.toString()), false);
});

test('Mailgun API and event Message-Id wrapper variants normalize to one identity', async () => {
  for (const messageId of [MESSAGE_ID, `<${MESSAGE_ID}>`]) {
    const memory = memoryRepository();
    const service = new MailgunWebhookIngressService({
      repository: memory.repository,
      signingKey: SIGNING_KEY,
      nowSeconds: () => NOW,
    });
    await service.handle(rawEvent('delivered', { messageId }));
    assert.equal(memory.records[0]?.providerMessageId, MESSAGE_ID);
  }
});

test('event fields are not normalized or persisted before signature authentication', async () => {
  const memory = memoryRepository();
  const service = new MailgunWebhookIngressService({
    repository: memory.repository,
    signingKey: SIGNING_KEY,
    nowSeconds: () => NOW,
  });
  const body = JSON.parse(rawEvent('accepted').toString('utf8')) as {
    signature: { signature: string };
    'event-data': Record<string, unknown>;
  };
  body.signature.signature = '0'.repeat(64);
  body['event-data'].recipient = { deliberately: 'malformed' };
  await assert.rejects(
    () => service.handle(Buffer.from(JSON.stringify(body))),
    MailgunWebhookAuthenticationError,
  );
  assert.equal(memory.records.length, 0);
});

test('the exact untrimmed timestamp and token fields are authenticated', async () => {
  const memory = memoryRepository();
  const service = new MailgunWebhookIngressService({
    repository: memory.repository, signingKey: SIGNING_KEY, nowSeconds: () => NOW,
  });
  await assert.rejects(
    () => service.handle(rawEvent('accepted', {
      token: ` ${TOKEN}`,
      signature: signature(String(NOW), TOKEN),
    })),
    MailgunWebhookAuthenticationError,
  );
  await assert.rejects(
    () => service.handle(rawEvent('accepted', {
      timestamp: `${String(NOW)} `,
      signature: signature(String(NOW), TOKEN),
    })),
    MailgunWebhookAuthenticationError,
  );
  await assert.rejects(
    () => service.handle(rawEvent('accepted', { signature: '0'.repeat(64) })),
    MailgunWebhookAuthenticationError,
  );
  assert.equal(memory.records.length, 0);
});

test('clock skew accepts the exact five-minute boundary and rejects stale or future replay', async () => {
  for (const offset of [-300, 300]) {
    const memory = memoryRepository();
    const service = new MailgunWebhookIngressService({
      repository: memory.repository, signingKey: SIGNING_KEY, nowSeconds: () => NOW,
    });
    const timestamp = String(NOW + offset);
    await assert.doesNotReject(service.handle(rawEvent('accepted', { timestamp })));
    assert.equal(memory.records.length, 1);
  }
  for (const offset of [-301, 301]) {
    const memory = memoryRepository();
    const service = new MailgunWebhookIngressService({
      repository: memory.repository, signingKey: SIGNING_KEY, nowSeconds: () => NOW,
    });
    const timestamp = String(NOW + offset);
    await assert.rejects(
      () => service.handle(rawEvent('accepted', { timestamp })),
      MailgunWebhookAuthenticationError,
    );
    assert.equal(memory.records.length, 0);
  }
});

test('oversized and malformed payloads fail without touching persistence', async () => {
  const memory = memoryRepository();
  const service = new MailgunWebhookIngressService({
    repository: memory.repository, signingKey: SIGNING_KEY, nowSeconds: () => NOW,
  });
  await assert.rejects(
    () => service.handle(Buffer.alloc(MAILGUN_WEBHOOK_MAX_BODY_BYTES + 1, 0x20)),
    MailgunWebhookBodyTooLargeError,
  );
  await assert.rejects(() => service.handle(Buffer.from('{')), /valid UTF-8 JSON/);
  await assert.rejects(
    () => service.handle(Buffer.from(JSON.stringify({
      signature: { timestamp: String(NOW), token: TOKEN, signature: signature(String(NOW)) },
      'event-data': {},
      workspaceId: WORKSPACE_ID,
    }))),
    /unsupported field/,
  );
  assert.equal(memory.records.length, 0);
});

test('all supported delivery and feedback events remain distinct evidence', async () => {
  for (const type of MAILGUN_WEBHOOK_EVENT_TYPES) {
    const expected = {
      replayed: false,
      effectiveDeliveryStatus: type === 'accepted' ? 'accepted'
        : type === 'delivered' ? 'delivered'
          : type === 'opened' ? 'read'
            : type === 'failed' ? 'failed' : null,
      suppressionRecorded: ['failed', 'complained', 'unsubscribed'].includes(type),
      optOutRecorded: type === 'unsubscribed',
    } as const;
    const memory = memoryRepository(expected);
    const service = new MailgunWebhookIngressService({
      repository: memory.repository, signingKey: SIGNING_KEY, nowSeconds: () => NOW,
    });
    const result = await service.handle(rawEvent(type));
    assert.equal(result.eventType, type);
    assert.equal(memory.records[0]?.eventType, type);
    assert.equal(
      memory.records[0]?.failureSeverity,
      type === 'failed' ? 'permanent' : null,
    );
  }
});

type QueryCall = Readonly<{ sql: string; values: readonly unknown[] }>;

function pgPool(
  domain: (sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>,
): { pool: Pick<Pool, 'connect'>; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (/^(?:BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
      if (sql.includes("set_config('app.user_id'")) return { rows: [{}] };
      return domain(sql, values);
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { pool: { connect: async () => client } as Pick<Pool, 'connect'>, calls };
}

function recordInput(): MailgunWebhookRecordInput {
  return {
    externalEventId: 'evt_accepted_1',
    eventType: 'accepted',
    occurredAt: '2026-08-26T12:00:00.000Z',
    providerMessageId: MESSAGE_ID,
    failureSeverity: null,
    payloadSha256: Buffer.alloc(32, 1),
    eventIdentitySha256: Buffer.alloc(32, 2),
    signatureTokenSha256: Buffer.alloc(32, 3),
    signatureTimestamp: '2026-08-26T12:00:01.000Z',
    recipientIdentitySha256: Buffer.alloc(32, 4),
  };
}

test('the PG repository derives safe request context and passes no raw address or token', async () => {
  const mocked = pgPool(async () => ({ rows: [{
    replayed: false,
    delivery_status: 'accepted',
    suppression_recorded: false,
    opt_out_recorded: false,
  }] }));
  const repository = new PgMailgunWebhookRepository({
    commandPool: mocked.pool, workspaceId: WORKSPACE_ID,
    providerConnectionId: CONNECTION_ID,
  });
  assert.deepEqual(await repository.record(recordInput()), {
    replayed: false,
    effectiveDeliveryStatus: 'accepted',
    suppressionRecorded: false,
    optOutRecorded: false,
  });
  const context = mocked.calls.find((call) => call.sql.includes("set_config('app.user_id'"));
  assert.equal(context?.values[0], '');
  assert.equal(context?.values[1], WORKSPACE_ID);
  assert.equal(context?.values[2], 'webhook');
  assert.match(String(context?.values[3]), /^mailgun:[0-9a-f]{48}$/);
  const domain = mocked.calls.find((call) => call.sql.includes('record_mailgun_webhook_event'))!;
  assert.equal(domain.values[0], WORKSPACE_ID);
  assert.equal(domain.values[1], CONNECTION_ID);
  assert.equal(domain.values[5], MESSAGE_ID);
  assert.equal(domain.values.includes(RECIPIENT), false);
  assert.equal(domain.values.includes(TOKEN), false);
  assert.equal(domain.values.includes(SIGNING_KEY), false);
});

test('database conflicts become stable safe errors', async () => {
  const cases = [
    ['22000', 'mailgun event identity conflict', MailgunWebhookEventConflictError],
    ['22000', 'mailgun signature token replay conflict', MailgunWebhookReplayError],
    ['23503', 'mailgun event does not match an outbound delivery', MailgunWebhookUnmatchedDeliveryError],
  ] as const;
  for (const [code, message, ErrorType] of cases) {
    const mocked = pgPool(async () => {
      throw Object.assign(new Error(message), { code });
    });
    const repository = new PgMailgunWebhookRepository({
      commandPool: mocked.pool, workspaceId: WORKSPACE_ID,
      providerConnectionId: CONNECTION_ID,
    });
    await assert.rejects(() => repository.record(recordInput()), ErrorType);
    assert.equal(mocked.calls.at(-1)?.sql, 'ROLLBACK');
  }
});
