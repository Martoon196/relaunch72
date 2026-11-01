/**
 * Persistence boundary for the blog engine. Every method is scoped to one
 * brand (workspace) except the brand-directory and worker discovery calls.
 * Implementations: `MemorySeoBlogStore` (tests, local) and `PgSeoBlogStore`
 * (forced-RLS PostgreSQL, migration 0131).
 *
 * Concurrency: mutable rows carry `rowVersion`; an update with a stale
 * expected version throws `StaleWriteError`. Article versions, usage and
 * activity are append-only. Publications and jobs are unique on their
 * idempotency key, so a duplicate worker cannot create a second operation.
 */

import type {
  ActivityEvent, Article, ArticleBrief, ArticleVersion, Brand, BrandProfile, Destination, Job, JobKind,
  KnowledgeDocument, Publication, TopicPlan, UsageKind, UsageRecord, WebsiteInventory,
} from './types.js';
import { DEFAULT_BRAND_SETTINGS, SeoBlogError } from './types.js';

export class StaleWriteError extends SeoBlogError {
  constructor(what = 'record') {
    super(409, `This ${what} changed while you were working. Reload and try again.`, 'stale_write');
  }
}

export interface CreateBrandInput {
  readonly commandId: string;
  readonly actorId: string;
  readonly name: string;
  readonly slug: string;
  readonly website: string | null;
  readonly now: string;
}

export interface SeoBlogStore {
  createBrand(input: CreateBrandInput): Promise<{ brand: Brand; created: boolean }>;
  listBrands(actorId: string): Promise<Brand[]>;
  canManage(actorId: string, brandId: string): Promise<boolean>;
  getBrand(brandId: string): Promise<Brand | null>;
  updateBrand(brand: Brand): Promise<Brand>;

  putBlob(brandId: string, bytes: Buffer, mime: string | null): Promise<string>;
  getBlob(brandId: string, blobId: string): Promise<{ bytes: Buffer; mime: string | null } | null>;
  saveKnowledge(doc: KnowledgeDocument): Promise<void>;
  listKnowledge(brandId: string): Promise<KnowledgeDocument[]>;

  saveProfile(profile: BrandProfile): Promise<void>;
  latestProfile(brandId: string): Promise<BrandProfile | null>;

  saveInventory(inventory: WebsiteInventory): Promise<void>;
  getInventory(brandId: string): Promise<WebsiteInventory | null>;

  savePlan(plan: TopicPlan): Promise<void>;
  getPlan(brandId: string, planId: string): Promise<TopicPlan | null>;
  listPlans(brandId: string): Promise<TopicPlan[]>;
  saveBrief(brief: ArticleBrief): Promise<void>;
  getBrief(brandId: string, briefId: string): Promise<ArticleBrief | null>;
  listBriefs(brandId: string): Promise<ArticleBrief[]>;

  createArticle(article: Article): Promise<{ article: Article; created: boolean }>;
  getArticle(brandId: string, articleId: string): Promise<Article | null>;
  listArticles(brandId: string): Promise<Article[]>;
  /** Writes `article` if the stored rowVersion equals article.rowVersion; returns it with rowVersion + 1. */
  updateArticle(article: Article): Promise<Article>;
  addVersion(version: ArticleVersion): Promise<void>;
  getVersion(brandId: string, versionId: string): Promise<ArticleVersion | null>;
  listVersions(brandId: string, articleId: string): Promise<ArticleVersion[]>;

  saveDestination(destination: Destination): Promise<void>;
  getDestination(brandId: string, destinationId: string): Promise<Destination | null>;
  listDestinations(brandId: string): Promise<Destination[]>;

  /** Inserts unless the idempotency key exists; returns the stored row either way. */
  insertPublication(publication: Publication): Promise<{ publication: Publication; inserted: boolean }>;
  updatePublication(publication: Publication): Promise<Publication>;
  listPublications(brandId: string, articleId?: string): Promise<Publication[]>;

  enqueueJob(job: Job): Promise<{ job: Job; created: boolean }>;
  /** Lease up to `limit` runnable jobs (queued and due, or running with an expired lease). */
  claimJobs(input: { brandId?: string; kinds?: readonly JobKind[]; now: string; owner: string; leaseMs: number; limit: number }): Promise<Job[]>;
  updateJob(job: Job): Promise<Job>;
  getJob(brandId: string, jobId: string): Promise<Job | null>;
  listJobs(brandId: string): Promise<Job[]>;

  recordUsage(usage: UsageRecord): Promise<void>;
  usageSince(brandId: string, kind: UsageKind, sinceIso: string): Promise<number>;
  recordActivity(event: ActivityEvent): Promise<void>;
  listActivity(brandId: string, limit: number): Promise<ActivityEvent[]>;

