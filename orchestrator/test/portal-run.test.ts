import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateBrandBrain, runTickReal } from '../src/portal/run.js';
import { MemoryCrmStore } from '../src/crm/store.js';
import { validIntake } from './helpers.js';

test('generateBrandBrain writes the full brand brain + artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  await generateBrandBrain(validIntake(), dir);
  for (const f of ['intake.json', 's2.json', 's3.json', 's4.json', 's8.json', 'cc.json', 'keyword-report.json', 'ad.json']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} was written`);
  }
  const kw = JSON.parse(fs.readFileSync(path.join(dir, 'keyword-report.json'), 'utf8')) as { mode: string; disclaimer: string; queries: unknown[] };
  assert.equal(kw.mode, 'simulated');
  assert.match(kw.disclaimer, /not live/i);
  assert.equal(kw.queries.length, 7, 'all 7 fan-out queries priced');
});

test('runTickReal regenerates content/keyword/ads and records the run to the timeline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain2-'));
  await generateBrandBrain(validIntake(), dir);
  const store = new MemoryCrmStore();
  await store.upsertTenant({ id: 't1', name: 'Test Co', runDir: dir });

  const n = await runTickReal(store, 't1');
  assert.equal(n, 3, 'content draft + simulated keyword estimates + paused ad draft');
  const view = await store.tenantView('t1');
  const railRuns = view.activity.filter((a) => a.kind === 'rail_run');
  assert.equal(railRuns.length, 3);
  assert.ok(railRuns.some((a) => /content cluster/.test(a.summary)));
  assert.ok(railRuns.some((a) => /simulated search-volume estimates/.test(a.summary)));
  assert.ok(railRuns.some((a) => /paused and not published/.test(a.summary)));
  assert.ok(!railRuns.some((a) => /\bscheduled\b/i.test(a.summary)), 'artifact presence must not claim a schedule operation');
  assert.ok(railRuns.filter((a) => /\bpublished\b/i.test(a.summary)).every((a) => /(?:nothing was|not) published/i.test(a.summary)), 'published must only appear in an explicit negation');
});

test('runTickReal records an honest no-op when the tenant has no brand brain', async () => {
  const store = new MemoryCrmStore();
  await store.upsertTenant({ id: 't2', name: 'No Brain Co' }); // no runDir
  const n = await runTickReal(store, 't2');
  assert.equal(n, 1, 'records one visible no-op note');
  const view = await store.tenantView('t2');
  assert.equal(view.activity.filter((a) => a.kind === 'rail_run').length, 0, 'must not record a successful rail run');
  assert.ok(view.activity.some((a) => a.kind === 'note' && /not started.*nothing was generated, scheduled or published/i.test(a.summary)));
});
