/**
 * Offline fixtures for the SEO blog engine: a scripted model, a fake search
 * provider, a static public web, an in-memory GitHub REST API and an
 * in-memory signed content-API website. They exercise mechanics, policy,
 * concurrency and failure handling — never real research quality or a live site.
 */

import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { LlmClient, LlmRequest, LlmResponse } from '../src/llm/client.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';
import { contentApiSignature } from '../src/seo-blog/publishers/content-api.js';
import { ContentApiPublisher } from '../src/seo-blog/publishers/content-api.js';
import { GithubStaticPublisher } from '../src/seo-blog/publishers/github-static.js';
import type { PublisherRegistry } from '../src/seo-blog/publishers/registry.js';
import type { WebsitePublisher } from '../src/seo-blog/publishers/types.js';
import type { SearchHit, SearchProvider } from '../src/seo-blog/research.js';
import { validatePublicUrl, type FetchedResource, type FetchOptions, type FetchTransport } from '../src/seo-blog/safe-fetch.js';
import { MemorySeoBlogStore } from '../src/seo-blog/store.js';
import type { DestinationType } from '../src/seo-blog/types.js';
import { SeoBlogCredentialVault } from '../src/seo-blog/vault.js';

export const OWNER = { userId: '11111111-1111-4111-8111-111111111111' };
export const STRANGER = { userId: '22222222-2222-4222-8222-222222222222' };

export class Clock {
  constructor(public ms: number) {}
  now = (): string => new Date(this.ms).toISOString();
  advance(ms: number): void { this.ms += ms; }
  set(iso: string): void { this.ms = Date.parse(iso); }
}

// ─── Public web ──────────────────────────────────────────────────────────────

type Page = { status?: number; contentType?: string; body: string };

export class FakeWeb implements FetchTransport {
  readonly pages = new Map<string, Page>();
  readonly dynamic: ((url: string) => Page | null)[] = [];
  readonly requests: string[] = [];
  set(url: string, page: Page | string): void {
    this.pages.set(url, typeof page === 'string' ? { body: page } : page);
  }
  async fetch(raw: string, options: FetchOptions = {}): Promise<FetchedResource> {
    const url = validatePublicUrl(raw).toString();
    this.requests.push(url);
    let page: Page | null = this.pages.get(url) ?? null;
    for (const d of this.dynamic) page ??= d(url);
    const body = Buffer.from(page?.body ?? 'Not found');
    const max = options.maxBytes ?? 2_000_000;
    return { url: raw, finalUrl: url, status: page ? page.status ?? 200 : 404, contentType: page?.contentType ?? 'text/html; charset=utf-8', body: body.subarray(0, max), truncated: body.length > max, headers: {} };
  }
}

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 7 === 0 ? '.' : ''}`).join(' ');

export function seedBrandSite(web: FakeWeb, origin: string, topic: string): void {
  web.set(`${origin}/robots.txt`, { contentType: 'text/plain', body: `User-agent: *\nSitemap: ${origin}/sitemap.xml\n` });
  web.set(`${origin}/sitemap.xml`, { contentType: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/guides/${topic}-basics</loc></url><url><loc>${origin}/pricing</loc></url></urlset>` });
  web.set(`${origin}/`, `<html><head><title>Home</title></head><body><h1>Welcome</h1><a href="/guides/${topic}-basics">Guide</a><a href="/about">About</a></body></html>`);
  web.set(`${origin}/guides/${topic}-basics`, `<html><head><title>${topic} basics for landlords</title><link rel="canonical" href="${origin}/guides/${topic}-basics"><meta property="article:published_time" content="2026-05-01T09:00:00Z"></head><body><main><h1>${topic} basics for landlords</h1><h2>Why it matters</h2><p>${words(160, 'context')}</p><h2>What to do next</h2><p>${words(160, 'steps')}</p></main></body></html>`);
  web.set(`${origin}/pricing`, `<html><head><title>Pricing</title></head><body><h1>Pricing</h1><p>Plans</p></body></html>`);
  web.set(`${origin}/about`, `<html><head><title>About us</title></head><body><main><h1>About us</h1><p>We help landlords.</p></main></body></html>`);
}

