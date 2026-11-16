/**
 * Review item: `payload.programme.research.numbers` on a planning task (how the search numbers went for that run:
 * measured, no_data, unavailable or off) is internal bookkeeping. It is documented in docs/seo-blog-engine.md and on
 * `ResearchBundle.numbers`, and it is kept out of every hash and every prompt: the planning request (and so the method
 * receipt's prompt hash) is identical whatever it says; the run's input hash is built from the business, its profile
 * and the planning authority, never from the task payload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import type { KeywordMetric, KeywordProvider } from '../src/keyword/types.js';
import type { LlmRequest } from '../src/llm/client.js';
import { harness, OWNER, seedBrandSite } from './seo-blog-fixtures.js';

const metrics = (kind: 'measured' | 'none' | 'fail'): KeywordProvider => ({ mode: 'live', async metrics(keywords: string[]): Promise<KeywordMetric[]> {
  if (kind === 'fail') throw new Error('request failed');
  return kind === 'none' ? [] : keywords.map((keyword) => ({ keyword, volume: 320, difficulty: 20, cpc: null, source: 'dataforseo' }));
} });

async function run(kind: 'off' | 'measured' | 'none' | 'fail') {
  const h = harness();
  const e = new SeoBlogEngine({ store: h.store, llm: h.llm, search: h.search, transport: h.web, publishers: new Map(), vault: h.vault, now: h.clock.now, batchLimit: 20, ...(kind === 'off' ? {} : { keywords: metrics(kind) }) });
  const seen: unknown[] = [];
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req: LlmRequest) => { if (req.meta?.stage === 'SEO_BLOG_PLAN') seen.push({ system: req.system, messages: req.messages, outputSchema: req.outputSchema ?? null, maxTokens: req.maxTokens }); return inner(req); };
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await e.createBrand(OWNER, { commandId: '11111111-1111-4111-8111-111111111111', name: 'Harbour Lettings', website: 'https://harbour.example' });
  await e.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await e.getBrand(OWNER, brand.id);
  await e.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await e.extractBrandProfile(OWNER, brand.id);
  await e.confirmProfile(OWNER, brand.id, profile.version);
  await e.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await e.tick('w');
  const job = (await h.store.listJobs(brand.id)).find((j) => j.kind === 'plan')!;
  const programme = job.payload.programme as { research: { numbers?: string } };
  const norm = JSON.stringify(seen).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'UUID');
  return { state: job.state, numbers: programme.research.numbers, requestSha: createHash('sha256').update(norm).digest('hex'), request: norm };
}

test('payload.programme.research.numbers is recorded, but never in a prompt or a hash: the planning request is the same whatever it says', async () => {
  const runs = { off: await run('off'), measured: await run('measured'), none: await run('none'), fail: await run('fail') };
  assert.deepEqual(Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.numbers])), { off: 'off', measured: 'measured', none: 'no_data', fail: 'unavailable' });
  for (const r of Object.values(runs)) {
    assert.equal(r.state, 'done');
    assert.doesNotMatch(r.request, /"numbers"|no_data|unavailable/, 'not in the prompt');
    assert.equal(r.requestSha, runs.off.requestSha, 'the planning request does not change with it');
  }
});
