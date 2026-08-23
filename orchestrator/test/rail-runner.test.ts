import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { railRunner } from '../src/manager/rail-runner.js';
import { MockGhlClient } from '../src/ghl/mock.js';
import { MockClient } from '../src/llm/mock.js';
import { extractJson } from '../src/llm/json.js';
import { validIntake } from './helpers.js';
import type { Tenant, DueAction } from '../src/manager/types.js';

const intake = validIntake();

async function mockStage(stage: string): Promise<unknown> {
  const client = new MockClient(intake);
  const resp = await client.complete({ model: 'mock', maxTokens: 1, system: '', messages: [], meta: { stage, attempt: 1 } });
  const parsed = extractJson(resp.text) as { value: unknown };
  return parsed.value;
}

/** A tenant runDir seeded with the brand brain (intake + S2 + S3). */
async function seedRunDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'railrun-'));
  fs.writeFileSync(path.join(dir, 'intake.json'), JSON.stringify(intake));
  fs.writeFileSync(path.join(dir, 's2.json'), JSON.stringify(await mockStage('S2')));
  fs.writeFileSync(path.join(dir, 's3.json'), JSON.stringify(await mockStage('S3')));
  return dir;
}

const action = (a: DueAction['action']): DueAction => ({ tenantId: 't', action: a, cadence: 'weekly', dueDate: '2026-08-03' });

test('railRunner mock generates a Soro cluster without claiming a live push', async () => {
  const runDir = await seedRunDir();
  const tenant: Tenant = { id: 't', name: 'Test Co', runDir, rules: [] };
  const ghl = new MockGhlClient();
  const run = railRunner(ghl, { mock: true });

  const e = await run(tenant, action('content_cluster'));
  assert.equal(e.status, 'skipped', e.note);
  assert.match(e.note ?? '', /simulation only.*article briefs drafted/i);
  assert.match(e.note ?? '', /no external account changed/i);
  assert.equal(ghl.artifacts.filter((a) => a.type === 'content_cluster').length, 1);
  assert.ok(fs.existsSync(path.join(runDir, 'cc.json')), 'cluster persisted to runDir');
});

test('railRunner keyword_refresh reads the cluster and pushes a report', async () => {
  const runDir = await seedRunDir();
  const tenant: Tenant = { id: 't', name: 'Test Co', runDir, rules: [] };
  const ghl = new MockGhlClient();
  const run = railRunner(ghl, { mock: true });

  await run(tenant, action('content_cluster')); // writes cc.json
  const e = await run(tenant, action('keyword_refresh'));
  assert.equal(e.status, 'skipped', e.note);
  assert.match(e.note ?? '', /simulated planning estimates.*not live search-volume data/i);
  assert.equal(ghl.artifacts.filter((a) => a.type === 'note').length, 1);
});

test('railRunner mock labels social and ad outputs as drafts, never scheduled or published', async () => {
  const runDir = await seedRunDir();
  fs.writeFileSync(path.join(runDir, 's4.json'), JSON.stringify(await mockStage('S4')));
  fs.writeFileSync(path.join(runDir, 's8.json'), JSON.stringify(await mockStage('S8')));
  const ghl = new MockGhlClient();
  const run = railRunner(ghl, { mock: true });
  const tenant: Tenant = { id: 't', name: 'Test Co', runDir, rules: [] };

  const social = await run(tenant, action('social_batch'));
  const ads = await run(tenant, action('ads_refresh'));

  assert.equal(social.status, 'skipped');
  assert.match(social.note ?? '', /schedule drafted; no post was scheduled or published/i);
  assert.equal(ads.status, 'skipped');
  assert.match(ads.note ?? '', /simulated ad drafts.*no ad account changed/i);
  assert.match(ads.note ?? '', /no external account changed/i);
});

test('railRunner skips (does not crash) when the tenant has no brand brain', async () => {
  const ghl = new MockGhlClient();
  const run = railRunner(ghl, { mock: true });
  const e = await run({ id: 'x', name: 'No Brain', rules: [] }, action('content_cluster'));
  assert.equal(e.status, 'skipped');
  assert.match(e.note ?? '', /no runDir/);
});

test('railRunner keyword_refresh skips cleanly when there is no cluster yet', async () => {
  const runDir = await seedRunDir();
  const ghl = new MockGhlClient();
  const run = railRunner(ghl, { mock: true });
  const e = await run({ id: 't', name: 'Test Co', runDir, rules: [] }, action('keyword_refresh'));
  assert.equal(e.status, 'skipped');
  assert.match(e.note ?? '', /needs a cc\.json/);
});
