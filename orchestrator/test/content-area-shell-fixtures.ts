/**
 * Fixtures for the content area shell preview: a small in-memory stand-in for the SEO blog engine (only the reads the
 * owner pages make), a realistic business, and a helper that renders any page through the real router.
 *
 * Scenarios:
 * - "busy": five articles need the owner, some are live, some are going out this week, one is being written and
 *   the publishing days ahead are still empty.
 * - "calm": nothing needs the owner; articles are live and going out.
 * - "new": a brand-new business with no articles.
 * - "hostile": the busy business with a hostile business name and hostile titles (escaping checks).
 */
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSeoBlog } from '../src/portal/seo-blog-router.js';
import type { PortalSeoBlogService } from '../src/portal/seo-blog-service.js';
import type { PortalSessionIdentity } from '../src/portal/auth-service.js';
import type { SeoBlogEngine, PublishingPlan } from '../src/seo-blog/engine.js';
import { nextPublishingSlot, plannedSiteGone, publishingSite } from '../src/seo-blog/publishing-plan.js';
import type { Article, ArticleBody, ArticleBrief, ArticleVersion, Brand, Destination, Job } from '../src/seo-blog/types.js';
import { SeoBlogError } from '../src/seo-blog/types.js';
import * as fx from './seo-blog-article-page-fixtures.js';

export const SECRET = 's'.repeat(48);
export const NOW = '2026-11-16T12:00:00.000Z';
export const OWNER_ID = '11111111-1111-4111-8111-111111111111';
export const BRAND_ID = fx.BRAND_ID;
export const HOSTILE_NAME = '<script>alert("biz")</script> & Sons\'';
export const HOSTILE_TITLE = '<img src=x onerror=alert(1)> "Quotes" & \'more\'';

export type Scenario = 'busy' | 'calm' | 'new' | 'hostile';

export function identity(userId = OWNER_ID): PortalSessionIdentity {
  return { sessionToken: `token-${userId}`, userId, workspaceId: '33333333-3333-4333-8333-333333333333', userEmail: 'owner@example.test' };
}

const IMG = 'https://www.martinhowardproperty.example/images/';
const pic = (name: string, alt: string): ArticleBody['image'] => ({ kind: 'brand_asset', url: `${IMG}${name}.jpg`, alt, provenance: '', width: 1536, height: 1024 } as ArticleBody['image']);
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const vid = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Spec {
  readonly n: number;
  readonly title: string;
  readonly excerpt: string;
  readonly image?: ArticleBody['image'];
  readonly article: Partial<Article>;
  readonly status: string;
  /** The planned date of the topic (shown on the calendar for drafts). */
  readonly suggested?: string;
  readonly written?: boolean;
}

const schedule = (localDate: string, localTime = '09:00') => ({ publishAtUtc: `${localDate}T${localTime}:00.000Z`, localDate, localTime, timezone: 'Europe/London', destinationId: fx.destination.id, setAt: '2026-11-12T10:00:00.000Z', setBy: 'owner' });

