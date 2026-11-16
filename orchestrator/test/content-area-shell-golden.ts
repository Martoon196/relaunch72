/**
 * The existing SEO blog pages, rendered through the real router, for the "preview switched off = unchanged" proof.
 * The fingerprints in content-area-shell-golden.json were recorded from d7417c5 (before the shell existed) with
 * this same list. Each fingerprint covers the status, the headers that matter and the normalised page.
 */
import { createHash } from 'node:crypto';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { articleId, BRAND_ID, call, identity, normalise, showcase, type Rendered } from './content-area-shell-fixtures.js';

export const GOLDEN_NOW = '2026-11-16T12:00:00.000Z';

const B = `/portal/seo-blog/b/${BRAND_ID}`;

export interface GoldenOptions { readonly headers?: Record<string, string>; readonly input?: Record<string, unknown> }

function fingerprint(r: Rendered): string {
  const h = r.headers;
  const kept = ['content-type', 'content-security-policy', 'location', 'set-cookie', 'cache-control'].map((k) => `${k}:${h[k] ?? ''}`).join('\n');
  return createHash('sha256').update(`${r.status}\n${kept}\n${normalise(r.body)}`).digest('hex');
}

/** Every page in the list, as name -> fingerprint (and the normalised bodies, for a readable failure). */
export async function goldenPages(opts: GoldenOptions = {}): Promise<{ prints: Record<string, string>; bodies: Record<string, string> }> {
  const prints: Record<string, string> = {}, bodies: Record<string, string> = {};
  const who = identity(OWNER.userId);
  const get = async (name: string, service: Parameters<typeof call>[0], path: string) => {
    const r = await call(service, who, 'GET', path, { headers: opts.headers ?? {}, input: opts.input ?? {} });
    prints[name] = fingerprint(r); bodies[name] = normalise(r.body);
  };
  for (const scenario of ['busy', 'calm', 'new'] as const) {
    const s = showcase(scenario);
    const pages: [string, string][] = [
      ['businesses', '/portal/seo-blog'], ['overview', `${B}/overview`], ['articles', `${B}/articles`],
      ['calendar-month', `${B}/calendar?date=2026-11-16`], ['calendar-week', `${B}/calendar?view=week&date=2026-11-16`], ['calendar-list', `${B}/calendar?view=list&date=2026-11-16`],
      ['calendar-default', `${B}/calendar`], ['activity', `${B}/activity`], ['results-unknown', `${B}/results`], ['look-unknown', '/portal/seo-blog/look'], ['home-unknown', `${B}/home`],
    ];
    if (scenario !== 'new') for (const n of [1, 2, 4, 6, 8, 13]) pages.push([`article-${n}`, `${B}/articles/${articleId(n)}`]);
    for (const [name, path] of pages) await get(`${scenario}:${name}`, s.service, path);
  }
  const f = await websiteFixture();
  const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null } as unknown as Parameters<typeof call>[0];
  const R = `/portal/seo-blog/b/${f.brand.id}`;
  for (const [name, path] of [['overview', `${R}/overview`], ['dna', `${R}/dna`], ['setup', `${R}/setup`], ['topics', `${R}/topics`], ['articles', `${R}/articles`], ['article', `${R}/articles/${f.articleId}`],
    ['article-edit', `${R}/articles/${f.articleId}?edit=1`], ['calendar', `${R}/calendar?date=2026-11-02`], ['publishing', `${R}/publishing`], ['social', `${R}/social`], ['social-calendar', `${R}/social/calendar?from=2026-11-02&to=2026-12-02`],
    ['activity', `${R}/activity`], ['campaigns', `${R}/campaigns`], ['methods', `${R}/methods`], ['businesses', '/portal/seo-blog']] as const) await get(`engine:${name}`, service, path);
  return { prints, bodies };
}