export function seedResearchWeb(web: FakeWeb): void {
  web.set('https://www.gov.uk/deposit-protection-schemes-and-landlords', `<html><head><title>Deposit protection schemes and landlords - GOV.UK</title></head><body><main><h1>Deposit protection</h1><p>You must put your tenants’ deposit in a government-backed tenancy deposit scheme (TDP) if you rent your home on an assured shorthold tenancy that started after 6 April 2007. You must protect the deposit within 30 days of getting it. Deposit protection rules apply in England and Wales.</p></main></body></html>`);
  web.set('https://www.gov.uk/private-renting/tenancy-deposit-protection', `<html><head><title>Tenancy deposit protection - GOV.UK</title></head><body><main><h1>Tenancy deposit protection</h1><p>Your landlord must put your deposit in a government-approved tenancy deposit scheme. At the end of your tenancy your deposit must be returned to you within 10 days of you both agreeing how much you will get back.</p></main></body></html>`);
  web.set('https://landlord-news.example/deposits-explained', `<html><head><title>Deposits explained</title></head><body><main><h1>Deposits</h1><p>Landlords often ask how deposit disputes are resolved and what evidence helps. A clear inventory and check-in report make disputes easier to settle for everyone involved in the tenancy.</p></main></body></html>`);
}

export class FakeSearch implements SearchProvider {
  readonly id = 'fake-serp';
  readonly mode = 'live' as const;
  calls = 0;
  async search(): Promise<SearchHit[]> {
    this.calls++;
    return [
      { url: 'https://landlord-news.example/deposits-explained', title: 'Deposits explained', snippet: '' },
      { url: 'https://www.gov.uk/deposit-protection-schemes-and-landlords', title: 'Deposit protection', snippet: '' },
      { url: 'https://www.gov.uk/private-renting/tenancy-deposit-protection', title: 'Tenancy deposit protection', snippet: '' },
    ];
  }
}

// ─── Scripted model ──────────────────────────────────────────────────────────

function block(content: string, tag: string): unknown {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(content);
  return m ? JSON.parse(m[1]!) : null;
}

