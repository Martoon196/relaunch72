import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createSafeTelemetryLogger,
  safeDatabaseCode,
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

test('the inbox read failure event carries only a class and a SQLSTATE', () => {
  const lines: string[] = [];
  const logger = createSafeTelemetryLogger({
    service: 'relaunch72-server',
    write: (line) => { lines.push(line); },
    now: () => '2026-08-29T10:00:00.000Z',
    nextCorrelationId: () => '11111111-1111-4111-8111-111111111111',
  });
  // The shape a driver actually throws when a role lacks a table privilege.
  const driverError = Object.assign(new Error('permission denied for table property_predator_sms_jobs'), {
    code: '42501',
    detail: 'workspace 0f2c...',
    hint: 'GRANT SELECT ON app.property_predator_sms_jobs TO r72_web',
    where: 'PL/pgSQL function inline_code_block line 4',
    schema: 'app',
    table: 'property_predator_sms_jobs',
    query: 'SELECT conversation.id FROM app.conversations ...',
  });
  logger.emit('error', 'portal.inbox.read_failed', { error: driverError });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(record, {
    schemaVersion: 1,
    occurredAt: '2026-08-29T10:00:00.000Z',
    service: 'relaunch72-server',
    level: 'error',
    event: 'portal.inbox.read_failed',
    correlationId: '11111111-1111-4111-8111-111111111111',
    errorClass: 'Error',
    databaseCode: '42501',
  });
  // Nothing the driver attached may reach the line, including the failing SQL.
  for (const leaked of [
    'permission denied', 'GRANT SELECT', 'property_predator_sms_jobs',
    'inline_code_block', 'SELECT conversation.id', 'workspace 0f2c',
  ]) {
    assert.equal(lines[0]!.includes(leaked), false, `record must not contain ${leaked}`);
  }
});

test('only a real SQLSTATE is treated as a database code', () => {
  assert.equal(safeDatabaseCode({ code: '42501' }), '42501');
  assert.equal(safeDatabaseCode({ code: '23505' }), '23505');
  for (const rejected of [
    { code: 'ECONNREFUSED' }, { code: '4250' }, { code: '425011' },
    { code: '42-01' }, { code: 42501 }, { code: null }, {}, null, undefined,
    'ERROR', new Error('no code'),
  ]) {
    assert.equal(safeDatabaseCode(rejected), undefined, `must reject ${JSON.stringify(rejected)}`);
  }
});

test('an error without a SQLSTATE still emits a class and omits the code', () => {
  const lines: string[] = [];
  const logger = createSafeTelemetryLogger({
    service: 'relaunch72-server',
    write: (line) => { lines.push(line); },
    now: () => '2026-08-29T10:00:00.000Z',
    nextCorrelationId: () => '22222222-2222-4222-8222-222222222222',
  });
  logger.emit('error', 'portal.inbox.read_failed', { error: new TypeError('boom') });
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.errorClass, 'TypeError');
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'databaseCode'), false);
  assert.equal(safeTelemetryErrorClass(new RangeError('x')), 'RangeError');
});

test('the portal router reports inbox read failures instead of swallowing them', () => {
  const source = fs.readFileSync(path.resolve(HERE, '../src/portal/router.ts'), 'utf8');
  assert.equal(source.includes("'portal.inbox.read_failed'"), true);
  // The bare `catch {` that hid the privilege regression must not come back.
  assert.equal(
    /\} catch \{\s*return sendHtml\(res, 503, portalStatusPage\(deps, sessionToken, \{\s*title: 'Conversion Inbox temporarily unavailable'/.test(source),
    false,
    'the inbox catch must bind and report its error',
  );
});
