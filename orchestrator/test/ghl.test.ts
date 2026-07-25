import test from 'node:test';
import assert from 'node:assert/strict';
import { MockGhlClient } from '../src/ghl/mock.js';
import { ghlRunner, runTick } from '../src/manager/engine.js';
import type { Tenant } from '../src/manager/types.js';

test('MockGhlClient creates a location once per tenant (find-or-create)', async () => {
  const ghl = new MockGhlClient();
  const first = await ghl.ensureLocation({ id: 't1', name: 'Tenant One' });
  assert.equal(first.created, true);
  assert.equal(first.locationId, 'ghl-loc-t1');
  const again = await ghl.ensureLocation({ id: 't1', name: 'Tenant One' });
  assert.equal(again.created, false);
  assert.equal(again.locationId, 'ghl-loc-t1');
  assert.equal(ghl.locations.size, 1);
});

test('MockGhlClient records pushed artifacts with deterministic ids', async () => {
  const ghl = new MockGhlClient();
  const a = await ghl.pushArtifact('ghl-loc-t1', { type: 'content_cluster', title: 'C' });
  const b = await ghl.pushArtifact('ghl-loc-t1', { type: 'content_cluster', title: 'C2' });
  assert.equal(a.artifactId, 'ghl-art-content_cluster-0');
  assert.equal(b.artifactId, 'ghl-art-content_cluster-1');
  assert.equal(ghl.artifacts.length, 2);
});

const roster: Tenant[] = [
  { id: 'a', name: 'A', rules: [{ action: 'social_batch', cadence: 'daily' }, { action: 'content_cluster', cadence: 'weekly' }] },
];

test('ghlRunner ensures the sub-account and pushes an artifact per due action', async () => {
  const ghl = new MockGhlClient();
  // 2026-08-03 is a Monday → daily social + weekly cluster both due.
  const res = await runTick(roster, '2026-08-03', ghlRunner(ghl));
  assert.equal(res.entries.length, 2);
  assert.ok(res.entries.every((e) => e.status === 'ok'));
  // Location created once, reused for the second action.
  assert.equal(ghl.locations.size, 1);
  assert.equal(ghl.artifacts.length, 2);
  assert.match(res.entries[0]!.note ?? '', /ghl\[mock\]/);
  assert.match(res.entries.find((e) => e.action === 'content_cluster')!.note ?? '', /content_cluster → ghl-loc-a/);
});
