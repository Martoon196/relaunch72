/**
 * SEO blog engine service. The portal router, the worker and tests all drive
 * the engine through this class. Every owner call carries the server-resolved
 * actor and brand; access is re-checked on every call.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { LlmClient } from '../llm/client.js';
import type { KeywordProvider } from '../keyword/types.js';
import { runChecks } from './checks.js';
import { assessDuplicate, slugify } from './dedupe.js';
import {
  extractProfile, GenerationUnavailableError, proposeCluster, resolveMarkers, rewriteSection, writeArticle, writeArticlePromotions,
  type PlannedArticle,
} from './generation.js';
import { buildInventory, linkableUrls } from './inventory.js';
import { cleanText, extractKnowledge } from './knowledge.js';
import { approvalIsCurrent, articleStatusLabel, checksAreCurrent, evaluatePublication } from './policy.js';
import { publisherFor, type PublisherRegistry } from './publishers/registry.js';
import { PublisherOutcomeUnknownError, PublisherRejectedError, verifyPublicUrl, type PublishInput } from './publishers/types.js';
import { exportMarkdown, renderArticlePage, versionMarker } from './render.js';
import { researchQueries, ResearchUnavailableError, type SearchProvider } from './research.js';
import { validatePublicUrl, type FetchTransport } from './safe-fetch.js';
import { autoPlace, isValidTimeZone, localToUtc, utcToLocal, validateCadence } from './schedule.js';
import type { SeoBlogStore } from './store.js';
import { StaleWriteError } from './store.js';
import {
  DESTINATION_TYPES, FACTUAL_KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORIES, SeoBlogError,
  type Article, type ArticleBody, type ArticleBrief, type ArticlePromotionPack, type ArticleVersion, type Brand, type BrandProfile, type BrandSettings,
  type CheckReport, type Destination, type GenerationRecord, type Job, type JobKind, type KnowledgeCategory,
  type KnowledgeDocument, type KnowledgeRef, type Publication, type ResearchSource, type TopicPlan, type UsageKind,
  type VersionChange, type WebsiteInventory,
} from './types.js';
import type { SeoBlogCredentialVault } from './vault.js';
import type { ArticlePromotionApproval, PromotionNetwork } from './promotions.js';

export interface Actor {
  readonly userId: string;
}

export interface EngineDeps {
  readonly store: SeoBlogStore;
  readonly llm: LlmClient | null;
  readonly search: SearchProvider;
  readonly transport: FetchTransport;
  readonly publishers: PublisherRegistry;
  readonly vault: SeoBlogCredentialVault | null;
  readonly keywords?: KeywordProvider | null;
  readonly now?: () => string;
  /** Upper bound for unattended work per tick. */
  readonly batchLimit?: number;
  readonly promotions?: ArticlePromotionApproval;
}

/** Estimated model tokens per stage, used for pre-flight budget checks and batch estimates. */
export const USAGE_ESTIMATES = Object.freeze({ profile: 14_000, plan: 40_000, article: 32_000, promotion: 6_000, section: 8_000, searchPerPlan: 8 });

const JOB_MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60 * 1000;
const PREPARED_STALE_MS = 5 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 30;

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function profileFactsSha(p: Pick<BrandProfile, 'offers' | 'approvedClaims' | 'conflicts'>): string {
  return sha256({ offers: p.offers.map((o) => ({ name: o.name, description: o.description, price: o.price, url: o.url })), claims: p.approvedClaims, conflicts: p.conflicts.map((c) => ({ field: c.field, detail: c.detail })) });
}

function monthStart(now: string): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class BudgetExceededError extends SeoBlogError {
  constructor(kind: UsageKind) {
    const label = kind === 'model_tokens' ? 'writing' : kind === 'search_calls' ? 'research' : 'image';
    super(409, `The monthly ${label} budget for this brand is used up or not set. Raise it in Publishing settings to continue; nothing else is affected.`, 'budget_exceeded');
  }
}

export interface BrandReadiness {
  readonly website: boolean;
  readonly knowledge: number;
  readonly unreadableKnowledge: number;
  readonly profile: 'missing' | 'unconfirmed' | 'confirmed' | 'stale';
  readonly inventory: boolean;
  readonly research: boolean;
  readonly generation: 'live' | 'simulated' | 'unavailable';
  readonly budgets: boolean;
  readonly destination: 'none' | 'unverified' | 'connected' | 'failed';
  readonly canPlan: boolean;
  readonly missing: readonly string[];
}

export class SeoBlogEngine {
  private readonly store: SeoBlogStore;
  private readonly now: () => string;

  constructor(private readonly deps: EngineDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // ─── Access ──────────────────────────────────────────────────────────────

  private async brandFor(actor: Actor, brandId: string): Promise<Brand> {
    if (!validUuid(brandId)) throw new SeoBlogError(404, 'That brand was not found.', 'not_found');
    if (!(await this.store.canManage(actor.userId, brandId))) throw new SeoBlogError(404, 'That brand was not found.', 'not_found');
    const brand = await this.store.getBrand(brandId);
    if (!brand) throw new SeoBlogError(404, 'That brand was not found.', 'not_found');
    return brand;
  }

  private async log(brandId: string, actor: string, kind: string, message: string, subjectId: string | null = null): Promise<void> {
    await this.store.recordActivity({ brandId, at: this.now(), actor, kind, message, subjectId });
  }

  // ─── Brands ──────────────────────────────────────────────────────────────

  async createBrand(actor: Actor, input: { commandId: string; name: string; website?: string | null }): Promise<{ brand: Brand; created: boolean }> {
    if (!validUuid(input.commandId)) throw new SeoBlogError(400, 'Refresh the form and try again.');
    const name = cleanText(String(input.name ?? '')).replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120) throw new SeoBlogError(400, 'Enter a brand name between 2 and 120 characters.');
    const website = input.website?.trim() ? normaliseWebsite(input.website) : null;
    const result = await this.store.createBrand({ commandId: input.commandId, actorId: actor.userId, name, slug: slugify(name, 60), website, now: this.now() });
    if (result.created) await this.log(result.brand.id, actor.userId, 'brand.created', `Brand “${name}” created.`);
    return result;
  }

  listBrands(actor: Actor): Promise<Brand[]> {
    return this.store.listBrands(actor.userId);
  }

  async getBrand(actor: Actor, brandId: string): Promise<Brand> {
    return this.brandFor(actor, brandId);
  }

