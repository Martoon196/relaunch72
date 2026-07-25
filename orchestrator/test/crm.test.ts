import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryCrmStore, JsonCrmStore } from '../src/crm/store.js';
import { ingestTick } from '../src/crm/ingest.js';
import type { ActivityEntry } from '../src/manager/types.js';

test('a tenant, its contacts, pipeline counts and timeline', async () => {
  const store = new MemoryCrmStore();
  await store.upsertTenant({ id: 't1', name: 'Brightmoor Electrical' });
  const a = await store.addContact('t1', { name: 'Jo Landlord', email: 'jo@example.com' });
  await store.addContact('t1', { name: 'Sam Owner', stage: 'contacted' });
  await store.moveContact(a.id, 'qualified');

  const view = await store.tenantView('t1');
  assert.equal(view.contacts.length, 2);
  assert.equal(view.pipeline.qualified, 1);
  assert.equal(view.pipeline.contacted, 1);
  assert.equal(view.pipeline.lead, 0);
  // Timeline is most-recent-first: the stage change is the latest event.
  assert.equal(view.activity[0]!.kind, 'stage_changed');
  assert.match(view.activity[0]!.summary, /lead → qualified/);
});

test('adding a contact to a missing tenant is a clear error', async () => {
  const store = new MemoryCrmStore();
  await assert.rejects(() => store.addContact('nope', { name: 'X' }), /No such tenant/);
});

test('ingestTick turns manager rail runs into timeline activities (skips skipped)', async () => {
  const store = new MemoryCrmStore();
  await store.upsertTenant({ id: 't1', name: 'Brightmoor' });
  const entries: ActivityEntry[] = [
    { tenantId: 't1', action: 'content_cluster', at: '2026-08-03', status: 'ok', note: '7-article cluster pushed' },
    { tenantId: 't1', action: 'social_batch', at: '2026-08-03', status: 'ok', note: '30 posts scheduled' },
    { tenantId: 't1', action: 'keyword_refresh', at: '2026-08-03', status: 'skipped', note: 'no cluster yet' },
  ];
  const n = await ingestTick(store, entries);
  assert.equal(n, 2, 'the skipped entry is not logged');

  const view = await store.tenantView('t1');
  const railRuns = view.activity.filter((x) => x.kind === 'rail_run');
  assert.equal(railRuns.length, 2);
  assert.equal(railRuns.find((x) => x.summary.includes('posts'))!.channel, 'social');
});

test('JsonCrmStore persists across instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-'));
  const file = path.join(dir, 'crm.json');
  const s1 = new JsonCrmStore(file);
  await s1.upsertTenant({ id: 't1', name: 'Persisted Co' });
  await s1.addContact('t1', { name: 'Ada' });

  const s2 = new JsonCrmStore(file); // fresh instance reads the same file
  const view = await s2.tenantView('t1');
  assert.equal(view.tenant.name, 'Persisted Co');
  assert.equal(view.contacts.length, 1);
  assert.equal(view.contacts[0]!.name, 'Ada');
});
