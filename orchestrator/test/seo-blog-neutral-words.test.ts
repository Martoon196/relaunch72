/**
 * Neutral words: nothing a client can see reveals who supplies the search data, which writing method is used, or
 * which AI model (or its maker) writes the articles. The platform's own name, Relaunch72, is allowed.
 *
 * Every client-visible surface is rendered from fixtures as a non-founder owner, in the old look and the new look,
 * in states that carry realistic raw supplier and SDK error text, method errors and rejection text: every content
 * area page, the Markdown and HTML exports, the published article HTML, the website publisher payloads and every
 * JSON answer the router gives. None may contain a banned term. The same surfaces as the founder still carry the
 * technical detail.
 *
 * The banned list is built from the code (see `bannedTerms`), not typed in by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { ContentApiPublisher } from '../src/seo-blog/publishers/content-api.js';
import { WordPressPublisher } from '../src/seo-blog/publishers/wordpress.js';
import type { PublishInput, WebsitePublisher } from '../src/seo-blog/publishers/types.js';
import type { PublisherRegistry } from '../src/seo-blog/publishers/registry.js';
import { researchDiagnostic } from '../src/seo-blog/programme.js';
import { isProfileJob } from '../src/seo-blog/profile-jobs.js';
import { ownerWords, ownerActivityWords, revealsInternals } from '../src/seo-blog/owner-words.js';
import type { ActivityEvent, Article, ArticleBrief, ArticleVersion, Brand, Job, TopicPlan, DestinationType } from '../src/seo-blog/types.js';
import { campaignCreatorsPage, productionRulesPage } from '../src/portal/campaign-creator-view.js';
import { overviewPage, type Shell } from '../src/portal/seo-blog-view.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import { OWNER } from './seo-blog-fixtures.js';
import { websiteFixture } from './seo-blog-website-fixtures.js';
import { articleId as showcaseArticle, BRAND_ID as SHOWCASE_BRAND, call, identity, showcase, type Rendered } from './content-area-shell-fixtures.js';
import jpeg from 'jpeg-js';
import { createHash } from 'node:crypto';
import { CreativeStudioService } from '../src/creative-studio/service.js';
import { MemoryCreativeLibraryStore } from '../src/creative-studio/store.js';
import { CreativeGeneration } from '../src/creative-studio/generation-service.js';
import type { GenerationState, GenerationStore } from '../src/creative-studio/generation-store.js';
import type { ArtworkInput, ArtworkRenderer, RenderedArtwork } from '../src/creative-studio/renderer.js';
import { harness } from './seo-blog-fixtures.js';
import { creativeBrand, HEARTH } from './creative-studio-fixtures.js';
import { editorPage } from '../src/portal/seo-blog-article-view.js';
import * as fx from './seo-blog-article-page-fixtures.js';
import * as sp from './seo-panel-fixtures.js';
import { MethodController } from '../src/seo-blog/method-packs.js';
import { MemoryMethodStore } from '../src/seo-blog/method-store.js';
import { CampaignCreator } from '../src/seo-blog/campaign-creator.js';
import { MemorySeoBlogStore } from '../src/seo-blog/store.js';
import { UnconfiguredSearchProvider } from '../src/seo-blog/research.js';
import { FakeWeb } from './seo-blog-fixtures.js';
import { fixtureBrand } from './rl72-method-fixtures.js';
import { UpgradeFixtureModel, upgradeSnapshot, campaignBrief, MemoryCreatorFixture } from './rl72-upgrade-fixtures.js';
import { nativeCsrf, nativeIdentity, nativeSeoCall } from './seo-blog-native-request.js';

// The tests choose the look themselves; the build machine's own setting must not decide it.
delete process.env.CONTENT_AREA_PREVIEW;

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ORCH, '..');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (dir: string, ext: RegExp): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name), ext) : ext.test(d.name) ? [path.join(dir, d.name)] : []);

interface Banned { readonly term: string; readonly why: string; readonly re: RegExp; readonly visibleOnly?: boolean }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The banned list, built from the code: suppliers, models and makers, method packs, rule ids, product names, internal words. */
export function bannedTerms(): Banned[] {
  const out = new Map<string, Banned>();
  const add = (term: string, why: string, opts: { caseSensitive?: boolean; word?: boolean; visibleOnly?: boolean } = {}) => {
    const t = term.trim(); if (!t || out.has(t.toLowerCase())) return;
    const body = esc(t).replace(/&/g, '(?:&|&amp;)').replace(/’|'/g, "(?:'|’|&#39;|&#x27;)");
    out.set(t.toLowerCase(), { term: t, why, re: new RegExp(opts.word === false ? body : `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, opts.caseSensitive ? '' : 'i'), ...(opts.visibleOnly ? { visibleOnly: true } : {}) });
  };
  // Suppliers: the research provider ids (research.ts), the keyword data sources (keyword/types.ts), the supplier
  // adapters' own names (keyword/<supplier>.ts) and hosts, and the social posting supplier's adapters (src/<supplier>-*).
  for (const m of read(path.join(ORCH, 'src/seo-blog/research.ts')).matchAll(/readonly id = '([^']+)'/g)) if (m[1] !== 'none') add(m[1]!, 'research supplier id (research.ts)');
  const sources = /source:\s*([^;]+);/.exec(read(path.join(ORCH, 'src/keyword/types.ts')))![1]!;
  for (const m of sources.matchAll(/'([^']+)'/g)) if (m[1] !== 'mock') add(m[1]!, 'keyword data source (keyword/types.ts)', { word: false });
  for (const f of readdirSync(path.join(ORCH, 'src/keyword'))) { const n = f.replace(/\.ts$/, ''); if (!['cli', 'mock', 'types'].includes(n)) add(n, `supplier adapter (src/keyword/${f})`, { word: false }); }
  for (const f of walk(path.join(ORCH, 'src'), /\.ts$/)) for (const m of read(f).matchAll(/https:\/\/(api\.[a-z0-9-]+\.com)/g)) if (/dataforseo/i.test(m[1]!)) add(m[1]!, `supplier host (${path.relative(ORCH, f)})`);
  for (const d of readdirSync(path.join(ORCH, 'src'))) { const m = /^([a-z]+)-inbound-pg$/.exec(d); if (m && m[1] !== 'test') add(m[1]!, `social posting supplier (src/${d})`); }
  // Models and makers: every model id the code or prompt headers can name, its family words, and the SDK makers.
  const modelFiles = [...walk(path.join(ORCH, 'src'), /\.ts$/), ...walk(path.join(REPO, 'prompts'), /\.md$/)];
  for (const f of modelFiles) {
    const text = read(f);
    for (const m of text.matchAll(/\bclaude-[a-z]+-[0-9][a-z0-9-]*/g)) { add(m[0], `model id (${path.relative(REPO, f)})`); add(m[0].split('-')[1]!, `model family (${path.relative(REPO, f)})`); add('claude', 'model name'); }
    for (const m of text.matchAll(/\bgpt-image-[0-9]+\b/g)) add(m[0], `image model id (${path.relative(REPO, f)})`);
    for (const m of text.matchAll(/from '@([a-z]+)-ai\/sdk'/g)) add(m[1]!, `model maker SDK (${path.relative(ORCH, f)})`);
  }
  if (/openai/i.test(read(path.join(ORCH, 'src/seo-blog/image-generation.ts')))) add('openai', 'image model maker (seo-blog/image-generation.ts)');
  // Method packs: every pack id and rule/check/step id in both pack directories, and every product name in the catalogue.
  const packFiles = [...walk(path.join(ORCH, 'method-packs'), /\.json$/), ...readdirSync(path.join(REPO, 'docs/relaunch72-rule-packs')).filter((f) => /\.json$/.test(f) && !/schema|CATALOGUE|LEDGER/.test(f)).map((f) => path.join(REPO, 'docs/relaunch72-rule-packs', f))];
  for (const f of packFiles) {
    const pack = JSON.parse(read(f)) as Record<string, unknown>;
    if (typeof pack.packId === 'string') add(pack.packId, `method pack id (${path.relative(REPO, f)})`);
    for (const key of ['rules', 'qualityChecks', 'decisionSteps']) for (const item of (pack[key] as { id?: string }[] | undefined) ?? []) if (item.id && /\./.test(item.id)) add(item.id, `method rule id (${path.relative(REPO, f)})`);
  }
  const catalogue = JSON.parse(read(path.join(REPO, 'docs/relaunch72-rule-packs/CATALOGUE.json'))) as { family: { proposedName: string }; bundles: { proposedName: string }[]; entries: { proposedName: string; productName: string }[] };
  add(catalogue.family.proposedName, 'product family name (CATALOGUE.json)', { caseSensitive: true });
  for (const b of catalogue.bundles) add(b.proposedName, 'product bundle name (CATALOGUE.json)', { caseSensitive: true });
  for (const e of catalogue.entries) { add(e.productName, 'product name (CATALOGUE.json)', { caseSensitive: true }); add(e.proposedName, 'product name (CATALOGUE.json)', { caseSensitive: true }); }
  // Internal vocabulary, in what a person reads (visible text, attribute values that are read aloud or shown, comments).
  for (const w of ['prompt', 'prompts', 'promptVersion', 'token', 'tokens', 'supplier', 'suppliers', 'supplier attempts', 'provider', 'providers', 'API key', 'method pack', 'method packs', 'production pack', 'production packs', 'simulated', 'production methods'])
    add(w, 'internal vocabulary', { visibleOnly: true });
  return [...out.values()];
}

const BANNED = bannedTerms();
/** A match without printing the whole page when it fails. */
const has = (body: string, re: RegExp, what = `contains ${re.source}`) => assert.ok(re.test(body), what);
const hasNot = (body: string, re: RegExp, what: string) => assert.ok(!re.test(body), what);

/** What a person can read or a page carries as data: text, comments, data and value attributes. Styles and scripts are code. */
function readable(body: string, contentType: string): string {
  if (!/html/.test(contentType)) return body;
  const comments = [...body.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  const attrs = [...body.matchAll(/\s(?:value|title|alt|placeholder|aria-label|content|data-[a-z-]+)="([^"]*)"/gi)].map((m) => m[1]);
  const text = body.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
  return [text, ...comments, ...attrs].join('\n').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;|&#34;/g, '"');
}

/** Every banned term the surface contains, with a little context. */
/** The owner's own website credential is theirs to name (a GitHub fine-grained token for their own repository). */
const OWNERS_OWN = /GitHub fine-grained token/g;

function offences(body: string, contentType: string): string[] {
  const visible = readable(body, contentType).replace(OWNERS_OWN, 'GitHub credential');
  const found: string[] = [];
  for (const b of BANNED) {
    const m = b.re.exec(b.visibleOnly ? visible : `${body}\n${visible}`);
    if (m) { const at = (b.visibleOnly ? visible : `${body}\n${visible}`); found.push(`"${b.term}" (${b.why}) near …${at.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ')}…`); }
  }
  return found;
}

function assertClean(failures: string[], surface: string, body: string, contentType = 'text/html') {
  for (const f of offences(body, contentType)) failures.push(`${surface}: ${f}`);
}

// ─── Fixtures: a real engine with realistic raw records ─────────────────────

/** Realistic raw image-generation failure text (supplier, model id and maker). */
const IMAGE_ERROR = 'OpenAI image request failed for gpt-image-2: 429 {"error":{"type":"rate_limit_exceeded","message":"Rate limit reached"}}. The image provider may still have charged.';
const SDK_ERROR = 'The writing model could not be reached (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CWf9QmAnthropicX"}). Nothing was changed.';
const METHOD_ERROR = 'Assigned method hash changed: blog-writing';
const REJECTION = 'The assigned production methods could not produce a valid draft. blog.figures-cited-exactly: "62% of landlords" has no source id; blog.answer-in-the-open: first paragraph does not answer the query';
const UNCERTAIN = 'The method generation outcome is uncertain. Review its saved receipt before another call.';
const MODEL = 'claude-sonnet-4-6';

async function scene() {
  const f = await websiteFixture('content_api', '/blog');
  const { h, brand } = f;
  const store = h.store as unknown as { plans: Map<string, TopicPlan>; briefs: Map<string, ArticleBrief>; versions: Map<string, ArticleVersion>; jobs: Map<string, Job>; articles: Map<string, Article>; profiles: Map<string, { generation?: unknown }[]> };
  const now = h.clock.now();
  // Generation records name the model and the prompt; plans carry the supplier on every source and every measured demand.
  for (const [id, plan] of store.plans) store.plans.set(id, { ...plan, generation: { ...plan.generation, mode: 'live', model: MODEL, promptVersion: 'seo-blog-plan-v2.md@2#0123456789ab', methodReceiptId: 'receipt-editorial-planning-1' }, sources: plan.sources.map((s) => ({ ...s, provider: 'dataforseo-serp' })) });
  for (const [id, brief] of store.briefs) store.briefs.set(id, { ...brief, demand: { kind: 'measured', volume: 880, competition: 0.31, provider: 'dataforseo', retrievedAt: '2026-10-14T09:00:00.000Z' } } as ArticleBrief);
  for (const [id, v] of store.versions) store.versions.set(id, { ...v, generation: { ...v.generation, mode: 'live', model: MODEL, promptVersion: 'seo-blog-article.md@7#fedcba987654', methodReceiptId: 'receipt-blog-writing-1' } } as ArticleVersion);
  for (const [id, list] of store.profiles) store.profiles.set(id, list.map((p) => ({ ...p, generation: { mode: 'live', model: MODEL, promptVersion: 'seo-blog-profile.md@1#aaaaaaaaaaaa', tokensIn: 1, tokensOut: 1 } })));
  // A held research run (the supplier refused the credentials), with its stored diagnostic, attempts and task id.
  const diagnostic = researchDiagnostic(40100, 401, 'task-11071234-1535-0216-0000-a1b2c3d4e5f6');
  const metrics = researchDiagnostic(40204, 402);
  const job = (over: Partial<Job>): Job => ({ id: randomUUID(), brandId: brand.id, kind: 'write', idempotencyKey: randomUUID(), payload: {}, state: 'blocked', attempts: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, runAfter: now, progress: 'Paused until the issue is fixed.', error: null, createdAt: now, updatedAt: now, rowVersion: 1, ...over });
  const plan = job({ kind: 'plan', payload: { requestedBy: OWNER.userId, programme: { schema: 1, logicalRunId: 'run-1', retries: 0, snapshot: {}, attempts: [{ kind: 'serp', querySha: 'q', query: 'bridging loans', nonce: 'n', startedAt: now, diagnostic }, { kind: 'metrics', querySha: 'm', query: 'bridging loans', nonce: 'm', startedAt: now, diagnostic: metrics }], metricsWarning: metrics, hold: 'credentials' } },
    error: `${diagnostic.summary} ${diagnostic.remedy}`, progress: `${diagnostic.summary} ${diagnostic.remedy}` });
  const briefs = [...store.briefs.values()];
  const failedBrief = briefs.find((b) => !b.articleId) ?? briefs[1]!;
  const jobs = [plan,
    job({ payload: { briefId: failedBrief.id }, error: SDK_ERROR }),
    job({ state: 'failed', error: METHOD_ERROR, progress: 'Stopped after repeated failures.' }),
    job({ error: REJECTION }),
    job({ error: UNCERTAIN }),
    job({ kind: 'plan', state: 'queued', error: 'The search engine could not process this research request.', progress: 'Applying the saved planning result; no new model call.' }),
    job({ kind: 'publish', state: 'failed', error: 'Writing allowance: monthly ceiling reached. Used 2,000,000; ceiling 2,000,000; remaining 0 model tokens. Action estimate 60,000; shortfall 60,000. Minimum estimated monthly ceiling 2,060,000. Review Publishing settings before retrying.' }),
    job({ payload: { stage: 'profile', requestedBy: OWNER.userId }, error: SDK_ERROR }),
    job({ kind: 'inventory', state: 'failed', error: 'Research allowance: monthly ceiling reached. Used 100; ceiling 100; remaining 0 supplier attempts.' }),
  ];
  for (const j of jobs) store.jobs.set(j.id, j);
  // An article whose writing failed with the methods' rejection text (no written version).
  const failedId = randomUUID();
  const base = (await h.store.getArticle(brand.id, f.articleId))!;
  store.articles.set(failedId, { ...base, id: failedId, briefId: failedBrief.id, slug: `${base.slug}-2`, currentVersionId: null, editorialState: 'failed', failure: REJECTION, checks: null, approval: null, schedule: null, publishedUrl: null, delivery: 'none' } as unknown as Article);
  store.briefs.set(failedBrief.id, { ...failedBrief, articleId: failedId, status: 'generating' } as ArticleBrief);
  const current = (await h.store.getBrand(brand.id))!;
  await h.store.updateBrand({ ...current, settings: { ...current.settings, programme: { ...current.settings.programme, researchHold: { logicalRunId: 'run-1', jobId: plan.id, at: now, reason: 'credentials', diagnostic } } } } as Brand);
  for (const message of [`write: ${SDK_ERROR}`, `write: ${METHOD_ERROR}`, `write: ${REJECTION}`, `plan: ${diagnostic.summary} ${diagnostic.remedy}`, 'instagram connection handoff prepared. No account is connected until the provider confirms.', `write: ${UNCERTAIN}`])
    await h.store.recordActivity({ brandId: brand.id, at: now, actor: 'system', kind: 'job.blocked', message, subjectId: null } as ActivityEvent);
  return { ...f, failedId, diagnostic };
}

function service(f: Awaited<ReturnType<typeof scene>>, founder: boolean): PortalSeoBlogService {
  return { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => f.h.engine, socialCallback: async () => null,
    limitsFor: () => ({ allowed: async () => founder, list: async () => [] }) } as unknown as PortalSeoBlogService;
}

const NEW = { headers: { cookie: 'r72_content_look=new' }, input: { contentAreaPreview: 'enabled' } };

async function surfaces(f: Awaited<ReturnType<typeof scene>>, founder: boolean): Promise<[string, Rendered][]> {
  const svc = service(f, founder);
  const R = `/portal/seo-blog/b/${f.brand.id}`, A = `${R}/articles/${f.articleId}`, F = `${R}/articles/${f.failedId}`;
  const profileJob = (await f.h.engine.listJobs(OWNER, f.brand.id)).find((j) => isProfileJob(j) && j.error === SDK_ERROR);
  assert.ok(profileJob, 'a profile task with raw SDK text is on record');
  const paths: [string, string][] = [['businesses', '/portal/seo-blog'], ['overview', `${R}/overview`], ['root', R], ['dna', `${R}/dna`], ['setup', `${R}/setup`], ['topics', `${R}/topics`], ['articles', `${R}/articles`],
    ['article', A], ['article-edit', `${A}?edit=1`], ['article-folds', `${A}?open=where&open=history&open=rewrite&open=improve`], ['article-campaign', `${A}/campaign`], ['article-posts', `${A}/posts`],
    ['article-failed', F], ['article-failed-campaign', `${F}/campaign`], ['calendar', `${R}/calendar?date=2026-11-02`], ['calendar-week', `${R}/calendar?view=week&date=2026-11-02`], ['calendar-list', `${R}/calendar?view=list&date=2026-11-02`],
    ['publishing', `${R}/publishing`], ['social', `${R}/social`], ['social-calendar', `${R}/social/calendar?from=2026-11-02&to=2026-12-02`], ['activity', `${R}/activity`], ['campaigns', `${R}/campaigns`],
    ['methods', `${R}/methods`], ['results', `${R}/results`], ['look', '/portal/seo-blog/look'], ['missing', `${R}/nothing-here`],
    ['preview (published article HTML)', `${A}/preview`], ['export markdown', `${A}/export?format=markdown`], ['export html', `${A}/export?format=html`],
    ['image status (JSON)', `${R}/image/status?article=${f.articleId}&job=${randomUUID()}`], ['profile status (JSON)', `${R}/profile/status?job=${profileJob!.id}`],
    ['creative jobs (JSON)', `${R}/creative/jobs/${randomUUID()}`]];
  const out: [string, Rendered][] = [];
  for (const [name, p] of paths) {
    out.push([`old look · ${name}`, await call(svc, identity(OWNER.userId), 'GET', p)]);
    out.push([`new look · ${name}`, await call(svc, identity(OWNER.userId), 'GET', p, NEW)]);
  }
  // A refused action comes back as a signed page message: the budget refusal names allowance units.
  const brand = await f.h.engine.getBrand(OWNER, f.brand.id);
  await f.h.engine.updateSettings(OWNER, f.brand.id, brand.rowVersion, { budgets: { ...brand.settings.budgets, modelTokensPerMonth: 1 } });
  const { portalCsrfToken } = await import('../src/portal/session.js');
  const csrf = portalCsrfToken('s'.repeat(48), identity(OWNER.userId).sessionToken);
  const brief = (await f.h.engine.listPlans(OWNER, f.brand.id)).flatMap((p) => p.briefs).find((b) => ['planned', 'accepted'].includes(b.status));
  for (const [look, opts] of [['old look', {}], ['new look', NEW]] as const) {
    const posted = await call(svc, identity(OWNER.userId), 'POST', `${R}/generate`, { ...opts, form: { _csrf: csrf, brief: brief?.id ?? randomUUID() } });
    out.push([`${look} · refused action (redirect)`, posted]);
    if (posted.headers.location) out.push([`${look} · refused action (page)`, await call(svc, identity(OWNER.userId), 'GET', posted.headers.location.replace(/^https:\/\/portal\.example/, ''), opts)]);
    const extract = await call(svc, identity(OWNER.userId), 'POST', `${R}/profile/extract`, { ...opts, form: { _csrf: csrf, commandId: randomUUID(), baseVersion: '1' } });
    if (extract.headers.location) out.push([`${look} · refused extraction (page)`, await call(svc, identity(OWNER.userId), 'GET', extract.headers.location.replace(/^https:\/\/portal\.example/, ''), opts)]);
  }
  await f.h.engine.updateSettings(OWNER, f.brand.id, (await f.h.engine.getBrand(OWNER, f.brand.id)).rowVersion, { budgets: brand.settings.budgets });
  return out;
}

/** The website publisher payloads for the fixture's article: what the content API receives, and what WordPress would. */
async function publisherPayloads(f: Awaited<ReturnType<typeof scene>>): Promise<[string, string][]> {
  const inputs: PublishInput[] = [];
  const inner = new ContentApiPublisher(f.h.site.fetch, 1000, () => f.h.clock.ms);
  const spy: WebsitePublisher = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, { publish: async (input: PublishInput) => { inputs.push(input); return inner.publish(input); } });
  const publishers: PublisherRegistry = new Map<DestinationType, WebsitePublisher>([['content_api', spy]]);
  const engine = new SeoBlogEngine({ store: f.h.store, llm: f.h.llm, search: f.h.search, transport: f.h.web, publishers, vault: f.h.vault, now: f.h.clock.now, batchLimit: 20 });
  const detail = await engine.getArticle(OWNER, f.brand.id, f.articleId);
  await engine.approveAndSchedule(OWNER, f.brand.id, f.articleId, { versionId: detail.version!.id, when: 'now', destinationId: f.destination.id });
  f.h.clock.advance(5 * 60_000);
  await engine.dispatchDue(f.brand.id);
  assert.ok(inputs.length > 0, 'the fixture article reached the website publisher');
  const sent = f.h.site.payloads.map((p) => JSON.stringify(p));
  return [...sent.map((s, i) => [`content API payload ${i + 1}`, s] as [string, string]), ['WordPress payload', new WordPressPublisher().payload(inputs[0]!)]];
}


// ─── Creative studio, campaign creators, the SEO report and the allowance states ───

/** Labelled stub renderer: real tiny JPEG bytes (no browser). */
class StubRenderer implements ArtworkRenderer {
  readonly version = 'test-stub-renderer';
  available() { return true; }
  async renderBatch(inputs: readonly ArtworkInput[]): Promise<RenderedArtwork[]> {
    return inputs.map((input) => {
      const bytes = Buffer.from(jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 120), width: 8, height: 8 }, 90).data);
      const out = { mime: 'image/jpeg' as const, sha256: createHash('sha256').update(bytes).digest('hex'), width: input.placement.width, height: input.placement.height, contrast: { headline: 8 }, scrimAlpha: 0.42, headlineSize: 80, issues: [] };
      Object.defineProperty(out, 'bytes', { enumerable: false, get: () => Buffer.from(bytes) });
      return out as unknown as RenderedArtwork;
    });
  }
}

async function creativeScene(founder: boolean) {
  const h = harness();
  const hearth = await creativeBrand(h, HEARTH);
  const briefId = randomUUID(), jobId = randomUUID(), now = h.clock.now();
  const state: GenerationState = {
    briefs: [{ id: briefId, version: 1, data: { title: 'Calm kitchen morning', text: 'A bright modern kitchen in morning light', size: '1536x1024', references: [], useVisualGuidance: true }, createdBy: OWNER.userId, createdAt: now }],
    generations: [], attempts: [],
    jobs: [{ id: jobId, state: 'failed', briefId, briefVersion: 1, intentId: randomUUID(), progress: 'Stopped.', error: IMAGE_ERROR, paidAttemptStarted: true, createdAt: now, updatedAt: now }],
    usage: { brandImagesThisMonth: 0, brandUnresolvedEarlier: 0, studioImagesCounted: 0, studioUnresolved: 0, period: '2026-11' },
  };
  const store = { state: async () => state } as unknown as GenerationStore;
  const generation = new CreativeGeneration({ store, brands: h.store, providerConfigured: false,
    policy: async () => ({ version: 1, sha256: 'p'.repeat(64), enabled: false, model: 'gpt-image-2', quality: 'medium', maxConcurrency: 0, monthlyMicrousd: 0, perAttemptMicrousd: 0, admissionEpoch: 1 }) });
  const studio = new CreativeStudioService({ library: new MemoryCreativeLibraryStore(), brands: h.store, renderer: new StubRenderer(), renderJobs: h.store, generation,
    savedImages: { list: async () => [], load: async () => { throw new Error('unused'); } } });
  const svc = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => h.engine, socialCallback: async () => null, creativeEnabled: true, creativeFor: () => studio, creativeSavedImages: async () => [],
    limitsFor: () => ({ allowed: async () => founder, list: async () => [] }) } as unknown as PortalSeoBlogService;
  const set = await studio.draft(OWNER.userId, hearth.brand.id, randomUUID(), { purpose: 'advert', source_kind: 'offer', offer: 'Annual boiler service', audience: '', destination: HEARTH.pages[0]!.url, placements: ['square'], concepts: '1' }, { kind: 'neutral' });
  // A render task through the router, then stopped with raw text.
  const { portalCsrfToken } = await import('../src/portal/session.js');
  const csrf = portalCsrfToken('s'.repeat(48), identity(OWNER.userId).sessionToken);
  const R = `/portal/seo-blog/b/${hearth.brand.id}/creative`;
  const posted = await call(svc, identity(OWNER.userId), 'POST', `${R}/draft`, { form: { _csrf: csrf, commandId: randomUUID(), background: 'neutral', purpose: 'advert', source_kind: 'offer', offer: 'Annual boiler service', audience: '', destination: HEARTH.pages[0]!.url, placements: 'square', concepts: '1' } });
  const jobs = (h.store as unknown as { jobs: Map<string, Job> }).jobs;
  const taskId = /\/creative\/task\/([0-9a-f-]{36})/.exec(posted.headers.location ?? '')?.[1];
  const render = taskId ? jobs.get(taskId) : undefined;
  assert.ok(render, `a render task is on record (${posted.status} ${posted.headers.location ?? ''} ${[...jobs.values()].map((j) => j.kind).join(',')})`);
  jobs.set(render!.id, { ...render!, state: 'failed', error: IMAGE_ERROR, progress: 'Stopped.' });
  const out: [string, Rendered][] = [];
  for (const [look, opts] of [['old look', {}], ['new look', NEW]] as const) {
    for (const [name, path] of [['creative', R], ['creative generate', `${R}/generate`], ['creative brief', `${R}/generate/${briefId}`], ['creative kit', `${R}/kit`], ['creative enquiries', `${R}/enquiries`],
      ['creative set', `${R}/s/${set.setId}`], ['creative task', `${R}/task/${render!.id}`], ['creative jobs (JSON)', `${R}/jobs/${render!.id}`]] as const)
      out.push([`${look} · ${name}`, await call(svc, identity(OWNER.userId), 'GET', path, opts)]);
  }
  return out;
}

