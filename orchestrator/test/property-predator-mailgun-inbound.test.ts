import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createPropertyPredatorMailgunInboundHandler,
  loadPropertyPredatorMailgunInboundConfig,
} from '../src/integrations/mailgun-inbound/router.js';
import { assertPgPropertyPredatorMailgunInboundReady } from '../src/integrations/mailgun-inbound/readiness.js';
import { MailgunWebhookAuthenticationError } from '../src/mailgun-webhook-pg/types.js';
import {
  PropertyPredatorMailgunInboundConflictError,
  PropertyPredatorMailgunInboundContractError,
  PropertyPredatorMailgunInboundIngressService,
  PropertyPredatorMailgunInboundUnmatchedError,
  type PropertyPredatorMailgunInboundRecordInput,
} from '../src/property-predator-mailgun-inbound-pg/index.js';
import { propertyPredatorMailgunReplyAddress } from '../src/providers/property-predator-mailgun-reply-correlation.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INSTALLATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SIGNING_KEY = Buffer.from('s'.repeat(32), 'utf8');
const NOW_SECONDS = 1_800_000_000;
const CORRELATION = '0123456789abcdef'.repeat(4);

function signedForm(overrides: Readonly<Record<string, string>> = {}): Buffer {
  const timestamp = overrides.timestamp ?? String(NOW_SECONDS);
  const token = overrides.token ?? 'owned-office-route-token';
  const signature = overrides.signature ?? createHmac('sha256', SIGNING_KEY)
    .update(timestamp, 'ascii').update(token, 'ascii').digest('hex');
  const fields = new URLSearchParams({
    timestamp,
    token,
    signature,
    sender: 'office@propertypredator.com',
    recipient: propertyPredatorMailgunReplyAddress(CORRELATION, 'mg.propertypredator.com'),
    subject: 'Re: Property Predator owned-office proof',
    'stripped-text': 'Yes, this verified reply reached the owned office.',
    'body-plain': 'quoted fallback must not win',
    'message-headers': JSON.stringify([
      ['From', 'office@propertypredator.com'],
      ['Message-Id', '<owned-office-reply-001@example.test>'],
    ]),
    'attachment-count': '0',
    ...overrides,
  });
  return Buffer.from(fields.toString(), 'utf8');
}

function request(body: Uint8Array, type = 'application/x-www-form-urlencoded'): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  return Object.assign(stream, {
    method: 'POST',
    url: '/api/provider-webhooks/mailgun/inbound/owned-seed',
    headers: { 'content-type': type, 'content-length': String(body.byteLength) },
  });
}

function response(): ServerResponse & { statusCode: number; body: string; headers: Record<string, string> } {
  const state = {
    statusCode: 0, body: '', headers: {} as Record<string, string>,
    writeHead(code: number, headers: Record<string, string> = {}) {
      state.statusCode = code;
      Object.assign(state.headers, headers);
      return state;
    },
    end(body = '') { state.body = body; return state; },
  };
  return state as unknown as ServerResponse & {
    statusCode: number; body: string; headers: Record<string, string>;
  };
}

test('signed owned-office Mailgun reply authenticates before parsing and retains bounded evidence', async () => {
  let recorded: PropertyPredatorMailgunInboundRecordInput | undefined;
  const service = new PropertyPredatorMailgunInboundIngressService({
    signingKey: SIGNING_KEY,
    nowSeconds: () => NOW_SECONDS,
    repository: {
      record: async (input) => {
        recorded = input;
        return {
          replayed: false,
          conversationId: WORKSPACE_ID,
          messageId: CONNECTION_ID,
          messageVersionId: INSTALLATION_ID,
          adminCallTaskId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        };
      },
    },
  });
  const result = await service.handle(signedForm());
  assert.equal(result.disposition, 'recorded');
  assert.equal(recorded?.correlationSha256, CORRELATION);
  assert.equal(recorded?.providerMessageId, 'owned-office-reply-001@example.test');
  assert.equal(recorded?.bodyText, 'Yes, this verified reply reached the owned office.');
  assert.equal(recorded?.occurredAt, new Date(NOW_SECONDS * 1_000).toISOString());
  for (const digest of [
    recorded?.payloadSha256, recorded?.eventIdentitySha256,
    recorded?.signatureTokenSha256, recorded?.senderIdentitySha256,
    recorded?.recipientIdentitySha256, recorded?.subjectSha256,
    recorded?.bodySha256,
  ]) assert.equal(digest?.byteLength, 32);
});

test('invalid signature fails before invalid sender or message content is interpreted', async () => {
  let calls = 0;
  const service = new PropertyPredatorMailgunInboundIngressService({
    signingKey: SIGNING_KEY,
    nowSeconds: () => NOW_SECONDS,
    repository: { record: async () => { calls += 1; throw new Error('must not run'); } },
  });
  await assert.rejects(
    service.handle(signedForm({ signature: '0'.repeat(64), sender: 'attacker@example.test' })),
    (error: unknown) => error instanceof MailgunWebhookAuthenticationError,
  );
  assert.equal(calls, 0);
});

