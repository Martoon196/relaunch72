import assert from 'node:assert/strict';
import test from 'node:test';
import { createCachedRuntimeReadinessProbe } from '../src/ops/runtime-readiness-cache.js';

test('runtime readiness probe deduplicates concurrent checks and caches healthy evidence', async () => {
  let calls = 0;
  let clock = 100;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const probe = createCachedRuntimeReadinessProbe({
    probe: async () => { calls += 1; await gate; return []; },
    now: () => clock,
    successTtlMs: 100,
    failureTtlMs: 10,
    timeoutMs: 1_000,
  });
  const first = probe();
  const second = probe();
  assert.equal(calls, 1);
  release?.();
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, []);
  assert.deepEqual(await probe(), []);
  assert.equal(calls, 1);
  clock = 201;
  assert.deepEqual(await probe(), []);
  assert.equal(calls, 2);
});

test('runtime readiness probe safely caches failure and never exposes thrown details', async () => {
  let calls = 0;
  let clock = 10;
  const secret = 'postgresql://owner:secret@example.invalid/database';
  const probe = createCachedRuntimeReadinessProbe({
    probe: async () => { calls += 1; throw new Error(secret); },
    now: () => clock,
    successTtlMs: 100,
    failureTtlMs: 10,
    timeoutMs: 1_000,
  });
  const first = await probe();
  assert.deepEqual(first, ['Protected runtime readiness probe failed']);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.deepEqual(await probe(), first);
  assert.equal(calls, 1);
  clock = 21;
  await probe();
  assert.equal(calls, 2);
});

test('runtime readiness probe times out rather than holding /ready open', async () => {
  const probe = createCachedRuntimeReadinessProbe({
    probe: () => new Promise<readonly string[]>(() => undefined),
    timeoutMs: 10,
    successTtlMs: 10,
    failureTtlMs: 10,
  });
  const started = Date.now();
  assert.deepEqual(await probe(), ['Protected runtime readiness probe failed']);
  assert.ok(Date.now() - started < 500);
});
