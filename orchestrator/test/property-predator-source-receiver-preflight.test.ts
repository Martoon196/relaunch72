import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROPERTY_PREDATOR_RECEIVER_RECEIPTS,
  formatPropertyPredatorReceiverPreflight,
  runPropertyPredatorReceiverPreflight,
} from '../src/ops/property-predator-source-receiver-preflight.js';

const SECRET_BASE64URL = Buffer.alloc(32, 0x3b).toString('base64url');
const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ID = 'pp-growth-2026-01';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'true',
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID: KEY_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID: WORKSPACE_ID,
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL: SECRET_BASE64URL,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function byName(report: Awaited<ReturnType<typeof runPropertyPredatorReceiverPreflight>>) {
  return new Map(report.checks.map((entry) => [entry.name, entry]));
}

test('a fully bound receiver reports ready for activation review', async () => {
  const report = await runPropertyPredatorReceiverPreflight(env(), {
    schemaProbe: { async assertReady() { /* installed */ } },
  });
  assert.equal(report.result, 'ready-for-activation-review');
  assert.deepEqual([...report.blockers], []);
  assert.equal(report.networkCallsMade, 0);
  const checks = byName(report);
  assert.equal(checks.get('receiver_route')?.status, 'ok');
  assert.equal(checks.get('source_key_binding')?.status, 'ok');
  assert.equal(checks.get('shadow_store_schema')?.status, 'ok');
});

test('the exact route, receipts and signature window are reported', async () => {
  const report = await runPropertyPredatorReceiverPreflight(env());
  const checks = byName(report);
  assert.equal(
    checks.get('receiver_route')?.facts?.path,
    '/api/external-events/v1/property-predator',
  );
  assert.equal(checks.get('receiver_route')?.facts?.method, 'POST');
  assert.equal(checks.get('receipt_contract')?.facts?.freshStatus, 202);
  assert.equal(checks.get('receipt_contract')?.facts?.replayStatus, 200);
  assert.equal(checks.get('receipt_contract')?.facts?.signatureToleranceSeconds, 300);
  // The constants the report quotes must be the ones the source relies on.
  assert.equal(PROPERTY_PREDATOR_RECEIVER_RECEIPTS.fresh.replayed, false);
  assert.equal(PROPERTY_PREDATOR_RECEIVER_RECEIPTS.replay.replayed, true);
});

test('a dark bridge still answers whether its key is bound', async () => {
  // This is the whole point of a pre-activation preflight: the loader
  // short-circuits while the bridge is off, so the command must probe the key
  // shape against a copy rather than reporting only "disabled".
  const report = await runPropertyPredatorReceiverPreflight(
    env({ PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'false' }),
    { schemaProbe: { async assertReady() { /* installed */ } } },
  );
  const checks = byName(report);
  assert.equal(checks.get('bridge_switch')?.status, 'unverifiable');
  assert.equal(checks.get('source_key_binding')?.status, 'ok');
  assert.equal(report.result, 'ready-for-activation-review');
});

test('a dark bridge with no key names each missing value', async () => {
  const report = await runPropertyPredatorReceiverPreflight({
    PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'false',
  } as NodeJS.ProcessEnv);
  assert.equal(report.result, 'blocked');
  const joined = report.blockers.join('\n');
  for (const key of [
    'PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID',
    'PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID',
    'PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL',
  ]) {
    assert.match(joined, new RegExp(key), `${key} must be named as missing`);
  }
});

test('the preflight never turns the bridge on', async () => {
  const source = env({ PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED: 'false' });
  await runPropertyPredatorReceiverPreflight(source);
  // The forced-on probe must use a copy; the caller's environment is untouched.
  assert.equal(source.PROPERTY_PREDATOR_EXTERNAL_EVENTS_ENABLED, 'false');
});

test('an incomplete or non-dedicated key blocks with a safe reason', async () => {
  for (const overrides of [
    { PROPERTY_PREDATOR_EXTERNAL_EVENTS_KEY_ID: 'not a key id' },
    { PROPERTY_PREDATOR_EXTERNAL_EVENTS_WORKSPACE_ID: 'not-a-uuid' },
    { PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL: 'short' },
    {
      PROPERTY_PREDATOR_EXTERNAL_EVENTS_HMAC_SECRET_BASE64URL: SECRET_BASE64URL,
      STRIPE_WEBHOOK_SECRET: SECRET_BASE64URL,
    },
  ]) {
    const report = await runPropertyPredatorReceiverPreflight(env(overrides));
    assert.equal(report.result, 'blocked', JSON.stringify(overrides));
    // Every blocker names a variable, never a value.
    for (const blocker of report.blockers) {
      assert.equal(blocker.includes(SECRET_BASE64URL), false, 'a blocker leaked the secret');
    }
  }
});

test('no secret material reaches the report or its rendering', async () => {
  const report = await runPropertyPredatorReceiverPreflight(env(), {
    schemaProbe: { async assertReady() { /* installed */ } },
  });
  const rendered = `${JSON.stringify(report)}\n${formatPropertyPredatorReceiverPreflight(report)}`;
  assert.equal(rendered.includes(SECRET_BASE64URL), false);
  assert.equal(rendered.includes(Buffer.alloc(32, 0x3b).toString('hex')), false);
  // The decoded length is the only thing said about the secret.
  const checks = byName(report);
  assert.equal(checks.get('source_key_binding')?.facts?.secretBytes, 32);
  // The key id is an identity, not a credential, and is safe to show.
  assert.equal(checks.get('source_key_binding')?.facts?.keyId, KEY_ID);
});

test('an unavailable schema blocks and a missing database is honest', async () => {
  const blocked = await runPropertyPredatorReceiverPreflight(env(), {
    schemaProbe: {
      async assertReady() {
        throw new Error('shadow recorder is missing or not SECURITY DEFINER');
      },
    },
  });
  assert.equal(blocked.result, 'blocked');
  assert.match(blocked.blockers.join(''), /shadow recorder is missing/);

  const unproven = await runPropertyPredatorReceiverPreflight(env());
  assert.equal(byName(unproven).get('shadow_store_schema')?.status, 'unverifiable');
  // Unproven is not a blocker, but it must never read as proven either.
  assert.equal(unproven.result, 'ready-for-activation-review');
});

test('sender delivery is never claimed and is stated in the rendering', async () => {
  const report = await runPropertyPredatorReceiverPreflight(env(), {
    schemaProbe: { async assertReady() { /* installed */ } },
  });
  assert.equal(report.senderProven, false);
  assert.equal(byName(report).get('source_worker_delivery')?.status, 'unverifiable');
  assert.match(
    formatPropertyPredatorReceiverPreflight(report),
    /Property Predator worker delivery is NOT proven by this command\./,
  );
});