  async updateBrandBasics(actor: Actor, brandId: string, input: { rowVersion: number; website: string | null; locale: string; timezone: string }): Promise<Brand> {
    const brand = await this.brandFor(actor, brandId);
    if (brand.rowVersion !== input.rowVersion) throw new StaleWriteError('brand');
    if (!isValidTimeZone(input.timezone)) throw new SeoBlogError(400, 'Choose a valid timezone, for example Europe/London.');
    if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(input.locale)) throw new SeoBlogError(400, 'Choose a locale such as en-GB.');
    const website = input.website?.trim() ? normaliseWebsite(input.website) : null;
    const updated = await this.store.updateBrand({ ...brand, website, locale: input.locale, timezone: input.timezone });
    await this.log(brandId, actor.userId, 'brand.updated', 'Brand website, locale or timezone updated.');
    return updated;
  }

  async updateSettings(actor: Actor, brandId: string, rowVersion: number, patch: Partial<BrandSettings>): Promise<Brand> {
    const brand = await this.brandFor(actor, brandId);
    if (brand.rowVersion !== rowVersion) throw new StaleWriteError('brand settings');
    const next: BrandSettings = { ...brand.settings, ...patch };
    validateSettings(next);
    const updated = await this.store.updateBrand({ ...brand, settings: next });
    const changes: string[] = [];
    if (patch.autoPublish !== undefined && patch.autoPublish !== brand.settings.autoPublish) changes.push(`automatic publishing ${patch.autoPublish ? 'on' : 'off'}`);
    if (patch.pauseAll !== undefined && patch.pauseAll !== brand.settings.pauseAll) changes.push(patch.pauseAll ? 'all publishing paused' : 'publishing resumed');
    if (patch.ongoingProduction !== undefined && patch.ongoingProduction !== brand.settings.ongoingProduction) changes.push(`ongoing production ${patch.ongoingProduction ? 'on' : 'off'}`);
    await this.log(brandId, actor.userId, 'settings.updated', changes.length ? `Settings changed: ${changes.join(', ')}.` : 'Publishing settings updated.');
    return updated;
  }

  async readiness(actor: Actor, brandId: string): Promise<BrandReadiness> {
    const brand = await this.brandFor(actor, brandId);
    return this.readinessFor(brand);
  }

  private async readinessFor(brand: Brand): Promise<BrandReadiness> {
    const [docs, profile, inventory, destinations] = await Promise.all([
      this.activeKnowledge(brand.id), this.store.latestProfile(brand.id), this.store.getInventory(brand.id), this.store.listDestinations(brand.id),
    ]);
    const all = await this.store.listKnowledge(brand.id);
    const profileState: BrandReadiness['profile'] = !profile ? 'missing' : this.profileStale(profile, docs) ? 'stale' : profile.confirmedAt ? 'confirmed' : 'unconfirmed';
    const generation: BrandReadiness['generation'] = !this.deps.llm ? 'unavailable' : this.deps.llm.mode === 'live' ? 'live' : 'simulated';
    const connected = destinations.find((d) => d.status === 'connected');
    const destination: BrandReadiness['destination'] = connected ? 'connected' : destinations[0]?.status ?? 'none';
    const budgets = brand.settings.budgets.modelTokensPerMonth > 0 && brand.settings.budgets.searchCallsPerMonth > 0;
    const research = this.deps.search.mode === 'live';
    const missing: string[] = [];
    if (!brand.website) missing.push('Add the brand website.');
    if (docs.filter((d) => d.text).length === 0) missing.push('Upload brand guidance or paste brand text.');
    if (profileState !== 'confirmed') missing.push(profileState === 'stale' ? 'Brand knowledge changed: re-extract and confirm the brand profile.' : 'Extract and confirm the brand profile.');
    if (!research) missing.push('Connect a research provider (server configuration).');
    if (generation === 'unavailable') missing.push('Connect a writing model API key (server configuration).');
    if (!budgets) missing.push('Set monthly writing and research budgets.');
    if (destination !== 'connected') missing.push('Connect and verify the website for publishing.');
    return {
      website: Boolean(brand.website), knowledge: docs.length, unreadableKnowledge: all.filter((d) => d.active && ['unreadable', 'unsupported', 'rejected'].includes(d.status)).length,
      profile: profileState, inventory: Boolean(inventory), research, generation, budgets, destination,
      canPlan: profileState === 'confirmed' && research && generation !== 'unavailable' && budgets,
      missing,
    };
  }

  // ─── Knowledge ───────────────────────────────────────────────────────────

  private async activeKnowledge(brandId: string): Promise<KnowledgeDocument[]> {
    const all = await this.store.listKnowledge(brandId);
    const latest = new Map<string, KnowledgeDocument>();
    for (const d of all) if (!latest.has(d.id) || latest.get(d.id)!.version < d.version) latest.set(d.id, d);
    return [...latest.values()].filter((d) => d.active);
  }

  async listKnowledge(actor: Actor, brandId: string): Promise<KnowledgeDocument[]> {
    await this.brandFor(actor, brandId);
    return this.store.listKnowledge(brandId);
  }

  async uploadKnowledge(actor: Actor, brandId: string, input: {
    category: string; title: string; filename?: string | null; bytes?: Buffer | null; pastedText?: string | null; replacesDocumentId?: string | null;
  }): Promise<KnowledgeDocument> {
    await this.brandFor(actor, brandId);
    if (!(KNOWLEDGE_CATEGORIES as readonly string[]).includes(input.category)) throw new SeoBlogError(400, 'Choose what kind of guidance this is.');
    const title = cleanText(String(input.title ?? '')).slice(0, 160) || (input.filename ?? 'Pasted text');
    const result = extractKnowledge({ filename: input.filename ?? null, bytes: input.bytes ?? null, pastedText: input.pastedText });
    const existing = await this.store.listKnowledge(brandId);
    let id: string = randomUUID();
    let version = 1;
    if (input.replacesDocumentId) {
      const prior = existing.filter((d) => d.id === input.replacesDocumentId);
      if (prior.length === 0) throw new SeoBlogError(404, 'The document to replace was not found.');
      id = input.replacesDocumentId;
      version = Math.max(...prior.map((d) => d.version)) + 1;
    }
    const keep = result.status !== 'rejected' && result.status !== 'unsupported';
    const blobId = keep && input.bytes ? await this.store.putBlob(brandId, input.bytes, result.mime) : null;
    const doc: KnowledgeDocument = {
      id, brandId, version, category: input.category as KnowledgeCategory, title, filename: input.filename ?? null,
      format: result.format, mime: result.mime, sizeBytes: input.bytes?.length ?? Buffer.byteLength(input.pastedText ?? ''),
      sha256: result.sha256, blobId, status: result.status, statusDetail: result.detail, text: result.text,
      pagesRead: result.pagesRead, pagesTotal: result.pagesTotal, active: keep, createdAt: this.now(),
    };
    await this.store.saveKnowledge(doc);
    await this.log(brandId, actor.userId, 'knowledge.uploaded', `${title}: ${result.detail}`, id);
    return doc;
  }

  async retireKnowledge(actor: Actor, brandId: string, documentId: string): Promise<void> {
    await this.brandFor(actor, brandId);
    const docs = (await this.store.listKnowledge(brandId)).filter((d) => d.id === documentId);
    const latest = docs.sort((a, b) => b.version - a.version)[0];
    if (!latest) throw new SeoBlogError(404, 'That document was not found.');
    await this.store.saveKnowledge({ ...latest, version: latest.version + 1, active: false, createdAt: this.now(), statusDetail: 'Retired by the owner.' });
    await this.log(brandId, actor.userId, 'knowledge.retired', `${latest.title} retired.`, documentId);
  }

  private knowledgeRefs(docs: readonly KnowledgeDocument[]): KnowledgeRef[] {
    return docs.filter((d) => d.text).map((d) => ({ documentId: d.id, version: d.version, sha256: d.sha256, category: d.category }))
      .sort((a, b) => a.documentId.localeCompare(b.documentId));
  }

  /** Profile is stale when a factual document changed after extraction; visual guidance never invalidates. */
  private profileStale(profile: BrandProfile, active: readonly KnowledgeDocument[]): boolean {
    const factual = (refs: readonly KnowledgeRef[]) => refs.filter((r) => FACTUAL_KNOWLEDGE_CATEGORIES.has(r.category)).map((r) => `${r.documentId}:${r.sha256}`).sort().join('|');
    return factual(profile.knowledge) !== factual(this.knowledgeRefs(active));
  }

  /** The key that article checks are bound to: profile facts plus factual-knowledge identity. */
  private async currentFactsKey(brandId: string): Promise<{ key: string; profile: BrandProfile | null; stale: boolean }> {
    const [profile, all] = await Promise.all([this.store.latestProfile(brandId), this.store.listKnowledge(brandId)]);
    return this.factsKeyFrom(profile, all);
  }

  /** Pure form, used inside the publication-begin boundary on locked/same-snapshot reads. */
  private factsKeyFrom(profile: BrandProfile | null, allKnowledge: readonly KnowledgeDocument[]): { key: string; profile: BrandProfile | null; stale: boolean } {
    if (!profile) return { key: 'no-profile', profile: null, stale: true };
    const latest = new Map<string, KnowledgeDocument>();
    for (const d of allKnowledge) if (!latest.has(d.id) || latest.get(d.id)!.version < d.version) latest.set(d.id, d);
    const stale = this.profileStale(profile, [...latest.values()].filter((d) => d.active));
    return { key: sha256({ facts: profile.factsSha, profileVersion: profile.version, confirmed: profile.confirmedAt, stale }), profile, stale };
  }

  // ─── Profile ─────────────────────────────────────────────────────────────

  private async requireBudget(brand: Brand, kind: UsageKind, amount: number): Promise<void> {
    const ceiling = kind === 'model_tokens' ? brand.settings.budgets.modelTokensPerMonth : kind === 'search_calls' ? brand.settings.budgets.searchCallsPerMonth : brand.settings.budgets.imagesPerMonth;
    const used = await this.store.usageSince(brand.id, kind, monthStart(this.now()));
    if (ceiling <= 0 || used + amount > ceiling) throw new BudgetExceededError(kind);
  }

  private async recordGeneration(brandId: string, record: GenerationRecord, reference: string): Promise<void> {
    await this.store.recordUsage({ brandId, kind: 'model_tokens', amount: record.tokensIn + record.tokensOut, at: this.now(), reference });
  }

  private llm(): LlmClient {
    if (!this.deps.llm) throw new GenerationUnavailableError();
    return this.deps.llm;
  }

  async extractBrandProfile(actor: Actor, brandId: string): Promise<BrandProfile> {
    const brand = await this.brandFor(actor, brandId);
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.profile);
    const docs = await this.activeKnowledge(brandId);
    const result = await extractProfile(this.llm(), { brandName: brand.name, website: brand.website, documents: docs });
    await this.recordGeneration(brandId, result.record, 'profile');
    const prior = await this.store.latestProfile(brandId);
    const profile: BrandProfile = {
      ...result.value, brandId, version: (prior?.version ?? 0) + 1, knowledge: this.knowledgeRefs(docs),
      factsSha: profileFactsSha(result.value), source: 'extracted', confirmedAt: null, confirmedBy: null,
      createdAt: this.now(), generation: result.record,
    };
    await this.store.saveProfile(profile);
    await this.log(brandId, actor.userId, 'profile.extracted', `Brand profile version ${profile.version} extracted${profile.conflicts.length ? ` with ${profile.conflicts.length} conflict(s) to resolve` : ''}.`);
    return profile;
  }

  async editProfile(actor: Actor, brandId: string, expectedVersion: number, edits: Partial<Pick<BrandProfile, 'summary' | 'audiences' | 'positioning' | 'offers' | 'conversionPages' | 'voice' | 'approvedClaims' | 'exclusions' | 'conflicts' | 'missingFacts'>>): Promise<BrandProfile> {
    await this.brandFor(actor, brandId);
    const current = await this.store.latestProfile(brandId);
    if (!current || current.version !== expectedVersion) throw new StaleWriteError('brand profile');
    for (const page of edits.conversionPages ?? []) if (!/^https:\/\//.test(page.url)) throw new SeoBlogError(400, 'Conversion pages must be full https:// addresses.');
    const merged = { ...current, ...edits };
    const profile: BrandProfile = { ...merged, version: current.version + 1, factsSha: profileFactsSha(merged), source: 'owner_edited', confirmedAt: null, confirmedBy: null, createdAt: this.now(), generation: null };
    await this.store.saveProfile(profile);
    await this.log(brandId, actor.userId, 'profile.edited', `Brand profile edited (version ${profile.version}). Confirm it to use it.`);
    return profile;
  }

  async confirmProfile(actor: Actor, brandId: string, version: number): Promise<BrandProfile> {
    await this.brandFor(actor, brandId);
    const current = await this.store.latestProfile(brandId);
    if (!current || current.version !== version) throw new StaleWriteError('brand profile');
    if (current.confirmedAt) return current;
    // Confirmation is a new immutable profile version so history keeps what was confirmed and when.
    const confirmed: BrandProfile = { ...current, version: current.version + 1, confirmedAt: this.now(), confirmedBy: actor.userId, createdAt: this.now() };
    await this.store.saveProfile(confirmed);
    await this.log(brandId, actor.userId, 'profile.confirmed', `Brand profile confirmed${current.conflicts.length ? `; ${current.conflicts.length} unresolved conflict(s) will hold any article that mentions them` : ''}.`);
    return confirmed;
  }

  getProfile(actor: Actor, brandId: string): Promise<BrandProfile | null> {
    return this.brandFor(actor, brandId).then(() => this.store.latestProfile(brandId));
  }

  // ─── Inventory ───────────────────────────────────────────────────────────

  async refreshInventory(brandId: string, actorLabel = 'system'): Promise<WebsiteInventory> {
    const brand = await this.store.getBrand(brandId);
    if (!brand?.website) throw new SeoBlogError(409, 'Add the brand website before reading its pages.');
    const inventory = await buildInventory(brandId, brand.website, this.deps.transport, { now: this.now() });
    await this.store.saveInventory(inventory);
    const ok = inventory.pages.filter((p) => p.fetchStatus === 'ok');
    await this.log(brandId, actorLabel, 'inventory.refreshed', `Website read: ${ok.length} pages (${ok.filter((p) => p.editorial).length} editorial), ${inventory.pages.length - ok.length} could not be read.`);
    return inventory;
  }

  async requestInventory(actor: Actor, brandId: string): Promise<Job> {
    await this.brandFor(actor, brandId);
    return this.enqueue(brandId, 'inventory', `inventory:${this.now().slice(0, 13)}`, {});
  }

  async getInventory(actor: Actor, brandId: string): Promise<WebsiteInventory | null> {
    await this.brandFor(actor, brandId);
    return this.store.getInventory(brandId);
  }

  // ─── Planning ────────────────────────────────────────────────────────────

  async requestPlan(actor: Actor, brandId: string, input: { commandId: string; focus?: string | null; excluded?: readonly string[]; sourceArticleUrl?: string | null }): Promise<Job> {
    const brand = await this.brandFor(actor, brandId);
    if (!validUuid(input.commandId)) throw new SeoBlogError(400, 'Refresh the form and try again.');
    const readiness = await this.readinessFor(brand);
    if (!readiness.canPlan) throw new SeoBlogError(409, `Before planning: ${readiness.missing.filter((m) => !m.includes('website for publishing')).join(' ')}`, 'not_ready');
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.plan);
    await this.requireBudget(brand, 'search_calls', USAGE_ESTIMATES.searchPerPlan);
    const sourceArticleUrl = input.sourceArticleUrl?.trim() ? validatePublicUrl(input.sourceArticleUrl.trim()).toString() : null;
    return this.enqueue(brandId, 'plan', `plan:${input.commandId}`, {
      focus: cleanText(input.focus ?? '').slice(0, 300) || null,
      excluded: (input.excluded ?? []).map((x) => cleanText(x).slice(0, 80)).filter(Boolean).slice(0, 20),
      sourceArticleUrl,
      requestedBy: actor.userId,
    });
  }

  /** Job handler: research → cluster → duplicate checks → suggested diary dates. */
  async runPlan(brandId: string, payload: { focus: string | null; excluded: string[]; sourceArticleUrl: string | null; requestedBy?: string }): Promise<TopicPlan> {
    const brand = await this.store.getBrand(brandId);
    if (!brand) throw new SeoBlogError(404, 'Brand not found.');
    const { profile, stale } = await this.currentFactsKey(brandId);
    if (!profile?.confirmedAt || stale) throw new SeoBlogError(409, 'Confirm the current brand profile before planning.', 'not_ready');
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.plan);
    await this.requireBudget(brand, 'search_calls', USAGE_ESTIMATES.searchPerPlan);
    let inventory = await this.store.getInventory(brandId);
    if (brand.website && (!inventory || Date.parse(this.now()) - Date.parse(inventory.fetchedAt) > 24 * 3600_000)) {
      inventory = await this.refreshInventory(brandId);
    }
    const pages = inventory?.pages ?? [];
    // Seed queries come from the brand itself: audiences' questions, offers, gaps — never from an owner prompt.
    const seeds = [
      payload.focus,
      ...profile.offers.slice(0, 3).map((o) => `${o.name} ${brand.locale === 'en-GB' ? 'UK' : ''}`.trim()),
      ...profile.audiences.slice(0, 3).map((a) => `${a} questions`),
      profile.positioning.split(/[.;]/)[0],
    ].filter((q): q is string => Boolean(q && q.trim().length > 3)).map((q) => q.slice(0, 120));
    const research = await researchQueries({
      queries: [...new Set(seeds)].slice(0, USAGE_ESTIMATES.searchPerPlan), search: this.deps.search, transport: this.deps.transport,
      locale: brand.locale, brandWebsite: brand.website, now: this.now, keywordProvider: this.deps.keywords ?? null,
    });
    if (research.searchCalls > 0) await this.store.recordUsage({ brandId, kind: 'search_calls', amount: research.searchCalls, at: this.now(), reference: 'plan' });
    if (research.sources.length === 0) throw new ResearchUnavailableError('Research returned no usable sources. Planning paused; nothing was invented.');
    const planned = await this.store.listBriefs(brandId);
    const articles = await this.store.listArticles(brandId);
    const result = await proposeCluster(this.llm(), {
      brandName: brand.name, profile, inventory: pages, sources: research.sources,
      focus: payload.focus, excluded: payload.excluded, sourceArticleUrl: payload.sourceArticleUrl,
    });
    await this.recordGeneration(brandId, result.record, 'plan');
    const short = new Map(research.sources.map((s, i) => [`S${i + 1}`, s]));
    const planId = randomUUID();
    const cluster = [result.value.pillar, ...result.value.supporting];
    const slugToId = new Map(cluster.map((a) => [a.slug, randomUUID()]));
    const comparable: import('./dedupe.js').PlannedComparable[] = [
      ...planned.filter((b) => !['omitted', 'skipped'].includes(b.status)).map((b) => ({ id: b.id, title: b.workingTitle, targetQuery: b.targetQuery, slug: b.slug })),
      ...articles.map((a) => ({ id: a.id, title: a.slug.replace(/-/g, ' '), targetQuery: a.slug.replace(/-/g, ' '), slug: a.slug })),
    ];
    const usedSlugs = new Set([...planned.map((b) => b.slug), ...articles.map((a) => a.slug)]);
    const briefs: ArticleBrief[] = [];
    for (const item of cluster) {
      const duplicate = assessDuplicate({ title: item.working_title, targetQuery: item.target_query, slug: item.slug }, pages, comparable);
      let slug = item.slug;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${item.slug}-${n}`.slice(0, 80);
      usedSlugs.add(slug);
      const metric = research.keywordMetrics.find((m) => m.keyword.toLowerCase() === item.target_query.toLowerCase() && m.volume !== null);
      const brief: ArticleBrief = {
        id: slugToId.get(item.slug)!, planId, brandId, role: item.role, slug,
        workingTitle: item.working_title, targetQuery: item.target_query, searchIntent: item.search_intent,
        relatedQuestions: item.related_questions, angle: item.angle, outline: item.outline, keyPoints: item.key_points,
        cta: this.ctaFor(item, profile), internalLinks: item.internal_links.map((l) => (slugToId.has(l) ? `brief:${slugToId.get(l)}` : l)),
        whyFit: item.why_fit,
        demand: metric
          ? { kind: 'measured', volume: metric.volume, competition: metric.difficulty, provider: metric.source, retrievedAt: this.now() }
          : { kind: 'qualitative', rationale: 'No measured search data was available; chosen from the brand’s audiences, offers, content gaps and research.' },
        sourceIds: item.source_ids.map((id) => short.get(id)?.id).filter((id): id is string => Boolean(id)),
        duplicate,
        status: duplicate.verdict === 'skip' || duplicate.verdict === 'update_existing' ? 'postponed' : 'planned',
        suggestedAtUtc: null, articleId: null,
      };
      comparable.push({ id: brief.id, title: brief.workingTitle, targetQuery: brief.targetQuery, slug: brief.slug, sibling: true });
      briefs.push(brief);
    }
    // Suggested dates: pillar first, supporting after it, inside the planning horizon.
    const occupied = articles.filter((a) => a.schedule).map((a) => a.schedule!.localDate)
      .concat(planned.filter((b) => b.suggestedAtUtc && ['planned', 'accepted'].includes(b.status)).map((b) => utcToLocal(b.suggestedAtUtc!, brand.timezone).date));
    const pillar = briefs.find((b) => b.role === 'pillar');
    const placement = autoPlace({
      items: briefs.filter((b) => b.status === 'planned').map((b) => ({ id: b.id, role: b.role, after: b.role === 'supporting' && pillar && pillar.status === 'planned' ? [pillar.id] : [] })),
      occupiedLocalDates: occupied, cadence: brand.settings.cadence, timeZone: brand.timezone, now: this.now(), horizonDays: brand.settings.planningHorizonDays,
    });
    const when = new Map(placement.placed.map((p) => [p.id, p.utc]));
    const plan: TopicPlan = {
      id: planId, brandId, status: 'proposed', topic: result.value.topic,
      moneyPage: result.value.money_page.url ? { url: result.value.money_page.url, label: result.value.money_page.label } : null,
      briefIds: briefs.map((b) => b.id), sources: research.sources,
      inputs: { focus: payload.focus, excluded: payload.excluded, sourceArticleUrl: payload.sourceArticleUrl },
      profileVersion: profile.version, inventoryAt: inventory?.fetchedAt ?? null, generation: result.record, createdAt: this.now(), acceptedAt: null,
    };
    // Briefs first, plan last: a crash in between leaves orphan briefs no screen lists, never a half plan.
    for (const brief of briefs) await this.store.saveBrief({ ...brief, suggestedAtUtc: when.get(brief.id) ?? null });
    await this.store.savePlan(plan);
    await this.log(brandId, payload.requestedBy ?? 'system', 'plan.proposed', `New topic plan: “${plan.topic}” (${briefs.length} articles).`, planId);
    if (brand.settings.autoAcceptPlans) {
      await this.acceptPlanInternal(brand, plan, 'system');
      if (brand.settings.ongoingProduction) await this.topUpWrites(brandId);
    }
    return plan;
  }

  private ctaFor(item: PlannedArticle, profile: BrandProfile): { label: string; url: string } | null {
    if (!item.cta_url) return null;
    const page = profile.conversionPages.find((p) => p.url === item.cta_url);
    return { label: page?.label ?? 'Find out more', url: item.cta_url };
  }

  async listPlans(actor: Actor, brandId: string): Promise<{ plan: TopicPlan; briefs: ArticleBrief[] }[]> {
    await this.brandFor(actor, brandId);
    const [plans, briefs] = await Promise.all([this.store.listPlans(brandId), this.store.listBriefs(brandId)]);
    return plans.map((plan) => ({ plan, briefs: plan.briefIds.map((id) => briefs.find((b) => b.id === id)).filter((b): b is ArticleBrief => Boolean(b)) }));
  }

  async setBriefStatus(actor: Actor, brandId: string, briefId: string, status: 'planned' | 'postponed' | 'omitted'): Promise<ArticleBrief> {
    await this.brandFor(actor, brandId);
    const brief = await this.store.getBrief(brandId, briefId);
    if (!brief) throw new SeoBlogError(404, 'That planned article was not found.');
    if (['generating', 'generated'].includes(brief.status)) throw new SeoBlogError(409, 'This article has already been written.');
    const next = { ...brief, status, suggestedAtUtc: status === 'planned' ? brief.suggestedAtUtc : null };
    await this.store.saveBrief(next);
    await this.log(brandId, actor.userId, 'brief.status', `“${brief.workingTitle}” marked ${status}.`, briefId);
    return next;
  }

  async acceptPlan(actor: Actor, brandId: string, planId: string): Promise<TopicPlan> {
    const brand = await this.brandFor(actor, brandId);
    const plan = await this.store.getPlan(brandId, planId);
    if (!plan) throw new SeoBlogError(404, 'That plan was not found.');
    return this.acceptPlanInternal(brand, plan, actor.userId);
  }

  private async acceptPlanInternal(brand: Brand, plan: TopicPlan, actor: string): Promise<TopicPlan> {
    if (plan.status === 'accepted') return plan;
    if (plan.status !== 'proposed') throw new SeoBlogError(409, 'Only a proposed plan can be accepted.');
    for (const id of plan.briefIds) {
      const brief = await this.store.getBrief(brand.id, id);
      if (brief?.status === 'planned') await this.store.saveBrief({ ...brief, status: 'accepted' });
    }
    const accepted: TopicPlan = { ...plan, status: 'accepted', acceptedAt: this.now() };
    await this.store.savePlan(accepted);
    await this.log(brand.id, actor, 'plan.accepted', `Plan “${plan.topic}” accepted.`, plan.id);
    return accepted;
  }

  // ─── Article generation ──────────────────────────────────────────────────

  async estimate(actor: Actor, brandId: string, briefIds: readonly string[]): Promise<{ articles: number; modelTokens: number; remainingTokens: number }> {
    const brand = await this.brandFor(actor, brandId);
    const used = await this.store.usageSince(brandId, 'model_tokens', monthStart(this.now()));
    return { articles: briefIds.length, modelTokens: briefIds.length * USAGE_ESTIMATES.article, remainingTokens: Math.max(0, brand.settings.budgets.modelTokensPerMonth - used) };
  }

  async requestArticles(actor: Actor, brandId: string, briefIds: readonly string[]): Promise<Job[]> {
    const brand = await this.brandFor(actor, brandId);
    if (briefIds.length === 0 || briefIds.length > 10) throw new SeoBlogError(400, 'Choose between 1 and 10 planned articles.');
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.article * briefIds.length);
    if (!this.deps.llm) throw new GenerationUnavailableError();
    const jobs: Job[] = [];
    for (const briefId of briefIds) {
      const brief = await this.store.getBrief(brandId, briefId);
      if (!brief) throw new SeoBlogError(404, 'A planned article was not found.');
      if (['omitted', 'skipped'].includes(brief.status)) throw new SeoBlogError(409, `“${brief.workingTitle}” is omitted; restore it first.`);
      jobs.push(await this.enqueue(brandId, 'write', `write:${briefId}`, { briefId, requestedBy: actor.userId }));
    }
    return jobs;
  }

  async requestRegeneration(actor: Actor, brandId: string, articleId: string, expectedVersionId: string): Promise<Job> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId);
    if (!article) throw new SeoBlogError(404, 'That article was not found.');
    if (article.currentVersionId !== expectedVersionId) throw new StaleWriteError('article');
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.article);
    return this.enqueue(brandId, 'write', `rewrite:${articleId}:${expectedVersionId}`, { briefId: article.briefId, fromVersionId: expectedVersionId, requestedBy: actor.userId });
  }

  private async sourcesForBrief(brandId: string, brief: ArticleBrief): Promise<ResearchSource[]> {
    const plan = await this.store.getPlan(brandId, brief.planId);
    const all = plan?.sources ?? [];
    const chosen = all.filter((s) => brief.sourceIds.includes(s.id));
    return chosen.length >= 2 ? chosen : all.slice(0, 12);
  }

  private async linkable(brandId: string): Promise<{ url: string; title: string | null }[]> {
    const [inventory, articles, destinations] = await Promise.all([this.store.getInventory(brandId), this.store.listArticles(brandId), this.store.listDestinations(brandId)]);
    const pages = (inventory?.pages ?? []).filter((p) => p.fetchStatus === 'ok').map((p) => ({ url: p.canonical ?? p.url, title: p.title }));
    // Already-published articles are real pages; planned ones never become public links.
    const published = articles.filter((a) => a.delivery === 'published' && a.publishedUrl).map((a) => ({ url: a.publishedUrl!, title: a.slug.replace(/-/g, ' ') }));
    void destinations;
    return [...pages, ...published];
  }

  /** Job handler. Idempotent: a re-run after a crash finishes or no-ops, never duplicates. */
  async runWrite(brandId: string, payload: { briefId: string; fromVersionId?: string; requestedBy?: string }): Promise<Article> {
    const brand = await this.store.getBrand(brandId);
    if (!brand) throw new SeoBlogError(404, 'Brand not found.');
    const brief = await this.store.getBrief(brandId, payload.briefId);
    if (!brief) throw new SeoBlogError(404, 'Planned article not found.');
    const { profile, stale } = await this.currentFactsKey(brandId);
    if (!profile?.confirmedAt || stale) throw new SeoBlogError(409, 'Confirm the current brand profile before writing.', 'not_ready');
    const { article: created } = await this.store.createArticle({
      id: randomUUID(), brandId, briefId: brief.id, planId: brief.planId, slug: brief.slug, editorialState: 'writing',
      currentVersionId: null, requiresApproval: false, approval: null, checks: null, schedule: null, hold: null,
      delivery: 'none', publishedVersionId: null, publishedUrl: null, lastAttemptAt: null, publishedAt: null, failure: null,
      createdAt: this.now(), rowVersion: 1,
    });
    let article = created;
    if (!payload.fromVersionId && article.currentVersionId) {
      // Already written (e.g. a crash after the version was stored): finish bookkeeping only.
      if (brief.status !== 'generated') await this.store.saveBrief({ ...brief, status: 'generated', articleId: article.id });
      return article;
    }
    if (payload.fromVersionId && article.currentVersionId !== payload.fromVersionId) return article; // superseded meanwhile
    if (brief.status !== 'generating') await this.store.saveBrief({ ...brief, status: 'generating', articleId: article.id });
    if (article.editorialState !== 'writing') article = await this.store.updateArticle({ ...article, editorialState: 'writing' });
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.article);
    const sources = await this.sourcesForBrief(brandId, brief);
    const linkable = await this.linkable(brandId);
    let written;
    try {
      written = await writeArticle(this.llm(), { profile, brief, sources, linkable, length: brand.settings.lengthPreference });
    } catch (error) {
      await this.store.updateArticle({ ...article, editorialState: article.currentVersionId ? 'draft' : 'failed', failure: (error as Error).message.slice(0, 300) }).catch(() => undefined);
      throw error;
    }
    await this.recordGeneration(brandId, written.record, `article:${article.id}`);
    const previous = article.currentVersionId ? await this.store.getVersion(brandId, article.currentVersionId) : null;
    const v = written.value;
    const publicIds = new Set(v.public_source_ids.map((id) => written.short.get(id)?.id).filter(Boolean));
    const body: ArticleBody = {
      title: v.title, seoTitle: v.seo_title, metaDescription: v.meta_description, excerpt: v.excerpt,
      slug: previous?.body.slug ?? brief.slug,
      intro: resolveMarkers(v.intro, written.short),
      sections: v.sections.map((s, i) => ({ id: previous?.body.sections[i]?.id ?? randomUUID(), heading: s.heading, body: resolveMarkers(s.body, written.short) })),
      conclusion: resolveMarkers(v.conclusion, written.short),
      cta: brief.cta,
      faqs: v.faqs.map((f) => ({ q: f.q, a: resolveMarkers(f.a, written.short) })),
      citations: sources.map((s) => ({ sourceId: s.id, url: s.url, title: s.title, retrievedAt: s.retrievedAt, passage: s.passage, public: publicIds.has(s.id) || bodyCites(v, written.short, s.id) })),
      image: previous?.body.image ?? { kind: 'none', url: null, alt: v.image_alt, provenance: 'No image selected yet.', width: null, height: null },
      author: brand.settings.author,
    };
    const version = await this.appendVersion(brand, article, body, previous ? 'regenerated' : 'generated', null, payload.requestedBy ?? 'system', written.record, profile, brief);
    await this.store.saveBrief({ ...(await this.store.getBrief(brandId, brief.id))!, status: 'generated', articleId: article.id });
    await this.log(brandId, payload.requestedBy ?? 'system', previous ? 'article.regenerated' : 'article.generated', `“${body.title}” ${previous ? 'regenerated' : 'written'} (version ${version.number}).`, article.id);
    return (await this.store.getArticle(brandId, article.id))!;
  }

  private async appendVersion(
    brand: Brand, article: Article, body: ArticleBody, change: VersionChange, changedSectionId: string | null, actor: string,
    generation: GenerationRecord | null, profile: BrandProfile, brief: ArticleBrief,
  ): Promise<ArticleVersion> {
    const versions = await this.store.listVersions(brand.id, article.id);
    const contentSha = sha256(body);
    const versionId = randomUUID();
    const destinations = (await this.store.listDestinations(brand.id)).filter(d => d.status === 'connected');
    const destination = destinations.find(d => d.id === article.schedule?.destinationId) ?? (destinations.length === 1 ? destinations[0] : null);
    const canonicalUrl = destination ? publisherFor(this.deps.publishers, destination.type).publicUrlFor(destination, body.slug) : null;
    let generationRecord: GenerationRecord | null = null;
    let posts: ArticlePromotionPack['posts'] = (['instagram', 'linkedin'] as const).map(network => ({
      network, title: body.title, copy: `${body.title}\n\n${body.excerpt}\n\nRead the full article.`,
      artworkInstructions: `Create a brand-approved editorial image illustrating “${body.title}”. Review the image before scheduling.`,
    }));
    try {
      await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.promotion);
      const generated = await writeArticlePromotions(this.llm(), profile, body);
      await this.recordGeneration(brand.id, generated.record, `promotion:${article.id}:${versionId}`);
      posts = generated.value.posts; generationRecord = generated.record;
    } catch (error) {
      // Preserve the article/edit when the optional copy stage cannot run. The UI labels this fallback.
      await this.log(brand.id, actor, 'promotion.fallback', `Accompanying drafts use the article excerpt: ${(error as Error).message.slice(0, 160)}`, article.id);
    }
    const promotionPack: ArticlePromotionPack = {
      source: 'relaunch72.seo-blog', brandId: brand.id, articleId: article.id, versionId, contentSha,
      profileVersion: profile.version, factsSha: profile.factsSha, canonicalUrl,
      generation: generationRecord, mode: generationRecord ? 'model' : 'excerpt_fallback', posts,
    };
    const version: ArticleVersion = {
      id: versionId, articleId: article.id, brandId: brand.id, number: (versions.at(-1)?.number ?? 0) + 1,
      parentVersionId: article.currentVersionId, change, changedSectionId, createdAt: this.now(), createdBy: actor, body,
      profileVersion: profile.version, factsSha: profile.factsSha, knowledge: profile.knowledge, briefId: brief.id, planId: brief.planId,
      generation, contentSha, promotionPack,
    };
    await this.store.addVersion(version);
    const checks = await this.checkVersion(brand, version);
    // A new version always invalidates the old approval; review-required articles return to Needs approval.
    await this.store.updateArticle({
      ...article, slug: body.slug, currentVersionId: version.id, editorialState: 'draft', approval: null, checks, failure: null,
      hold: article.hold && ['checks_failed', 'stale_version'].includes(article.hold.reason) ? null : article.hold,
    });
    return version;
  }

  async refreshPromotionVersion(actor: Actor, brandId: string, articleId: string, expectedVersionId: string): Promise<ArticleVersion> {
    const brand = await this.brandFor(actor, brandId);
    const { article, version, profile, brief } = await this.editable(brandId, articleId, expectedVersionId);
    return this.appendVersion(brand, article, version.body, 'metadata_changed', null, actor.userId, null, profile, brief);
  }

  async approvePromotion(actor: Actor, brandId: string, articleId: string, versionId: string, network: PromotionNetwork, expectedPackSha: string): Promise<void> {
    const brand = await this.brandFor(actor, brandId);
    const { article, version } = await this.editable(brandId, articleId, versionId);
    if (!version.promotionPack || sha256(version.promotionPack) !== expectedPackSha) throw new SeoBlogError(409, 'The accompanying drafts changed. Refresh before approving.');
    if (!this.deps.promotions) throw new SeoBlogError(503, 'Canonical promotion approval is temporarily unavailable.');
    const link = await this.deps.promotions.approve(brand, article, version, network);
    const current = (await this.store.getArticle(brandId, articleId))!;
    if (current.currentVersionId !== versionId) throw new StaleWriteError('article');
    await this.store.updateArticle({ ...current, linkedPromotions: [...(current.linkedPromotions ?? []).filter(p => !(p.articleVersionId === versionId && p.network === network)), link] });
    await this.log(brandId, actor.userId, 'promotion.approved', `${network} accompanying post approved for article version ${version.number}. Delivery remains separately gated.`, articleId);
  }

  private async checkVersion(brand: Brand, version: ArticleVersion): Promise<CheckReport> {
    const facts = await this.currentFactsKey(brand.id);
    const profile = facts.profile;
    if (!profile) throw new SeoBlogError(409, 'Extract the brand profile first.');
    const [inventory, articles, plan] = await Promise.all([this.store.getInventory(brand.id), this.store.listArticles(brand.id), this.store.getPlan(brand.id, version.planId)]);
    const linkable = linkableUrls(inventory);
    for (const a of articles) if (a.delivery === 'published' && a.publishedUrl) linkable.add(a.publishedUrl);
    const sources = new Map((plan?.sources ?? []).map((s) => [s.id, s]));
    for (const c of version.body.citations) if (!sources.has(c.sourceId)) sources.set(c.sourceId, { id: c.sourceId, url: c.url, title: c.title, retrievedAt: c.retrievedAt, passage: c.passage, provider: 'recorded', primary: false, query: '' });
    const others = [
      ...articles.filter((a) => a.id !== version.articleId).map((a) => ({ title: a.slug.replace(/-/g, ' '), slug: a.slug, kind: 'article' as const })),
      ...(inventory?.pages ?? []).filter((p) => p.fetchStatus === 'ok' && p.title).map((p) => ({ title: p.title!, slug: '', kind: 'page' as const })),
    ];
    const report = runChecks(version, { profile, sources, linkable, website: brand.website, others, now: this.now() });
    const issues = facts.stale
      ? [{ code: 'profile.stale', severity: 'critical' as const, message: 'Brand facts changed after this profile was confirmed.', fix: 'Re-extract and confirm the brand profile, then rerun checks.', location: null }, ...report.issues]
      : report.issues;
    return { ...report, factsSha: facts.key, issues, status: issues.some((i) => i.severity === 'critical') ? 'critical' : issues.length ? 'warnings' : 'pass' };
  }

  async rerunChecks(actor: Actor, brandId: string, articleId: string): Promise<CheckReport> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId);
    if (!article?.currentVersionId) throw new SeoBlogError(404, 'That article has no version yet.');
    const version = (await this.store.getVersion(brandId, article.currentVersionId))!;
    const checks = await this.checkVersion(brand, version);
    await this.store.updateArticle({ ...article, checks, hold: article.hold?.reason === 'checks_failed' && checks.status !== 'critical' ? null : article.hold });
    return checks;
  }

  // ─── Editing ─────────────────────────────────────────────────────────────

  async getArticle(actor: Actor, brandId: string, articleId: string): Promise<{ article: Article; version: ArticleVersion | null; versions: ArticleVersion[]; publications: Publication[]; status: string }> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId);
    if (!article) throw new SeoBlogError(404, 'That article was not found.');
    const versions = await this.store.listVersions(brandId, articleId);
    return {
      article, version: versions.find((v) => v.id === article.currentVersionId) ?? null, versions,
      publications: await this.store.listPublications(brandId, articleId), status: articleStatusLabel(article, brand.settings),
    };
  }

  async listArticles(actor: Actor, brandId: string): Promise<{ article: Article; title: string; status: string }[]> {
    const brand = await this.brandFor(actor, brandId);
    const articles = await this.store.listArticles(brandId);
    return Promise.all(articles.map(async (article) => {
      const version = article.currentVersionId ? await this.store.getVersion(brandId, article.currentVersionId) : null;
      return { article, title: version?.body.title ?? article.slug.replace(/-/g, ' '), status: articleStatusLabel(article, brand.settings) };
    }));
  }

  async editArticle(actor: Actor, brandId: string, articleId: string, expectedVersionId: string, edit: Partial<Omit<ArticleBody, 'citations' | 'author'>>): Promise<ArticleVersion> {
    const brand = await this.brandFor(actor, brandId);
    const { article, version, profile, brief } = await this.editable(brandId, articleId, expectedVersionId);
    if (article.delivery === 'publishing') throw new SeoBlogError(409, 'This article is being published. Wait for it to finish before editing.');
    const sections = edit.sections?.map((s) => ({ id: s.id && version.body.sections.some((x) => x.id === s.id) ? s.id : randomUUID(), heading: cleanText(s.heading).slice(0, 140), body: cleanText(s.body) }));
    const body: ArticleBody = {
      ...version.body,
      ...edit,
      ...(sections ? { sections } : {}),
      slug: edit.slug !== undefined ? slugify(edit.slug) : version.body.slug,
      image: edit.image ? this.validateImage(brand, edit.image) : version.body.image,
      citations: version.body.citations,
      author: brand.settings.author,
    };
    if (sha256(body) === version.contentSha) return version;
    const onlyMeta = sections === undefined && edit.intro === undefined && edit.conclusion === undefined && edit.faqs === undefined;
    const change: VersionChange = edit.image && Object.keys(edit).length === 1 ? 'image_changed' : onlyMeta ? 'metadata_changed' : 'edited';
    const next = await this.appendVersion(brand, article, body, change, null, actor.userId, null, profile, brief);
    await this.log(brandId, actor.userId, 'article.edited', `“${body.title}” edited (version ${next.number}). Approval was reset.`, articleId);
    return next;
  }

  private validateImage(brand: Brand, image: ArticleBody['image']): ArticleBody['image'] {
    if (image.kind === 'none') return { kind: 'none', url: null, alt: cleanText(image.alt).slice(0, 200), provenance: 'No image selected.', width: null, height: null };
    if (image.kind === 'generated') throw new SeoBlogError(409, 'Image generation is not connected for blog articles yet. Choose an existing brand image instead.');
    if (!image.url || !/^https:\/\//.test(image.url)) throw new SeoBlogError(400, 'Use a full https:// address for the image.');
    if (!image.alt || image.alt.trim().length < 5) throw new SeoBlogError(400, 'Describe the image in the alt text.');
    if (/\b(our client|testimonial|before and after|screenshot of|our property at)\b/i.test(image.alt)) {
      throw new SeoBlogError(400, 'Alt text must describe an illustrative image, not present it as evidence of a real client, property or product result.');
    }
    return {
      kind: image.kind, url: image.url, alt: cleanText(image.alt).slice(0, 200),
      provenance: cleanText(image.provenance || (brand.website && image.url.startsWith(new URL(brand.website).origin) ? 'Existing image on the brand website.' : 'Image supplied by the owner.')).slice(0, 300),
      width: image.width ?? null, height: image.height ?? null,
    };
  }

  private async editable(brandId: string, articleId: string, expectedVersionId: string): Promise<{ article: Article; version: ArticleVersion; profile: BrandProfile; brief: ArticleBrief }> {
    const article = await this.store.getArticle(brandId, articleId);
    if (!article) throw new SeoBlogError(404, 'That article was not found.');
    if (article.currentVersionId !== expectedVersionId) throw new StaleWriteError('article');
    const version = await this.store.getVersion(brandId, expectedVersionId);
    const profile = await this.store.latestProfile(brandId);
    const brief = await this.store.getBrief(brandId, article.briefId);
    if (!version || !profile || !brief) throw new SeoBlogError(409, 'The article’s history is incomplete.');
    return { article, version, profile, brief };
  }

  async regenerateSection(actor: Actor, brandId: string, articleId: string, expectedVersionId: string, sectionId: string, instruction: string): Promise<ArticleVersion> {
    const brand = await this.brandFor(actor, brandId);
    const { article, version, profile, brief } = await this.editable(brandId, articleId, expectedVersionId);
    const index = version.body.sections.findIndex((s) => s.id === sectionId);
    if (index < 0) throw new SeoBlogError(404, 'That section was not found.');
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.section);
    const sources = await this.sourcesForBrief(brandId, brief);
    const result = await rewriteSection(this.llm(), {
      profile, outline: version.body.sections.map((s) => s.heading), section: version.body.sections[index]!,
      instruction: cleanText(instruction), sources, linkable: await this.linkable(brandId),
    });
    await this.recordGeneration(brandId, result.record, `section:${articleId}`);
    // Only the target section changes; every other section is carried over byte-for-byte.
    const sections = version.body.sections.map((s, i) => (i === index ? { id: s.id, heading: result.value.heading, body: resolveMarkers(result.value.body, result.short) } : s));
    const known = new Set(version.body.citations.map((c) => c.sourceId));
    const citations = [...version.body.citations, ...sources.filter((s) => !known.has(s.id)).map((s) => ({ sourceId: s.id, url: s.url, title: s.title, retrievedAt: s.retrievedAt, passage: s.passage, public: sections[index]!.body.includes(`[src:${s.id}]`) }))]
      .map((c) => (sections[index]!.body.includes(`[src:${c.sourceId}]`) ? { ...c, public: true } : c));
    const next = await this.appendVersion(brand, article, { ...version.body, sections, citations }, 'section_regenerated', sectionId, actor.userId, result.record, profile, brief);
    await this.log(brandId, actor.userId, 'article.section', `Section “${sections[index]!.heading}” regenerated (version ${next.number}).`, articleId);
    return next;
  }

  // ─── Approval, holds, schedule ───────────────────────────────────────────

  async setRequiresApproval(actor: Actor, brandId: string, articleId: string, rowVersion: number, required: boolean): Promise<Article> {
    await this.brandFor(actor, brandId);
    const article = await this.mutableArticle(brandId, articleId, rowVersion);
    const next = await this.store.updateArticle({ ...article, requiresApproval: required });
    await this.log(brandId, actor.userId, 'article.approval_flag', `Article ${required ? 'now needs' : 'no longer needs'} your approval before publishing.`, articleId);
    return next;
  }

  async approve(actor: Actor, brandId: string, articleId: string, versionId: string): Promise<Article> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId);
    if (!article) throw new SeoBlogError(404, 'That article was not found.');
    if (article.currentVersionId !== versionId) throw new SeoBlogError(409, 'A newer version exists. Review the current version before approving.', 'stale_write');
    const version = await this.store.getVersion(brandId, versionId);
    const facts = await this.currentFactsKey(brandId);
    let checks = article.checks;
    if (!checksAreCurrent(checks, version, facts.key)) checks = await this.checkVersion(brand, version!);
    if (checks!.status === 'critical') {
      await this.store.updateArticle({ ...article, checks });
      throw new SeoBlogError(409, 'This version has critical issues. Fix them before approving — approval cannot override them.', 'checks_failed');
    }
    const next = await this.store.updateArticle({
      ...article, checks,
      approval: { versionId, contentSha: version!.contentSha, approvedAt: this.now(), approvedBy: actor.userId },
      // A late approval never releases a missed slot by itself: the owner chooses a new time.
      hold: article.hold,
    });
    await this.log(brandId, actor.userId, 'article.approved', `Version ${version!.number} approved.`, articleId);
    return next;
  }

  private async mutableArticle(brandId: string, articleId: string, rowVersion: number): Promise<Article> {
    const article = await this.store.getArticle(brandId, articleId);
    if (!article) throw new SeoBlogError(404, 'That article was not found.');
    if (article.rowVersion !== rowVersion) throw new StaleWriteError('article');
    if (article.delivery === 'publishing') throw new SeoBlogError(409, 'This article is being published right now.');
    return article;
  }

  async moveProposedDate(actor: Actor, brandId: string, articleId: string, rowVersion: number, localDate: string, localTime: string): Promise<void> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.mutableArticle(brandId, articleId, rowVersion);
    if (article.schedule) throw new SeoBlogError(409, 'Use Move schedule for an article with a publication schedule.');
    const brief = await this.store.getBrief(brandId, article.briefId);
    if (!brief) throw new SeoBlogError(404, 'The article plan was not found.');
    const proposed = localToUtc(localDate, localTime, brand.timezone);
    await this.store.saveBrief({ ...brief, suggestedAtUtc: proposed.utc });
    await this.log(brandId, actor.userId, 'diary.proposal_moved', 'Editorial proposal moved; no website publication scheduled.', articleId);
  }

  async schedule(actor: Actor, brandId: string, articleId: string, rowVersion: number, input: { localDate: string; localTime: string; destinationId: string }): Promise<Article> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.mutableArticle(brandId, articleId, rowVersion);
    if (!article.currentVersionId) throw new SeoBlogError(409, 'Write the article before scheduling it.');
    if (article.delivery === 'published' && article.publishedVersionId === article.currentVersionId) throw new SeoBlogError(409, 'This version is already published.');
    if (article.delivery === 'unknown') throw new SeoBlogError(409, 'The last publication is still being reconciled with the website. Wait until it is resolved.');
    const destination = await this.store.getDestination(brandId, input.destinationId);
    if (!destination) throw new SeoBlogError(400, 'Choose a connected website for this article.');
    const conversion = localToUtc(input.localDate, input.localTime, brand.timezone);
    if (Date.parse(conversion.utc) <= Date.parse(this.now())) throw new SeoBlogError(400, 'Choose a time in the future. Missed times are never published late.');
    const next = await this.store.updateArticle({
      ...article,
      schedule: { publishAtUtc: conversion.utc, localDate: input.localDate, localTime: conversion.localTime, timezone: brand.timezone, destinationId: destination.id, setAt: this.now(), setBy: actor.userId },
      // Choosing a new time is the owner's response to a missed or held slot.
      hold: null,
      // A failed attempt is retried only through a new owner-chosen slot (a new operation key).
      delivery: article.delivery === 'failed' ? 'none' : article.delivery,
      failure: article.delivery === 'failed' ? null : article.failure,
    });
    const note = conversion.adjusted === 'gap_shifted_forward' ? ` (${input.localTime} does not exist that day because the clocks go forward; scheduled for ${conversion.localTime})` : '';
    await this.log(brandId, actor.userId, 'article.scheduled', `Scheduled for ${input.localDate} ${conversion.localTime} ${brand.timezone}${note}. This is a diary slot; the website has not been changed.`, articleId);
    return next;
  }

  async unschedule(actor: Actor, brandId: string, articleId: string, rowVersion: number): Promise<Article> {
    await this.brandFor(actor, brandId);
    const article = await this.mutableArticle(brandId, articleId, rowVersion);
    const next = await this.store.updateArticle({ ...article, schedule: null });
    await this.log(brandId, actor.userId, 'article.unscheduled', 'Scheduled publication cancelled; the article is in the unscheduled tray.', articleId);
    return next;
  }

  async hold(actor: Actor, brandId: string, articleId: string, rowVersion: number, held: boolean): Promise<Article> {
    await this.brandFor(actor, brandId);
    const article = await this.mutableArticle(brandId, articleId, rowVersion);
    const next = await this.store.updateArticle({ ...article, hold: held ? { reason: 'owner', detail: 'Held by the owner.', at: this.now() } : null });
    await this.log(brandId, actor.userId, held ? 'article.held' : 'article.released', held ? 'Article held.' : 'Hold released.', articleId);
    return next;
  }

  /** Place unscheduled, unpublished drafts into free cadence slots (diary only). */
  async autoPlaceArticles(actor: Actor, brandId: string, destinationId: string): Promise<{ placed: number; unplaced: number }> {
    const brand = await this.brandFor(actor, brandId);
    const destination = await this.store.getDestination(brandId, destinationId);
    if (!destination) throw new SeoBlogError(400, 'Choose a website first.');
    const articles = await this.store.listArticles(brandId);
    const briefs = await this.store.listBriefs(brandId);
    const pending = articles.filter((a) => !a.schedule && a.currentVersionId && a.delivery !== 'published');
    const pillarIds = new Map(briefs.filter((b) => b.role === 'pillar').map((b) => [b.planId, b.articleId]));
    const result = autoPlace({
      items: pending.map((a) => {
        const brief = briefs.find((b) => b.id === a.briefId);
        const pillar = brief?.role === 'supporting' ? pillarIds.get(brief.planId) : null;
        return { id: a.id, role: brief?.role ?? 'supporting', after: pillar && pending.some((p) => p.id === pillar) ? [pillar] : [] };
      }),
      occupiedLocalDates: articles.filter((a) => a.schedule).map((a) => a.schedule!.localDate),
      cadence: brand.settings.cadence, timeZone: brand.timezone, now: this.now(), horizonDays: brand.settings.planningHorizonDays,
    });
    for (const p of result.placed) {
      const a = pending.find((x) => x.id === p.id)!;
      const fresh = (await this.store.getArticle(brandId, a.id))!;
      await this.store.updateArticle({ ...fresh, hold: null, schedule: { publishAtUtc: p.utc, localDate: p.localDate, localTime: p.localTime, timezone: brand.timezone, destinationId: destination.id, setAt: this.now(), setBy: actor.userId } });
    }
    await this.log(brandId, actor.userId, 'diary.autoplace', `Automatic placement: ${result.placed.length} placed, ${result.unplaced.length} left unscheduled.`);
    return { placed: result.placed.length, unplaced: result.unplaced.length };
  }

  // ─── Destinations ────────────────────────────────────────────────────────

  async connectDestination(actor: Actor, brandId: string, input: { type: string; label: string; config: Record<string, string>; credential: string; destinationId?: string | null }): Promise<Destination> {
    await this.brandFor(actor, brandId);
    if (!(DESTINATION_TYPES as readonly string[]).includes(input.type)) throw new SeoBlogError(400, 'This website type is not supported yet.');
    if (!this.deps.vault) throw new SeoBlogError(503, 'Secure credential storage is not configured on the server. Website connections are unavailable.', 'vault_unavailable');
    const publisher = publisherFor(this.deps.publishers, input.type);
    const validated = publisher.validateConfig(input.config);
    const existing = input.destinationId ? await this.store.getDestination(brandId, input.destinationId) : null;
    if (input.destinationId && !existing) throw new SeoBlogError(404, 'That website connection was not found.');
    const id = existing?.id ?? randomUUID();
    const sealed = input.credential ? this.deps.vault.seal(brandId, id, input.credential) : existing?.sealedCredential ?? null;
    if (!sealed) throw new SeoBlogError(400, `Enter the ${publisher.credentialLabel.toLowerCase()}.`);
    let destination: Destination = {
      id, brandId, type: publisher.type, label: cleanText(input.label).slice(0, 80) || publisher.label, config: validated.config,
      sealedCredential: sealed, publicBaseUrl: validated.publicBaseUrl, status: 'unverified', statusDetail: 'Not checked yet.', checkedAt: null,
      createdAt: existing?.createdAt ?? this.now(),
    };
    await this.store.saveDestination(destination);
    destination = await this.checkDestinationInternal(destination);
    await this.log(brandId, actor.userId, 'destination.connected', `${destination.label}: ${destination.statusDetail}`, id);
    return destination;
  }

  async checkDestination(actor: Actor, brandId: string, destinationId: string): Promise<Destination> {
    await this.brandFor(actor, brandId);
    const destination = await this.store.getDestination(brandId, destinationId);
    if (!destination) throw new SeoBlogError(404, 'That website connection was not found.');
    return this.checkDestinationInternal(destination);
  }

  private async checkDestinationInternal(destination: Destination): Promise<Destination> {
    const publisher = publisherFor(this.deps.publishers, destination.type);
    let result: { ok: boolean; detail: string };
    try {
      result = await publisher.checkConnection(destination, this.credentialFor(destination));
    } catch (error) {
      result = { ok: false, detail: (error as Error).message };
    }
    const next: Destination = { ...destination, status: result.ok ? 'connected' : 'failed', statusDetail: result.detail.slice(0, 300), checkedAt: this.now() };
    await this.store.saveDestination(next);
    return next;
  }

  private credentialFor(destination: Destination): string {
    if (!this.deps.vault || !destination.sealedCredential) throw new SeoBlogError(409, 'Reconnect the website: no credential is stored.', 'credential_unavailable');
    return this.deps.vault.open(destination.brandId, destination.id, destination.sealedCredential);
  }

  async listDestinations(actor: Actor, brandId: string): Promise<Omit<Destination, 'sealedCredential'>[]> {
    await this.brandFor(actor, brandId);
    return (await this.store.listDestinations(brandId)).map(({ sealedCredential: _omit, ...rest }) => rest);
  }

  // ─── Preview & export ────────────────────────────────────────────────────

  async preview(actor: Actor, brandId: string, articleId: string, versionId?: string): Promise<string> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId);
    const version = article ? await this.store.getVersion(brandId, versionId ?? article.currentVersionId ?? '') : null;
    if (!article || !version || version.articleId !== articleId) throw new SeoBlogError(404, 'That version was not found.');
    const destination = article.schedule ? await this.store.getDestination(brandId, article.schedule.destinationId) : (await this.store.listDestinations(brandId))[0] ?? null;
    const base = destination?.publicBaseUrl ?? brand.website ?? 'https://example.invalid';
    const canonical = destination ? publisherFor(this.deps.publishers, destination.type).publicUrlFor(destination, version.body.slug) : `${base}/blog/${version.body.slug}/`;
    return renderArticlePage(version.body, {
      siteName: brand.name, canonicalUrl: canonical, blogIndexUrl: destination ? publisherFor(this.deps.publishers, destination.type).indexUrlFor(destination) : `${base}/blog/`,
      locale: brand.locale, publishedAt: this.now(), articleId, versionId: version.id, contentSha: version.contentSha, noindex: true,
    });
  }

  async exportArticle(actor: Actor, brandId: string, articleId: string, format: 'markdown' | 'html'): Promise<{ filename: string; body: string; contentType: string }> {
    await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId);
    const version = article?.currentVersionId ? await this.store.getVersion(brandId, article.currentVersionId) : null;
    if (!article || !version) throw new SeoBlogError(404, 'That article has no version yet.');
    if (format === 'markdown') {
      return { filename: `${version.body.slug}.md`, contentType: 'text/markdown; charset=utf-8', body: exportMarkdown(version.body, { canonicalUrl: article.publishedUrl, versionId: version.id, articleId }) };
    }
    return { filename: `${version.body.slug}.html`, contentType: 'text/html; charset=utf-8', body: await this.preview(actor, brandId, articleId, version.id) };
  }

  // ─── Dispatch & reconciliation (worker) ──────────────────────────────────

  /** Evaluate every due article of one brand against the latest policy and publish or hold it. */
  async dispatchDue(brandId: string): Promise<{ published: number; held: number; skipped: number }> {
    const counts = { published: 0, held: 0, skipped: 0 };
    const now = this.now();
    for (const candidate of await this.store.listArticles(brandId)) {
      if (!candidate.schedule || candidate.hold || Date.parse(candidate.schedule.publishAtUtc) > Date.parse(now)) continue;
      try {
        const outcome = await this.dispatchOne(brandId, candidate.id);
        counts[outcome]++;
      } catch (error) {
        if (error instanceof StaleWriteError) { counts.skipped++; continue; } // another worker got there first
        throw error;
      }
    }
    await this.reconcile(brandId);
    return counts;
  }

  private async dispatchOne(brandId: string, articleId: string): Promise<'published' | 'held' | 'skipped'> {
    // Preparation outside the boundary: refresh stale checks so the boundary can judge them.
    const brand = await this.store.getBrand(brandId);
    const article = await this.store.getArticle(brandId, articleId);
    if (!brand || !article) return 'skipped';
    const version = article.currentVersionId ? await this.store.getVersion(brandId, article.currentVersionId) : null;
    const facts = await this.currentFactsKey(brandId);
    if (version && !checksAreCurrent(article.checks, version, facts.key) && Date.parse(article.schedule?.publishAtUtc ?? '') <= Date.parse(this.now())) {
      await this.store.updateArticle({ ...article, checks: await this.checkVersion(brand, version) });
    }
    // The publication-begin boundary: policy is evaluated on locked, current state and the
    // operation + article claim (or hold) are committed atomically. No provider call inside.
    const now = this.now();
    const begun = await this.store.beginPublication({
      brandId, articleId, resumePublicationId: null,
      decide: (s) => {
        const f = this.factsKeyFrom(s.profile, s.knowledge);
        const decision = evaluatePublication({ brand: s.brand, article: s.article, version: s.version, checks: s.article.checks, currentFactsSha: f.key, destination: s.destination, now });
        if (decision.decision === 'not_due' || decision.decision === 'skip') return { kind: 'skip', why: decision.decision === 'skip' ? decision.why : 'Not due.' };
        if (decision.decision === 'hold') return { kind: 'hold', article: { ...s.article, hold: { ...decision.hold, at: now } } };
        const publisher = publisherFor(this.deps.publishers, s.destination!.type);
        const publication: Publication = {
          id: randomUUID(), brandId, articleId, versionId: s.version!.id, contentSha: s.version!.contentSha, versionNumber: s.version!.number,
          destinationId: s.destination!.id,
          // One operation per exact version, destination and owner-set schedule: duplicate workers share it.
          idempotencyKey: `${brandId}:${articleId}:${s.version!.id}:${s.destination!.id}:${s.article.schedule!.setAt}`, scheduledFor: s.article.schedule!.publishAtUtc,
          policy: decision.policy, state: 'prepared', attempts: 0, firstAttemptAt: null, lastAttemptAt: null, providerRef: null,
          publicUrl: publisher.publicUrlFor(s.destination!, s.version!.body.slug), verifiedAt: null, verifyAttempts: 0,
          detail: 'Authorised and recorded before sending.', events: [{ at: now, state: 'prepared', detail: `Authorised by policy rule "${decision.policy.rule}".` }], rowVersion: 1,
        };
        return { kind: 'begin', publication, article: { ...s.article, delivery: 'publishing', lastAttemptAt: now, failure: null } };
      },
    });
    if (begun.kind === 'skip') return 'skipped';
    if (begun.kind === 'hold') {
      await this.log(brandId, 'system', 'publish.held', `Not published: ${begun.article!.hold!.detail}`, articleId);
      return 'held';
    }
    await this.attempt(brand, begun.publication, begun.destination, begun.version);
    return 'published';
  }

  /** Append to the operation's own history; identity and earlier events are never rewritten. */
  private pub(p: Publication, patch: Partial<Publication>): Publication {
    const next = { ...p, ...patch };
    const events = [...(p.events ?? []), { at: this.now(), state: next.state, detail: next.detail }].slice(-60);
    return { ...next, events };
  }

  private publishInput(brand: Brand, publication: Publication, destination: Destination, version: ArticleVersion): PublishInput {
    return {
      operationId: publication.id, destination, credential: this.credentialFor(destination), brandName: brand.name, locale: brand.locale,
      articleId: publication.articleId, versionId: publication.versionId, contentSha: publication.contentSha,
      versionNumber: publication.versionNumber ?? version.number, body: version.body,
      publishedAt: publication.firstAttemptAt ?? this.now(),
    };
  }

  private async attempt(brand: Brand, publication: Publication, destination: Destination, version: ArticleVersion): Promise<Publication> {
    const publisher = publisherFor(this.deps.publishers, destination.type);
    let p = await this.store.updatePublication(this.pub(publication, { state: 'submitted', attempts: publication.attempts + 1, firstAttemptAt: publication.firstAttemptAt ?? this.now(), lastAttemptAt: this.now(), detail: 'Sent to the website.' }));
    try {
      const outcome = await publisher.publish(this.publishInput(brand, p, destination, version));
      p = await this.store.updatePublication(this.pub(p, { state: 'verifying', providerRef: outcome.providerRef, publicUrl: outcome.publicUrl, detail: outcome.status === 'already_present' ? 'Already on the website; confirming the public page.' : 'Accepted by the website; confirming the public page.' }));
      await this.log(brand.id, 'system', 'publish.accepted', `Website accepted the article; waiting for ${p.publicUrl} to serve it.`, p.articleId);
      return this.verify(brand, p, version);
    } catch (error) {
      if (error instanceof PublisherOutcomeUnknownError) {
        p = await this.store.updatePublication(this.pub(p, { state: 'outcome_unknown', detail: `Outcome unknown: ${error.message} Reconciling — it will not be sent twice.` }));
        await this.setArticleDelivery(brand.id, p.articleId, 'unknown', null);
        return p;
      }
      const message = error instanceof PublisherRejectedError || error instanceof SeoBlogError ? error.message : 'The website could not be updated.';
      p = await this.store.updatePublication(this.pub(p, { state: 'failed', detail: message }));
      await this.setArticleDelivery(brand.id, p.articleId, 'failed', message);
      await this.log(brand.id, 'system', 'publish.failed', message, p.articleId);
      return p;
    }
  }

  private async setArticleDelivery(brandId: string, articleId: string, delivery: Article['delivery'], failure: string | null, extra: Partial<Article> = {}): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const a = await this.store.getArticle(brandId, articleId);
      if (!a) return;
      try {
        const hold = delivery === 'unknown' ? { reason: 'outcome_unknown' as const, detail: 'The website’s response was lost; reconciling before anything else happens.', at: this.now() }
          : delivery === 'failed' ? { reason: 'destination' as const, detail: failure ?? 'Publishing failed.', at: this.now() } : a.hold;
        await this.store.updateArticle({ ...a, delivery, failure, hold: delivery === 'published' ? null : hold, ...extra });
        return;
      } catch (error) {
        if (!(error instanceof StaleWriteError)) throw error;
      }
    }
  }

  private async verify(brand: Brand, publication: Publication, version: ArticleVersion): Promise<Publication> {
    const marker = versionMarker(publication.articleId, publication.versionId, publication.contentSha);
    const result = await verifyPublicUrl(this.deps.transport, publication.publicUrl, marker);
    if (result === 'served') {
      const p = await this.store.updatePublication(this.pub(publication, { state: 'published', verifiedAt: this.now(), verifyAttempts: publication.verifyAttempts + 1, detail: 'Verified on the public website.' }));
      await this.setArticleDelivery(brand.id, publication.articleId, 'published', null, { publishedVersionId: publication.versionId, publishedUrl: publication.publicUrl, publishedAt: this.now() });
      await this.log(brand.id, 'system', 'publish.verified', `Published and verified at ${publication.publicUrl} (version ${version.number}).`, publication.articleId);
      return p;
    }
    const attempts = publication.verifyAttempts + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      const p = await this.store.updatePublication(this.pub(publication, { state: 'outcome_unknown', verifyAttempts: attempts, detail: 'The website accepted the change but the public page has not shown it. Check the site’s deployment.' }));
      await this.setArticleDelivery(brand.id, publication.articleId, 'unknown', null);
      return p;
    }
    return this.store.updatePublication(this.pub(publication, { verifyAttempts: attempts, detail: result === 'different' ? 'The public page still shows an earlier version; waiting for the site to update.' : 'Waiting for the public page to appear.' }));
  }

  /**
   * Resend a confirmed-absent operation only if it is still authorised now. The same operation
   * id and history are kept. Superseded operations (new version, rescheduled, other destination)
   * are cancelled without touching the site; unauthorised ones (paused, approval missing,
   * failing checks, disconnected destination) are cancelled and the article is held.
   */
  private async resumeAbsent(brand: Brand, publication: Publication): Promise<void> {
    const now = this.now();
    const result = await this.store.beginPublication({
      brandId: brand.id, articleId: publication.articleId, resumePublicationId: publication.id,
      decide: (s) => {
        const p = s.publication!;
        const stale = Date.parse(now) - Date.parse(p.lastAttemptAt ?? p.scheduledFor) > PREPARED_STALE_MS;
        if (p.rowVersion !== publication.rowVersion || !(p.state === 'outcome_unknown' || (['prepared', 'submitted'].includes(p.state) && stale))) {
          return { kind: 'skip', why: 'Another worker is handling this operation.' };
        }
        const article = s.article;
        const clearUnknownHold = article.hold?.reason === 'outcome_unknown' ? null : article.hold;
        const cancel = (detail: string, hold: Article['hold']) => ({
          kind: 'hold' as const,
          publication: this.pub(p, { state: 'cancelled', detail }),
          article: { ...article, delivery: 'none' as const, hold, failure: null },
        });
        const superseded = article.currentVersionId !== p.versionId
          || !article.schedule || article.schedule.destinationId !== p.destinationId
          || !p.idempotencyKey.endsWith(`:${article.schedule.setAt}`);
        if (superseded) {
          return cancel('Not re-sent: superseded by a newer version or schedule. Nothing was published by this operation.', clearUnknownHold);
        }
        const f = this.factsKeyFrom(s.profile, s.knowledge);
        const decision = evaluatePublication({
          brand: s.brand, article: { ...article, delivery: 'none', hold: clearUnknownHold }, version: s.version, checks: article.checks,
          currentFactsSha: f.key, destination: s.destination, now,
        });
        if (decision.decision === 'hold') {
          return cancel(`Not re-sent: ${decision.hold.detail}`, { ...decision.hold, at: now });
        }
        if (decision.decision !== 'publish') {
          return cancel(`Not re-sent: ${decision.decision === 'skip' ? decision.why : 'no longer due'}.`, clearUnknownHold ?? { reason: 'owner', detail: 'Choose a new time.', at: now });
        }
        return {
          kind: 'begin',
          publication: this.pub(p, { state: 'prepared', policy: decision.policy, detail: 'Confirmed absent; re-authorised on current state and re-sending the same operation.' }),
          article: { ...article, delivery: 'publishing', hold: null, lastAttemptAt: now, failure: null },
        };
      },
    });
    if (result.kind === 'begin') {
      await this.attempt(brand, result.publication, result.destination, result.version);
    } else if (result.kind === 'hold') {
      await this.log(brand.id, 'system', 'publish.cancelled', result.publication?.detail ?? 'Operation not re-sent.', publication.articleId);
    }
  }

  /** Recover operations left submitted, unknown, verifying or stale-prepared. Never blindly re-sends. */
  async reconcile(brandId: string): Promise<number> {
    const brand = await this.store.getBrand(brandId);
    if (!brand) return 0;
    let touched = 0;
    for (const publication of await this.store.listPublications(brandId)) {
      const stalePrepared = publication.state === 'prepared' && Date.parse(this.now()) - Date.parse(publication.lastAttemptAt ?? publication.scheduledFor) > PREPARED_STALE_MS;
      const staleSubmitted = publication.state === 'submitted' && Date.parse(this.now()) - Date.parse(publication.lastAttemptAt ?? publication.scheduledFor) > PREPARED_STALE_MS;
      if (!['outcome_unknown', 'verifying'].includes(publication.state) && !stalePrepared && !staleSubmitted) continue;
      const version = await this.store.getVersion(brandId, publication.versionId);
      const destination = await this.store.getDestination(brandId, publication.destinationId);
      if (!version || !destination) continue;
      touched++;
      try {
        await this.reconcileOne(brand, publication, version, destination);
      } catch (error) {
        // Another worker advanced this operation first; it owns the next step.
        if (error instanceof StaleWriteError) continue;
        throw error;
      }
    }
    return touched;
  }

  private async reconcileOne(brand: Brand, publication: Publication, version: ArticleVersion, destination: Destination): Promise<void> {
    const brandId = brand.id;
    {
      if (publication.state === 'verifying') { await this.verify(brand, publication, version); return; }
      const publisher = publisherFor(this.deps.publishers, destination.type);
      try {
        const existing = await publisher.findExisting(this.publishInput(brand, publication, destination, version));
        if (existing.state === 'present') {
          const p = await this.store.updatePublication(this.pub(publication, { state: 'verifying', providerRef: existing.providerRef, detail: 'Found on the website during reconciliation; confirming the public page.' }));
          await this.setArticleDelivery(brandId, publication.articleId, 'publishing', null);
          await this.verify(brand, p, version);
        } else if (existing.state === 'absent' && publication.attempts < JOB_MAX_ATTEMPTS) {
          // Confirmed not applied. Re-sending is a new provider effect, so it passes the same
          // begin boundary as a first send: current version, schedule, approval, pause, facts,
          // checks and destination are revalidated on locked state, or the operation is held.
          await this.resumeAbsent(brand, publication);
        } else {
          const detail = existing.state === 'other_version'
            ? 'The website shows a different version of this article. Nothing was overwritten; review and schedule again.'
            : 'The article could not be published after several attempts.';
          await this.store.updatePublication(this.pub(publication, { state: 'failed', detail }));
          await this.setArticleDelivery(brandId, publication.articleId, 'failed', detail);
        }
      } catch (error) {
        if (error instanceof PublisherOutcomeUnknownError) return; // still unknown; try again next tick
        if (error instanceof StaleWriteError) throw error; // concurrent progress, not a failure
        await this.store.updatePublication(this.pub(publication, { state: 'failed', detail: (error as Error).message.slice(0, 300) }));
        await this.setArticleDelivery(brandId, publication.articleId, 'failed', (error as Error).message.slice(0, 300));
      }
    }
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────

  private async enqueue(brandId: string, kind: JobKind, idempotencyKey: string, payload: Record<string, unknown>): Promise<Job> {
    const now = this.now();
    const { job } = await this.store.enqueueJob({
      id: randomUUID(), brandId, kind, idempotencyKey, payload, state: 'queued', attempts: 0, maxAttempts: JOB_MAX_ATTEMPTS,
      leaseOwner: null, leaseExpiresAt: null, runAfter: now, progress: 'Queued.', error: null, createdAt: now, updatedAt: now, rowVersion: 1,
    });
    return job;
  }

  async listJobs(actor: Actor, brandId: string): Promise<Job[]> {
    await this.brandFor(actor, brandId);
    return this.store.listJobs(brandId);
  }

  async cancelJob(actor: Actor, brandId: string, jobId: string): Promise<Job> {
    await this.brandFor(actor, brandId);
    const job = await this.store.getJob(brandId, jobId);
    if (!job) throw new SeoBlogError(404, 'That task was not found.');
    if (['done', 'failed', 'cancelled'].includes(job.state)) return job;
    const next = await this.store.updateJob({ ...job, state: 'cancelled', leaseOwner: null, leaseExpiresAt: null, progress: 'Cancelled by the owner.', updatedAt: this.now() });
    await this.log(brandId, actor.userId, 'job.cancelled', `${job.kind} task cancelled.`, jobId);
    return next;
  }

  /** One worker tick: run due jobs, dispatch due publications, reconcile. Bounded. */
  async tick(owner: string): Promise<{ jobs: number; brands: number }> {
    const limit = this.deps.batchLimit ?? 5;
    const jobs = await this.store.claimJobs({ now: this.now(), owner, leaseMs: LEASE_MS, limit });
    for (const job of jobs) await this.runJob(job);
    const brands = await this.store.activeBrandIds(this.now());
    for (const brandId of brands.slice(0, 50)) await this.dispatchDue(brandId);
    return { jobs: jobs.length, brands: brands.length };
  }

  async runJob(job: Job): Promise<Job> {
    let current = job;
    try {
      const fresh = await this.store.getJob(job.brandId, job.id);
      if (!fresh || fresh.state === 'cancelled' || fresh.leaseOwner !== job.leaseOwner) return fresh ?? job;
      current = await this.store.updateJob({ ...fresh, progress: progressLabel(job.kind), updatedAt: this.now() });
      const p = job.payload as Record<string, unknown>;
      if (job.kind === 'inventory') await this.refreshInventory(job.brandId);
      else if (job.kind === 'plan') await this.runPlan(job.brandId, { focus: (p.focus as string | null) ?? null, excluded: (p.excluded as string[]) ?? [], sourceArticleUrl: (p.sourceArticleUrl as string | null) ?? null, requestedBy: p.requestedBy as string | undefined });
      else if (job.kind === 'write') await this.runWrite(job.brandId, { briefId: String(p.briefId), fromVersionId: p.fromVersionId as string | undefined, requestedBy: p.requestedBy as string | undefined });
      else if (job.kind === 'publish') await this.dispatchDue(job.brandId);
      else if (job.kind === 'daily') await this.runDaily(job.brandId);
      const latest = (await this.store.getJob(job.brandId, job.id))!;
      if (latest.state === 'cancelled') return latest;
      return await this.store.updateJob({ ...latest, state: 'done', leaseOwner: null, leaseExpiresAt: null, progress: 'Done.', error: null, updatedAt: this.now() });
    } catch (error) {
      const latest = (await this.store.getJob(job.brandId, job.id)) ?? current;
      if (latest.state === 'cancelled') return latest;
      const known = error instanceof SeoBlogError;
      const blocked = known && [409, 503].includes(error.status);
      const exhausted = latest.attempts >= latest.maxAttempts;
      const message = known ? error.message : 'An unexpected error stopped this task. It will retry automatically.';
      const next = await this.store.updateJob({
        ...latest,
        state: blocked ? 'blocked' : exhausted ? 'failed' : 'queued',
        leaseOwner: null, leaseExpiresAt: null,
        runAfter: new Date(Date.parse(this.now()) + 60_000 * 2 ** latest.attempts).toISOString(),
        progress: blocked ? 'Paused until the issue is fixed.' : exhausted ? 'Stopped after repeated failures.' : 'Will retry.',
        error: message.slice(0, 400), updatedAt: this.now(),
      });
      await this.log(job.brandId, 'system', `job.${next.state}`, `${job.kind}: ${message}`.slice(0, 400), job.id);
      return next;
    }
  }

  async retryJob(actor: Actor, brandId: string, jobId: string): Promise<Job> {
    await this.brandFor(actor, brandId);
    const job = await this.store.getJob(brandId, jobId);
    if (!job) throw new SeoBlogError(404, 'That task was not found.');
    if (!['blocked', 'failed'].includes(job.state)) return job;
    return this.store.updateJob({ ...job, state: 'queued', attempts: 0, runAfter: this.now(), error: null, progress: 'Queued again by the owner.', updatedAt: this.now() });
  }

  /** Daily bounded top-up when the brand enables ongoing production. Never replaces accepted plans. */
  async runDaily(brandId: string): Promise<void> {
    const brand = await this.store.getBrand(brandId);
    if (!brand?.settings.ongoingProduction) return;
    const day = this.now().slice(0, 10);
    if (brand.website) await this.enqueue(brandId, 'inventory', `daily-inventory:${day}`, {});
    const [articles, briefs, plans] = await Promise.all([this.store.listArticles(brandId), this.store.listBriefs(brandId), this.store.listPlans(brandId)]);
    const backlog = articles.filter((a) => a.delivery !== 'published').length;
    const horizonEnd = Date.parse(this.now()) + brand.settings.planningHorizonDays * 86_400_000;
    const future = briefs.filter((b) => ['planned', 'accepted'].includes(b.status) && b.suggestedAtUtc && Date.parse(b.suggestedAtUtc) <= horizonEnd).length
      + articles.filter((a) => a.schedule && Date.parse(a.schedule.publishAtUtc) <= horizonEnd).length;
    const slotsNeeded = Math.ceil((brand.settings.planningHorizonDays / 7) * brand.settings.cadence.perWeek);
    const recentPlan = plans.find((p) => Date.parse(this.now()) - Date.parse(p.createdAt) < 7 * 86_400_000 && p.status === 'proposed');
    if (future < slotsNeeded && !recentPlan) {
      await this.enqueue(brandId, 'plan', `daily-plan:${day}`, { focus: null, excluded: [], sourceArticleUrl: null, requestedBy: 'system' });
    }
    void backlog;
    await this.topUpWrites(brandId);
  }

  /** Draft accepted briefs up to the backlog ceiling; `write:<briefId>` keys make this idempotent. */
  private async topUpWrites(brandId: string): Promise<void> {
    const brand = await this.store.getBrand(brandId);
    if (!brand?.settings.ongoingProduction) return;
    const [articles, briefs, jobs] = await Promise.all([this.store.listArticles(brandId), this.store.listBriefs(brandId), this.store.listJobs(brandId)]);
    const pendingWrites = jobs.filter((j) => j.kind === 'write' && ['queued', 'running'].includes(j.state)).length;
    const backlog = articles.filter((a) => a.delivery !== 'published').length + pendingWrites;
    const room = Math.max(0, brand.settings.backlogCeiling - backlog);
    const queued = new Set(jobs.filter((j) => j.kind === 'write').map((j) => String((j.payload as { briefId?: string }).briefId)));
    for (const brief of briefs.filter((b) => b.status === 'accepted' && !queued.has(b.id)).slice(0, room)) {
      await this.enqueue(brandId, 'write', `write:${brief.id}`, { briefId: brief.id, requestedBy: 'system' });
    }
  }

  /** Worker discovery: brands with due schedules, open operations, runnable jobs or ongoing production. */
  activeBrands(): Promise<string[]> {
    return this.store.activeBrandIds(this.now());
  }

  async enqueueDailyForAll(brandIds: readonly string[]): Promise<void> {
    const day = this.now().slice(0, 10);
    for (const id of brandIds) await this.enqueue(id, 'daily', `daily:${day}`, {});
  }

  async activity(actor: Actor, brandId: string, limit = 100): Promise<import('./types.js').ActivityEvent[]> {
    await this.brandFor(actor, brandId);
    return this.store.listActivity(brandId, Math.min(Math.max(limit, 1), 500));
  }

  async usage(actor: Actor, brandId: string): Promise<Record<UsageKind, number>> {
    await this.brandFor(actor, brandId);
    const since = monthStart(this.now());
    return {
      model_tokens: await this.store.usageSince(brandId, 'model_tokens', since),
      search_calls: await this.store.usageSince(brandId, 'search_calls', since),
      images: await this.store.usageSince(brandId, 'images', since),
    };
  }

  approvalCurrent(article: Article, version: ArticleVersion | null): boolean {
    return approvalIsCurrent(article, version);
  }
}

function progressLabel(kind: JobKind): string {
  return { inventory: 'Reading the website…', plan: 'Researching and planning…', write: 'Writing the article…', publish: 'Publishing…', daily: 'Daily top-up…' }[kind];
}

function bodyCites(v: { intro: string; sections: { body: string }[]; conclusion: string }, short: Map<string, ResearchSource>, sourceId: string): boolean {
  const text = [v.intro, ...v.sections.map((s) => s.body), v.conclusion].join('\n');
  for (const [id, s] of short) if (s.id === sourceId && text.includes(`[src:${id}]`)) return true;
  return false;
}

export function normaliseWebsite(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  const url = validatePublicUrl(withScheme);
  return `${url.protocol}//${url.host}`;
}

