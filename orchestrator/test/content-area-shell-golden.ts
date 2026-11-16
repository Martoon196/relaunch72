/**
 * The existing SEO blog pages and form posts, through the real router, for the "preview switched off = unchanged" proof.
 *
 * content-area-shell-golden.json.gz holds, for every request below, the full status, every header and the full body,
 * recorded from the platform foundation commit (before the shell) with the same list. Nothing is hashed or normalised:
 * random ids are pinned to a counter (`pinIds`) and the clock is pinned by the caller, so two renders are byte-equal.
 */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { OWNER, STRANGER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { portalCsrfToken } from '../src/portal/session.js';
import { articleId, BRAND_ID, call, identity, SECRET, showcase, type Rendered } from './content-area-shell-fixtures.js';

export const GOLDEN_NOW = '2026-11-16T12:00:00.000Z';
/** Where the recording lives, beside this file. */
export const GOLDEN_FILE = 'content-area-shell-golden.json.gz';
/** The commit the recording was made from. */
export const GOLDEN_BASE = '37eda58';

const B = `/portal/seo-blog/b/${BRAND_ID}`;

/** Every `randomUUID()` (command ids on forms, the real engine's record ids) becomes a counter, restarted per run. */
export function pinIds(): void {
  let n = 0;
  const next = (() => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`) as typeof crypto.randomUUID;
  crypto.randomUUID = next;
  syncBuiltinESMExports();
  // The store uses the global Web Crypto object (`crypto.randomUUID()` without an import).
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: next, configurable: true, writable: true });
}

export interface GoldenOptions { readonly headers?: Record<string, string>; readonly input?: Record<string, unknown> }
export type GoldenRecord = Record<string, Rendered>;

export async function goldenPages(opts: GoldenOptions = {}): Promise<GoldenRecord> {
  pinIds();
  const out: GoldenRecord = {};
  const who = identity(OWNER.userId);
  const csrf = portalCsrfToken(SECRET, who.sessionToken);
  const req = async (name: string, service: Parameters<typeof call>[0], method: 'GET' | 'POST', path: string, form?: Record<string, string>, user = who) => {
    out[name] = await call(service, user, method, path, { headers: opts.headers ?? {}, input: opts.input ?? {}, ...(form ? { form } : {}) });
  };
  const variants: [string, Parameters<typeof showcase>[0], Parameters<typeof showcase>[1], ((s: ReturnType<typeof showcase>) => void)?][] = [
    ['busy', 'busy', {}], ['calm', 'calm', {}], ['new', 'new', {}], ['paused', 'busy', { pauseAll: true }], ['auto', 'busy', { autoPublish: true }],
    ['gone', 'busy', {}, (s) => { s.destinations = [{ ...s.destinations[0]!, status: 'failed' }]; }],
    ['stopped', 'calm', {}, (s) => { s.jobs[0] = { ...s.jobs[0]!, state: 'blocked', error: 'Writing allowance: monthly ceiling reached.' }; }],
  ];
  for (const [name, scenario, settings, mutate] of variants) {
    const s = showcase(scenario, settings);
    mutate?.(s);
    const pages: [string, string][] = [
      ['businesses', '/portal/seo-blog'], ['overview', `${B}/overview`], ['root', B], ['articles', `${B}/articles`],
      ['calendar-month', `${B}/calendar?date=2026-11-16`], ['calendar-week', `${B}/calendar?view=week&date=2026-11-16`], ['calendar-list', `${B}/calendar?view=list&date=2026-11-16`],
      ['calendar-default', `${B}/calendar`], ['calendar-message', `${B}/calendar?n=bm90ZQ&s=x`], ['activity', `${B}/activity`], ['results-unknown', `${B}/results`], ['look-unknown', '/portal/seo-blog/look'],
      ['look-back', '/portal/seo-blog/look?back=https://evil.example'], ['home-unknown', `${B}/home`], ['script-unknown', '/portal/seo-blog/content-area.js'], ['foreign-brand', '/portal/seo-blog/b/e0000000-0000-4000-8000-000000000009/overview'],
    ];
    if (scenario !== 'new') for (const n of [1, 2, 4, 6, 8, 13]) pages.push([`article-${n}`, `${B}/articles/${articleId(n)}`]);
    for (const [page, path] of pages) await req(`${name}:${page}`, s.service, 'GET', path);
    await req(`${name}:post-look`, s.service, 'POST', '/portal/seo-blog/look', { _csrf: csrf, look: 'new', back: B });
    await req(`${name}:post-look-no-token`, s.service, 'POST', '/portal/seo-blog/look', { look: 'new' });
    await req(`${name}:anonymous-script`, s.service, 'GET', '/portal/seo-blog/content-area.js', undefined, null as never);
  }
  pinIds();
  const f = await websiteFixture();
  pinIds();
  const service = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null } as unknown as Parameters<typeof call>[0];
  const R = `/portal/seo-blog/b/${f.brand.id}`;
  const A = `${R}/articles/${f.articleId}`;
  const gets = async (prefix: string) => {
    for (const [name, path] of [['overview', `${R}/overview`], ['dna', `${R}/dna`], ['setup', `${R}/setup`], ['topics', `${R}/topics`], ['articles', `${R}/articles`], ['article', A],
      ['article-edit', `${A}?edit=1`], ['article-folds', `${A}?open=where&open=history&open=rewrite`], ['article-campaign', `${A}/campaign`], ['article-posts', `${A}/posts`],
      ['calendar', `${R}/calendar?date=2026-11-02`], ['calendar-default', `${R}/calendar`], ['calendar-week', `${R}/calendar?view=week&date=2026-11-02`], ['publishing', `${R}/publishing`], ['social', `${R}/social`],
      ['social-calendar', `${R}/social/calendar?from=2026-11-02&to=2026-12-02`], ['activity', `${R}/activity`], ['campaigns', `${R}/campaigns`], ['methods', `${R}/methods`], ['results', `${R}/results`],
      ['businesses', '/portal/seo-blog'], ['look', '/portal/seo-blog/look']] as const) await req(`${prefix}:${name}`, service, 'GET', path);
  };
  await gets('engine');
  // Form posts: the answers (status, redirect address, signed message, cookies) and the pages after them.
  const row = async () => (await f.h.engine.getArticle(OWNER, f.brand.id, f.articleId)).article;
  const brandRow = async () => (await f.h.engine.getBrand(OWNER, f.brand.id)).rowVersion;
  await req('post:hold', service, 'POST', `${A}/hold`, { _csrf: csrf, rowVersion: String((await row()).rowVersion), held: '1' });
  await req('post:allow', service, 'POST', `${A}/hold`, { _csrf: csrf, rowVersion: String((await row()).rowVersion), held: '0' });
  await req('post:schedule', service, 'POST', `${A}/schedule`, { _csrf: csrf, rowVersion: String((await row()).rowVersion), localDate: '2026-11-25', localTime: '09:00', destinationId: f.destination.id });
  await req('post:unschedule', service, 'POST', `${A}/unschedule`, { _csrf: csrf, rowVersion: String((await row()).rowVersion) });
  await req('post:autoplace', service, 'POST', `${R}/calendar/autoplace`, { _csrf: csrf, destinationId: f.destination.id });
  await req('post:pause', service, 'POST', `${R}/settings/toggle`, { _csrf: csrf, rowVersion: String(await brandRow()), name: 'pauseAll', value: '1' });
  await req('post:bad-token', service, 'POST', `${A}/hold`, { _csrf: 'nope', rowVersion: '1', held: '1' });
  await req('post:retry-unknown', service, 'POST', `${R}/jobs/00000000-0000-4000-8000-0000000000ff/retry`, { _csrf: csrf, back: 'articles' });
  await req('post:look', service, 'POST', '/portal/seo-blog/look', { _csrf: csrf, look: 'new' });
  await req('post:look-stranger', service, 'POST', '/portal/seo-blog/look', { _csrf: portalCsrfToken(SECRET, identity(STRANGER.userId).sessionToken), look: 'new' }, identity(STRANGER.userId));
  await req('stranger:look', service, 'GET', '/portal/seo-blog/look', undefined, identity(STRANGER.userId));
  await gets('after-posts');
  return out;
}