function specs(scenario: Scenario): Spec[] {
  if (scenario === 'new') return [];
  const t = (s: string) => scenario === 'hostile' ? `${s} ${HOSTILE_TITLE}` : s;
  const approved = (n: number) => ({ versionId: vid(n), contentSha: 'c'.repeat(64), approvedAt: '2026-11-12T10:00:00.000Z', approvedBy: 'owner' });
  const live = (n: number, date: string): Partial<Article> => ({ approval: approved(n), delivery: 'published', publishedVersionId: vid(n), publishedAt: `${date}T09:01:00.000Z`, publishedUrl: `https://www.martinhowardproperty.example/blog/article-${n}` });
  const needs: Spec[] = [
    { n: 1, title: t('How to appraise a UK property deal and set your maximum offer'), excerpt: 'Work backwards from the end value to an offer you can defend.', image: pic('appraise', 'A terraced house at dusk'), article: {}, status: 'Needs approval', suggested: '2026-11-23T09:00:00.000Z' },
    { n: 2, title: t('Bridging loans explained for first-time investors'), excerpt: 'What a bridging loan costs and when it makes sense.', image: pic('bridging', 'Two houses side by side'), article: { checks: { ...fx.article().checks!, status: 'critical', issues: [fx.critical] } }, status: 'Needs approval' },
    { n: 3, title: t('Five questions to ask before you buy at auction'), excerpt: 'Auctions move fast. These five questions slow you down in the right places.', image: pic('auction', 'A detached house with a tree'), article: {}, status: 'Needs approval' },
    { n: 4, title: t('Section 24 in plain English: what landlords can still claim'), excerpt: 'How mortgage interest relief works now, with a worked example.', image: pic('section24', 'A row of town houses'), article: { schedule: schedule('2026-11-30') }, status: 'Needs approval' },
    { n: 5, title: t('Is an HMO worth the extra work?'), excerpt: 'The rent, the licence and the wear and tear, side by side.', article: {}, status: 'Needs approval' },
  ];
  const going: Spec[] = [
    { n: 6, title: t('What a lender’s valuer looks for'), excerpt: 'Understand the valuation before the valuer arrives.', image: pic('valuer', 'A block of flats'), article: { approval: approved(6), schedule: schedule('2026-11-18') }, status: 'Scheduled' },
    { n: 7, title: t('Rental yield: gross, net and what really matters'), excerpt: 'Three ways to measure yield and which one to trust.', image: pic('yield', 'A street of houses at night'), article: { approval: approved(7), schedule: schedule('2026-11-20') }, status: 'Scheduled' },
  ];
  const lives: Spec[] = [
    { n: 8, title: t('Buy, refurbish, refinance: the numbers on a £140,000 terrace'), excerpt: 'A worked example from purchase to refinance.', image: pic('brrr', 'A terrace with lit windows'), article: { ...live(8, '2026-11-16'), schedule: schedule('2026-11-16') }, status: 'Published' },
    { n: 9, title: t('Buy-to-let mortgages in 2026: a plain guide'), excerpt: 'How lenders assess a buy-to-let and what has changed this year.', image: pic('mortgage', 'A house with a tree'), article: { ...live(9, '2026-11-13'), schedule: schedule('2026-11-13') }, status: 'Published' },
    { n: 10, title: t('Stamp duty on second homes, explained'), excerpt: 'What you pay on an additional home and when.', image: pic('stamp', 'A house at sunset'), article: { ...live(10, '2026-11-11'), schedule: schedule('2026-11-11') }, status: 'Published' },
    { n: 11, title: t('Leasehold or freehold: what changes for investors'), excerpt: 'The questions to ask before you buy a flat.', article: { ...live(11, '2026-11-09'), schedule: schedule('2026-11-09') }, status: 'Published' },
    { n: 12, title: t('How to read a survey without panicking'), excerpt: 'What the traffic-light ratings really mean.', image: pic('survey', 'A cottage'), article: { ...live(12, '2026-11-04'), schedule: schedule('2026-11-04') }, status: 'Published' },
  ];
  const writing: Spec = { n: 13, title: 'refurbishment budget accuracy', excerpt: '', article: { currentVersionId: null, editorialState: 'writing', checks: null, slug: 'refurbishment-budget-accuracy' }, status: 'Writing', suggested: '2026-11-27T09:00:00.000Z', written: false };
  return scenario === 'calm' ? [...going, ...lives, writing] : [...needs, ...going, ...lives, writing];
}

export interface Showcase {
  readonly brand: Brand;
  readonly brands: Brand[];
  readonly rows: { article: Article; title: string; status: string; excerpt?: string; image?: ArticleBody['image'] }[];
  readonly versions: Map<string, ArticleVersion>;
  readonly briefs: ArticleBrief[];
  readonly jobs: Job[];
  /** Mutable: tests change these to reach other states (a disconnected website, Brand DNA to confirm, no allowance, a plan to accept). */
  destinations: Omit<Destination, 'sealedCredential'>[];
  dna: 'none' | 'proposed' | 'confirmed' | 'out_of_date';
  planStatus: 'proposed' | 'accepted';
  usage: { model_tokens: number; search_calls: number; images: number };
  /** The writing service as readiness reports it (default connected). */
  generation?: 'live' | 'simulated' | 'unavailable';
  readonly service: PortalSeoBlogService;
}