  /** Worker discovery: brands with due schedules or runnable jobs. */
  activeBrandIds(now: string): Promise<string[]>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemorySeoBlogStore implements SeoBlogStore {
  private brands = new Map<string, Brand>();
  private brandCommands = new Map<string, string>();
  private members = new Map<string, Set<string>>();
  private blobs = new Map<string, { brandId: string; bytes: Buffer; mime: string | null }>();
  private knowledge = new Map<string, KnowledgeDocument>();
  private profiles = new Map<string, BrandProfile[]>();
  private inventories = new Map<string, WebsiteInventory>();
  private plans = new Map<string, TopicPlan>();
  private briefs = new Map<string, ArticleBrief>();
  private articles = new Map<string, Article>();
  private versions = new Map<string, ArticleVersion>();
  private destinations = new Map<string, Destination>();
  private publications = new Map<string, Publication>();
  private jobs = new Map<string, Job>();
  private usage: UsageRecord[] = [];
  private activity: ActivityEvent[] = [];
  /** Test hook: fail the next N writes of a given method to simulate a crash. */
  failNext: Partial<Record<string, number>> = {};

  constructor(private readonly organizationFor: (actorId: string) => string = () => '00000000-0000-4000-8000-000000000001') {}

  private maybeFail(method: string): void {
    const n = this.failNext[method] ?? 0;
    if (n > 0) {
      this.failNext[method] = n - 1;
      throw new Error(`simulated crash in ${method}`);
    }
  }

  /** Test helper: grant another actor membership of an existing brand. */
  grant(actorId: string, brandId: string): void {
    if (!this.members.has(brandId)) this.members.set(brandId, new Set());
    this.members.get(brandId)!.add(actorId);
  }

  async createBrand(input: CreateBrandInput): Promise<{ brand: Brand; created: boolean }> {
    const key = `${input.actorId}:${input.commandId}`;
    const existing = this.brandCommands.get(key);
    if (existing) return { brand: clone(this.brands.get(existing)!), created: false };
    const organizationId = this.organizationFor(input.actorId);
    if ([...this.brands.values()].some((b) => b.organizationId === organizationId && b.slug === input.slug)) {
      throw new SeoBlogError(409, 'A brand with this name already exists. Choose a different name.', 'brand_exists');
    }
    const brand: Brand = {
      id: crypto.randomUUID(), organizationId, name: input.name, slug: input.slug, website: input.website,
      locale: 'en-GB', timezone: 'Europe/London', settings: clone(DEFAULT_BRAND_SETTINGS),
      createdAt: input.now, createdBy: input.actorId, rowVersion: 1,
    };
    this.brands.set(brand.id, brand);
    this.brandCommands.set(key, brand.id);
    this.grant(input.actorId, brand.id);
    return { brand: clone(brand), created: true };
  }

  async listBrands(actorId: string): Promise<Brand[]> {
    return [...this.brands.values()].filter((b) => this.members.get(b.id)?.has(actorId)).map(clone).sort((a, b) => a.name.localeCompare(b.name));
  }

  async canManage(actorId: string, brandId: string): Promise<boolean> {
    return Boolean(this.members.get(brandId)?.has(actorId));
  }

  async getBrand(brandId: string): Promise<Brand | null> {
    const b = this.brands.get(brandId);
    return b ? clone(b) : null;
  }

  async updateBrand(brand: Brand): Promise<Brand> {
    this.maybeFail('updateBrand');
    const current = this.brands.get(brand.id);
    if (!current || current.rowVersion !== brand.rowVersion) throw new StaleWriteError('brand');
    const next = { ...clone(brand), rowVersion: brand.rowVersion + 1 };
    this.brands.set(brand.id, next);
    return clone(next);
  }

  async putBlob(brandId: string, bytes: Buffer, mime: string | null): Promise<string> {
    const id = crypto.randomUUID();
    this.blobs.set(id, { brandId, bytes: Buffer.from(bytes), mime });
    return id;
  }

  async getBlob(brandId: string, blobId: string): Promise<{ bytes: Buffer; mime: string | null } | null> {
    const blob = this.blobs.get(blobId);
    return blob && blob.brandId === brandId ? { bytes: Buffer.from(blob.bytes), mime: blob.mime } : null;
  }

  async saveKnowledge(doc: KnowledgeDocument): Promise<void> {
    const key = `${doc.brandId}:${doc.id}:${doc.version}`;
    this.knowledge.set(key, clone(doc));
  }

  async listKnowledge(brandId: string): Promise<KnowledgeDocument[]> {
    return [...this.knowledge.values()].filter((d) => d.brandId === brandId).map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version - b.version);
  }

