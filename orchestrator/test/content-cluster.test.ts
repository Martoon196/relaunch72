import test from 'node:test';
import assert from 'node:assert/strict';
import { qaContentCluster } from '../src/qa/checks.js';
import { MockClient } from '../src/llm/mock.js';
import { extractJson } from '../src/llm/json.js';
import { validIntake } from './helpers.js';

const intake = validIntake();

async function mockStage(stage: string): Promise<Record<string, unknown>> {
  const client = new MockClient(intake);
  const resp = await client.complete({ model: 'mock', maxTokens: 1, system: '', messages: [], meta: { stage, attempt: 1 } });
  const parsed = extractJson(resp.text);
  assert.ok('value' in parsed, `mock ${stage} must emit parseable JSON`);
  return JSON.parse(JSON.stringify((parsed as { value: unknown }).value)) as Record<string, unknown>;
}

/** The real mock prior (S2 dream-buyer + S3 message guide) the cluster grounds in. */
async function priorS2S3(): Promise<Record<string, unknown>> {
  return { S2: await mockStage('S2'), S3: await mockStage('S3') };
}

test('qaContentCluster passes a grounded, interlinked mock cluster', async () => {
  const cluster = await mockStage('CC');
  const prior = await priorS2S3();
  assert.deepEqual(qaContentCluster(cluster, intake, prior), []);
});

test('mock cluster is 1 pillar + 6 supporting with unique slugs and distinct queries', async () => {
  const c = (await mockStage('CC')) as {
    pillar: { slug: string; target_query: string };
    supporting: { slug: string; target_query: string }[];
  };
  assert.equal(c.supporting.length, 6);
  const slugs = [c.pillar.slug, ...c.supporting.map((s) => s.slug)];
  assert.equal(new Set(slugs).size, slugs.length, 'slugs unique');
  const queries = [c.pillar.target_query, ...c.supporting.map((s) => s.target_query)];
  assert.equal(new Set(queries).size, queries.length, 'fan-out queries distinct');
});

test('cc.number_invented (FATAL) fires on a fabricated statistic', async () => {
  const c = (await mockStage('CC')) as { pillar: { key_points: string[] } };
  c.pillar.key_points[0] = 'Businesses like this see 73% more enquiries within 45 days of publishing.';
  const issues = qaContentCluster(c, intake, await priorS2S3());
  const hit = issues.find((i) => i.check === 'cc.number_invented');
  assert.ok(hit, 'invented 73% / 45 must be caught');
  assert.equal(hit?.fatal, true, 'invented numbers park immediately');
});

test('cc.quote_fabricated (FATAL) fires on a quote no customer said', async () => {
  const c = (await mockStage('CC')) as { pillar: { key_points: string[] } };
  c.pillar.key_points[2] = 'A customer said: "this is the best service in the entire country by far".';
  const issues = qaContentCluster(c, intake, await priorS2S3());
  assert.ok(issues.some((i) => i.check === 'cc.quote_fabricated' && i.fatal), 'fabricated testimony parks');
});

test('cc.pillar_backlink_missing fires when a supporting article drops the pillar link', async () => {
  const c = (await mockStage('CC')) as { supporting: { internal_links: string[] }[] };
  c.supporting[0]!.internal_links = [];
  assert.ok(qaContentCluster(c, intake, await priorS2S3()).some((i) => i.check === 'cc.pillar_backlink_missing'));
});

test('cc.pillar_hub_incomplete fires when the pillar stops linking to a supporting article', async () => {
  const c = (await mockStage('CC')) as { pillar: { internal_links: string[] }; supporting: { slug: string }[] };
  c.pillar.internal_links = c.pillar.internal_links.filter((s) => s !== c.supporting[0]!.slug);
  assert.ok(qaContentCluster(c, intake, await priorS2S3()).some((i) => i.check === 'cc.pillar_hub_incomplete'));
});

test('cc.query_duplicate fires when two articles chase the same fan-out query', async () => {
  const c = (await mockStage('CC')) as { pillar: { target_query: string }; supporting: { target_query: string }[] };
  c.supporting[1]!.target_query = c.supporting[0]!.target_query;
  assert.ok(qaContentCluster(c, intake, await priorS2S3()).some((i) => i.check === 'cc.query_duplicate'));
});

test('cc.internal_link_dangling fires on a link to a non-existent article', async () => {
  const c = (await mockStage('CC')) as { supporting: { internal_links: string[] }[] };
  c.supporting[0]!.internal_links.push('this-article-does-not-exist');
  assert.ok(qaContentCluster(c, intake, await priorS2S3()).some((i) => i.check === 'cc.internal_link_dangling'));
});

test('cc.snippet_too_long fires when the citation block overflows', async () => {
  const c = (await mockStage('CC')) as { supporting: { snippet_answer: string }[] };
  c.supporting[0]!.snippet_answer = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');
  assert.ok(qaContentCluster(c, intake, await priorS2S3()).some((i) => i.check === 'cc.snippet_too_long'));
});

test('banned phrase (H3 never-word) is caught in cluster copy', async () => {
  const c = (await mockStage('CC')) as { pillar: { angle: string } };
  c.pillar.angle = 'The cheap option every landlord should grab — a real bargain for certificates.';
  // "cheap" is an H3 never-word in the fixture intake.
  assert.ok(qaContentCluster(c, intake, await priorS2S3()).some((i) => i.check === 'banned_phrase'));
});