function validateSettings(s: BrandSettings): void {
  validateCadence(s.cadence);
  if (!Number.isInteger(s.planningHorizonDays) || s.planningHorizonDays < 7 || s.planningHorizonDays > 120) throw new SeoBlogError(400, 'Planning horizon must be 7–120 days.');
  if (!Number.isInteger(s.backlogCeiling) || s.backlogCeiling < 0 || s.backlogCeiling > 50) throw new SeoBlogError(400, 'Backlog ceiling must be 0–50 articles.');
  if (!['concise', 'standard', 'in-depth'].includes(s.lengthPreference)) throw new SeoBlogError(400, 'Choose a length preference.');
  for (const [k, v] of Object.entries(s.budgets)) if (!Number.isInteger(v) || v < 0 || v > 1_000_000_000) throw new SeoBlogError(400, `Budget ${k} must be a whole number of 0 or more.`);
  if (s.author && (!s.author.name.trim() || s.author.name.length > 120 || (s.author.url && !/^https:\/\//.test(s.author.url)))) throw new SeoBlogError(400, 'Author needs a name and, optionally, an https:// profile link.');
  for (const key of ['autoPublish', 'pauseAll', 'ongoingProduction', 'autoAcceptPlans'] as const) if (typeof s[key] !== 'boolean') throw new SeoBlogError(400, 'Invalid toggle value.');
}
