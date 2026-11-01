/**
 * PostgreSQL implementation of the blog store (migration 0131), running as
 * the existing `r72_content_command` identity under forced RLS.
 *
 * A user store is bound to one authenticated portal principal. Each
 * transaction installs the brand as `app.workspace_id`; the database then
 * re-checks owner/admin membership of that brand on every row, and the
 * caller's opaque portal session is re-locked inside the same transaction.
 * A worker store installs the worker actor for one brand at a time.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type DbTransaction } from '../db/transaction.js';
import { InactivePortalSessionError } from '../db/transaction.js';
import type { DatabaseRequestContext } from '../db/rls.js';
import type { BeginDecision, BeginResult, CreateBrandInput, PublicationSnapshot, SeoBlogStore } from './store.js';
import { StaleWriteError } from './store.js';
import {
  DEFAULT_BRAND_SETTINGS, SeoBlogError,
  type ActivityEvent, type Article, type ArticleBrief, type ArticleVersion, type Brand, type BrandProfile, type Destination,
  type Job, type JobKind, type KnowledgeDocument, type Publication, type TopicPlan, type UsageKind, type UsageRecord, type WebsiteInventory,
} from './types.js';

export type PgSeoBlogPrincipal =
  | { readonly kind: 'user'; readonly userId: string; readonly requestId: string; readonly sessionToken: string; readonly selectedWorkspaceId: string }
  | { readonly kind: 'worker'; readonly requestId: string };

const DISCOVERY_WORKSPACE = '00000000-0000-4000-8000-000000000000';

function isUnique(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

export class PgSeoBlogStore implements SeoBlogStore {
  private readonly sessionHash: Buffer | null;

  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly principal: PgSeoBlogPrincipal) {
    this.sessionHash = principal.kind === 'user' ? createHash('sha256').update(principal.sessionToken).digest() : null;
  }

  private context(workspaceId: string): DatabaseRequestContext {
    const p = this.principal;
    return p.kind === 'user'
      ? { actorKind: 'user', workspaceId, userId: p.userId, requestId: p.requestId }
      : { actorKind: 'worker', workspaceId, requestId: p.requestId };
  }

  private async tx<T>(workspaceId: string, operation: (t: DbTransaction) => Promise<T>, readOnly = false): Promise<T> {
    return withTransaction(this.pool, this.context(workspaceId), async (t) => {
      if (this.principal.kind === 'user') {
        // Re-validate the caller's exact portal session inside this transaction.
        const guard = await t.query<{ ok: boolean }>('SELECT app_private.lock_active_portal_session($1, $2, $3) AS ok',
          [this.sessionHash, this.principal.userId, this.principal.selectedWorkspaceId]);
        if (guard.rows[0]?.ok !== true) throw new InactivePortalSessionError();
      }
      return operation(t);
    }, { readOnly: readOnly && this.principal.kind === 'worker' ? true : false });
  }

  private assertActor(actorId: string): void {
    if (this.principal.kind !== 'user' || this.principal.userId !== actorId) throw new SeoBlogError(403, 'Sign in again to continue.');
  }

  // ─── Brands ────────────────────────────────────────────────────────────

  async createBrand(input: CreateBrandInput): Promise<{ brand: Brand; created: boolean }> {
    this.assertActor(input.actorId);
    const selected = (this.principal as { selectedWorkspaceId: string }).selectedWorkspaceId;
    const result = await this.tx(selected, async (t) => {
      const r = await t.query<{ result: { workspaceId: string; created: boolean } }>(
        'SELECT app_private.seo_blog_create_brand($1, $2, $3, $4, $5) AS result',
        [input.commandId, input.name, input.slug, input.website, JSON.stringify(DEFAULT_BRAND_SETTINGS)]);
      return r.rows[0]!.result;
    }).catch((error) => {
      if ((error as { code?: string }).code === '42501') throw new SeoBlogError(403, 'Only an organisation owner can add brands.');
      throw error;
    });
    const brand = await this.getBrand(result.workspaceId);
    if (!brand) throw new SeoBlogError(503, 'The new brand could not be read back.');
    return { brand, created: result.created };
  }

  async listBrands(actorId: string): Promise<Brand[]> {
    this.assertActor(actorId);
    const selected = (this.principal as { selectedWorkspaceId: string }).selectedWorkspaceId;
    return this.tx(selected, async (t) => {
      const r = await t.query<{ brand: Brand }>('SELECT app_private.seo_blog_list_brands() AS brand');
      return r.rows.map((row) => normaliseBrand(row.brand));
    }, true);
  }

  async canManage(actorId: string, brandId: string): Promise<boolean> {
    this.assertActor(actorId);
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ ok: boolean }>('SELECT app_private.can_manage_workspace(app_private.current_user_id(), $1) AS ok', [brandId]);
      return r.rows[0]?.ok === true;
    }, true);
  }

  async getBrand(brandId: string): Promise<Brand | null> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ brand: Brand | null }>('SELECT app_private.seo_blog_brand($1) AS brand', [brandId]);
      return r.rows[0]?.brand ? normaliseBrand(r.rows[0].brand) : null;
    }, true);
  }

  async updateBrand(brand: Brand): Promise<Brand> {
    const next = await this.tx(brand.id, async (t) => {
      const r = await t.query<{ v: string | null }>('SELECT app_private.seo_blog_update_brand($1, $2, $3, $4, $5, $6) AS v',
        [brand.id, brand.rowVersion, brand.website, brand.locale, brand.timezone, JSON.stringify(brand.settings)]);
      return r.rows[0]?.v;
    });
    if (next === null || next === undefined) throw new StaleWriteError('brand');
    return (await this.getBrand(brand.id))!;
  }

  // ─── Generic records ───────────────────────────────────────────────────

  private async putRecord(brandId: string, kind: string, id: string, data: unknown, mode: 'insert' | 'upsert'): Promise<void> {
    await this.tx(brandId, async (t) => {
      const sql = mode === 'insert'
        ? 'INSERT INTO app.seo_blog_records (workspace_id, kind, id, data) VALUES ($1, $2, $3, $4)'
        : `INSERT INTO app.seo_blog_records (workspace_id, kind, id, data) VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`;
      await t.query(sql, [brandId, kind, id, JSON.stringify(data)]);
    }).catch((error) => {
      if (isUnique(error)) throw new StaleWriteError(kind);
      throw error;
    });
  }

  private async records<T>(brandId: string, kind: string, id?: string): Promise<T[]> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: T }>(
        `SELECT data FROM app.seo_blog_records WHERE workspace_id = $1 AND kind = $2 ${id ? 'AND id = $3' : ''} ORDER BY created_at, id`,
        id ? [brandId, kind, id] : [brandId, kind]);
      return r.rows.map((row) => row.data);
    }, true);
  }

  async putBlob(brandId: string, bytes: Buffer, mime: string | null): Promise<string> {
    const id = randomUUID();
    await this.tx(brandId, (t) => t.query('INSERT INTO app.seo_blog_blobs (workspace_id, id, mime, bytes, sha256) VALUES ($1, $2, $3, $4, $5)',
      [brandId, id, mime, bytes, createHash('sha256').update(bytes).digest()]));
    return id;
  }

  async getBlob(brandId: string, blobId: string): Promise<{ bytes: Buffer; mime: string | null } | null> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ bytes: Buffer; mime: string | null }>('SELECT bytes, mime FROM app.seo_blog_blobs WHERE workspace_id = $1 AND id = $2', [brandId, blobId]);
      return r.rows[0] ?? null;
    }, true);
  }

  saveKnowledge(doc: KnowledgeDocument): Promise<void> { return this.putRecord(doc.brandId, 'knowledge', `${doc.id}:${doc.version}`, doc, 'insert'); }
  async listKnowledge(brandId: string): Promise<KnowledgeDocument[]> {
    return (await this.records<KnowledgeDocument>(brandId, 'knowledge')).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.version - b.version);
  }
  saveProfile(profile: BrandProfile): Promise<void> { return this.putRecord(profile.brandId, 'profile', String(profile.version).padStart(8, '0'), profile, 'insert'); }
  async latestProfile(brandId: string): Promise<BrandProfile | null> {
    const all = await this.records<BrandProfile>(brandId, 'profile');
    return all.sort((a, b) => b.version - a.version)[0] ?? null;
  }
  saveInventory(inventory: WebsiteInventory): Promise<void> { return this.putRecord(inventory.brandId, 'inventory', 'current', inventory, 'upsert'); }
  async getInventory(brandId: string): Promise<WebsiteInventory | null> { return (await this.records<WebsiteInventory>(brandId, 'inventory', 'current'))[0] ?? null; }
  savePlan(plan: TopicPlan): Promise<void> { return this.putRecord(plan.brandId, 'plan', plan.id, plan, 'upsert'); }
  async getPlan(brandId: string, planId: string): Promise<TopicPlan | null> { return (await this.records<TopicPlan>(brandId, 'plan', planId))[0] ?? null; }
  async listPlans(brandId: string): Promise<TopicPlan[]> { return (await this.records<TopicPlan>(brandId, 'plan')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  saveBrief(brief: ArticleBrief): Promise<void> { return this.putRecord(brief.brandId, 'brief', brief.id, brief, 'upsert'); }
  async getBrief(brandId: string, briefId: string): Promise<ArticleBrief | null> { return (await this.records<ArticleBrief>(brandId, 'brief', briefId))[0] ?? null; }
  listBriefs(brandId: string): Promise<ArticleBrief[]> { return this.records<ArticleBrief>(brandId, 'brief'); }
  saveDestination(destination: Destination): Promise<void> { return this.putRecord(destination.brandId, 'destination', destination.id, destination, 'upsert'); }
  async getDestination(brandId: string, destinationId: string): Promise<Destination | null> { return (await this.records<Destination>(brandId, 'destination', destinationId))[0] ?? null; }
  listDestinations(brandId: string): Promise<Destination[]> { return this.records<Destination>(brandId, 'destination'); }

  // ─── Articles ──────────────────────────────────────────────────────────

  async createArticle(article: Article): Promise<{ article: Article; created: boolean }> {
    return this.tx(article.brandId, async (t) => {
      const { rowVersion: _rv, ...data } = article;
      const inserted = await t.query<{ data: Article; row_version: string }>(
        `INSERT INTO app.seo_blog_articles (workspace_id, id, brief_id, slug, publish_at, held, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, brief_id) DO NOTHING RETURNING data, row_version`,
        [article.brandId, article.id, article.briefId, article.slug, article.schedule?.publishAtUtc ?? null, Boolean(article.hold), JSON.stringify(data)]);
      if (inserted.rows[0]) return { article: withVersion(inserted.rows[0]), created: true };
      const existing = await t.query<{ data: Article; row_version: string }>('SELECT data, row_version FROM app.seo_blog_articles WHERE workspace_id = $1 AND brief_id = $2', [article.brandId, article.briefId]);
      return { article: withVersion(existing.rows[0]!), created: false };
    }).catch((error) => {
      if (isUnique(error)) throw new SeoBlogError(409, 'Another article already uses this slug.', 'slug_exists');
      throw error;
    });
  }

  async getArticle(brandId: string, articleId: string): Promise<Article | null> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: Article; row_version: string }>('SELECT data, row_version FROM app.seo_blog_articles WHERE workspace_id = $1 AND id = $2', [brandId, articleId]);
      return r.rows[0] ? withVersion(r.rows[0]) : null;
    }, true);
  }

  async listArticles(brandId: string): Promise<Article[]> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: Article; row_version: string }>('SELECT data, row_version FROM app.seo_blog_articles WHERE workspace_id = $1 ORDER BY created_at, id', [brandId]);
      return r.rows.map(withVersion);
    }, true);
  }

  async updateArticle(article: Article): Promise<Article> {
    const { rowVersion, ...data } = article;
    const row = await this.tx(article.brandId, async (t) => {
      const r = await t.query<{ data: Article; row_version: string }>(
        `UPDATE app.seo_blog_articles SET data = $3, slug = $4, publish_at = $5, held = $6, row_version = row_version + 1, updated_at = clock_timestamp()
         WHERE workspace_id = $1 AND id = $2 AND row_version = $7 RETURNING data, row_version`,
        [article.brandId, article.id, JSON.stringify(data), article.slug, article.schedule?.publishAtUtc ?? null, Boolean(article.hold), rowVersion]);
      return r.rows[0];
    }).catch((error) => {
      if (isUnique(error)) throw new SeoBlogError(409, 'Another article already uses this slug.', 'slug_exists');
      throw error;
    });
    if (!row) throw new StaleWriteError('article');
    return withVersion(row);
  }

  async addVersion(version: ArticleVersion): Promise<void> {
    await this.tx(version.brandId, (t) => t.query(
      'INSERT INTO app.seo_blog_article_versions (workspace_id, id, article_id, number, content_sha256, data) VALUES ($1, $2, $3, $4, $5, $6)',
      [version.brandId, version.id, version.articleId, version.number, version.contentSha, JSON.stringify(version)],
    )).catch((error) => {
      if (isUnique(error)) throw new StaleWriteError('article version');
      throw error;
    });
  }

  async getVersion(brandId: string, versionId: string): Promise<ArticleVersion | null> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: ArticleVersion }>('SELECT data FROM app.seo_blog_article_versions WHERE workspace_id = $1 AND id = $2', [brandId, versionId]);
      return r.rows[0]?.data ?? null;
    }, true);
  }

  async listVersions(brandId: string, articleId: string): Promise<ArticleVersion[]> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: ArticleVersion }>('SELECT data FROM app.seo_blog_article_versions WHERE workspace_id = $1 AND article_id = $2 ORDER BY number', [brandId, articleId]);
      return r.rows.map((row) => row.data);
    }, true);
  }

  // ─── Publications ──────────────────────────────────────────────────────

  /**
   * The publication-begin boundary. One READ COMMITTED transaction:
   *   1. brand settings row        FOR SHARE   (pause / auto-publish toggles UPDATE this row)
   *   2. article row               FOR UPDATE  (edits, approval, schedule, holds UPDATE this row)
   *   3. resumed operation row     FOR UPDATE  (concurrent reconcilers serialise here)
   *   4. destination record        FOR SHARE   (reconnection UPSERTs this row)
   *   5. version, profile and knowledge are read in the same snapshot
   *   6. `decide` runs synchronously; its outcome (operation row + article claim, or a hold) is written
   * and the transaction commits. A conflicting change committed first is seen after the lock wait;
   * one committed later waits for this boundary and applies to an operation that has already begun.
   * The provider request always happens after commit, never inside this transaction.
   */
  async beginPublication(input: { brandId: string; articleId: string; resumePublicationId: string | null; decide: (snapshot: PublicationSnapshot) => BeginDecision }): Promise<BeginResult> {
    const skip = new Error('seo-blog: begin skipped');
    let skipWhy = '';
    try {
      return await this.tx(input.brandId, async (t) => {
        const brandRow = await t.query<{ settings: Brand['settings'] }>(
          'SELECT settings FROM app.seo_blog_brands WHERE workspace_id = $1 FOR SHARE', [input.brandId]);
        const articleRow = await t.query<{ data: Article; row_version: string }>(
          'SELECT data, row_version FROM app.seo_blog_articles WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [input.brandId, input.articleId]);
        if (!brandRow.rows[0] || !articleRow.rows[0]) { skipWhy = 'Article not found.'; throw skip; }
        const article = withVersion<Article>(articleRow.rows[0]);
        let existing: Publication | null = null;
        if (input.resumePublicationId) {
          const r = await t.query<{ data: Publication; row_version: string }>(
            'SELECT data, row_version FROM app.seo_blog_publications WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [input.brandId, input.resumePublicationId]);
          if (!r.rows[0]) { skipWhy = 'Operation not found.'; throw skip; }
          existing = withVersion<Publication>(r.rows[0]);
        }
        const destinationId = existing?.destinationId ?? article.schedule?.destinationId ?? null;
        const destination = destinationId ? (await t.query<{ data: Destination }>(
          `SELECT data FROM app.seo_blog_records WHERE workspace_id = $1 AND kind = 'destination' AND id = $2 FOR SHARE`, [input.brandId, destinationId])).rows[0]?.data ?? null : null;
        const version = article.currentVersionId ? (await t.query<{ data: ArticleVersion }>(
          'SELECT data FROM app.seo_blog_article_versions WHERE workspace_id = $1 AND id = $2', [input.brandId, article.currentVersionId])).rows[0]?.data ?? null : null;
        const profile = (await t.query<{ data: BrandProfile }>(
          `SELECT data FROM app.seo_blog_records WHERE workspace_id = $1 AND kind = 'profile' ORDER BY id DESC LIMIT 1`, [input.brandId])).rows[0]?.data ?? null;
        const knowledge = (await t.query<{ data: KnowledgeDocument }>(
          `SELECT data FROM app.seo_blog_records WHERE workspace_id = $1 AND kind = 'knowledge'`, [input.brandId])).rows.map((r) => r.data);
        const decision = input.decide({
          brand: { id: input.brandId, settings: { ...DEFAULT_BRAND_SETTINGS, ...brandRow.rows[0].settings } },
          article, version, destination, profile, knowledge, publication: existing,
        });
        if (decision.kind === 'skip') { skipWhy = decision.why; throw skip; }
        let publication: Publication | undefined;
        if (decision.publication) {
          const { rowVersion: _rv, ...data } = decision.publication;
          const written = existing
            ? await t.query<{ data: Publication; row_version: string }>(
              `UPDATE app.seo_blog_publications SET data = $3, state = $4, row_version = row_version + 1, updated_at = clock_timestamp()
               WHERE workspace_id = $1 AND id = $2 AND row_version = $5 RETURNING data, row_version`,
              [input.brandId, existing.id, JSON.stringify(data), decision.publication.state, existing.rowVersion])
            : await t.query<{ data: Publication; row_version: string }>(
              `INSERT INTO app.seo_blog_publications (workspace_id, id, article_id, version_id, idempotency_key, state, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING data, row_version`,
              [input.brandId, decision.publication.id, decision.publication.articleId, decision.publication.versionId, decision.publication.idempotencyKey, decision.publication.state, JSON.stringify(data)]);
          if (!written.rows[0]) { skipWhy = 'This operation has already begun.'; throw skip; }
          publication = withVersion<Publication>(written.rows[0]);
        }
        const { rowVersion: _arv, ...articleData } = decision.article;
        const updated = await t.query<{ data: Article; row_version: string }>(
          `UPDATE app.seo_blog_articles SET data = $3, slug = $4, publish_at = $5, held = $6, row_version = row_version + 1, updated_at = clock_timestamp()
           WHERE workspace_id = $1 AND id = $2 AND row_version = $7 RETURNING data, row_version`,
          [input.brandId, article.id, JSON.stringify(articleData), decision.article.slug, decision.article.schedule?.publishAtUtc ?? null, Boolean(decision.article.hold), article.rowVersion]);
        if (!updated.rows[0]) throw new StaleWriteError('article');
        return { kind: decision.kind, article: withVersion<Article>(updated.rows[0]), ...(publication ? { publication } : {}) };
      });
    } catch (error) {
      if (error === skip) return { kind: 'skip', why: skipWhy };
      throw error;
    }
  }

  async insertPublication(publication: Publication): Promise<{ publication: Publication; inserted: boolean }> {
    return this.tx(publication.brandId, async (t) => {
      const { rowVersion: _rv, ...data } = publication;
      const r = await t.query<{ data: Publication; row_version: string }>(
        `INSERT INTO app.seo_blog_publications (workspace_id, id, article_id, version_id, idempotency_key, state, data) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING data, row_version`,
        [publication.brandId, publication.id, publication.articleId, publication.versionId, publication.idempotencyKey, publication.state, JSON.stringify(data)]);
      if (r.rows[0]) return { publication: withVersion(r.rows[0]), inserted: true };
      const existing = await t.query<{ data: Publication; row_version: string }>('SELECT data, row_version FROM app.seo_blog_publications WHERE workspace_id = $1 AND idempotency_key = $2', [publication.brandId, publication.idempotencyKey]);
      return { publication: withVersion(existing.rows[0]!), inserted: false };
    });
  }

  async updatePublication(publication: Publication): Promise<Publication> {
    const { rowVersion, ...data } = publication;
    const row = await this.tx(publication.brandId, async (t) => (await t.query<{ data: Publication; row_version: string }>(
      `UPDATE app.seo_blog_publications SET data = $3, state = $4, row_version = row_version + 1, updated_at = clock_timestamp()
       WHERE workspace_id = $1 AND id = $2 AND row_version = $5 RETURNING data, row_version`,
      [publication.brandId, publication.id, JSON.stringify(data), publication.state, rowVersion])).rows[0]);
    if (!row) throw new StaleWriteError('publication');
    return withVersion(row);
  }

  async listPublications(brandId: string, articleId?: string): Promise<Publication[]> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: Publication; row_version: string }>(
        `SELECT data, row_version FROM app.seo_blog_publications WHERE workspace_id = $1 ${articleId ? 'AND article_id = $2' : ''} ORDER BY created_at`,
        articleId ? [brandId, articleId] : [brandId]);
      return r.rows.map(withVersion);
    }, true);
  }

  // ─── Jobs ──────────────────────────────────────────────────────────────

  async enqueueJob(job: Job): Promise<{ job: Job; created: boolean }> {
    return this.tx(job.brandId, async (t) => {
      const { rowVersion: _rv, ...data } = job;
      const r = await t.query<{ data: Job; row_version: string }>(
        `INSERT INTO app.seo_blog_jobs (workspace_id, id, kind, idempotency_key, state, run_after, lease_expires_at, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING data, row_version`,
        [job.brandId, job.id, job.kind, job.idempotencyKey, job.state, job.runAfter, job.leaseExpiresAt, JSON.stringify(data)]);
      if (r.rows[0]) return { job: withVersion(r.rows[0]), created: true };
      const existing = await t.query<{ data: Job; row_version: string }>('SELECT data, row_version FROM app.seo_blog_jobs WHERE workspace_id = $1 AND idempotency_key = $2', [job.brandId, job.idempotencyKey]);
      return { job: withVersion(existing.rows[0]!), created: false };
    });
  }

  async claimJobs(input: { brandId?: string; kinds?: readonly JobKind[]; now: string; owner: string; leaseMs: number; limit: number }): Promise<Job[]> {
    if (!input.brandId) {
      const out: Job[] = [];
      for (const brandId of await this.activeBrandIds(input.now)) {
        if (out.length >= input.limit) break;
        out.push(...await this.claimJobs({ ...input, brandId, limit: input.limit - out.length }));
      }
      return out;
    }
    const brandId = input.brandId;
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: Job; row_version: string }>(
        `SELECT data, row_version FROM app.seo_blog_jobs WHERE workspace_id = $1
           AND ((state = 'queued' AND run_after <= $2) OR (state = 'running' AND lease_expires_at <= $2))
           ${input.kinds ? 'AND kind = ANY($4)' : ''}
         ORDER BY run_after LIMIT $3 FOR UPDATE SKIP LOCKED`,
        input.kinds ? [brandId, input.now, input.limit, input.kinds] : [brandId, input.now, input.limit]);
      const leased: Job[] = [];
      for (const row of r.rows.map(withVersion)) {
        const next: Job = { ...row, state: 'running', leaseOwner: input.owner, leaseExpiresAt: new Date(Date.parse(input.now) + input.leaseMs).toISOString(), attempts: row.attempts + 1, updatedAt: input.now };
        const { rowVersion, ...data } = next;
        const u = await t.query<{ data: Job; row_version: string }>(
          `UPDATE app.seo_blog_jobs SET data = $3, state = 'running', lease_expires_at = $4, row_version = row_version + 1, updated_at = clock_timestamp()
           WHERE workspace_id = $1 AND id = $2 AND row_version = $5 RETURNING data, row_version`,
          [brandId, next.id, JSON.stringify(data), next.leaseExpiresAt, rowVersion]);
        if (u.rows[0]) leased.push(withVersion(u.rows[0]));
      }
      return leased;
    });
  }

  async updateJob(job: Job): Promise<Job> {
    const { rowVersion, ...data } = job;
    const row = await this.tx(job.brandId, async (t) => (await t.query<{ data: Job; row_version: string }>(
      `UPDATE app.seo_blog_jobs SET data = $3, state = $4, run_after = $5, lease_expires_at = $6, row_version = row_version + 1, updated_at = clock_timestamp()
       WHERE workspace_id = $1 AND id = $2 AND row_version = $7 RETURNING data, row_version`,
      [job.brandId, job.id, JSON.stringify(data), job.state, job.runAfter, job.leaseExpiresAt, rowVersion])).rows[0]);
    if (!row) throw new StaleWriteError('job');
    return withVersion(row);
  }

  async getJob(brandId: string, jobId: string): Promise<Job | null> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: Job; row_version: string }>('SELECT data, row_version FROM app.seo_blog_jobs WHERE workspace_id = $1 AND id = $2', [brandId, jobId]);
      return r.rows[0] ? withVersion(r.rows[0]) : null;
    }, true);
  }

  async listJobs(brandId: string): Promise<Job[]> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ data: Job; row_version: string }>('SELECT data, row_version FROM app.seo_blog_jobs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200', [brandId]);
      return r.rows.map(withVersion);
    }, true);
  }

  // ─── Usage & activity ──────────────────────────────────────────────────

  async recordUsage(usage: UsageRecord): Promise<void> {
    await this.tx(usage.brandId, (t) => t.query('INSERT INTO app.seo_blog_usage (workspace_id, kind, amount, at, reference) VALUES ($1, $2, $3, $4, $5)',
      [usage.brandId, usage.kind, usage.amount, usage.at, usage.reference.slice(0, 200)]));
  }

  async usageSince(brandId: string, kind: UsageKind, sinceIso: string): Promise<number> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ total: string | null }>('SELECT sum(amount)::text AS total FROM app.seo_blog_usage WHERE workspace_id = $1 AND kind = $2 AND at >= $3', [brandId, kind, sinceIso]);
      return Number(r.rows[0]?.total ?? 0);
    }, true);
  }

  async recordActivity(event: ActivityEvent): Promise<void> {
    await this.tx(event.brandId, (t) => t.query('INSERT INTO app.seo_blog_activity (workspace_id, at, actor, kind, message, subject_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [event.brandId, event.at, event.actor.slice(0, 80), event.kind.slice(0, 80), event.message.slice(0, 2000), event.subjectId]));
  }

  async listActivity(brandId: string, limit: number): Promise<ActivityEvent[]> {
    return this.tx(brandId, async (t) => {
      const r = await t.query<{ at: Date; actor: string; kind: string; message: string; subject_id: string | null }>(
        'SELECT at, actor, kind, message, subject_id FROM app.seo_blog_activity WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2', [brandId, limit]);
      return r.rows.map((row) => ({ brandId, at: new Date(row.at).toISOString(), actor: row.actor, kind: row.kind, message: row.message, subjectId: row.subject_id }));
    }, true);
  }

  async activeBrandIds(now: string): Promise<string[]> {
    if (this.principal.kind !== 'worker') return [];
    return withTransaction(this.pool, { actorKind: 'worker', workspaceId: DISCOVERY_WORKSPACE, requestId: this.principal.requestId }, async (t) => {
      const r = await t.query<{ id: string }>('SELECT app_private.seo_blog_active_workspaces($1) AS id', [now]);
      return r.rows.map((row) => row.id);
    }, { readOnly: true });
  }
}

function withVersion<T extends { rowVersion: number }>(row: { data: Omit<T, 'rowVersion'> | T; row_version: string | number }): T {
  return { ...(row.data as T), rowVersion: Number(row.row_version) };
}

function normaliseBrand(raw: Brand): Brand {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt).toISOString(),
    rowVersion: Number(raw.rowVersion),
    settings: { ...DEFAULT_BRAND_SETTINGS, ...(raw.settings ?? {}) },
  };
}
