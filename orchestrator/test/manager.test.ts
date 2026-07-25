import test from 'node:test';
import assert from 'node:assert/strict';
import { isCadenceDue, dueActions } from '../src/manager/schedule.js';
import { runTick, mockRunner, type ActionRunner } from '../src/manager/engine.js';
import type { Tenant } from '../src/manager/types.js';

// 2026-08-03 is a Monday; 2026-08-01 is the 1st (a Saturday).
const MONDAY = '2026-08-03';
const TUESDAY = '2026-08-04';
const FIRST = '2026-08-01';

test('isCadenceDue: daily always, weekly on Monday, monthly on the 1st', () => {
  assert.equal(isCadenceDue('daily', TUESDAY), true);
  assert.equal(isCadenceDue('weekly', MONDAY), true);
  assert.equal(isCadenceDue('weekly', TUESDAY), false);
  assert.equal(isCadenceDue('monthly', FIRST), true);
  assert.equal(isCadenceDue('monthly', TUESDAY), false);
});

test('isCadenceDue throws on a bad date', () => {
  assert.throws(() => isCadenceDue('daily', 'nope'), /Invalid date/);
});

const roster: Tenant[] = [
  { id: 'a', name: 'A', rules: [{ action: 'social_batch', cadence: 'daily' }, { action: 'content_cluster', cadence: 'weekly' }] },
  { id: 'b', name: 'B', rules: [{ action: 'ads_refresh', cadence: 'monthly' }] },
];

test('dueActions picks only what fires on the date', () => {
  // Tuesday: only A's daily social.
  const tue = dueActions(roster, TUESDAY);
  assert.deepEqual(tue.map((d) => `${d.tenantId}:${d.action}`), ['a:social_batch']);
  // Monday: A's daily + A's weekly cluster.
  const mon = dueActions(roster, MONDAY).map((d) => `${d.tenantId}:${d.action}`);
  assert.deepEqual(mon, ['a:social_batch', 'a:content_cluster']);
  // The 1st: A's daily + B's monthly ads.
  const first = dueActions(roster, FIRST).map((d) => `${d.tenantId}:${d.action}`);
  assert.deepEqual(first.sort(), ['a:social_batch', 'b:ads_refresh'].sort());
});

test('runTick runs each due action through the mock runner', async () => {
  const res = await runTick(roster, MONDAY);
  assert.equal(res.due, 2);
  assert.equal(res.entries.length, 2);
  assert.ok(res.entries.every((e) => e.status === 'ok'));
});

test('runTick captures a failing runner as a failed entry, not a crash', async () => {
  const boom: ActionRunner = async () => { throw new Error('rail exploded'); };
  const res = await runTick(roster, TUESDAY, boom);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0]!.status, 'failed');
  assert.match(res.entries[0]!.note ?? '', /rail exploded/);
});

test('mockRunner is deterministic and names the action + tenant', async () => {
  const e = await mockRunner(roster[0]!, { tenantId: 'a', action: 'social_batch', cadence: 'daily', dueDate: MONDAY });
  assert.equal(e.status, 'ok');
  assert.match(e.note ?? '', /social_batch/);
});