/** The campaign creators (email and request kit): list, review, text export and JSON export, approved. */
async function creatorScene(founder: boolean) {
  const f = fixtureBrand('home'), blogs = new MemorySeoBlogStore(), actor = f.profile.confirmedBy!;
  const created = await blogs.createBrand({ commandId: randomUUID(), actorId: actor, name: f.brand.name, slug: 'fixture-' + randomUUID(), website: f.brand.website, now: f.profile.createdAt });
  const brand = await blogs.updateBrand({ ...created.brand, settings: f.brand.settings });
  const profile = { ...f.profile, brandId: brand.id }; await blogs.saveProfile(profile);
  const methods = new MemoryMethodStore(); methods.snapshots.set(brand.id, upgradeSnapshot(brand.id));
  const controller = new MethodController(methods, true), model = new UpgradeFixtureModel(), store = new MemoryCreatorFixture(methods);
  const creator = new CampaignCreator(store, blogs, controller, model);
  const engine = new SeoBlogEngine({ store: blogs, methods: controller, creatorStore: store, llm: model, search: new UnconfiguredSearchProvider(), transport: new FakeWeb(), publishers: new Map(), vault: null });
  const who = nativeIdentity(actor), base = `/portal/seo-blog/b/${brand.id}/campaigns`;
  const out: [string, Rendered][] = [];
  const get = async (name: string, path: string) => { for (const [look, preview] of [['old look', false], ['new look', true]] as const) {
    const r = await nativeSeoCall(engine, { who, method: 'GET', path, founder, ...(preview ? { headers: { cookie: 'r72_content_look=new' }, preview: true } : {}) });
    out.push([`${look} · ${name}`, { status: r.status, headers: r.headers, body: r.body }]);
  } };
  await get('campaign creators', base);
  for (const kind of ['email', 'advocacy'] as const) {
    let r = await creator.create(actor, brand.id, randomUUID(), campaignBrief(profile, kind));
    r = await creator.approve(actor, brand.id, r.id, r.rowVersion, r.version!.contentSha, true);
    await get(`${kind} campaign review`, `${base}/${r.id}`);
    await get(`${kind} campaign text export`, `${base}/${r.id}/export`);
    await get(`${kind} campaign JSON export`, `${base}/${r.id}/export?format=json`);
  }
  // The founder-only pack controls refuse a client's post exactly like an action that does not exist.
  const csrf = nativeCsrf(who);
  for (const action of ['update', 'disable', 'activate', 'nothing-here'])
    out.push([`POST methods/${action}`, await nativeSeoCall(engine, { who, method: 'POST', path: `/portal/seo-blog/b/${brand.id}/methods/${action}`, fields: { _csrf: csrf, revision: '1', packId: ['email-writing'] }, founder }).then((r) => ({ status: r.status, headers: r.headers, body: r.body }))]);
  out.push(['POST unknown action', await nativeSeoCall(engine, { who, method: 'POST', path: `/portal/seo-blog/b/${brand.id}/nothing-here`, fields: { _csrf: csrf }, founder }).then((r) => ({ status: r.status, headers: r.headers, body: r.body }))]);
  return { out, methods, brand };
}

