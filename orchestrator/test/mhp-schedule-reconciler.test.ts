import test from 'node:test';
import assert from 'node:assert/strict';
import { createMhpScheduleReconciler, startMhpScheduleReconciler } from '../src/mhp/schedule-reconciler.js';

test('disabled billing never calls a provider, including startup', async () => {
  let calls = 0;
  const source = { billingEnabled: false, reconcileScheduleBatch: async () => { calls++; return { nextCursor: null, checked: 0 }; } };
  const runner = createMhpScheduleReconciler(source);
  assert.equal((await runner.runOnce()).completed, false);
  startMhpScheduleReconciler(source)(); assert.equal(calls, 0);
});
test('four-page run carries its cursor into the next hourly invocation', async () => {
  const cursors: (string | undefined)[] = [];
  const runner = createMhpScheduleReconciler({ billingEnabled: true, reconcileScheduleBatch: async cursor => {
    cursors.push(cursor); return { nextCursor: cursors.length < 5 ? `cursor${cursors.length}` : null, checked: 1 };
  } });
  assert.deepEqual(await runner.runOnce(), { checked: 4, completed: false, failures: 0 });
  assert.deepEqual(await runner.runOnce(), { checked: 1, completed: true, failures: 0 });
  assert.deepEqual(cursors, [undefined,'cursor1','cursor2','cursor3','cursor4']);
});
test('concurrent tick shares in-flight work and stop prevents subsequent pages', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = createMhpScheduleReconciler({ billingEnabled: true, reconcileScheduleBatch: async () => {
    calls++; await gate; return { nextCursor: 'next', checked: 1 };
  } });
  const first = runner.runOnce(), second = runner.runOnce(); assert.equal(first, second);
  runner.stop(); release();
  assert.deepEqual(await first, { checked: 1, completed: false, failures: 0 });
  await runner.runOnce(); assert.equal(calls, 1);
});
test('provider failure retains last successful cursor and publishes counts only', async () => {
  const cursors: (string | undefined)[] = [], results: unknown[] = [];
  let attempt = 0;
  const runner = createMhpScheduleReconciler({ billingEnabled: true, reconcileScheduleBatch: async cursor => {
    cursors.push(cursor); attempt++;
    if (attempt === 1) return { nextCursor: 'resume', checked: 1 };
    if (attempt === 2) throw new Error('sensitive provider response must not escape');
    return { nextCursor: null, checked: 1, failures: 1 };
  } }, { onResult: r => results.push(r) });
  assert.deepEqual(await runner.runOnce(), { checked: 1, completed: false, failures: 1 });
  assert.deepEqual(await runner.runOnce(), { checked: 1, completed: true, failures: 1 });
  assert.deepEqual(cursors, [undefined,'resume','resume']);
  assert.ok(!JSON.stringify(results).includes('sensitive')); assert.ok(!JSON.stringify(results).includes('resume'));
});
test('time budget stops between bounded batches and carries progress', async () => {
  let now = 0, calls = 0;
  const runner = createMhpScheduleReconciler({ billingEnabled: true, reconcileScheduleBatch: async () => {
    now += 20; calls++; return { nextCursor: 'next', checked: 1 };
  } }, { now: () => now, timeBudgetMs: 10 });
  assert.deepEqual(await runner.runOnce(), { checked: 1, completed: false, failures: 0 }); assert.equal(calls, 1);
});
