import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryCrmStore } from '../src/crm/store.js';
import { makeDashboard } from '../src/portal/data.js';

test('persisted portal artifacts are runtime-validated before reaching HTML views', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r72-portal-data-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(runDir, 'keyword-report.json'), JSON.stringify({
    queries: [
      { query: 'safe query', volume: 1200 },
      { query: 'malformed volume', volume: '<img src=x onerror=alert(1)>' },
      { query: 72, volume: 500 },
      { query: '   ', volume: 500 },
    ],
  }));
  fs.writeFileSync(path.join(runDir, 'cc.json'), JSON.stringify({ topic: 'missing pillar' }));
  fs.writeFileSync(path.join(runDir, 's8.json'), JSON.stringify({
    posts: [{ platform: 'LinkedIn', hook: 72, body: 'not a valid post' }],
  }));
  fs.writeFileSync(path.join(runDir, 'ad.json'), JSON.stringify({ ad_sets: [{}] }));
  fs.writeFileSync(path.join(runDir, 's3.json'), JSON.stringify({}));

  const store = new MemoryCrmStore();
  await store.upsertTenant({ id: 'tenant-1', name: 'Validated workspace', runDir });
  const dashboard = makeDashboard(store, () => runDir);
  const data = await dashboard('tenant-1');

  assert.deepEqual(data?.artifacts.keywords, [
    { query: 'safe query', volume: 1200 },
    { query: 'malformed volume', volume: null },
  ]);
  assert.equal(data?.artifacts.cluster, undefined);
  assert.equal(data?.artifacts.ad, undefined);
  assert.equal(data?.artifacts.post, undefined);
  assert.equal(data?.brand, undefined);
});

test('whitespace-only content cannot materialize empty dashboard preview cards', async (t) => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r72-portal-empty-artifacts-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(runDir, 'cc.json'), JSON.stringify({
    topic: '   ',
    pillar: { working_title: '   ', search_intent: '\n\t' },
  }));
  fs.writeFileSync(path.join(runDir, 'keyword-report.json'), JSON.stringify({
    queries: [{ query: '   ', volume: 100 }],
  }));
  fs.writeFileSync(path.join(runDir, 's8.json'), JSON.stringify({
    posts: [{ platform: ' ', hook: '\t', body: '\n' }],
  }));

  const store = new MemoryCrmStore();
  await store.upsertTenant({ id: 'tenant-empty', name: 'Empty artifacts workspace', runDir });
  const data = await makeDashboard(store, () => runDir)('tenant-empty');

  assert.equal(data?.artifacts.cluster, undefined);
  assert.deepEqual(data?.artifacts.keywords, []);
  assert.equal(data?.artifacts.post, undefined);
});
