/**
 * Affiliate Studio release 1 is the data layer only: nothing that serves a page, a route or a worker may use it yet.
 * Every import or dynamic import in src/ is resolved; none outside src/affiliate may reach src/affiliate, and in
 * particular no module under src/portal or src/seo-blog.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const AFFILIATE = path.join(SRC, 'affiliate') + path.sep;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(full));
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(entry.name)) out.push(full);
  }
  return out;
}
/** Every module specifier in a file: static imports and exports, side-effect imports, dynamic import() and require(). */
function specifiers(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/gu)) found.push(m[2]!);
  return found;
}

// Release 2 (screens): only these files may reach src/affiliate. The portal pieces run only with AFFILIATE_STUDIO on;
// the article engine pieces act only on articles that carry products or product links.
const WIRED = new Set(['portal/affiliate-service.ts', 'portal/affiliate-routes.ts', 'portal/affiliate-views.ts', 'portal/seo-blog-router.ts', 'portal/seo-blog-service.ts',
  'portal/seo-blog-article-view.ts', 'seo-blog/engine.ts', 'seo-blog/types.ts', 'seo-blog/generation.ts', 'seo-blog/checks.ts', 'seo-blog/render.ts', 'seo-blog/publishers/content-api.ts']);

test('only the wired files import src/affiliate; nothing else outside src/affiliate does', async () => {
  const files = await sources(SRC);
  assert.ok(files.length > 200, 'the source tree was found');
  assert.ok(files.some(f => f.startsWith(path.join(SRC, 'portal') + path.sep)) && files.some(f => f.startsWith(path.join(SRC, 'seo-blog') + path.sep)));
  const offenders: string[] = [];
  for (const file of files) {
    if (file.startsWith(AFFILIATE) || WIRED.has(path.relative(SRC, file).split(path.sep).join('/'))) continue;
    const text = await readFile(file, 'utf8');
    for (const spec of specifiers(text)) {
      const target = spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : spec;
      if (target.startsWith(AFFILIATE) || target === AFFILIATE.slice(0, -1) || /(?:^|\/)affiliate\/(?:programmes|product-store|report-store|amazon-tracking-report)(?:\.js|\.ts)?$/u.test(spec)) {
        offenders.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the scan itself finds an import of src/affiliate when there is one', () => {
  const portal = path.join(SRC, 'portal', 'x.ts');
  for (const text of ["import { PROGRAMMES } from '../affiliate/programmes.js';", "export * from '../affiliate/product-store.js'", "const m = await import('../affiliate/report-store.js')",
    "import '../affiliate/amazon-tracking-report.js';", 'import type { X } from "../affiliate/programmes.js"']) {
    const hits = specifiers(text).map(spec => path.resolve(path.dirname(portal), spec)).filter(t => t.startsWith(AFFILIATE));
    assert.equal(hits.length, 1, text);
  }
});