export function showcase(scenario: Scenario = 'busy', settings: Partial<Brand['settings']> = {}): Showcase {
  const brand = { ...fx.brand, name: scenario === 'hostile' ? HOSTILE_NAME : fx.brand.name,
    settings: { ...fx.brand.settings, ongoingProduction: true, autoAcceptPlans: true, backlogCeiling: 12, cadence: { weekdays: [1, 3, 5], localTime: '09:00', perWeek: 3 }, ...settings } } as Brand;
  const other = { ...brand, id: 'e0000000-0000-4000-8000-000000000001', slug: 'key-lettings', name: 'Key Lettings' } as Brand;
  const versions = new Map<string, ArticleVersion>();
  const rows: Showcase['rows'] = [];
  const briefs: ArticleBrief[] = [];
  for (const s of specs(scenario)) {
    const written = s.written !== false;
    const body = fx.body({ title: s.title, excerpt: s.excerpt, image: s.image ?? fx.body().image });
    const v = { ...fx.version(3, body), id: vid(s.n), articleId: id(s.n) } as ArticleVersion;
    if (written) versions.set(v.id, v);
    const checks = written ? { ...fx.article().checks!, versionId: v.id, ...(s.article.checks ?? {}) } : null;
    const article = fx.article({ id: id(s.n), briefId: bid(s.n), slug: body.slug + '-' + s.n, currentVersionId: written ? v.id : null, createdAt: `2026-11-${String(s.n).padStart(2, '0')}T08:00:00.000Z`, ...s.article, checks: s.article.checks === null ? null : checks });
    rows.push({ article, title: s.title, status: s.status, ...(written ? { excerpt: s.excerpt } : {}), ...(s.image ? { image: s.image } : {}) });
    briefs.push({ id: bid(s.n), planId: 'p1', brandId: BRAND_ID, workingTitle: written ? s.title : 'How accurate is your refurbishment budget?', slug: article.slug, status: written ? 'generated' : 'generating', articleId: article.id,
      ...(s.suggested ? { suggestedAtUtc: s.suggested } : {}) } as unknown as ArticleBrief);
  }
  if (scenario !== 'new') briefs.push({ id: bid(40), planId: 'p1', brandId: BRAND_ID, workingTitle: 'Planning permission for loft conversions', slug: 'loft-conversions', status: 'accepted', articleId: null, suggestedAtUtc: '2026-12-04T09:00:00.000Z' } as unknown as ArticleBrief);
  const jobs: Job[] = scenario === 'new' ? [] : [{ id: 'cccccccc-1111-4222-8333-444455556666', brandId: BRAND_ID, kind: 'write', idempotencyKey: 'write:13', payload: { briefId: bid(13) }, state: 'running', attempts: 1, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null,
    runAfter: '2026-11-16T10:00:00.000Z', progress: 'Working', error: null, createdAt: '2026-11-16T10:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z', rowVersion: 2 } as Job];
  const check = (b: string) => { if (b !== BRAND_ID) throw new SeoBlogError(404, 'That business was not found.'); };
  const state = { destinations: [fx.destination] as Omit<Destination, 'sealedCredential'>[], dna: (scenario === 'new' ? 'none' : 'confirmed') as Showcase['dna'], planStatus: 'accepted' as Showcase['planStatus'], usage: { model_tokens: 412_000, search_calls: 37, images: 4 } };
  const engine = {
    campaignCreatorsReady: false, productionMethodsReady: false,
    listBrands: async () => [brand, other],
    getBrand: async (_: unknown, b: string) => { if (b === other.id) return other; check(b); return brand; },
    brandDnaStatus: async () => out.dna,
    existingWorkspaceOffer: async () => false,
    readiness: async () => { const profile = out.dna === 'confirmed' ? 'confirmed' : out.dna === 'out_of_date' ? 'stale' : out.dna === 'proposed' ? 'unconfirmed' : 'missing';
      // The engine's own readiness rule (budgets: both monthly ceilings above zero; planning needs them and a confirmed profile).
      const budgets = brand.settings.budgets.modelTokensPerMonth > 0 && brand.settings.budgets.searchCallsPerMonth > 0;
      return { website: true, knowledge: 3, unreadableKnowledge: 0, profile, inventory: true, research: true, generation: out.generation ?? 'live', budgets, destination: out.destinations.some((d) => d.status === 'connected') ? 'connected' : 'none', canPlan: profile === 'confirmed' && budgets, missing: [] }; },
    listArticles: async (_: unknown, b: string) => (b === other.id ? [] : rows),
    usage: async () => out.usage,
    listJobs: async (_: unknown, b: string) => (b === other.id ? [] : jobs),
    listPlans: async (_: unknown, b: string) => (b === other.id ? [] : [{ plan: { id: 'p1', status: out.planStatus, createdAt: '2026-11-10T09:00:00.000Z' }, briefs }]),
    listDestinations: async () => out.destinations,
    campaignCalendar: async () => [],
    activity: async () => [],
    getArticle: async (_: unknown, b: string, articleId: string) => {
      check(b);
      const row = rows.find((r) => r.article.id === articleId);
      if (!row) throw new SeoBlogError(404, 'That article was not found.');
      const version = row.article.currentVersionId ? versions.get(row.article.currentVersionId) ?? null : null;
      return { article: row.article, version, versions: version ? [version] : [], publications: [], status: row.status };
    },
    publishingPlan: async (_: unknown, _b: string, articleId: string): Promise<PublishingPlan> => {
      // The engine's own steps (engine.ts publishingPlan), over this fixture's records.
      const a = rows.find((r) => r.article.id === articleId)!.article;
      const ds = out.destinations, others = rows.map((r) => r.article), websites = ds.filter((d) => d.status === 'connected').length;
      const gone = plannedSiteGone(a, ds);
      if (gone) {
        const alt = publishingSite({ schedule: null }, brand, ds, NOW);
        return { site: null, goneSite: gone, alternative: alt ? { site: { id: alt.id, label: alt.label }, slot: nextPublishingSlot({ id: a.id, schedule: null }, brand, others, alt.id, NOW) } : null,
          websites, websitesOnRecord: ds.length, slot: null, paused: brand.settings.pauseAll, now: NOW, rowVersion: a.rowVersion };
      }
      const site = publishingSite(a, brand, ds, NOW);
      return { site: site ? { id: site.id, label: site.label } : null, websites, websitesOnRecord: ds.length, slot: site ? nextPublishingSlot(a, brand, others, site.id, NOW) : null, paused: brand.settings.pauseAll, now: NOW, rowVersion: a.rowVersion };
    },
  } as unknown as SeoBlogEngine;
  const service: PortalSeoBlogService = { generation: 'live', research: 'live', social: 'unavailable', engineFor: () => engine, socialCallback: async () => null } as PortalSeoBlogService;
  const out: Showcase = { brand, brands: [brand, other], rows, versions, briefs, jobs, ...state, service };
  return out;
}