  async saveProfile(profile: BrandProfile): Promise<void> {
    const list = this.profiles.get(profile.brandId) ?? [];
    if (list.some((p) => p.version === profile.version)) throw new StaleWriteError('brand profile');
    list.push(clone(profile));
    this.profiles.set(profile.brandId, list);
  }

  async latestProfile(brandId: string): Promise<BrandProfile | null> {
    const list = this.profiles.get(brandId) ?? [];
    const latest = [...list].sort((a, b) => b.version - a.version)[0];
    return latest ? clone(latest) : null;
  }

  async saveInventory(inventory: WebsiteInventory): Promise<void> {
    this.inventories.set(inventory.brandId, clone(inventory));
  }

  async getInventory(brandId: string): Promise<WebsiteInventory | null> {
    const i = this.inventories.get(brandId);
    return i ? clone(i) : null;
  }

  async savePlan(plan: TopicPlan): Promise<void> { this.plans.set(plan.id, clone(plan)); }
  async getPlan(brandId: string, planId: string): Promise<TopicPlan | null> {
    const p = this.plans.get(planId);
    return p && p.brandId === brandId ? clone(p) : null;
  }
  async listPlans(brandId: string): Promise<TopicPlan[]> {
    return [...this.plans.values()].filter((p) => p.brandId === brandId).map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async saveBrief(brief: ArticleBrief): Promise<void> {
    this.maybeFail('saveBrief');
    this.briefs.set(brief.id, clone(brief));
  }
  async getBrief(brandId: string, briefId: string): Promise<ArticleBrief | null> {
    const b = this.briefs.get(briefId);
    return b && b.brandId === brandId ? clone(b) : null;
  }
  async listBriefs(brandId: string): Promise<ArticleBrief[]> {
    return [...this.briefs.values()].filter((b) => b.brandId === brandId).map(clone);
  }

  async createArticle(article: Article): Promise<{ article: Article; created: boolean }> {
    const existing = [...this.articles.values()].find((a) => a.brandId === article.brandId && a.briefId === article.briefId);
    if (existing) return { article: clone(existing), created: false };
    if ([...this.articles.values()].some((a) => a.brandId === article.brandId && a.slug === article.slug)) {
      throw new SeoBlogError(409, 'Another article already uses this slug.', 'slug_exists');
    }
    this.articles.set(article.id, clone(article));
    return { article: clone(article), created: true };
  }
  async getArticle(brandId: string, articleId: string): Promise<Article | null> {
    const a = this.articles.get(articleId);
    return a && a.brandId === brandId ? clone(a) : null;
  }
  async listArticles(brandId: string): Promise<Article[]> {
    return [...this.articles.values()].filter((a) => a.brandId === brandId).map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async updateArticle(article: Article): Promise<Article> {
    this.maybeFail('updateArticle');
    const current = this.articles.get(article.id);
    if (!current || current.brandId !== article.brandId || current.rowVersion !== article.rowVersion) throw new StaleWriteError('article');
    if (article.slug !== current.slug && [...this.articles.values()].some((a) => a.id !== article.id && a.brandId === article.brandId && a.slug === article.slug)) {
      throw new SeoBlogError(409, 'Another article already uses this slug.', 'slug_exists');
    }
    const next = { ...clone(article), rowVersion: article.rowVersion + 1 };
    this.articles.set(article.id, next);
    return clone(next);
  }
  async addVersion(version: ArticleVersion): Promise<void> {
    this.maybeFail('addVersion');
    if (this.versions.has(version.id) || [...this.versions.values()].some((v) => v.articleId === version.articleId && v.number === version.number)) {
      throw new StaleWriteError('article version');
    }
    this.versions.set(version.id, clone(version));
  }
  async getVersion(brandId: string, versionId: string): Promise<ArticleVersion | null> {
    const v = this.versions.get(versionId);
    return v && v.brandId === brandId ? clone(v) : null;
  }
  async listVersions(brandId: string, articleId: string): Promise<ArticleVersion[]> {
    return [...this.versions.values()].filter((v) => v.brandId === brandId && v.articleId === articleId).map(clone).sort((a, b) => a.number - b.number);
  }

  async saveDestination(destination: Destination): Promise<void> { this.destinations.set(destination.id, clone(destination)); }
  async getDestination(brandId: string, destinationId: string): Promise<Destination | null> {
    const d = this.destinations.get(destinationId);
    return d && d.brandId === brandId ? clone(d) : null;
  }
  async listDestinations(brandId: string): Promise<Destination[]> {
    return [...this.destinations.values()].filter((d) => d.brandId === brandId).map(clone);
  }

  async insertPublication(publication: Publication): Promise<{ publication: Publication; inserted: boolean }> {
    this.maybeFail('insertPublication');
    const existing = [...this.publications.values()].find((p) => p.brandId === publication.brandId && p.idempotencyKey === publication.idempotencyKey);
    if (existing) return { publication: clone(existing), inserted: false };
    this.publications.set(publication.id, clone(publication));
    return { publication: clone(publication), inserted: true };
  }
  async updatePublication(publication: Publication): Promise<Publication> {
    this.maybeFail('updatePublication');
    const current = this.publications.get(publication.id);
    if (!current || current.rowVersion !== publication.rowVersion) throw new StaleWriteError('publication');
    const next = { ...clone(publication), rowVersion: publication.rowVersion + 1 };
    this.publications.set(publication.id, next);
    return clone(next);
  }
  async listPublications(brandId: string, articleId?: string): Promise<Publication[]> {
    return [...this.publications.values()].filter((p) => p.brandId === brandId && (!articleId || p.articleId === articleId)).map(clone);
  }

  async enqueueJob(job: Job): Promise<{ job: Job; created: boolean }> {
    const existing = [...this.jobs.values()].find((j) => j.brandId === job.brandId && j.idempotencyKey === job.idempotencyKey);
    if (existing) return { job: clone(existing), created: false };
    this.jobs.set(job.id, clone(job));
    return { job: clone(job), created: true };
  }
  async claimJobs(input: { brandId?: string; kinds?: readonly JobKind[]; now: string; owner: string; leaseMs: number; limit: number }): Promise<Job[]> {
    const now = Date.parse(input.now);
    const runnable = [...this.jobs.values()]
      .filter((j) => (!input.brandId || j.brandId === input.brandId) && (!input.kinds || input.kinds.includes(j.kind)))
      .filter((j) => (j.state === 'queued' && Date.parse(j.runAfter) <= now)
        || (j.state === 'running' && j.leaseExpiresAt !== null && Date.parse(j.leaseExpiresAt) <= now))
      .sort((a, b) => a.runAfter.localeCompare(b.runAfter))
      .slice(0, input.limit);
    return runnable.map((j) => {
      const leased: Job = { ...j, state: 'running', leaseOwner: input.owner, leaseExpiresAt: new Date(now + input.leaseMs).toISOString(), attempts: j.attempts + 1, updatedAt: input.now, rowVersion: j.rowVersion + 1 };
      this.jobs.set(j.id, leased);
      return clone(leased);
    });
  }
  async updateJob(job: Job): Promise<Job> {
    const current = this.jobs.get(job.id);
    if (!current || current.rowVersion !== job.rowVersion) throw new StaleWriteError('job');
    const next = { ...clone(job), rowVersion: job.rowVersion + 1 };
    this.jobs.set(job.id, next);
    return clone(next);
  }
  async getJob(brandId: string, jobId: string): Promise<Job | null> {
    const j = this.jobs.get(jobId);
    return j && j.brandId === brandId ? clone(j) : null;
  }
  async listJobs(brandId: string): Promise<Job[]> {
    return [...this.jobs.values()].filter((j) => j.brandId === brandId).map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recordUsage(usage: UsageRecord): Promise<void> { this.usage.push(clone(usage)); }
  async usageSince(brandId: string, kind: UsageKind, sinceIso: string): Promise<number> {
    return this.usage.filter((u) => u.brandId === brandId && u.kind === kind && u.at >= sinceIso).reduce((n, u) => n + u.amount, 0);
  }
  async recordActivity(event: ActivityEvent): Promise<void> { this.activity.push(clone(event)); }
  async listActivity(brandId: string, limit: number): Promise<ActivityEvent[]> {
    return this.activity.filter((e) => e.brandId === brandId).slice(-limit).reverse().map(clone);
  }

  async activeBrandIds(now: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const a of this.articles.values()) if (a.schedule && !a.hold && a.schedule.publishAtUtc <= now) ids.add(a.brandId);
    for (const p of this.publications.values()) if (['prepared', 'submitted', 'outcome_unknown', 'verifying'].includes(p.state)) ids.add(p.brandId);
    for (const j of this.jobs.values()) if (j.state === 'queued' || j.state === 'running') ids.add(j.brandId);
    return [...ids];
  }

  /** Test helper: simulate a process restart by dropping in-flight leases' owners (state is durable). */
  snapshotCounts(): Record<string, number> {
    return { articles: this.articles.size, versions: this.versions.size, publications: this.publications.size, jobs: this.jobs.size, briefs: this.briefs.size };
  }
}
