import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keyword-first planning is wired behind SEO_BLOG_KEYWORD_POOL (off by default). Only these files may import the
// foundation modules; with the switch off none of them constructs or calls a keyword research provider.
const NEW_MODULES = ['keyword/dataforseo-labs', 'seo-blog/keyword-pool', 'seo-blog/traffic-estimate', 'seo-blog/keyword-store-shape'];
const WIRING = ['seo-blog/keyword-fill', 'seo-blog/keyword-planning', 'portal/content-area-keywords', 'portal/seo-blog-router', 'seo-blog/engine', 'seo-blog/types', 'seo-blog/store', 'portal/seo-blog-service'];
const src = fileURLToPath(new URL('../src/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

test('only the wiring files import the keyword foundation; every other production module is unchanged', () => {
  const offenders: string[] = [];
  for (const file of files(src)) {
    const rel = relative(src, file).replace(/\\/g, '/').replace(/\.(ts|mts|js|mjs)$/, '');
    if (NEW_MODULES.includes(rel) || WIRING.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of [...NEW_MODULES, 'seo-blog/keyword-fill']) {
      const base = m.split('/').pop()!;
      if (new RegExp(`(from|import)\\s*\\(?\\s*['"][^'"]*\\b${base}(\\.js|\\.ts)?['"]`).test(text)) offenders.push(`${rel} imports ${m}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('with SEO_BLOG_KEYWORD_POOL off (the default) no keyword research provider is composed, whatever credentials exist', async () => {
  const { seoBlogRuntime } = await import('../src/portal/seo-blog-service.js');
  const creds = { SEO_BLOG_DATAFORSEO_LOGIN: 'synthetic-login', SEO_BLOG_DATAFORSEO_PASSWORD: 'synthetic-password' };
  assert.equal(seoBlogRuntime(creds).keywordResearch, null);
  assert.equal(seoBlogRuntime({ ...creds, SEO_BLOG_KEYWORD_POOL: 'yes' }).keywordResearch, null);
  assert.equal(seoBlogRuntime({ SEO_BLOG_KEYWORD_POOL: 'true' }).keywordResearch, null, 'no credentials: none');
  assert.equal(seoBlogRuntime({ ...creds, SEO_BLOG_KEYWORD_POOL: 'true', SEO_BLOG_RESEARCH_PROVIDER: 'none' }).keywordResearch, null);
  assert.equal(seoBlogRuntime({ ...creds, SEO_BLOG_KEYWORD_POOL: 'true' }).keywordResearch?.mode, 'live');
});

test('the new modules only depend on what they declare (pure modules import no I/O)', () => {
  for (const m of ['seo-blog/keyword-pool', 'seo-blog/traffic-estimate', 'seo-blog/keyword-store-shape']) {
    const text = readFileSync(join(src, `${m}.ts`), 'utf8');
    assert.doesNotMatch(text, /from ['"]node:(fs|net|http|https|child_process|dns)['"]|\bfetch\(|Date\.now\(|Math\.random\(|new Date\(\)/, m);
  }
});
