import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createPropertyPredatorMailgunWebhookHandler,
  loadPropertyPredatorMailgunWebhookConfig,
} from '../src/integrations/mailgun-webhook/router.js';
import { assertPgMailgunWebhookIngressReady } from '../src/integrations/mailgun-webhook/readiness.js';
import {
  MailgunWebhookAuthenticationError,
  MailgunWebhookBodyTooLargeError,
  MailgunWebhookEventConflictError,
  MailgunWebhookUnmatchedDeliveryError,
} from '../src/mailgun-webhook-pg/index.js';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function request(body = '{}', contentType = 'application/json'): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  return Object.assign(stream, {
    method: 'POST',
    url: '/api/provider-webhooks/mailgun/events',
    headers: { 'content-type': contentType },
  });
}

function response(): ServerResponse & {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
} {
  const state = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writeHead(code: number, headers: Record<string, string> = {}) {
      state.statusCode = code;
      Object.assign(state.headers, headers);
      return state;
    },
    end(body = '') {
      state.body = body;
      return state;
    },
  };
  return state as unknown as ServerResponse & {
    statusCode: number; body: string; headers: Record<string, string>;
  };
}

test('Mailgun webhook configuration is dark by default and malformed opt-in fails visibly', () => {
  assert.deepEqual(loadPropertyPredatorMailgunWebhookConfig({}), {
    enabled: false,
    configurationReady: true,
    blockers: [],
    workspaceId: null,
    providerConnectionId: null,
    signingKey: null,
  });
  const malformed = loadPropertyPredatorMailgunWebhookConfig({
    PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'TRUE',
  });
  assert.equal(malformed.enabled, true);
  assert.equal(malformed.configurationReady, false);
  assert.match(malformed.blockers.join(' '), /exact true/);
  assert.equal(JSON.stringify(malformed).includes('MAILGUN_SIGNING_KEY'), false);
});

test('ready Mailgun webhook configuration retains only trusted route bindings and secret bytes', () => {
  const config = loadPropertyPredatorMailgunWebhookConfig({
    PROPERTY_PREDATOR_MAILGUN_WEBHOOK_ENABLED: 'true',
    MAILGUN_WEBHOOK_SIGNATURE_VERIFICATION_ENABLED: 'true',
    PROPERTY_PREDATOR_PILOT_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_MAILGUN_CONNECTION_ID: CONNECTION_ID,
    MAILGUN_SIGNING_KEY: 'a'.repeat(32),
  });
  assert.equal(config.configurationReady, true);
  assert.equal(config.workspaceId, WORKSPACE_ID);
  assert.equal(config.providerConnectionId, CONNECTION_ID);
  assert.equal(Buffer.from(config.signingKey!).byteLength, 32);
  assert.equal(JSON.stringify(config).includes('a'.repeat(32)), false);
});

test('webhook handler accepts one bounded JSON result and exposes no recipient evidence', async () => {
  const handler = createPropertyPredatorMailgunWebhookHandler({
    handle: async () => ({
      disposition: 'recorded', replayed: false, eventType: 'delivered',
      effectiveDeliveryStatus: 'delivered', suppressionRecorded: false,
      optOutRecorded: false,
    }),
  });
  const res = response();
  await handler(request('{"secret":"not-returned"}'), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    received: true,
    replayed: false,
    event_type: 'delivered',
    effective_delivery_status: 'delivered',
    suppression_recorded: false,
    opt_out_recorded: false,
  });
  assert.equal(res.body.includes('secret'), false);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('webhook handler maps authentication, bounds, conflicts and retryable mismatch safely', async () => {
  const cases = [
    [new MailgunWebhookAuthenticationError(), 401, 'invalid_signature', false],
    [new MailgunWebhookBodyTooLargeError(), 413, 'payload_too_large', false],
    [new MailgunWebhookEventConflictError(), 409, 'event_conflict', false],
    [new MailgunWebhookUnmatchedDeliveryError(), 503, 'webhook_temporarily_unavailable', true],
  ] as const;
  for (const [error, code, safeError, retries] of cases) {
    const handler = createPropertyPredatorMailgunWebhookHandler({
      handle: async () => { throw error; },
    });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, code);
    assert.deepEqual(JSON.parse(res.body), { error: safeError });
    assert.equal(Boolean(res.headers['retry-after']), retries);
    assert.equal(res.body.includes(error.message), false);
  }
});

test('webhook handler rejects non-JSON before ingress is invoked', async () => {
  let calls = 0;
  const handler = createPropertyPredatorMailgunWebhookHandler({
    handle: async () => {
      calls += 1;
      throw new Error('must not run');
    },
  });
  const res = response();
  await handler(request('{}', 'application/x-www-form-urlencoded'), res);
  assert.equal(res.statusCode, 415);
  assert.equal(calls, 0);
});

test('Mailgun webhook readiness proves the exact function-only database identity', async () => {
  const installationId = '33333333-3333-4333-8333-333333333333';
  const statements: string[] = [];
  const client = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('mailgun_webhook_binding_ready')) return { rows: [{ ready: true }] };
      return { rows: [{}] };
    },
    release: () => undefined,
  };
  const pool = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('runtime_database_installation_id')) {
        return { rows: [{ installationId }] };
      }
      return { rows: [{
        correct_user: true,
        can_record: true,
        table_blind: true,
        cannot_assume_definer: true,
        can_check_binding: true,
      }] };
    },
    connect: async () => client,
  };
  await assert.doesNotReject(assertPgMailgunWebhookIngressReady(
    pool as never, WORKSPACE_ID, CONNECTION_ID, installationId,
  ));
  assert.match(statements.join(' '), /r72_mailgun_webhook_command/);
  assert.match(statements.join(' '), /record_mailgun_webhook_event/);
  assert.match(statements.join(' '), /mailgun_webhook_binding_ready/);

  await assert.rejects(assertPgMailgunWebhookIngressReady({
    query: async (statement: string) => statement.includes('runtime_database_installation_id')
      ? ({ rows: [{ installationId }] })
      : ({ rows: [{
      correct_user: true,
      can_record: true,
      table_blind: false,
      cannot_assume_definer: true,
      can_check_binding: true,
    }] }),
    connect: async () => client,
  } as never, WORKSPACE_ID, CONNECTION_ID, installationId), /protected readiness/);
});
