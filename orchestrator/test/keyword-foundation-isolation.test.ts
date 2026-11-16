import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keyword-first planning is foundation-only in this release: nothing in production may import it yet.
const NEW_MODULES = ['keyword/dataforseo-labs', 'seo-blog/keyword-pool', 'seo-blog/traffic-estimate', 'seo-blog/keyword-store-shape'];
const src = fileURLToPath(new URL('../src/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mts|js|mjs)$/.test(name) ? [path] : [];
  });
}

test('no production module imports the keyword foundation (portal, engine and every other existing file are unchanged)', () => {
  const offenders: string[] = [];
  for (const file of files(src)) {
    const rel = relative(src, file).replace(/\\/g, '/').replace(/\.(ts|mts|js|mjs)$/, '');
    if (NEW_MODULES.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of NEW_MODULES) {
      const base = m.split('/').pop()!;
      if (new RegExp(`(from|import)\\s*\\(?\\s*['"][^'"]*\\b${base}(\\.js|\\.ts)?['"]`).test(text)) offenders.push(`${rel} imports ${m}`);
    }
  }
  assert.deepEqual(offenders, []);
  // Explicit checks named in the release brief.
  for (const f of ['seo-blog/engine.ts', ...files(join(src, 'portal')).map((p) => relative(src, p))]) {
    assert.doesNotMatch(readFileSync(join(src, f), 'utf8'), /dataforseo-labs|keyword-pool|traffic-estimate|keyword-store-shape/, f);
  }
});

test('the new modules only depend on what they declare (pure modules import no I/O)', () => {
  for (const m of ['seo-blog/keyword-pool', 'seo-blog/traffic-estimate', 'seo-blog/keyword-store-shape']) {
    const text = readFileSync(join(src, `${m}.ts`), 'utf8');
    assert.doesNotMatch(text, /from ['"]node:(fs|net|http|https|child_process|dns)['"]|\bfetch\(|Date\.now\(|Math\.random\(|new Date\(\)/, m);
  }
});