export const articleId = id;

export interface Rendered { readonly status: number; readonly headers: Record<string, string>; readonly body: string }

/** One request through the real router. */
export async function call(service: PortalSeoBlogService, who: PortalSessionIdentity | null, method: string, path: string, opts: { form?: Record<string, string>; headers?: Record<string, string>; input?: Record<string, unknown> } = {}): Promise<Rendered> {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : '';
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: path, headers: { host: 'portal.example', ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(body)), origin: 'https://portal.example' } : {}), ...(opts.headers ?? {}) } });
  (req as PassThrough).end(body);
  let status = 0; let headers: Record<string, string> = {}; let out = '';
  const res = { writeHead(s: number, h: Record<string, string>) { status = s; headers = h; return res; }, end(chunk?: string | Buffer) { if (chunk) out += chunk.toString(); } } as unknown as ServerResponse;
  await handleSeoBlog(req, res, new URL(path, 'https://portal.example'), { service, identity: who, requestId: `r-${randomUUID()}`, sessionSecret: SECRET, vaultReady: true, ...(opts.input ?? {}) } as Parameters<typeof handleSeoBlog>[3]);
  return { status, headers, body: out };
}

/**
 * Fresh random ids (command ids made per render) and the real engine's random record ids differ on every run:
 * each distinct one becomes a numbered placeholder in order of first appearance, so the structure still compares exactly.
 */
export function normalise(html: string): string {
  const seen = new Map<string, string>();
  return html.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/gi, (m) => {
    if (/^[abc]0000000-0000-4000-8000-/.test(m) || m === BRAND_ID) return m;
    const key = m.toLowerCase();
    if (!seen.has(key)) seen.set(key, `<id-${seen.size + 1}>`);
    return seen.get(key)!;
  });
}