test('owned-office contract rejects truncated correlation, duplicate Message-Id and attachments', async () => {
  const service = new PropertyPredatorMailgunInboundIngressService({
    signingKey: SIGNING_KEY,
    nowSeconds: () => NOW_SECONDS,
    repository: { record: async () => { throw new Error('must not run'); } },
  });
  for (const input of [
    signedForm({ recipient: 'reply+abc@mg.propertypredator.com' }),
    signedForm({
      'message-headers': JSON.stringify([
        ['Message-Id', '<one@example.test>'], ['message-id', '<two@example.test>'],
      ]),
    }),
    signedForm({ 'attachment-count': '1' }),
  ]) {
    await assert.rejects(
      service.handle(input),
      (error: unknown) => error instanceof PropertyPredatorMailgunInboundContractError,
    );
  }
});

test('Mailgun inbound configuration stays dark by default and exact opt-in retains no printable secret', () => {
  assert.deepEqual(loadPropertyPredatorMailgunInboundConfig({}), {
    enabled: false, configurationReady: true, blockers: [],
    workspaceId: null, providerConnectionId: null, signingKey: null,
  });
  const malformed = loadPropertyPredatorMailgunInboundConfig({
    PROPERTY_PREDATOR_MAILGUN_INBOUND_ENABLED: 'TRUE',
  });
  assert.equal(malformed.enabled, true);
  assert.equal(malformed.configurationReady, false);
  assert.match(malformed.blockers.join(' '), /exact true/);

  const ready = loadPropertyPredatorMailgunInboundConfig({
    PROPERTY_PREDATOR_MAILGUN_INBOUND_ENABLED: 'true',
    MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: CONNECTION_ID,
    MAILGUN_SIGNING_KEY: 'k'.repeat(32),
  });
  assert.equal(ready.configurationReady, true);
  assert.equal(ready.workspaceId, WORKSPACE_ID);
  assert.equal(ready.providerConnectionId, CONNECTION_ID);
  assert.equal(JSON.stringify(ready).includes('k'.repeat(32)), false);
});

test('Mailgun inbound handler returns terminal/retry status without leaking database ids or content', async () => {
  const success = createPropertyPredatorMailgunInboundHandler({
    handle: async () => ({
      disposition: 'recorded', replayed: false,
      conversationId: WORKSPACE_ID, messageId: CONNECTION_ID,
      messageVersionId: INSTALLATION_ID,
      adminCallTaskId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
  });
  const successResponse = response();
  await success(request(signedForm()), successResponse);
  assert.equal(successResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(successResponse.body), { received: true, replayed: false });
  assert.equal(successResponse.body.includes(WORKSPACE_ID), false);
  assert.equal(successResponse.headers['cache-control'], 'no-store');

  const cases = [
    [new MailgunWebhookAuthenticationError(), 401, 'invalid_signature'],
    [new PropertyPredatorMailgunInboundContractError('private content'), 406, 'not_applicable'],
    [new PropertyPredatorMailgunInboundUnmatchedError(), 406, 'not_applicable'],
    [new PropertyPredatorMailgunInboundConflictError(), 409, 'evidence_conflict'],
    [new Error('private failure'), 503, 'temporarily_unavailable'],
  ] as const;
  for (const [error, status, safeError] of cases) {
    const handler = createPropertyPredatorMailgunInboundHandler({
      handle: async () => { throw error; },
    });
    const res = response();
    await handler(request(signedForm()), res);
    assert.equal(res.statusCode, status);
    assert.deepEqual(JSON.parse(res.body), { received: false, error: safeError });
    assert.equal(res.body.includes(error.message), false);
  }
});

test('Mailgun inbound readiness proves the existing function-only command identity', async () => {
  const statements: string[] = [];
  const client = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('mailgun_inbound_binding_ready')) return { rows: [{ ready: true }] };
      return { rows: [{}] };
    },
    release: () => undefined,
  };
  const pool = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('runtime_database_installation_id')) {
        return { rows: [{ installationId: INSTALLATION_ID }] };
      }
      return { rows: [{
        correct_user: true, can_record: true, table_blind: true,
        cannot_assume_definer: true, can_check_binding: true,
      }] };
    },
    connect: async () => client,
  };
  await assert.doesNotReject(assertPgPropertyPredatorMailgunInboundReady(
    pool as never, WORKSPACE_ID, CONNECTION_ID, INSTALLATION_ID,
  ));
  assert.match(statements.join(' '), /record_property_predator_owned_seed_mailgun_inbound/);
  assert.match(statements.join(' '), /r72_mailgun_webhook_command/);
  assert.match(statements.join(' '), /pg_catalog\.pg_class/);
  assert.match(statements.join(' '), /relation\.oid/);
  assert.doesNotMatch(
    statements.join(' '),
    /has_table_privilege\(\s*current_user,\s*'app\.property_predator_mailgun_inbound_receipts'/,
  );
});