export class ScriptedModel implements LlmClient {
  readonly mode = 'mock' as const;
  readonly calls: string[] = [];
  /** Override the article response (e.g. to inject an unsupported figure). */
  articleOverride: ((base: Record<string, unknown>) => Record<string, unknown>) | null = null;
  failNext = 0;

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const stage = req.meta?.stage ?? '';
    this.calls.push(stage);
    if (this.failNext > 0) { this.failNext--; throw new Error('model unavailable'); }
    const content = req.messages[0]!.content;
    let out: unknown;
    if (stage === 'SEO_BLOG_PROFILE') {
      const docs = block(content, 'knowledge_documents') as { id: string; title: string }[];
      const brand = /Brand name: (.+)/.exec(content)?.[1] ?? 'Brand';
      const site = /Website: (\S+)/.exec(content)?.[1] ?? 'https://example.com';
      out = {
        summary: `${brand} helps UK landlords stay compliant and let property with confidence.`,
        audiences: ['Accidental landlords in England', 'Portfolio landlords'],
        positioning: 'Plain-English compliance help for private landlords',
        offers: [{ name: `${brand} Compliance Plan`, description: 'Monthly compliance support', price: '£49 per month', url: `${site}/pricing`, sourceDocumentId: docs[0]!.id }],
        conversionPages: [{ url: `${site}/pricing`, label: 'See plans' }],
        voice: { tone: ['plain', 'reassuring'], do: ['Explain rules simply'], dont: ['avoid jargon'], examples: ['We keep it simple.'] },
        approvedClaims: ['We explain landlord rules in plain English.'],
        exclusions: ['Tax advice'],
        conflicts: [],
        missingFacts: ['Named author'],
      };
    } else if (stage === 'SEO_BLOG_PLAN') {
      const inventory = block(content, 'website_inventory') as { url: string; editorial: boolean }[];
      const existing = inventory.find((p) => p.editorial)?.url ?? inventory[0]!.url;
      const base = (slug: string, title: string, role: 'pillar' | 'supporting', query: string) => ({
        role, slug, working_title: title, target_query: query, search_intent: 'learn',
        related_questions: ['When must a deposit be protected?'],
        angle: 'A plain-English walkthrough grounded in the official rules for private landlords.',
        outline: role === 'pillar' ? ['What the law requires', 'How protection works', 'Returning the deposit', 'Common mistakes'] : ['The rule', 'What to do', 'Next steps'],
        key_points: ['Protect the deposit within the legal deadline [S2].', 'Keep evidence of condition.'],
        why_fit: 'The brand’s landlords repeatedly need this compliance step explained clearly.',
        cta_url: null, internal_links: role === 'pillar' ? [existing] : ['tenancy-deposit-protection-guide'], source_ids: ['S1', 'S2'],
      });
      out = {
        topic: 'Tenancy deposit protection for private landlords',
        money_page: { url: null, label: 'See plans' },
        pillar: base('tenancy-deposit-protection-guide', 'Tenancy deposit protection: a landlord’s guide', 'pillar', 'how does tenancy deposit protection work'),
        supporting: [
          base('deposit-deadline-30-days', 'The deposit protection deadline explained', 'supporting', 'deposit protection deadline'),
          base('returning-a-tenancy-deposit', 'Returning a tenancy deposit at the end of a let', 'supporting', 'how to return a tenancy deposit'),
          base('deposit-dispute-evidence', 'What evidence helps in a deposit dispute', 'supporting', 'deposit dispute evidence'),
          base('choosing-a-deposit-scheme', 'Choosing between deposit protection schemes', 'supporting', 'which deposit scheme to choose'),
          base('prescribed-information-checklist', 'Prescribed information: a checklist', 'supporting', 'prescribed information deposit'),
          // Deliberately overlaps the existing site guide to exercise duplicate detection.
          base('deposits-basics-for-landlords', 'deposits basics for landlords', 'supporting', 'deposits basics for landlords'),
        ],
        provenance_note: 'Cluster chosen from the brand profile, the site inventory and the research sources.',
      };
    } else if (stage === 'SEO_BLOG_ARTICLE') {
      const sources = block(content, 'research_sources') as { id: string; url: string; passage: string }[];
      const linkable = block(content, 'linkable_pages') as { url: string }[];
      const gov = sources.find((s) => s.passage.includes('30 days')) ?? sources[0]!;
      const brief = block(content, 'brief') as { working_title: string };
      const guide = linkable.find((l) => l.url.includes('/guides/'))?.url;
      const filler = 'Landlords who keep clear records, explain each step to tenants and check the scheme paperwork early usually find the process calm and predictable for everyone involved.';
      const base: Record<string, unknown> = {
        title: brief.working_title,
        seo_title: brief.working_title.slice(0, 60),
        meta_description: 'A plain-English explanation of tenancy deposit protection rules for private landlords in England and Wales.',
        excerpt: 'What landlords need to know about protecting a tenancy deposit.',
        intro: `Protecting a tenancy deposit is one of the first legal steps after a let begins. ${filler}`,
        sections: [
          { heading: 'What the law requires', body: `Deposit protection is a legal requirement: you must protect the deposit within 30 days of getting it [src:${gov.id}]. ${filler}` },
          { heading: 'How to stay organised', body: `${guide ? `Our [basics guide](${guide}) covers the wider picture. ` : ''}${filler} ${filler}` },
          { heading: 'Common mistakes', body: `${filler} Missing paperwork is the most frequent problem we see raised by landlords asking for help.` },
        ],
        conclusion: `${filler} If you want help, see the plans.`,
        faqs: [{ q: 'Do all landlords need a scheme?', a: 'Most private landlords letting on an assured shorthold tenancy do; check the official guidance for your situation.' }],
        image_alt: 'An illustrated key resting on a tenancy agreement',
        public_source_ids: [gov.id],
      };
      out = this.articleOverride ? this.articleOverride(base) : base;
    } else if (stage === 'SEO_BLOG_SECTION') {
      const section = block(content, 'section') as { heading: string };
      out = { heading: section.heading, body: 'Rewritten section. Landlords who keep clear records and talk to tenants early usually find this part of the process calm, predictable and easy to evidence if questions come up later.' };
    } else {
      throw new Error(`unexpected stage ${stage}`);
    }
    return { text: JSON.stringify(out), tokensIn: 1000, tokensOut: 800, stopReason: 'end_turn', model: 'scripted' };
  }
}