test('Creative studio pages, their task page and job JSON stay neutral for a client, old look and new', async () => {
  const failures: string[] = [];
  const all = await creativeScene(false);
  for (const [name, r] of all) assertClean(failures, name, r.body, r.headers['content-type'] ?? 'text/html');
  if (failures.length) assert.fail(`Client-visible leaks (${failures.length}):\n${failures.join('\n')}`);
  const pick = (n: string) => all.find(([k]) => k === n)![1];
  for (const look of ['old look', 'new look']) for (const n of ['creative', 'creative generate', 'creative brief', 'creative kit', 'creative set', 'creative task', 'creative jobs (JSON)']) assert.equal(pick(`${look} · ${n}`).status, 200, `${look} · ${n} renders`);
  has(pick('old look · creative task').body, /Image generation could not finish/, 'the task page says what happened in plain words');
  has(pick('old look · creative jobs (JSON)').body, /"detail":"Image generation could not finish/);
  has(pick('old look · creative brief').body, /Image generation could not finish/);
  // The founder reads the raw text underneath.
  const founder = new Map(await creativeScene(true));
  has(founder.get('old look · creative task')!.body, /<summary>Technical detail<\/summary>[\s\S]*gpt-image-2/);
  has(founder.get('old look · creative brief')!.body, /<summary>Technical detail<\/summary>[\s\S]*gpt-image-2/);
});

test('campaign creators, their review pages and both exports stay neutral for a client; a client cannot post to Production rules', async () => {
  const failures: string[] = [];
  const { out: all, methods, brand } = await creatorScene(false);
  for (const [name, r] of all) assertClean(failures, name, r.body, r.headers['content-type'] ?? 'text/html');
  for (const [name, r] of all) for (const field of ['methodReceiptId', 'receipt', 'promptVersion', 'tokensIn', 'packId', '_method_sidecar']) if (r.body.includes(field)) failures.push(`${name}: carries stored field ${field}`);
  if (failures.length) assert.fail(`Client-visible leaks (${failures.length}):\n${failures.join('\n')}`);
  const pick = (n: string) => all.find(([k]) => k === n)![1];
  for (const look of ['old look', 'new look']) for (const kind of ['email', 'advocacy']) for (const n of ['campaign review', 'campaign text export', 'campaign JSON export']) assert.equal(pick(`${look} · ${kind} ${n}`).status, 200, `${look} · ${kind} ${n}`);
  has(pick('old look · email campaign JSON export').body, /"kind": "email"/);
  const unknown = pick('POST unknown action');
  for (const action of ['update', 'disable', 'activate', 'nothing-here']) {
    const r = pick(`POST methods/${action}`);
    assert.equal(r.status, unknown.status, `POST methods/${action}: same status as an unknown action`);
    assert.equal(r.body, unknown.body, `POST methods/${action}: same answer as an unknown action`);
  }
  assert.equal(unknown.status, 404);
  assert.equal((await methods.snapshot(brand.id)).assignment!.revision, 1, 'nothing changed');
  // The founder keeps full use.
  const founder = new Map((await creatorScene(true)).out);
  assert.equal(founder.get('POST methods/update')!.status, 303);
});

test('the SEO report in every state, and the allowance and "Write it now" states, stay neutral for a client', async () => {
  const failures: string[] = [];
  const newLook = () => ({ ...fx.shell(), preview: { needsYou: 1, path: '/x' } }) as ReturnType<typeof fx.shell>;
  const briefs = { measured: sp.measured(), unmeasured: sp.brief(), none: null, 'measured without numbers': sp.brief({ demand: { kind: 'measured', volume: null, competition: null, provider: 'dataforseo', retrievedAt: 'not a date' } as never }) };
  for (const [look, shell] of [['old look', fx.shell], ['new look', newLook]] as const) {
    for (const [state, b] of Object.entries(briefs)) for (const open of [[], ['seo']]) {
      const html = editorPage(shell(), { ...fx.pageData('ready'), articleBrief: b, open });
      assertClean(failures, `${look} · SEO report (${state}${open.length ? ', open' : ''})`, html);
      assert.ok(html.includes('r72-seo-panel'), `${look} · ${state}: the report is there`);
    }
  }
  // Allowance states through the router, with the engine's full refusal text on the stopped task.
  const full = 'Writing allowance: monthly ceiling reached. Used 2,000,000; ceiling 2,000,000; remaining 0 model tokens. Action estimate 32,000; shortfall 32,000. Minimum estimated monthly ceiling 2,032,000. Review Publishing settings before retrying.';
  const B = `/portal/seo-blog/b/${SHOWCASE_BRAND}`;
  for (const [state, usage] of [['enough now ("Write it now")', 412_000], ['still waiting', 1_990_000]] as const) {
    const s = showcase('calm', {});
    s.jobs[0] = { ...s.jobs[0]!, state: 'blocked', error: full };
    s.usage = { model_tokens: usage, search_calls: 3, images: 0 };
    for (const [look, opts] of [['old look', {}], ['new look', NEW]] as const) {
      for (const [name, path] of [['home', `${B}/overview`], ['articles', `${B}/articles`], ['article', `${B}/articles/${showcaseArticle(13)}`], ['calendar', `${B}/calendar?date=2026-11-16`]] as const) {
        const r = await call(s.service, identity(), 'GET', path, opts);
        assertClean(failures, `${look} · ${state} · ${name}`, r.body);
        if (state.startsWith('enough') && name !== 'calendar' && !(look === 'old look' && name === 'home')) has(r.body, /Write it now/, `${look} · ${name}: "Write it now"`);
      }
    }
  }
  if (failures.length) assert.fail(`Client-visible leaks (${failures.length}):\n${failures.join('\n')}`);
});

test('the writing allowance is said in articles for a client, from the engine\'s own per-article estimate; the units stay in Technical detail', async () => {
  const f = await scene();
  const all = new Map(await surfaces(f, false));
  const founder = new Map(await surfaces(f, true));
  const used = (await f.h.engine.usage(OWNER, f.brand.id)).model_tokens;
  const left = Math.floor((2_000_000 - used) / 32_000);
  for (const look of ['old look', 'new look']) {
    if (look === 'old look') has(all.get(`${look} · overview`)!.body, new RegExp(`enough left this month for about ${left} more articles`));
    hasNot(readable(all.get(`${look} · overview`)!.body, 'text/html'), /writing units/, `${look}: no units on the client overview`);
    hasNot(readable(all.get(`${look} · topics`)!.body, 'text/html'), /writing units/, `${look}: no units on the client topics page`);
    hasNot(readable(all.get(`${look} · setup`)!.body, 'text/html'), /writing units/, `${look}: no units on the client setup page`);
    if (look === 'old look') has(founder.get(`${look} · overview`)!.body, /<summary>Technical detail<\/summary><p class="muted">Writing units: [\d,]+ of 2,000,000 used/);
  }
});

// ─── The tests ───────────────────────────────────────────────────────────────

test('the banned list is built from the code and covers every kind of term', () => {
  const terms = BANNED.map((b) => b.term.toLowerCase());
  for (const t of ['dataforseo', 'dataforseo-serp', 'api.dataforseo.com', 'zernio', 'claude', 'claude-sonnet-4-6', 'sonnet', 'opus', 'haiku', 'anthropic', 'openai', 'gpt-image-2', 'blog-writing', 'editorial-planning', 'production-core',
    'blog.figures-cited-exactly', 'rl72 engine room', 'engine room', 'longform forge', 'inbox engine', 'word of mouth engine', 'prompt', 'tokens', 'supplier attempts', 'provider', 'api key', 'method pack', 'simulated']) assert.ok(terms.includes(t), `banned list includes ${t}`);
  assert.ok(!terms.includes('relaunch72'), 'the platform name is allowed');
  assert.ok(BANNED.length > 60, `${BANNED.length} banned terms`);
});

test('the dictionary turns raw supplier, model, method and rejection text into neutral sentences, and leaves neutral text alone', () => {
  for (const raw of [SDK_ERROR, METHOD_ERROR, REJECTION, UNCERTAIN, 'Unavailable capability: email-writing', 'Method release has no private-use approval: blog-writing@0.1.1', 'Connect a writing model API key (server configuration).', 'Connect a research provider (server configuration).',
    ...[40101, 40103, 40100, 40104, 40200, 40203, 40204].map((c) => { const d = researchDiagnostic(c); return `${d.summary} ${d.remedy}`; }), 'Applying the saved planning result; no new model call.',
    'Writing allowance: monthly ceiling reached. Used 2,000,000; ceiling 2,000,000; remaining 0 model tokens.', 'x: The DataForSEO account requires verification.', IMAGE_ERROR]) {
    const words = ownerWords(raw);
    assert.equal(revealsInternals(words), false, `${raw} → ${words}`);
    assert.deepEqual(offences(words, 'text/plain'), [], `${raw} → ${words}`);
    assert.doesNotMatch(words, /[–—]/, 'no em or en dashes');
  }
  for (const plain of ['Waiting to start', 'Done.', 'Paused until the issue is fixed.', 'Writing allowance: monthly ceiling reached.', '“Bridging loans explained” written (version 2).']) assert.equal(ownerWords(plain), plain);
  assert.equal(ownerActivityWords('write: Done.'), 'write: Done.');
  hasNot(ownerActivityWords(`write: ${SDK_ERROR}`), /write:|anthropic|model/i, "the activity line drops the task prefix and the SDK text");
});

test('a client sees no supplier, model, maker, method pack, rule id, product name or internal word on any surface, old look or new', async () => {
  const f = await scene();
  const failures: string[] = [];
  const all = await surfaces(f, false);
  for (const [name, r] of all) assertClean(failures, name, r.body, r.headers['content-type'] ?? 'text/html');
  for (const [name, body] of await publisherPayloads(f)) assertClean(failures, name, body, 'application/json');
  // Production rules: the same 404 as a page that does not exist, and no link to it anywhere.
  const pick = (n: string) => all.find(([k]) => k === n)![1];
  for (const look of ['old look', 'new look']) {
    if (pick(`${look} · methods`).status !== 404) failures.push(`${look} · methods: Production rules is a client page (status ${pick(`${look} · methods`).status})`);
    else if (pick(`${look} · methods`).body.replaceAll('/methods', '/<page>') !== pick(`${look} · missing`).body.replaceAll('/nothing-here', '/<page>')) failures.push(`${look} · methods: does not answer exactly like a page that does not exist`);
  }
  for (const [name, r] of all) if (r.status === 200 && /\/methods"/.test(r.body)) failures.push(`${name}: links to Production rules`);
  // Stored but never shown: the generation and source records do not reach any page or JSON answer.
  for (const [name, r] of all) for (const field of ['promptVersion', 'methodReceiptId', 'receipt-blog-writing-1', 'receipt-editorial-planning-1', 'seo-blog-article.md', 'seo-blog-plan-v2.md', 'tokensIn', 'tokensOut', 'task-11071234']) if (r.body.includes(field)) failures.push(`${name}: carries stored field ${field}`);
  if (failures.length) assert.fail(`Client-visible leaks (${failures.length}):\n${failures.join('\n')}`);
  // The pages under test are real pages (a test that renders only error pages would prove nothing).
  for (const n of ['overview', 'setup', 'topics', 'articles', 'article', 'article-failed', 'publishing', 'activity', 'calendar', 'social', 'dna']) for (const look of ['old look', 'new look']) assert.equal(pick(`${look} · ${n}`).status, 200, `${look} · ${n} renders`);
  assert.equal(pick('old look · profile status (JSON)').status, 200);
  has(pick('old look · profile status (JSON)').body, /"detail":"The writing service could not be reached/);
  has(pick('old look · topics').body, /Measured: 880 searches\/month \(measured, Oct 2026\)/);
  has(pick('old look · activity').body, /The writing service could not be reached/);
  has(pick('old look · topics').body, /Research is not available for this business right now/);
});

test('pages rendered directly in states the router fixture cannot reach stay neutral for a client', () => {
  const failures: string[] = [];
  const b = { id: '00000000-0000-4000-8000-0000000000aa', name: 'Harbour', slug: 'harbour', website: 'https://bay.example', locale: 'en-GB', timezone: 'Europe/London', rowVersion: 1,
    settings: { autoPublish: false, pauseAll: false, ongoingProduction: false, autoAcceptPlans: false, cadence: { weekdays: [1], localTime: '09:00', perWeek: 1 }, planningHorizonDays: 30, backlogCeiling: 3, budgets: { modelTokensPerMonth: 0, searchCallsPerMonth: 0, imagesPerMonth: 0 } } } as unknown as Brand;
  const shell: Shell = { brands: [b], brand: b, tab: 'overview', csrf: 'c', limitsAvailable: false, methodsAvailable: true, creatorsAvailable: true };
  const readiness = { website: true, knowledge: 1, unreadableKnowledge: 0, profile: 'confirmed', inventory: true, research: false, generation: 'simulated', budgets: false, destination: 'none', canPlan: false,
    missing: ['Connect a research provider (server configuration).', 'Connect a writing model API key (server configuration).', 'Set monthly writing and research budgets.'] } as const;
  for (const look of [{}, { preview: { needsYou: 0, path: '/x' } }]) {
    assertClean(failures, 'overview, nothing set up', overviewPage({ ...shell, ...look }, { readiness: readiness as never, articles: [], usage: { model_tokens: 0, search_calls: 0, images: 0 }, jobs: [] }));
    assertClean(failures, 'campaign creators, both kinds switched off', campaignCreatorsPage({ ...shell, ...look, tab: 'campaigns' }, { confirmedAt: 'x', audiences: ['a'], conversionPages: ['p'], conflicts: [] } as never, [], [], []));
    assertClean(failures, 'campaign creators, both kinds on', campaignCreatorsPage({ ...shell, ...look, tab: 'campaigns' }, { confirmedAt: 'x', audiences: ['Landlords'], conversionPages: [{ url: 'https://bay.example/contact', label: 'Contact' }], conflicts: [], voice: { do: [], dont: [] }, offers: [] } as never, [], ['email', 'advocacy'], []));
  }
  if (failures.length) assert.fail(`Client-visible leaks (${failures.length}):\n${failures.join('\n')}`);
  // The founder still has the rules page itself.
  assert.match(productionRulesPage({ ...shell, limitsAvailable: true, tab: 'methods' }, { enabled: true, assignment: { revision: 1, pins: [{ packId: 'blog-writing' }] } }, true), /Longform Forge/);
});

test('the founder sees the same neutral sentences plus the technical detail, and keeps Production rules', async () => {
  const f = await scene();
  const all = new Map(await surfaces(f, true));
  const page = (n: string) => all.get(n)!.body;
  for (const look of ['old look', 'new look']) {
    const activity = page(`${look} · activity`);
    has(activity, /The writing service could not be reached/);
    has(activity, /<summary>Technical detail<\/summary>/);
    has(activity, /overloaded_error/, `${look}: the founder reads the SDK text`);
    has(activity, /Assigned method hash changed: blog-writing/, `${look}: the founder reads the method error`);
    has(activity, /blog\.figures-cited-exactly/, `${look}: the founder reads the rule ids`);
    const topics = page(`${look} · topics`);
    has(topics, /Research is not available for this business right now/);
    has(topics, /DataForSEO authentication was refused\./, `${look}: the founder reads the supplier's diagnostic`);
    has(topics, /supplier status 40100 · HTTP 401 · task task-11071234/, `${look}: the founder reads the status code and task id`);
    if (look === 'old look') has(page(`${look} · overview`), /Technical detail/, 'the founder reads the research diagnostic on the overview');
    has(page(`${look} · publishing`), /Sonnet 4\.6[\s\S]*Check current Anthropic API pricing/, `${look}: the founder keeps the pricing guide`);
  }
  assert.equal(all.get('old look · methods')!.status, 200, 'the founder keeps Production rules');
});
