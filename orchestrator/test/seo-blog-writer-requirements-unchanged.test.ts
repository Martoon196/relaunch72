/**
 * Release 8 ("Writer gets the requirements"), the unchanged path. A brief with no measured target phrase (every
 * article in production while SEO_BLOG_KEYWORD_POOL is off) is written exactly as on d4e5527: the same prompt file,
 * version and hash, the same request byte for byte (plain and method-wrapped), and the same stored version shape.
 * The hashes below were recorded on d4e5527 with these fixtures before any release 8 change (the section-rewrite hash
 * was added in the review fix round, recorded the same way on d4e5527). No live calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ARTICLE_SCHEMA, writeArticle } from '../src/seo-blog/generation.js';
import { loadPrompt } from '../src/stages/prompt.js';
import { MethodController } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import type { LlmRequest } from '../src/llm/client.js';
import type { ArticleBrief, ArticleVersion, Brand } from '../src/seo-blog/types.js';
import { harness, OWNER, seedBrandSite, type Harness } from './seo-blog-fixtures.js';
import { fixtureBrand } from './rl72-method-fixtures.js';
import { UpgradeFixtureModel, upgradeSnapshot } from './rl72-upgrade-fixtures.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v).replace(UUID, 'UUID')).digest('hex');
const requestOf = (r: LlmRequest) => ({ model: r.model, maxTokens: r.maxTokens, system: r.system, messages: r.messages, outputSchema: r.outputSchema ?? null, thinking: r.thinking ?? null, meta: r.meta ?? null });

async function readyBrand(h: Harness): Promise<Brand> {
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const { brand } = await h.engine.createBrand(OWNER, { commandId: randomUUID(), name: 'Harbour Lettings', website: 'https://harbour.example' });
  await h.engine.uploadKnowledge(OWNER, brand.id, { category: 'product_facts', title: 'Plans', filename: 'plans.txt', bytes: Buffer.from('Harbour Lettings Compliance Plan costs £49 per month.') });
  const b = await h.engine.getBrand(OWNER, brand.id);
  await h.engine.updateSettings(OWNER, brand.id, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  const profile = await h.engine.extractBrandProfile(OWNER, brand.id);
  await h.engine.confirmProfile(OWNER, brand.id, profile.version);
  return h.engine.getBrand(OWNER, brand.id);
}

test('no measured target: the v1 article prompt file, version, hash and schema are the ones d4e5527 uses', () => {
  const v1 = loadPrompt('seo-blog-article.md');
  assert.equal(v1.header.version, '1.1.0');
  assert.equal(v1.header.stage, 'SEO_BLOG_ARTICLE');
  assert.equal(v1.sha256, '774720a5bf1babb8b54de1eecb5c6938d872dcf387f31143c4dd415329d90892');
  assert.equal(hash(ARTICLE_SCHEMA), '942109eb60c6281a4d55c43599dfac7129193462f1a35fa3d8f26fcbe6760020');
});

test('no measured target: the whole writing request and the stored version are byte for byte those of d4e5527', async () => {
  const h = harness();
  const seen: unknown[] = [];
  const inner = h.llm.complete.bind(h.llm);
  h.llm.complete = async (req: LlmRequest) => { if (req.meta?.stage === 'SEO_BLOG_ARTICLE') seen.push(requestOf(req)); return inner(req); };
  const brand = await readyBrand(h);
  await h.engine.requestPlan(OWNER, brand.id, { commandId: randomUUID() });
  await h.engine.tick('w');
  const { plan, briefs } = (await h.engine.listPlans(OWNER, brand.id))[0]! as { plan: { id: string }; briefs: ArticleBrief[] };
  assert.ok(briefs.every((b) => b.seo === undefined));
  // Research evidence is stored exactly as before: no page outline is captured when no phrase is measured.
  assert.equal(hash((plan as unknown as { sources: unknown }).sources), 'd518502db5e9b46749b94aa045cecec8e1b4f7054065f165fdeef6010f92026b');
  await h.engine.acceptPlan(OWNER, brand.id, plan.id);
  const pillar = briefs.find((b) => b.role === 'pillar')!;
  await h.engine.requestArticles(OWNER, brand.id, [pillar.id]);
  await h.engine.tick('w');
  assert.equal(seen.length, 1);
  const v1 = loadPrompt('seo-blog-article.md');
  assert.ok((seen[0] as { system: string }).system.startsWith(v1.body.split('{{LENGTH}}')[0]!));
  assert.equal(hash(seen), '778a5ec34d9b1e15cbaa97fc85b3db23f7ca8094e08cb1745f99f84c81ee99c4');
  const article = (await h.store.listArticles(brand.id)).find((a) => a.briefId === pillar.id)!;
  const version = (await h.store.getVersion(brand.id, article.currentVersionId!))! as ArticleVersion;
  assert.equal(version.generation!.promptVersion, `seo-blog-article.md@1.1.0#${v1.sha256.slice(0, 12)}`);
  assert.deepEqual(Object.keys(version.generation!).sort(), ['mode', 'model', 'promptVersion', 'tokensIn', 'tokensOut']);
  // The stored version with volatile identifiers and times normalised.
  const { createdAt: _c, engine, promotionPack: _p, ...rest } = version;
  // contentSha follows the body's random section ids, so 64-hex digests are normalised too; the body itself is compared.
  assert.equal(hash(JSON.parse(JSON.stringify({ ...rest, engine: { ...engine, at: 'AT' } }).replace(/[a-f0-9]{64}/g, 'H'))), 'b9559d070554680bcb6d95aa3a7b8da4612f9fec9cf124d87de752e714626da4');
  // A one-section rewrite of that article: the original section prompt and the whole request, byte for byte.
  const sectionSeen: unknown[] = [];
  h.llm.complete = async (req: LlmRequest) => { if (req.meta?.stage === 'SEO_BLOG_SECTION') sectionSeen.push(requestOf(req)); return inner(req); };
  const sectioned = await h.engine.regenerateSection(OWNER, brand.id, article.id, version.id, version.body.sections[0]!.id, 'Make it tighter.');
  assert.equal(sectionSeen.length, 1);
  assert.equal((sectionSeen[0] as { system: string }).system, loadPrompt('seo-blog-section.md').body);
  assert.equal(sectioned.generation!.promptVersion, `seo-blog-section.md@${loadPrompt('seo-blog-section.md').header.version}#${loadPrompt('seo-blog-section.md').sha256.slice(0, 12)}`);
  assert.deepEqual(Object.keys(sectioned.generation!).sort(), ['mode', 'model', 'promptVersion', 'tokensIn', 'tokensOut']);
  assert.equal(hash(JSON.parse(JSON.stringify(sectionSeen).replace(/[a-f0-9]{64}/g, 'H'))), '9b588b2a6dbbdc768f063e5853975b6c7b6a3d35dc4bea2349e7186e4b82172c');
});

test('no measured target, method-wrapped (structured article): the request is byte for byte that of d4e5527', async () => {
  const f = fixtureBrand(), store = new MemoryMethodStore(), model = new UpgradeFixtureModel();
  store.snapshots.set(f.brand.id, upgradeSnapshot(f.brand.id, ['production-core', 'blog-writing', 'visual-briefing']));
  const llm = await new MethodController(store, true).prepare(model, { ...f, stage: 'blog', stages: ['blog', 'visual-brief'], assetRef: 'article:' + f.brief.id, sources: ['S1', 'fixture-source'], baselineTokens: 32000,
    evidence: { research: f.sources, editorialFormat: { formatId: 'checklist', rationale: 'Checks suit this practical question.' } } });
  const out = await writeArticle(llm, { ...f, linkable: [], length: 'concise' });
  assert.ok(out.record.methodReceiptId);
  const v1 = loadPrompt('seo-blog-article.md');
  assert.equal(out.record.promptVersion, `seo-blog-article.md@1.1.0#${v1.sha256.slice(0, 12)}`);
  const req = model.requests.filter((r) => r.meta?.stage === 'SEO_BLOG_ARTICLE').map(requestOf);
  assert.equal(req.length, 1);
  // Fixture dates/ids are normalised; the hash covers system, messages, the native output schema and token ceiling.
  assert.equal(hash(JSON.parse(JSON.stringify(req).replace(/[a-f0-9]{64}/g, 'H'))), '1001fed8f6f7c42381d89fb126812b4eaa991c9decc5a0db84624e99c6b9e6a5');
});