// ─── In-memory GitHub ────────────────────────────────────────────────────────

export class FakeGithub {
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  head: string;
  /** Apply the ref update then throw a network error (outcome unknown). */
  dropNextRefResponse = false;
  /** Throw a network error WITHOUT applying the ref update (outcome unknown, actually absent). */
  failNextRefBeforeApply = 0;
  /** Move the branch underneath the publisher once (concurrent site edit). */
  concurrentEditOnce = false;
  refPatches = 0;
  private n = 0;
  constructor(readonly repo: string, files: Record<string, string>) {
    const tree = this.sha('tree');
    this.trees.set(tree, new Map(Object.entries(files)));
    this.head = this.sha('commit');
    this.commits.set(this.head, { tree, parents: [], message: 'initial' });
  }
  private sha(kind: string): string { return createHash('sha1').update(`${kind}${this.n++}`).digest('hex'); }
  files(commit = this.head): Map<string, string> {
    const sha = this.commits.has(commit) ? commit : this.head; // a branch name resolves to the head
    return this.trees.get(this.commits.get(sha)!.tree)!;
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace(`/repos/${this.repo}`, '');
    const method = init.method ?? 'GET';
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!String((init.headers as Record<string, string>)?.authorization ?? '').startsWith('Bearer gh-token')) return json(401, {});
    if (method === 'GET' && path === '') return json(200, { permissions: { push: true } });
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) return json(200, { object: { sha: this.head } });
    if (method === 'GET' && path.startsWith('/git/commits/')) { const c = this.commits.get(path.split('/').pop()!); return c ? json(200, { tree: { sha: c.tree } }) : json(404, {}); }
    if (method === 'GET' && path.startsWith('/contents/')) {
      const file = decodeURIComponent(path.slice('/contents/'.length));
      const ref = u.searchParams.get('ref') ?? this.head;
      const content = this.files(ref).get(file);
      return content === undefined ? json(404, {}) : json(200, { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    if (method === 'POST' && path === '/git/trees') {
      const body = JSON.parse(String(init.body)) as { base_tree: string; tree: { path: string; content: string }[] };
      const files = new Map(this.trees.get(body.base_tree)!);
      for (const e of body.tree) files.set(e.path, e.content);
      const sha = this.sha('tree');
      this.trees.set(sha, files);
      return json(201, { sha });
    }
    if (method === 'POST' && path === '/git/commits') {
      const body = JSON.parse(String(init.body)) as { tree: string; parents: string[]; message: string };
      const sha = this.sha('commit');
      this.commits.set(sha, body);
      return json(201, { sha });
    }
    if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
      if (this.failNextRefBeforeApply > 0) { this.failNextRefBeforeApply--; throw new TypeError('fetch failed'); }
      this.refPatches++;
      if (this.concurrentEditOnce) {
        this.concurrentEditOnce = false;
        const files = new Map(this.files());
        files.set('about.html', '<p>edited by a human</p>');
        const tree = this.sha('tree'); this.trees.set(tree, files);
        const sha = this.sha('commit'); this.commits.set(sha, { tree, parents: [this.head], message: 'human edit' });
        this.head = sha;
      }
      const body = JSON.parse(String(init.body)) as { sha: string; force: boolean };
      if (body.force) return json(422, { message: 'force not allowed in fake' });
      if (this.commits.get(body.sha)!.parents[0] !== this.head) return json(422, { message: 'Update is not a fast forward' });
      this.head = body.sha;
      if (this.dropNextRefResponse) { this.dropNextRefResponse = false; throw new TypeError('fetch failed'); }
      return json(200, { object: { sha: body.sha } });
    }
    return json(404, { message: `unhandled ${method} ${path}` });
  };

  /** Serve the branch head as a static site (what GitHub Pages would deploy). */
  serve(origin: string): (url: string) => Page | null {
    return (url: string) => {
      if (!url.startsWith(origin)) return null;
      let path = url.slice(origin.length).replace(/^\//, '');
      if (path === '' || path.endsWith('/')) path += 'index.html';
      const body = this.files().get(path);
      return body === undefined ? null : { body, contentType: path.endsWith('.xml') ? 'application/xml' : 'text/html' };
    };
  }
}

// ─── In-memory signed content-API site ───────────────────────────────────────

export class FakeContentSite {
  readonly articles = new Map<string, { versionId: string; slug: string; html: string; title: string }>();
  posts = 0;
  constructor(readonly origin: string, readonly secret: string) {}
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === 'string' ? init.body : '';
    const expected = contentApiSignature(this.secret, headers['x-r72-timestamp']!, init.method ?? 'GET', u.pathname, body);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (headers['x-r72-signature'] !== expected) return json(401, { error: 'bad signature' });
    if (u.pathname.endsWith('/status')) {
      if (u.searchParams.get('check')) return json(200, { ok: true });
      const a = this.articles.get(u.searchParams.get('article')!);
      return json(200, { state: !a ? 'absent' : a.versionId === u.searchParams.get('version') ? 'present' : 'other_version' });
    }
    this.posts++;
    const p = JSON.parse(body) as { articleId: string; versionId: string; slug: string; title: string; articleHtml: string; marker: string };
    const existing = this.articles.get(p.articleId);
    if (existing?.versionId === p.versionId) return json(200, { status: 'already_present', ref: p.versionId });
    this.articles.set(p.articleId, { versionId: p.versionId, slug: p.slug, title: p.title, html: `<html><head><meta name="r72-blog-version" content="${p.marker}"></head><body>${p.articleHtml}</body></html>` });
    return json(201, { status: 'published', ref: p.versionId });
  };
  serve(): (url: string) => Page | null {
    return (url: string) => {
      for (const a of this.articles.values()) if (url === `${this.origin}/blog/${a.slug}`) return { body: a.html };
      return null;
    };
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

export interface Harness {
  engine: SeoBlogEngine;
  store: MemorySeoBlogStore;
  web: FakeWeb;
  llm: ScriptedModel;
  search: FakeSearch;
  clock: Clock;
  github: FakeGithub;
  site: FakeContentSite;
  vault: SeoBlogCredentialVault;
  makeEngine(): SeoBlogEngine;
}

export function harness(start = '2026-11-02T10:00:00.000Z'): Harness {
  const clock = new Clock(Date.parse(start));
  const store = new MemorySeoBlogStore();
  const web = new FakeWeb();
  seedResearchWeb(web);
  const llm = new ScriptedModel();
  const search = new FakeSearch();
  const github = new FakeGithub('acme/site', { 'index.html': '<h1>Acme</h1>', 'sitemap.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://harbour.example/</loc></url>\n</urlset>\n' });
  web.dynamic.push(github.serve('https://harbour.example'));
  const site = new FakeContentSite('https://bay.example', 'x'.repeat(40));
  web.dynamic.push(site.serve());
  const vault = new SeoBlogCredentialVault(Buffer.alloc(32, 7));
  const publishers: PublisherRegistry = new Map<DestinationType, WebsitePublisher>([
    ['github_static', new GithubStaticPublisher(github.fetch, 1000)],
    ['content_api', new ContentApiPublisher(site.fetch, 1000, () => clock.ms)],
  ]);
  const makeEngine = () => new SeoBlogEngine({ store, llm, search, transport: web, publishers, vault, now: clock.now, batchLimit: 20 });
  return { engine: makeEngine(), store, web, llm, search, clock, github, site, vault, makeEngine };
}

/** Minimal valid DOCX (word/document.xml only). */
export function makeDocx(paragraphs: string[]): Buffer {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  return makeZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]);
}

export function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const compressed = deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function makePdf(pageStreams: (string | null)[]): Buffer {
  const parts: string[] = ['%PDF-1.4\n'];
  pageStreams.forEach((stream, i) => {
    parts.push(`${10 + i} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`);
    if (stream !== null) parts.push(`${30 + i} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
    else parts.push(`${30 + i} 0 obj\n<< /Type /XObject /Subtype /Image /Length 4 >>\nstream\n\u0000\u0001\u0002\u0003\nendstream\nendobj\n`);
  });
  parts.push('trailer\n<< >>\n%%EOF\n');
  return Buffer.from(parts.join(''), 'latin1');
}
