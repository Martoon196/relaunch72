import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import { portalCsrfToken } from '../src/portal/session.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import { harness, OWNER, STRANGER, seedBrandSite } from './seo-blog-fixtures.js';

const SECRET = 's'.repeat(48);

function identity(userId: string): PortalSessionIdentity {
  return { sessionToken: `token-${userId}`, userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' };
}

async function call(service: PortalSeoBlogService, who: PortalSessionIdentity | null, method: string, path: string, form?: Record<string, string | string[]>, extraHeaders: Record<string, string> = {}) {
  const body = form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), ...extraHeaders } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; },
    end(chunk?: string) { if (chunk) out += chunk; },
  } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true });
  return { status, headers, body: out };
}

test('owner screens: add brand, switch, every tab renders, CSRF and foreign access are enforced', async () => {
  const h = harness();
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', engineFor: () => h.engine };
  const owner = identity(OWNER.userId);
  const csrf = portalCsrfToken(SECRET, owner.sessionToken);

  assert.equal((await call(service, null, 'GET', '/portal/seo-blog')).status, 303, 'signed-out users go to login');
  const home = await call(service, owner, 'GET', '/portal/seo-blog');
  assert.equal(home.status, 200);
  assert.match(home.body, /Add brand/);
  assert.match(home.headers['content-security-policy']!, /script-src 'self'/);

  const commandId = randomUUID();
  const noCsrf = await call(service, owner, 'POST', '/portal/seo-blog/brands', { commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(noCsrf.status, 403);
  const crossSite = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'X', website: '' }, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  const created = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(created.status, 303);
  const location = created.headers.location!;
  assert.match(location, /^\/portal\/seo-blog\/b\/[0-9a-f-]{36}\/setup\?n=/);
  const brandId = /\/b\/([0-9a-f-]{36})\//.exec(location)![1]!;
  const retry = await call(service, owner, 'POST', '/portal/seo-blog/brands', { _csrf: csrf, commandId, name: 'Harbour <b>Lettings</b>', website: 'harbour.example' });
  assert.equal(/\/b\/([0-9a-f-]{36})\//.exec(retry.headers.location!)![1], brandId, 'retrying the same form does not duplicate');
  assert.equal((await h.engine.listBrands(OWNER)).length, 1);

  const setup = await call(service, owner, 'GET', location);
  assert.equal(setup.status, 200);
  assert.match(setup.body, /role="status">Harbour &lt;b&gt;Lettings&lt;\/b&gt; created/);
  assert.ok(!setup.body.includes('<b>Lettings</b>'), 'brand names are escaped everywhere');
  assert.match(setup.body, /enctype="multipart\/form-data"/);
  assert.match(setup.body, /Static website in a GitHub repository/);
  assert.match(setup.body, /Website content API/);
  // A forged notice is not displayed.
  const forged = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/setup?n=${Buffer.from('Your account is suspended').toString('base64url')}&s=bad`);
  assert.ok(!forged.body.includes('suspended'));

  // Seed a ready brand with content, then render every tab.
  seedBrandSite(h.web, 'https://harbour.example', 'deposits');
  const b = await h.engine.getBrand(OWNER, brandId);
  await h.engine.updateSettings(OWNER, brandId, b.rowVersion, { budgets: { modelTokensPerMonth: 2_000_000, searchCallsPerMonth: 200, imagesPerMonth: 0 } });
  await h.engine.uploadKnowledge(OWNER, brandId, { category: 'product_facts', title: 'Plans', pastedText: 'Harbour Compliance Plan costs £49 per month.' });
  const p = await h.engine.extractBrandProfile(OWNER, brandId);
  await h.engine.confirmProfile(OWNER, brandId, p.version);
  const plan = await call(service, owner, 'POST', `/portal/seo-blog/b/${brandId}/plan`, { _csrf: csrf, commandId: randomUUID(), focus: '', excluded: '', sourceArticleUrl: '' });
  assert.equal(plan.status, 303);
  await h.engine.tick('w');
  const topics = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/topics`);
  assert.match(topics.body, /Tenancy deposit protection/);
  assert.match(topics.body, /Qualitative/);
  assert.match(topics.body, /Update existing page/);
  const { plans } = { plans: await h.engine.listPlans(OWNER, brandId) };
  const ids = plans[0]!.briefs.filter((x) => x.status === 'planned').slice(0, 2).map((x) => x.id);
  const gen = await call(service, owner, 'POST', `/portal/seo-blog/b/${brandId}/generate`, { _csrf: csrf, brief: ids });
  assert.equal(gen.status, 303, gen.body);
  await h.engine.tick('w');
  const articles = await h.engine.listArticles(OWNER, brandId);
  assert.equal(articles.length, 2);
  const articleId = articles[0]!.article.id;
  for (const tab of ['overview', 'setup', 'topics', 'articles', `articles/${articleId}`, 'calendar', 'calendar?view=week', 'calendar?view=list', 'publishing', 'activity']) {
    const page = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/${tab}`);
    assert.equal(page.status, 200, tab);
    assert.ok(!/[0-9a-f]{64}/.test(page.body.replace(/value="[^"]*"/g, '')), `${tab}: no raw hashes on screen`);
  }
  const preview = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/articles/${articleId}/preview`);
  assert.match(preview.headers['content-security-policy']!, /default-src 'none'/);
  assert.match(preview.body, /noindex/);
  const md = await call(service, owner, 'GET', `/portal/seo-blog/b/${brandId}/articles/${articleId}/export?format=markdown`);
  assert.match(md.headers['content-disposition']!, /attachment; filename=".+\.md"/);
  assert.match(md.body, /^---\ntitle:/);

  // Keyboard/form scheduling path and the editor's section regeneration.
  const editor = await h.engine.getArticle(OWNER, brandId, articleId);
  const regen = await call(service, owner, 'POST', `/portal/seo-blog/b/${brandId}/articles/${articleId}/regenerate-section`, { _csrf: csrf, versionId: editor.version!.id, sectionId: editor.version!.body.sections[1]!.id, instruction: 'Simpler' });
  assert.equal(regen.status, 303);
  assert.match(Buffer.from(new URL(regen.headers.location!, 'https://x').searchParams.get('n')!, 'base64url').toString(), /Other sections are unchanged/);

  // Foreign access: another signed-in user sees "not found", never the brand.
  const stranger = identity(STRANGER.userId);
  const foreign = await call(service, stranger, 'GET', `/portal/seo-blog/b/${brandId}/overview`);
  assert.equal(foreign.status, 404);
  assert.ok(!foreign.body.includes('Harbour'));

  // Optional: write the rendered screens for screenshot evidence.
  const dir = process.env.SEO_BLOG_SNAPSHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    for (const [name, path] of [['brands', '/portal/seo-blog'], ['overview', `/portal/seo-blog/b/${brandId}/overview`], ['setup', `/portal/seo-blog/b/${brandId}/setup`], ['topics', `/portal/seo-blog/b/${brandId}/topics`], ['editor', `/portal/seo-blog/b/${brandId}/articles/${articleId}`], ['calendar', `/portal/seo-blog/b/${brandId}/calendar?date=2026-11-01`], ['publishing', `/portal/seo-blog/b/${brandId}/publishing`], ['preview', `/portal/seo-blog/b/${brandId}/articles/${articleId}/preview`]] as const) {
      writeFileSync(`${dir}/${name}.html`, (await call(service, owner, 'GET', path)).body);
    }
  }
});
