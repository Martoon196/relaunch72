import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createSafeTelemetryLogger,
  safeTelemetryErrorClass,
} from '../src/ops/safe-telemetry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INDEX = path.resolve(HERE, '../src/server/index.ts');
const RUNTIME_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-08-27T12:34:56.789Z';

test('safe telemetry emits one correlated JSON record without arbitrary or error-authored data', () => {
  const lines: string[] = [];
  const ids = [RUNTIME_ID, JOB_ID];
  const logger = createSafeTelemetryLogger({
    service: 'relaunch72-server',
    write: (line) => { lines.push(line); },
    now: () => NOW,
    nextCorrelationId: () => ids.shift()!,
  });
  const secret = 'key-secret-alpha-never-log';
  const email = 'customer-private@example.test';
  const hostile = Object.assign(new Error(`${secret} ${email}\nforged-log-line`), {
    name: email,
    stack: `stack contains ${secret}`,
    cause: { connectionString: `postgres://owner:${secret}@example.test/db` },
  });

  logger.emit('error', 'pipeline.start_failed', {
    correlationId: logger.nextCorrelationId(),
    error: hostile,
    // Runtime callers may be plain JavaScript. Unknown fields are ignored rather
    // than becoming an accidental escape hatch into logs.
    email,
    providerMessageId: secret,
  } as never);

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.endsWith('\n'), true);
  assert.equal(lines[0]!.slice(0, -1).includes('\n'), false);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(record, {
    schemaVersion: 1,
    occurredAt: NOW,
    service: 'relaunch72-server',
    level: 'error',
    event: 'pipeline.start_failed',
    correlationId: JOB_ID,
    errorClass: 'Error',
  });
  assert.doesNotMatch(lines[0]!, /key-secret|customer-private|postgres:|forged-log-line/);
});

test('safe telemetry uses fixed error classes and rejects attacker-controlled record dimensions', () => {
  assert.equal(safeTelemetryErrorClass(new AggregateError([])), 'AggregateError');
  assert.equal(safeTelemetryErrorClass(new RangeError('private')), 'RangeError');
  assert.equal(safeTelemetryErrorClass(new TypeError('private')), 'TypeError');
  assert.equal(safeTelemetryErrorClass({ name: 'DatabaseError', message: 'private' }), 'Error');

  const writes: string[] = [];
  const logger = createSafeTelemetryLogger({
    service: 'relaunch72-server',
    write: (line) => { writes.push(line); },
    now: () => NOW,
    nextCorrelationId: () => RUNTIME_ID,
  });
  assert.throws(
    () => logger.emit('warn', 'customer-private@example.test' as never),
    /event is invalid/,
  );
  assert.throws(
    () => logger.emit('customer-private@example.test\nforged' as never, 'server.fatal'),
    /level is invalid/,
  );
  assert.throws(
    () => logger.emit('warn', 'server.fatal', { correlationId: 'forged\nline' }),
    /correlation id is invalid/,
  );
  assert.deepEqual(writes, []);
});

test('server composition routes risky lifecycle logs through safe telemetry only', () => {
  const source = fs.readFileSync(SERVER_INDEX, 'utf8');
  assert.match(source, /createSafeTelemetryLogger\(\{ service: 'relaunch72-server' \}\)/);
  assert.match(source, /stdio: 'ignore'/);
  for (const forbidden of [
    '${error.message}',
    '${(e as Error).message}',
    '${(error as Error).message}',
    '${r.email}',
    '${email}',
    '${sent.messageId}',
    'stdio: [\'ignore\', \'inherit\', \'inherit\']',
  ]) {
    assert.equal(source.includes(forbidden), false, `server index must not contain ${forbidden}`);
  }
  for (const event of [
    'pipeline.start_failed',
    'stripe.catalog.provision_failed',
    'portal.setup_email.accepted',
    'portal.mount_failed',
    'portal.provision.failed',
    'server.shutdown_failed',
    'server.fatal',
  ]) {
    assert.equal(source.includes(`'${event}'`), true, `server index must emit ${event}`);
  }
});
