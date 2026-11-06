/**
 * SEO blog engine service. The portal router, the worker and tests all drive
 * the engine through this class. Every owner call carries the server-resolved
 * actor and brand; access is re-checked on every call.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { LlmClient } from '../llm/client.js';
import { loadPrompt } from '../stages/prompt.js';
import { stageModel } from '../config.js';
import type { KeywordProvider } from '../keyword/types.js';
import { runChecks } from './checks.js';
import { assessDuplicate, slugify } from './dedupe.js';
import {
  extractProfile, GenerationUnavailableError, GenerationRejectedError, CampaignGenerationRejectedError, proposeCluster, resolveMarkers, rewriteSection, writeArticle, writeArticlePromotions, writeArticleCampaignPromotions,
  type PlannedArticle, type PlannedCluster, type JsonCallResult,
} from './generation.js';
import { buildInventory, linkableUrls } from './inventory.js';
import { cleanText, extractKnowledge } from './knowledge.js';
import { approvalIsCurrent, articleStatusLabel, checksAreCurrent, evaluatePublication } from './policy.js';
import { publisherFor, type PublisherRegistry } from './publishers/registry.js';
import { PublisherOutcomeUnknownError, PublisherRejectedError, verifyPublicUrl, type PublishInput, type WebsitePublisher } from './publishers/types.js';
import { reviewedWebsiteTarget, targetEligibility, destinationIdentity,websiteIdentity, websiteSha, websiteWakeJob, type ArticleWebsiteTarget, type WebsiteStructure, type WebsiteVersionGuard } from './website-target.js';
import { observeWebsiteDelivery } from './website-delivery.js';
import { WORDPRESS_URL_CONTRACT } from './website-target.js';
import { exportMarkdown, renderArticlePage, versionMarker } from './render.js';
import { researchQueries, researchQuerySeeds, ResearchUnavailableError, ResearchProviderError, type SearchProvider, type ResearchBundle } from './research.js';
import { validatePublicUrl, type FetchTransport } from './safe-fetch.js';
import { autoPlace, isValidTimeZone, localToUtc, utcToLocal, validateCadence } from './schedule.js';
import type { SeoBlogStore } from './store.js';
import { StaleWriteError } from './store.js';
import { isProfileJob, profilePayload, unacknowledgedProfileCalls, type ProfileJobPayload, type ProfileJobReceipt, type ProfileJobSnapshot } from './profile-jobs.js';
import { editorialRecommendations, editorialRootIssue, legacyPlanningHold, programmeAuthorityFor, programmeInputSnapshot, programmeReadinessIssue, programmeRun, programmeSha, programmeKnowledgeRefs, researchDiagnostic,
  type ApprovedEditorialStructure, type ProgrammeAuthority, type ProgrammeBoundarySnapshot, type ProgrammeBoundaryDecision, type ProgrammeRun, type ResearchSearchReceipt, type ResearchDiagnostic, type ProgrammeProvenance } from './programme.js';
import {
  DESTINATION_TYPES, FACTUAL_KNOWLEDGE_CATEGORIES, KNOWLEDGE_CATEGORIES, SeoBlogError,
  type Article, type ArticleBody, type ArticleBrief, type ArticlePromotionPack, type ArticleVersion, type Brand, type BrandProfile, type BrandSettings,
  type CheckReport, type Destination, type GenerationRecord, type Job, type JobKind, type KnowledgeCategory,
  type KnowledgeDocument, type KnowledgeRef, type Publication, type ResearchSource, type TopicPlan, type UsageKind,
  type PromotionObservation, type SocialDispatch, type VersionChange, type WebsiteInventory,
} from './types.js';
import type { SeoBlogCredentialVault } from './vault.js';
import { linkedPromotionFor, OBSERVATION_CREATE_WINDOW_MS, OBSERVATION_TTL_MS, promotionPublicationHold, type ArticlePromotionApproval, type PromotionNetwork } from './promotions.js';
import { activeBindingFor, bindingHold, SocialDeliveryHoldError, type SocialOverview, type SocialRegistry } from './social.js';
import { automaticImageCommandId, imageJobDto, isArticleWriteJob, isImageJob, type ArticleImageService, type ArticleImageRequestResult } from './image-campaign.js';
import { createArticleCampaign, fallbackCampaignDrafts, type CampaignDraft } from './campaign.js';
import { SeoBlogCampaignService, type CampaignReviewPorts, type CampaignSelection } from './campaign-service.js';
import type { ArticleMediaReviewService } from './media-review.js';
import type { SeoBlogCampaignQueueService } from './campaign-queue.js';
import { campaignCopyIssue, INITIAL_CAMPAIGN_TOKEN_ESTIMATE, type CampaignGeneration, type CampaignCopyReceipt } from './campaign-generation.js';
import { campaignCalendarEntries, campaignJobLinks, socialCalendarWindow } from './campaign-calendar.js';
import { POSTING_PLATFORMS, currentPostDraft, defaultPostDraftId, derivePostDraft, editPostDraft, restorePostDraft, postDraftIsStale, type PlatformDraft, type PostDraftSource } from './platform-drafts.js';

export interface Actor {
  readonly userId: string;
}

interface PlanExecution {
  readonly search: SearchProvider;
  readonly metrics?: KeywordProvider;
  readonly research?: ResearchBundle;
  readonly modelResult?: JsonCallResult<PlannedCluster>;
  readonly planId: string;
  readonly provenance: ProgrammeProvenance;
  beforeModel(research: ResearchBundle): Promise<void>;
  recordModel(result: JsonCallResult<PlannedCluster>): Promise<void>;
  commit(plan: TopicPlan, briefs: readonly ArticleBrief[]): Promise<void>;
}

import { libraryPins, PRIVATE_RELEASE_VERSION, resolveMethods, type MethodController, type MethodPin } from './method-packs.js';
import { CampaignCreator, type CampaignCreatorStore } from './campaign-creator.js';
import { confirmedVisualInputs, type EditorialFormat } from './method-evidence.js';

export interface EngineDeps {
  readonly creatorStore?: CampaignCreatorStore;
  readonly methods?: MethodController;
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
  /** Per-brand social account registry and canonical calendar planning; absent when the Zernio command boundary is not composed. */
  readonly social?: SocialRegistry;
  readonly images?: ArticleImageService;
  readonly campaignReview?: CampaignReviewPorts;
  readonly mediaReview?: ArticleMediaReviewService;
  readonly campaignQueue?: SeoBlogCampaignQueueService;
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
  constructor(kind: UsageKind, used: number, ceiling: number, estimate: number) {
    const label = kind === 'model_tokens' ? 'Writing' : kind === 'search_calls' ? 'Research' : 'Image';
    const unit = kind === 'model_tokens' ? 'model tokens' : kind === 'search_calls' ? 'supplier attempts' : 'images';
    const number = (value: number) => value.toLocaleString('en-GB');
    const remaining = Math.max(0, ceiling - used);
    const reason = ceiling <= 0 ? 'not configured (ceiling 0)' : used >= ceiling ? 'monthly ceiling reached' : 'insufficient headroom for this action';
    super(409, `${label} allowance: ${reason}. Used ${number(used)}; ceiling ${number(ceiling)}; remaining ${number(remaining)} ${unit}. Action estimate ${number(estimate)}; shortfall ${number(Math.max(0, estimate - remaining))}. Minimum estimated monthly ceiling ${number(used + estimate)}. Review Publishing settings before retrying.`, 'budget_exceeded');
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
    if (patch.media !== undefined && (!patch.media || typeof patch.media.imageGenerationEnabled !== 'boolean')) throw new SeoBlogError(400, 'Invalid image generation toggle.');
    const next: BrandSettings = { ...brand.settings, ...patch,
      ...(patch.media !== undefined ? { media: { imageGenerationEnabled: patch.media.imageGenerationEnabled, authorizedBy: actor.userId, authorizedAt: this.now() } } : {}),
      ...(patch.ongoingProduction!==undefined || patch.programme!==undefined ? {programme:{...brand.settings.programme,
        ...(patch.programme ? {focus:cleanText(patch.programme.focus??'').slice(0,300)||null,exclusions:(patch.programme.exclusions??[]).map((x)=>cleanText(x).slice(0,80)).filter(Boolean).slice(0,20)} : {}),
        authorisedBy:actor.userId,authorisedAt:this.now()}} : {}),
    };
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

  async changeKnowledgeCategory(actor:Actor,brandId:string,documentId:string,expectedVersion:number,category:string):Promise<void> {
    await this.brandFor(actor,brandId);
    if(!KNOWLEDGE_CATEGORIES.includes(category as KnowledgeCategory)) throw new SeoBlogError(400,'Choose a guidance kind.');
    const current=(await this.store.listKnowledge(brandId)).filter((d)=>d.id===documentId).sort((a,b)=>b.version-a.version)[0];
    if(!current||!current.active) throw new SeoBlogError(404,'That active guidance document was not found.');
    if(current.version!==expectedVersion) throw new StaleWriteError('guidance document');
    if(current.category===category) return;
    await this.store.saveKnowledge({...current,category:category as KnowledgeCategory,version:current.version+1,createdAt:this.now()});
    await this.log(brandId,actor.userId,'knowledge.kind_changed','Guidance kind updated as a new document version. Review the profile if factual guidance changed.',documentId);
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
    if (ceiling <= 0 || used + amount > ceiling) throw new BudgetExceededError(kind, used, ceiling, amount);
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

  private profileGenerationContext(): ProfileJobPayload['source']['prompt'] {
    const p = loadPrompt('seo-blog-profile.md');
    return { version: p.header.version, sha256: p.sha256, model: stageModel(p.header.stage, p.header.model) };
  }

  private profileInputs(s: ProfileJobSnapshot, prompt: ProfileJobPayload['source']['prompt']): { documents: KnowledgeDocument[]; sha: string; source: ProfileJobPayload['source'] } {
    const latest = new Map<string, KnowledgeDocument>();
    for (const d of s.knowledge) if (!latest.has(d.id) || latest.get(d.id)!.version < d.version) latest.set(d.id, d);
    const documents = [...latest.values()].filter((d) => d.active);
    const source = { brandName: s.brand.name, website: s.brand.website, knowledge: this.knowledgeRefs(documents), prompt };
    return { documents, sha: sha256(source), source };
  }

  async requestProfileExtraction(actor: Actor, brandId: string, input: { commandId: string; baseVersion: number; acknowledgePriorUsage?: boolean }): Promise<Job> {
    await this.brandFor(actor, brandId);
    if (!validUuid(input.commandId)) throw new SeoBlogError(400, 'Refresh the form and try again.');
    const now = this.now();
    const context = this.profileGenerationContext();
    return this.store.profileJobBoundary({ brandId, jobId: input.commandId, requesterId: actor.userId, now, decide: (s) => {
      // Receipt lookup is not a new generation: replay it before changing-budget/source checks.
      const replay = s.jobs.find((j) => profilePayload(j).requestIds.includes(input.commandId));
      if (replay) return { job: replay, write: false };
      if (!s.requesterAllowed) throw new SeoBlogError(403, 'Only a current brand owner or administrator can extract its profile.');
      const active = s.jobs.find((j) => ['queued', 'running'].includes(j.state));
      if (active) {
        const p = profilePayload(active);
        if (p.requestIds.length >= 256) throw new SeoBlogError(409, 'An extraction is already active. Open its status instead.');
        return { job: { ...active, payload: { ...p, requestIds: [...p.requestIds, input.commandId] }, updatedAt: now }, write: true };
      }
      if ((s.profile?.version ?? 0) !== input.baseVersion) throw new StaleWriteError('brand profile');
      const pendingUsage = unacknowledgedProfileCalls(s.jobs);
      if (pendingUsage.length && !input.acknowledgePriorUsage) throw new SeoBlogError(409, 'A previous extraction has an uncertain outcome and may already have used model tokens. Review the current profile, then explicitly confirm a new extraction if needed.');
      const inputs = this.profileInputs(s, context);
      if (!inputs.documents.some((d) => d.text)) throw new SeoBlogError(409, 'Upload at least one readable guidance document first.');
      this.llm();
      if (s.brand.settings.budgets.modelTokensPerMonth <= 0 || s.modelTokensUsed + USAGE_ESTIMATES.profile > s.brand.settings.budgets.modelTokensPerMonth) throw new BudgetExceededError('model_tokens', s.modelTokensUsed, s.brand.settings.budgets.modelTokensPerMonth, USAGE_ESTIMATES.profile);
      const p: ProfileJobPayload = { stage: 'profile', requestedBy: actor.userId, requestIds: [input.commandId], inputSha: inputs.sha, source: inputs.source,
        baseVersion: input.baseVersion, baseProfileSha: sha256(s.profile), acknowledgedPriorUsage: pendingUsage.map((j) => j.id) };
      const job: Job = { id: input.commandId, brandId, kind: 'write', idempotencyKey: `profile:${input.commandId}`, payload: { ...p }, state: 'queued', attempts: 0, maxAttempts: 1,
        leaseOwner: null, leaseExpiresAt: null, runAfter: now, progress: 'Profile extraction queued. You can leave this page.', error: null, createdAt: now, updatedAt: now, rowVersion: 1 };
      return { job, write: true, event: { brandId, at: now, actor: actor.userId, kind: 'profile.queued', message: 'Profile extraction queued in the background.', subjectId: job.id } };
    } });
  }

  private profileHold(job: Job, reason: string, message: string, now: string): Job {
    return { ...job, state: 'blocked', leaseOwner: null, leaseExpiresAt: null, payload: { ...profilePayload(job), reason }, error: message, progress: message, updatedAt: now };
  }

  /** A receipt may account late usage, but only a currently owned lease may apply a profile. */
  private async completeProfileJob(job: Job, receipt: ProfileJobReceipt): Promise<Job> {
    const now = this.now(); const requesterId = profilePayload(job).requestedBy;
    const context = this.profileGenerationContext();
    return this.store.profileJobBoundary({ brandId: job.brandId, jobId: job.id, requesterId, now, decide: (s) => {
      const current = s.job;
      if (!current) throw new SeoBlogError(404, 'Profile task not found.');
      const p = profilePayload(current);
      if (p.start?.nonce !== receipt.nonce) throw new SeoBlogError(409, 'Profile result does not match its started operation.');
      if (current.state === 'done') return { job: current, write: false };
      const actual = p.receipt ?? receipt;
      const updated: Job = { ...current, payload: { ...p, receipt: actual }, updatedAt: now };
      const usage = p.receipt ? undefined : { brandId: job.brandId, kind: 'model_tokens' as const, amount: actual.generation.tokensIn + actual.generation.tokensOut, at: actual.receivedAt, reference: `profile:${current.id}:${receipt.nonce}` };
      const owned = current.state === 'running' && current.leaseOwner === job.leaseOwner && current.attempts === job.attempts && current.leaseExpiresAt !== null && current.leaseExpiresAt > now;
      if (!owned) {
        const late = current.state === 'running' ? this.profileHold(updated, 'lease_lost', 'Result received after its lease ended. Review before applying it; no new model call is needed.', now)
          : { ...updated, error: null, progress: 'A late result was saved and actual usage recorded. The profile was not replaced. Review the current profile and task controls.' };
        return { job: late, write: true, usage };
      }
      const sameInputs = this.profileInputs(s, context).sha === p.inputSha && (s.profile?.version ?? 0) === p.baseVersion && sha256(s.profile) === p.baseProfileSha;
      if (!s.requesterAllowed || !sameInputs) return { job: this.profileHold(updated, !s.requesterAllowed ? 'requester_changed' : 'inputs_changed', !s.requesterAllowed ? 'The requesting owner no longer manages this brand. Result retained; no profile was replaced.' : 'Guidance or profile changed during extraction. Result retained; current edits were not replaced.', now), write: true, usage };
      const profile: BrandProfile = { ...actual.value, brandId: job.brandId, version: p.baseVersion + 1, knowledge: this.knowledgeRefs(this.profileInputs(s, context).documents),
        factsSha: profileFactsSha(actual.value), source: 'extracted', confirmedAt: null, confirmedBy: null, createdAt: now, generation: actual.generation };
      return { job: { ...updated, state: 'done', leaseOwner: null, leaseExpiresAt: null, payload: { ...p, receipt: actual, resultVersion: profile.version }, error: null, progress: `Profile version ${profile.version} is ready. Review and confirm it.`, updatedAt: now }, write: true, profile, usage,
        event: { brandId: job.brandId, at: now, actor: 'system', kind: 'profile.extracted', message: `Profile version ${profile.version} extracted in the background. Review and confirm it.`, subjectId: job.id } };
    } });
  }

  private async runProfileJob(job: Job): Promise<Job> {
    const now = this.now(); let startedHere = false;
    const context = this.profileGenerationContext();
    let modelInput: { brandName: string; website: string | null; documents: KnowledgeDocument[] } | null = null;
    const started = await this.store.profileJobBoundary({ brandId: job.brandId, jobId: job.id, requesterId: profilePayload(job).requestedBy, now, decide: (s) => {
      const current = s.job;
      if (!current) throw new SeoBlogError(404, 'Profile task not found.');
      const p = profilePayload(current);
      if (current.state !== 'running' || current.leaseOwner !== job.leaseOwner || current.attempts !== job.attempts || !current.leaseExpiresAt || current.leaseExpiresAt <= now) return { job: current, write: false };
      if (p.receipt) return { job: current, write: false };
      if (p.start) return { job: this.profileHold(current, 'outcome_unknown', 'Extraction was interrupted after the model call started. Its outcome and token usage are uncertain. Review the current profile before explicitly starting another extraction.', now), write: true };
      const inputs = this.profileInputs(s, context);
      if (!s.requesterAllowed || inputs.sha !== p.inputSha || (s.profile?.version ?? 0) !== p.baseVersion || sha256(s.profile) !== p.baseProfileSha) return { job: this.profileHold(current, 'inputs_changed', 'The requesting owner, guidance or profile changed. Refresh and queue a new extraction.', now), write: true };
      if (!this.deps.llm) return { job: this.profileHold(current, 'unavailable', 'Profile generation is not configured.', now), write: true };
      if (s.brand.settings.budgets.modelTokensPerMonth <= 0 || s.modelTokensUsed + USAGE_ESTIMATES.profile > s.brand.settings.budgets.modelTokensPerMonth) return { job: this.profileHold(current, 'budget', new BudgetExceededError('model_tokens', s.modelTokensUsed, s.brand.settings.budgets.modelTokensPerMonth, USAGE_ESTIMATES.profile).message, now), write: true };
      startedHere = true; modelInput = { brandName: s.brand.name, website: s.brand.website, documents: inputs.documents };
      return { job: { ...current, payload: { ...p, start: { nonce: randomUUID(), at: now } }, progress: 'Extracting the brand profile. You can leave this page.', error: null, updatedAt: now }, write: true };
    } });
    const payload = profilePayload(started);
    if (payload.receipt && started.state === 'running' && started.leaseOwner === job.leaseOwner && started.attempts === job.attempts) return this.completeProfileJob(job, payload.receipt);
    if (!startedHere || !modelInput || !payload.start) return started;
    try {
      const result = await extractProfile(this.llm(), modelInput);
      const receipt = { nonce: payload.start.nonce, value: result.value, generation: result.record, receivedAt: this.now() };
      // A database failure retries this known receipt only, never the paid model call.
      try { return await this.completeProfileJob(started, receipt); }
      catch { return await this.completeProfileJob(started, receipt); }
    } catch {
      // Never turn an uncertain paid call into a generic automatic retry.
      return this.store.profileJobBoundary({ brandId: job.brandId, jobId: job.id, requesterId: payload.requestedBy, now: this.now(), decide: (s) => {
        if (!s.job) throw new SeoBlogError(404, 'Profile task not found.');
        const p = profilePayload(s.job);
        if (p.receipt || s.job.state === 'cancelled' || p.start?.nonce !== payload.start!.nonce) return { job: s.job, write: false };
        return { job: this.profileHold(s.job, 'outcome_unknown', 'The model call did not finish with a saved result. Token usage may have occurred. Review the current profile before explicitly starting another extraction.', this.now()), write: true };
      } });
    }
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
    const scanned = await buildInventory(brandId, brand.website, this.deps.transport, { now: this.now() });
    const inventory={...scanned,editorial:editorialRecommendations(scanned)};
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

  async approveEditorialStructure(actor: Actor, brandId: string, input: {rowVersion:number;scanId:string;scanSha:string;destinationId:string;root:string;categories:readonly {id:string;label:string;slug:string}[];newCategoryAddresses?:boolean}): Promise<ApprovedEditorialStructure> {
    await this.brandFor(actor,brandId);let approved:ApprovedEditorialStructure|undefined;
    const connection=await this.store.getDestination(brandId,input.destinationId);if(connection)await this.checkDestinationInternal(connection);
    await this.store.programmeBoundary({brandId,jobId:null,authority:{origin:'manual',sponsorUserId:actor.userId},now:this.now(),decide:(s)=>{
      if(!s.requesterAllowed) throw new SeoBlogError(403,'Only a current managing owner can approve editorial guidance.');
      if(s.brand.rowVersion!==input.rowVersion) throw new StaleWriteError('brand settings');
      if(!s.inventory) throw new SeoBlogError(409,'Read the website before approving its editorial structure.');
      const recommendation=s.inventory.editorial??editorialRecommendations(s.inventory);
      if(recommendation.scanId!==input.scanId || recommendation.scanSha!==input.scanSha) throw new SeoBlogError(409,'The website scan changed. Review the current recommendations before approval.');
      const issue=editorialRootIssue(s.destinations.find((d)=>d.id===input.destinationId),input.root);
      if(issue) throw new SeoBlogError(409,issue);
      if(!input.categories.length || input.categories.length>12) throw new SeoBlogError(400,'Choose between 1 and 12 editorial categories.');
      const categories=input.categories.map((item)=>{
        const known=recommendation.categories.find((c)=>c.id===item.id);
        if(!known&&!/^owner-[0-2]$/.test(item.id)) throw new SeoBlogError(400,'That category is not part of this recommendation.');
        const label=cleanText(item.label).trim();const slug=item.slug.trim();
        if(label.length<2||label.length>80||!(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).test(slug)||slug.length>60) throw new SeoBlogError(400,'Category labels need 2–80 characters; slugs use lowercase words separated by hyphens.');
        return {...(known??{id:item.id,evidenceUrls:[],rationale:'Owner-provided draft category. This does not create a CMS route.',confidence:'low' as const}),label,slug};
      });
      if(new Set(categories.map((c)=>c.id)).size!==categories.length||new Set(categories.map((c)=>c.slug)).size!==categories.length) throw new SeoBlogError(400,'Give each category a distinct label and slug.');
      const previous=s.brand.settings.programme?.structure;
      const destination=s.destinations.find((d)=>d.id===input.destinationId)!;
      let website:WebsiteStructure|undefined;
      if(destination.websiteCapability?.protocol==='v2') {
        const c=destination.websiteCapability.capabilities;const root=c.roots.find((r)=>`/${r.path}`===input.root)!;
        const changed=previous?.website&&categories.some((item)=>!previous.website!.categories.some((p)=>p.id===websiteIdentity('category',brandId,destination.id,c.siteId,root.path,item.slug)));
        if(changed&&!input.newCategoryAddresses)throw new SeoBlogError(409,'Changing a category address creates a new category identity. Explicitly confirm this; existing archives and article URLs will stay where they are.');
        website={siteId:c.siteId,structureId:websiteIdentity('structure',brandId,destination.id,c.siteId),rootId:root.id,rootPath:root.path,categories:categories.map((item)=>({recommendationId:item.id,id:websiteIdentity('category',brandId,destination.id,c.siteId,root.path,item.slug),label:item.label,slug:item.slug}))};
      }
      const base={schema:1 as const,version:(previous?.version??0)+1,scanId:recommendation.scanId,scanSha:recommendation.scanSha,root:input.root,destinationId:input.destinationId,categories,...(website?{website}:{}),approvedBy:actor.userId,approvedAt:this.now()};
      approved={...base,sha:programmeSha(base)};
      return {job:null,writeJob:false,settings:{...s.brand.settings,programme:{...s.brand.settings.programme,structure:approved}},event:{brandId,at:this.now(),actor:actor.userId,kind:'editorial.approved',message:`Editorial guidance version ${approved.version} approved. Existing URLs were not moved.`,subjectId:null}};
    }});
    if(!approved) throw new SeoBlogError(409,'Editorial guidance could not be approved.');
    return approved;
  }

  private programmeOwns(current: Job | null, claim: Job): boolean {
    return !!current && current.state==='running' && current.leaseOwner===claim.leaseOwner && current.attempts===claim.attempts && !!current.leaseExpiresAt && current.leaseExpiresAt>this.now();
  }
  private programmeIssue(s: ProgrammeBoundarySnapshot, run: ProgrammeRun, authority: ProgrammeAuthority): string | null {
    const issue=programmeReadinessIssue(s,authority);
    if(issue) return issue;
    if(programmeInputSnapshot(s,authority).sha!==run.snapshot.sha) return 'The confirmed profile, guidance, programme owner or approved editorial guidance changed. Start a new planning intent; current edits were preserved.';
    const structure=s.brand.settings.programme?.structure;
    return structure ? editorialRootIssue(s.destinations.find((d)=>d.id===structure.destinationId),structure.root) : null;
  }
  private programmeHeld(s: ProgrammeBoundarySnapshot, job: Job, run: ProgrammeRun, reason: string, message: string, diagnostic: ResearchDiagnostic | null = null): ProgrammeBoundaryDecision {
    const now=this.now();
    const hold={logicalRunId:run.logicalRunId,jobId:job.id,at:now,reason,diagnostic};
    const latch=!!s.brand.settings.programme?.researchHold || run.attempts.length>0 || !!run.modelStart || reason.startsWith('legacy');
    return {job:{...job,state:'blocked',leaseOwner:null,leaseExpiresAt:null,payload:{...job.payload,programme:{...run,hold:reason}},error:message.slice(0,400),progress:message.slice(0,400),updatedAt:now},writeJob:true,
      ...(latch?{settings:{...s.brand.settings,programme:{...s.brand.settings.programme,researchHold:s.brand.settings.programme?.researchHold??hold}}}:{}),
      event:{brandId:job.brandId,at:now,actor:'system',kind:'programme.held',message:message.slice(0,500),subjectId:job.id}};
  }
  private async programmeTransaction(job: Job, authority: ProgrammeAuthority, decide: (s: ProgrammeBoundarySnapshot)=>ProgrammeBoundaryDecision): Promise<Job> {
    const result=await this.store.programmeBoundary({brandId:job.brandId,jobId:job.id,authority,now:this.now(),decide});
    if(!result) throw new SeoBlogError(404,'Planning task not found.');
    return result;
  }
  private async programmeSearch(claim: Job, authority: ProgrammeAuthority, query: string, options: {locale:string;limit:number}, kind:'serp'|'metrics'='serp', effect?:()=>Promise<ResearchSearchReceipt>): Promise<ResearchSearchReceipt> {
    let cached:ResearchSearchReceipt|null=null; let nonce:string|null=null; let metricsSkipped=false;
    let supplierTask: {id:string;submittedAt:string;providerReportedCost:number|null}|undefined;
    const reserved=await this.programmeTransaction(claim,authority,(s)=>{
      const current=s.job; const run=current&&programmeRun(current);
      if(!current || !run) throw new SeoBlogError(409,'Planning run was not initialised.');
      const querySha=programmeSha({input:run.snapshot.sha,query,locale:options.locale,limit:options.limit,provider:kind==='serp'?this.deps.search.id:'keyword-metrics',kind});
      const saved=run.attempts.find((a)=>a.querySha===querySha && a.receipt);
      if(saved?.receipt) {cached=saved.receipt;return {job:current,writeJob:false};}
      if(!this.programmeOwns(current,claim)) return {job:current,writeJob:false};
      const pending=run.attempts.find((a)=>a.querySha===querySha&&!a.receivedAt);
      if(kind==='metrics' && (pending || run.metricsWarning)) {
        metricsSkipped=true; const warning=run.metricsWarning??researchDiagnostic(null);
        return {job:{...current,payload:{...current.payload,programme:{...run,metricsWarning:warning,attempts:run.attempts.map((a)=>a===pending?{...a,diagnostic:warning,uncertainAt:this.now()}:a)}}},writeJob:true};
      }
      const issue=this.programmeIssue(s,run,authority);
      if(issue) return this.programmeHeld(s,current,run,'inputs_changed',issue);
      if(s.brand.settings.programme?.researchHold) return this.programmeHeld(s,current,run,'research_held','The programme has a research hold. Review it and explicitly resume with a new intent.');
      if(pending) {
        if(kind==='serp' && pending.supplierTask && this.deps.search.readTask) {
          if(Date.parse(this.now())-Date.parse(pending.supplierTask.submittedAt)>3600_000) return this.programmeHeld(s,current,run,'supplier_wait_expired','The saved supplier task has not completed within one hour. Review its task ID; it will not be purchased again automatically.');
          nonce=pending.nonce;supplierTask=pending.supplierTask;return {job:current,writeJob:false};
        }
        return this.programmeHeld(s,current,run,'outcome_unknown','A research request started without a durable response. Its outcome and supplier charge may be uncertain. Review and explicitly resume; it will not be repeated automatically.');
      }
      const ceiling=s.brand.settings.budgets.searchCallsPerMonth;
      if(kind==='metrics' && (ceiling<=0||s.usage.search_calls+1>ceiling)) {
        metricsSkipped=true;return {job:{...current,payload:{...current.payload,programme:{...run,metricsWarning:{...researchDiagnostic(null),summary:'Optional keyword metrics were not requested because the remaining search-attempt allowance is insufficient.',remedy:'Source research remains valid; demand is labelled qualitative.'}}}},writeJob:true};
      }
      if(ceiling<=0||s.usage.search_calls+1>ceiling) return this.programmeHeld(s,current,run,'budget',new BudgetExceededError('search_calls',s.usage.search_calls,ceiling,1).message);
      nonce=randomUUID(); const now=this.now();
      return {job:{...current,payload:{...current.payload,programme:{...run,attempts:[...run.attempts,{querySha,query,nonce,kind,startedAt:now}]}},progress:`Researching ${kind==='metrics'?'optional demand metrics':'sources'} · attempt ${run.attempts.length+1}.`,error:null,updatedAt:now},writeJob:true,
        usage:{brandId:claim.brandId,kind:'search_calls',amount:1,at:now,reference:`research:${run.logicalRunId}:${nonce}`}};
    });
    if(cached) return cached;
    if(metricsSkipped) return {hits:[],keywordMetrics:[],taskId:null,providerReportedCost:null};
    if(!nonce || reserved.state!=='running') throw new ResearchUnavailableError('Research is held. See the programme status for the next action.');
    let receipt:ResearchSearchReceipt|null=null; let diagnostic:ResearchDiagnostic|null=null; let cost:number|null=supplierTask?.providerReportedCost??null; let waiting=false;
    try {
      if(kind==='serp' && !effect && this.deps.search.submitTask && this.deps.search.readTask) {
        if(supplierTask) {
          receipt=await this.deps.search.readTask(supplierTask.id,options);waiting=!receipt;
          if(receipt) receipt={...receipt,providerReportedCost:supplierTask.providerReportedCost};
        } else {
          const submitted=await this.deps.search.submitTask(query,options);
          supplierTask={id:submitted.taskId,submittedAt:this.now(),providerReportedCost:submitted.providerReportedCost};cost=submitted.providerReportedCost;waiting=true;
        }
      } else receipt=effect ? await effect() : this.deps.search.searchReceipt ? await this.deps.search.searchReceipt(query,options) : {hits:await this.deps.search.search(query,options),taskId:null,providerReportedCost:null};
    } catch(error) {
      diagnostic=error instanceof ResearchProviderError?error.diagnostic:researchDiagnostic(null);
      cost=supplierTask?supplierTask.providerReportedCost:error instanceof ResearchProviderError?error.providerReportedCost:null;
    }
    const save=()=>this.programmeTransaction(claim,authority,(s)=>{
      const current=s.job; const run=current&&programmeRun(current);
      if(!current || !run) throw new SeoBlogError(404,'Planning task not found.');
      const index=run.attempts.findIndex((a)=>a.nonce===nonce);
      if(index<0) throw new SeoBlogError(409,'Research receipt does not match its reserved attempt.');
      if(run.attempts[index]!.receivedAt) return {job:current,writeJob:false};
      const now=this.now(); const attempts=run.attempts.map((a,i)=>i===index?{...a,...(supplierTask?{supplierTask}:{}),...(waiting?{providerReportedCost:cost}:receipt?{receipt,receivedAt:now}:{diagnostic:diagnostic!,providerReportedCost:cost,receivedAt:now})}:a);
      const nextRun={...run,attempts,...(kind==='metrics'&&receipt?{metricsWarning:undefined}:{})}; const next={...current,payload:{...current.payload,programme:nextRun},updatedAt:now};
      if(!this.programmeOwns(current,claim)) return current.state==='running' ? this.programmeHeld(s,next,nextRun,'lease_lost','A late research receipt was retained, but its lease ended. No plan was applied. Review before resuming.') : {job:next,writeJob:true};
      const issue=this.programmeIssue(s,nextRun,authority);
      if(issue) return this.programmeHeld(s,next,nextRun,'inputs_changed',issue);
      if(waiting) return {job:{...next,state:'queued',leaseOwner:null,leaseExpiresAt:null,runAfter:new Date(Date.parse(now)+30_000).toISOString(),progress:'Waiting for the saved research task. Checking its result does not buy another search.',error:null},writeJob:true};
      if(receipt) return {job:next,writeJob:true};
      if(kind==='metrics') return {job:{...next,payload:{...next.payload,programme:{...nextRun,metricsWarning:diagnostic!}},progress:'Source research is available. Optional demand metrics are unavailable; demand remains qualitative.'},writeJob:true};
      if(diagnostic?.retryable && run.retries<2 && s.usage.search_calls<s.brand.settings.budgets.searchCallsPerMonth) {
        const retries=run.retries+1;const seconds=retries===1?60:300;
        return {job:{...next,state:'queued',leaseOwner:null,leaseExpiresAt:null,runAfter:new Date(Date.parse(now)+seconds*1000).toISOString(),payload:{...next.payload,programme:{...nextRun,retries}},error:diagnostic.summary,progress:`Temporary search error. Retry ${retries} of 2 is queued in ${seconds} seconds, within the remaining search allowance.`},writeJob:true};
      }
      return this.programmeHeld(s,next,nextRun,diagnostic?.retryable?'retries_exhausted':diagnostic?.category??'unknown',diagnostic ? `${diagnostic.summary} ${diagnostic.retryable?'The bounded retry allowance or search ceiling is exhausted. Explicit owner resume is required.':diagnostic.remedy}` : 'Research outcome is unknown. Review before resuming.',diagnostic);
    });
    let saved:Job; try{saved=await save();}catch{saved=await save();}
    if(kind==='metrics' && !receipt && saved.state==='running' && saved.leaseOwner===claim.leaseOwner && saved.attempts===claim.attempts) return {hits:[],keywordMetrics:[],taskId:null,providerReportedCost:cost};
    if(!receipt || saved.state!=='running' || saved.leaseOwner!==claim.leaseOwner || saved.attempts!==claim.attempts) throw new ResearchUnavailableError('Research is paused. Open programme status for the saved outcome.');
    return receipt;
  }

  private async runProgrammePlanJob(claim: Job): Promise<Job> {
    const brand=await this.store.getBrand(claim.brandId); if(!brand) throw new SeoBlogError(404,'Brand not found.');
    const profile=await this.store.latestProfile(claim.brandId); const authority=programmeAuthorityFor(claim,brand,profile);
    let ready=await this.programmeTransaction(claim,authority,(s)=>{
      const current=s.job;if(!current) throw new SeoBlogError(404,'Planning task not found.');
      if(!this.programmeOwns(current,claim)) return {job:current,writeJob:false};
      let run=programmeRun(current);
      const unreceiptedLegacyClaim=!run&&current.attempts>1;
      const source=programmeInputSnapshot(s,authority);
      if(!run) run={schema:1,logicalRunId:current.id,snapshot:source,retries:0,attempts:[]};
      const withRun={...current,payload:{...current.payload,programme:run}};
      if(unreceiptedLegacyClaim) return this.programmeHeld(s,withRun,run,'legacy_outcome_unknown','An older worker already claimed this planning task without durable supplier receipts. Review its outcome before a distinct new intent; no historical charge or usage was inferred.');
      const issue=this.programmeIssue(s,run,authority);
      if(issue) return this.programmeHeld(s,withRun,run,'inputs_changed',issue);
      if(!run.modelReceipt&&!this.deps.llm) return this.programmeHeld(s,withRun,run,'configuration','The writing model is not configured. No new supplier or model call was started.');
      if(!run.research&&this.deps.search.mode!=='live') return this.programmeHeld(s,withRun,run,'configuration','Source research is not configured. Connect the research provider before a new planning intent.');
      const legacy=legacyPlanningHold(s.jobs,s.brand.settings.programme?.researchAcknowledgements);
      const hold=s.brand.settings.programme?.researchHold??legacy;
      const explicit=hold && current.payload.resumeHoldId===hold.logicalRunId && authority.origin==='manual';
      if(hold && !explicit && !(hold.jobId===current.id && run.modelReceipt)) {
        const held=this.programmeHeld(s,withRun,run,'research_held',legacy?'An older planning task needs review. No historical supplier code or charge was inferred. A managing owner can explicitly resume with a new intent.':'Research is held. A managing owner can review and explicitly resume with a new intent.');
        return {...held,settings:{...s.brand.settings,programme:{...s.brand.settings.programme,researchHold:hold}}};
      }
      if(run.attempts.some((a)=>a.kind!=='metrics'&&!a.receivedAt&&!(a.supplierTask&&this.deps.search.readTask)) || (run.modelStart&&!run.modelReceipt)) return this.programmeHeld(s,withRun,run,'outcome_unknown','An interrupted paid research or model call has no durable result. Review its outcome before explicitly resuming; it will not be repeated automatically.');
      return {job:{...withRun,error:null,progress:run.modelReceipt?'Applying the saved planning result; no new model call.':'Researching and planning the next draft campaign.'},writeJob:true,
        ...(explicit?{settings:{...s.brand.settings,programme:{...s.brand.settings.programme,researchHold:null,researchAcknowledgements:[...(s.brand.settings.programme?.researchAcknowledgements??[]),{jobId:hold!.jobId,intentId:current.id,actorId:authority.sponsorUserId,at:this.now()}]}}}:{})};
    });
    if(ready.state!=='running' || ready.leaseOwner!==claim.leaseOwner || ready.attempts!==claim.attempts) return ready;
    const run=programmeRun(ready)!;
    const p=ready.payload;
    try {
      await this.runPlan(claim.brandId,{focus:(p.focus as string|null)??null,excluded:(p.excluded as string[])??[],sourceArticleUrl:(p.sourceArticleUrl as string|null)??null,requestedBy:typeof p.requestedBy==='string'?p.requestedBy:undefined},{
        planId:run.logicalRunId,provenance:{logicalRunId:run.logicalRunId,inputSha:run.snapshot.sha,structureSha:run.snapshot.structureSha,structureVersion:run.snapshot.structureVersion,root:run.snapshot.root,categoryLabels:run.snapshot.categoryLabels,authority},
        search:{id:this.deps.search.id,mode:this.deps.search.mode,search:async(query,options)=>[...(await this.programmeSearch(claim,authority,query,options)).hits]},
        ...(this.deps.keywords?.mode==='live'?{metrics:{mode:'live' as const,metrics:async(queries: string[])=>[...(await this.programmeSearch(claim,authority,queries.join('\n'),{locale:brand.locale,limit:queries.length},'metrics',async()=>({hits:[],keywordMetrics:(await this.deps.keywords!.metrics(queries)).filter((m)=>m.source!=='mock'),taskId:null,providerReportedCost:null}))).keywordMetrics??[]]}}:{}),
        research:run.research,modelResult:run.modelReceipt,
        beforeModel:async(research)=>{
          let permitted=false;
          ready=await this.programmeTransaction(claim,authority,(s)=>{
            const current=s.job;const latest=current&&programmeRun(current);if(!current||!latest) throw new SeoBlogError(404,'Planning task not found.');
            if(!this.programmeOwns(current,claim)) return {job:current,writeJob:false};
            const issue=this.programmeIssue(s,latest,authority);
            if(issue) return this.programmeHeld(s,current,latest,'inputs_changed',issue);
            if(latest.modelStart&&!latest.modelReceipt) return this.programmeHeld(s,current,latest,'outcome_unknown','A previous model call has no durable result. Review before a new paid intent.');
            const ceiling=s.brand.settings.budgets.modelTokensPerMonth;
            if(ceiling<=0||s.usage.model_tokens+USAGE_ESTIMATES.plan>ceiling) return this.programmeHeld(s,current,latest,'budget',new BudgetExceededError('model_tokens',s.usage.model_tokens,ceiling,USAGE_ESTIMATES.plan).message);
            permitted=true;return {job:{...current,payload:{...current.payload,programme:{...latest,research,modelStart:{nonce:randomUUID(),at:this.now()}}},progress:'Writing the researched draft plan.'},writeJob:true};
          });
          if(!permitted) throw new ResearchUnavailableError('Planning is held. See programme status.');
        },
        recordModel:async(result)=>{
          const nonce=programmeRun(ready)!.modelStart!.nonce;
          const save=()=>this.programmeTransaction(claim,authority,(s)=>{
            const current=s.job;const latest=current&&programmeRun(current);if(!current||!latest||latest.modelStart?.nonce!==nonce) throw new SeoBlogError(409,'Planning model result does not match its started operation.');
            if(latest.modelReceipt) return {job:current,writeJob:false};
            const at=this.now();return {job:{...current,payload:{...current.payload,programme:{...latest,modelReceipt:result,modelReceiptAt:at}},updatedAt:at},writeJob:true,
              usage:{brandId:claim.brandId,kind:'model_tokens',amount:result.record.tokensIn+result.record.tokensOut,at,reference:`plan:${latest.logicalRunId}:${nonce}`}};
          });
          try{ready=await save();}catch{ready=await save();}
        },
        commit:async(plan,briefs)=>{
          const save=()=>this.programmeTransaction(claim,authority,(s)=>{
            const current=s.job;const latest=current&&programmeRun(current);if(!current||!latest) throw new SeoBlogError(404,'Planning task not found.');
            if(current.state==='done') return {job:current,writeJob:false};
            if(!this.programmeOwns(current,claim)) return current.state==='running'?this.programmeHeld(s,current,latest,'lease_lost','The planning lease ended. The saved result was retained without applying it.'): {job:current,writeJob:false};
            const issue=this.programmeIssue(s,latest,authority);
            if(issue) return this.programmeHeld(s,current,latest,'inputs_changed',issue);
            const accept=s.brand.settings.autoAcceptPlans;
            const now=this.now();return {job:{...current,state:'done',leaseOwner:null,leaseExpiresAt:null,payload:{...current.payload,programme:{...latest,planId:plan.id}},progress:'Researched topic plan saved. Proposed dates are draft diary entries, not publication schedules.',error:null,updatedAt:now},writeJob:true,
              plan:accept?{...plan,status:'accepted',acceptedAt:now}:plan,briefs:briefs.map((b)=>accept&&b.status==='planned'?{...b,status:'accepted'}:b),
              settings:{...s.brand.settings,programme:{...s.brand.settings.programme,researchHold:s.brand.settings.programme?.researchHold?.jobId===current.id?null:s.brand.settings.programme?.researchHold??null}},
              event:{brandId:claim.brandId,at:now,actor:'system',kind:'plan.proposed',message:`Researched plan saved with ${briefs.length} proposed articles.`,subjectId:plan.id}};
          });
          try{ready=await save();}catch{ready=await save();}
        },
      });
      const outcome=(await this.store.getJob(claim.brandId,claim.id))??ready;
      if(outcome.state==='done') await this.topUpWrites(claim.brandId);
      return outcome;
    } catch(error) {
      return this.programmeTransaction(claim,authority,(s)=>{
        const current=s.job;const latest=current&&programmeRun(current);if(!current||!latest) throw new SeoBlogError(404,'Planning task not found.');
        if(error instanceof GenerationRejectedError && latest.modelStart && !latest.modelReceipt && !latest.modelRejection) {
          const now=this.now();const run={...latest,modelRejection:{record:error.record,reason:error.reason,at:now}};
          const next={...current,payload:{...current.payload,programme:run}};
          const held=this.programmeOwns(current,claim)?this.programmeHeld(s,next,run,'generation_rejected','The generated plan did not pass its format or evidence checks. Its known model usage was recorded. Review before another paid intent.'):{job:next,writeJob:true};
          // Rejected method receipts are already charged atomically by the
          // method store. Only unwrapped generation needs a plan usage entry.
          return {...held,...(error.record.methodReceiptId?{}:{usage:{brandId:claim.brandId,kind:'model_tokens' as const,amount:error.record.tokensIn+error.record.tokensOut,at:now,reference:`plan:${latest.logicalRunId}:${latest.modelStart.nonce}`}})};
        }
        if(!this.programmeOwns(current,claim)) return {job:current,writeJob:false};
        if(error instanceof BudgetExceededError) return this.programmeHeld(s,current,latest,'budget',error.message);
        return this.programmeHeld(s,current,latest,'planning_held',latest.modelStart&&!latest.modelReceipt?'A planning model call has no saved result. Token usage may be uncertain. Review before a new paid intent.':'Planning could not complete with usable research. Saved successful query receipts were retained; review programme status before resuming.');
      });
    }
  }

  async requestPlan(actor: Actor, brandId: string, input: { commandId: string; focus?: string | null; excluded?: readonly string[]; sourceArticleUrl?: string | null; resumeHoldId?: string | null }): Promise<Job> {
    const brand = await this.brandFor(actor, brandId);
    if (!validUuid(input.commandId)) throw new SeoBlogError(400, 'Refresh the form and try again.');
    const jobs=await this.store.listJobs(brandId);const prior=jobs.find((j)=>j.idempotencyKey===`plan:${input.commandId}`);
    if(prior) return prior;
    const hold=brand.settings.programme?.researchHold??legacyPlanningHold(jobs,brand.settings.programme?.researchAcknowledgements);
    if(hold && input.resumeHoldId!==hold.logicalRunId) throw new SeoBlogError(409,'Research is held after an earlier outcome. Review the programme status and explicitly resume with a new research intent.');
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
      resumeHoldId: input.resumeHoldId??null,
    });
  }

  /** Job handler: research → cluster → duplicate checks → suggested diary dates. */
  async runPlan(brandId: string, payload: { focus: string | null; excluded: string[]; sourceArticleUrl: string | null; requestedBy?: string }, execution?: PlanExecution): Promise<TopicPlan> {
    const brand = await this.store.getBrand(brandId);
    if (!brand) throw new SeoBlogError(404, 'Brand not found.');
    const { profile, stale } = await this.currentFactsKey(brandId);
    if (!profile?.confirmedAt || stale) throw new SeoBlogError(409, 'Confirm the current brand profile before planning.', 'not_ready');
    if(!execution?.modelResult) await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.plan);
    if(!execution) await this.requireBudget(brand, 'search_calls', USAGE_ESTIMATES.searchPerPlan);
    let inventory = await this.store.getInventory(brandId);
    if (brand.website && (!inventory || Date.parse(this.now()) - Date.parse(inventory.fetchedAt) > 24 * 3600_000)) {
      inventory = await this.refreshInventory(brandId);
    }
    const pages = inventory?.pages ?? [];
    const seeds = researchQuerySeeds({
      focus: payload.focus, audiences: profile.audiences, positioning: profile.positioning,
      categories: (brand.settings.programme?.structure?.categories ?? []).map((c) => c.label),
      limit: USAGE_ESTIMATES.searchPerPlan,
    });
    const research = execution?.research ?? await researchQueries({
      queries: seeds, search: execution?.search??this.deps.search, transport: this.deps.transport,
      locale: brand.locale, brandWebsite: brand.website, now: this.now, keywordProvider: execution ? execution.metrics??null : this.deps.keywords ?? null,
    });
    if (!execution && research.searchCalls > 0) await this.store.recordUsage({ brandId, kind: 'search_calls', amount: research.searchCalls, at: this.now(), reference: 'plan' });
    if (research.sources.length === 0) throw new ResearchUnavailableError('Research returned no usable sources. Planning paused; nothing was invented.');
    const planned = await this.store.listBriefs(brandId);
    const articles = await this.store.listArticles(brandId);
    if(execution && !execution.modelResult) await execution.beforeModel(research);
    const planId = execution?.planId??randomUUID();
    const result = execution?.modelResult ?? await proposeCluster(await this.methodLlm(brand,profile,'planning','plan:'+planId,research.sources), {
      brandName: brand.name, profile, inventory: pages, sources: research.sources,
      focus: [payload.focus,brand.settings.programme?.structure?`Owner-approved editorial category guidance: ${brand.settings.programme.structure.categories.map((c)=>c.label).join('; ')}. Preserve existing page URLs; category guidance does not create new website routes.`:null].filter(Boolean).join('\n')||null, excluded: payload.excluded, sourceArticleUrl: payload.sourceArticleUrl,
    });
    if(execution) { if(!execution.modelResult) await execution.recordModel(result); }
    else await this.recordGeneration(brandId, result.record, 'plan');
    const short = new Map(research.sources.map((s, i) => [`S${i + 1}`, s]));
    const cluster = [result.value.pillar, ...result.value.supporting];
    const planReceipt=result.record.methodReceiptId&&this.deps.methods?await this.deps.methods.store.receipt(brandId,result.record.methodReceiptId):null;
    const formatDecisions=(planReceipt?.sidecar?.decisions as {formatPerArticle?:{slug:string;formatId:string;rationale:string}[]}|undefined)?.formatPerArticle;
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
        ...(execution ? {programme:execution.provenance} : {}),
        id: slugToId.get(item.slug)!, planId, brandId, role: item.role, slug,
        ...(formatDecisions?.find(f=>f.slug===item.slug)?{editorialFormat:{...formatDecisions.find(f=>f.slug===item.slug)!,planReceiptId:result.record.methodReceiptId}}:{}),
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
      ...(execution ? {programme:execution.provenance} : {}),
      id: planId, brandId, status: 'proposed', topic: result.value.topic,
      moneyPage: result.value.money_page.url ? { url: result.value.money_page.url, label: result.value.money_page.label } : null,
      briefIds: briefs.map((b) => b.id), sources: research.sources,
      inputs: { focus: payload.focus, excluded: payload.excluded, sourceArticleUrl: payload.sourceArticleUrl },
      profileVersion: profile.version, inventoryAt: inventory?.fetchedAt ?? null, generation: result.record, createdAt: this.now(), acceptedAt: null,
    };
    // Briefs first, plan last: a crash in between leaves orphan briefs no screen lists, never a half plan.
    if(execution) { await execution.commit(plan,briefs.map((brief)=>({...brief,suggestedAtUtc:when.get(brief.id)??null}))); return plan; }
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
    if(plan.programme) {
      const current=await this.store.getBrand(brand.id);const profile=await this.store.latestProfile(brand.id);
      if(!current||!profile?.confirmedAt||profile.version!==plan.profileVersion||(current.settings.programme?.structure?.sha??null)!==plan.programme.structureSha) throw new SeoBlogError(409,'The profile or approved editorial guidance changed. Review a new plan before accepting.');
      if(current.settings.pauseAll) throw new SeoBlogError(409,'The programme is paused.');
    }
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
  async runWrite(brandId: string, payload: { briefId: string; fromVersionId?: string; requestedBy?: string }, claimedJob?:Job): Promise<Article> {
    const brand = await this.store.getBrand(brandId);
    if (!brand) throw new SeoBlogError(404, 'Brand not found.');
    if(brand.settings.pauseAll) throw new SeoBlogError(409,'Draft production is paused by the owner.');
    const brief = await this.store.getBrief(brandId, payload.briefId);
    if (!brief) throw new SeoBlogError(404, 'Planned article not found.');
    const { profile, stale } = await this.currentFactsKey(brandId);
    if (!profile?.confirmedAt || stale) throw new SeoBlogError(409, 'Confirm the current brand profile before writing.', 'not_ready');
    if(brief.programme) {
      const authority=brief.programme.authority;
      if(!authority) throw new SeoBlogError(409,'The planned article has no current programme authority. Review a new plan.');
      const plan=await this.store.getPlan(brandId,brief.planId);
      await this.store.programmeBoundary({brandId,jobId:null,authority,now:this.now(),decide:(s)=>{
        const issue=programmeReadinessIssue(s,authority);
        if(issue) throw new SeoBlogError(409,issue);
        if(s.profile?.version!==plan?.profileVersion||(s.brand.settings.programme?.structure?.sha??null)!==brief.programme!.structureSha) throw new SeoBlogError(409,'The planned article is based on changed profile or editorial guidance. Review a new plan.');
        return {job:null,writeJob:false};
      }});
    }
    const sourceKnowledgeSha=websiteSha(this.knowledgeRefs(await this.activeKnowledge(brandId)));
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
      const retained = await this.store.getVersion(brandId, article.currentVersionId);
      if (retained) await this.queueAutomaticArticleImage(brand, article, retained, profile);
      return article;
    }
    if (payload.fromVersionId && article.currentVersionId !== payload.fromVersionId) return article; // superseded meanwhile
    if(!payload.fromVersionId && article.campaignGeneration) {
      const retained=article.campaignGeneration;
      await this.appendVersion(brand,article,retained.body,'generated',null,payload.requestedBy??'system',retained.articleGeneration,profile,brief,sourceKnowledgeSha,false,claimedJob);
      await this.store.saveBrief({...brief,status:'generated',articleId:article.id});
      const completed=(await this.store.getArticle(brandId,article.id))!;
      const version=completed.currentVersionId?await this.store.getVersion(brandId,completed.currentVersionId):null;
      if(version)await this.queueAutomaticArticleImage(brand,completed,version,profile);
      return completed;
    }
    if (brief.status !== 'generating') await this.store.saveBrief({ ...brief, status: 'generating', articleId: article.id });
    if (article.editorialState !== 'writing') article = await this.store.updateArticle({ ...article, editorialState: 'writing' });
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.article);
    const sources = await this.sourcesForBrief(brandId, brief);
    const linkable = await this.linkable(brandId);
    let written;
    try {
      written = await writeArticle(await this.methodLlm(brand,profile,'blog','article:'+article.id,sources,undefined,brief.searchIntent==='buy',brief.editorialFormat), { profile, brief, sources, linkable, length: brand.settings.lengthPreference });
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
      citations: sources.map((s) => ({ sourceId: s.id, url: s.url, title: s.title, retrievedAt: s.retrievedAt, publishedAt:s.publishedAt,observedPeriod:s.observedPeriod,confidence:s.confidence,passage: s.passage, public: publicIds.has(s.id) || bodyCites(v, written.short, s.id) })),
      image: previous?.body.image ?? { kind: 'none', url: null, alt: v.image_alt, provenance: 'No image selected yet.', width: null, height: null },
      author: brand.settings.author,
    };
    const version = await this.appendVersion(brand, article, body, previous ? 'regenerated' : 'generated', null, payload.requestedBy ?? 'system', written.record, profile, brief,sourceKnowledgeSha,false,claimedJob);
    await this.store.saveBrief({ ...(await this.store.getBrief(brandId, brief.id))!, status: 'generated', articleId: article.id });
    await this.log(brandId, payload.requestedBy ?? 'system', previous ? 'article.regenerated' : 'article.generated', `“${body.title}” ${previous ? 'regenerated' : 'written'} (version ${version.number}).`, article.id);
    await this.queueAutomaticArticleImage(brand, article, version, profile);
    return (await this.store.getArticle(brandId, article.id))!;
  }

  private async queueAutomaticArticleImage(brand: Brand, article: Article, version: ArticleVersion, profile: BrandProfile): Promise<void> {
    if (!brand.settings.media?.imageGenerationEnabled || !this.deps.images || version.body.image.kind !== 'none') return;
    // An automatic intent is sponsored by the exact current confirmer. The SQL
    // boundary rechecks eligibility under the real worker, not a user principal.
    if (!profile.confirmedBy) return;
    try {
      const result = await this.deps.images.request({ brandId: brand.id, articleId: article.id, expectedVersionId: version.id,
        commandId: automaticImageCommandId(article.id, version.id), origin: 'programme', sponsorUserId: profile.confirmedBy, confirmedNewIntent: false });
      if (result.kind === 'held') await this.log(brand.id, 'system', 'image.held', result.detail.slice(0, 300), article.id);
    } catch {
      // Image readiness cannot erase a successfully saved article. No provider
      // call happens here; the durable image job alone can request admission.
      await this.log(brand.id, 'system', 'image.unavailable', 'The article was saved. Image preparation is unavailable; review campaign image settings.', article.id).catch(() => undefined);
    }
  }

  async requestArticleImage(actor: Actor, brandId: string, articleId: string, expectedVersionId: string, input: { readonly commandId: string; readonly confirmedNewIntent: boolean; readonly replacesIntentId?: string | null }): Promise<ArticleImageRequestResult> {
    await this.brandFor(actor, brandId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.commandId)) throw new SeoBlogError(400, 'Invalid image command.');
    if (input.replacesIntentId && !validUuid(input.replacesIntentId)) throw new SeoBlogError(400, 'Invalid previous image intent.');
    if (!this.deps.images) throw new SeoBlogError(503, 'Image storage and the capable image worker are not configured. No image call has been made.');
    // The service recovers a genuine command alias BEFORE fresh source checks.
    // A retained receipt is not permission for another paid provider call.
    const result = await this.deps.images.request({ brandId, articleId, expectedVersionId, commandId: input.commandId, origin: 'owner', sponsorUserId: actor.userId, confirmedNewIntent: input.confirmedNewIntent, replacesIntentId: input.replacesIntentId ?? null });
    return result.kind === 'job' ? { ...result, job: imageJobDto(result.job) } : result;
  }

  async retryImagePreparation(actor: Actor, brandId: string, jobId: string): Promise<Job> {
    await this.brandFor(actor, brandId);
    if (!this.deps.images) throw new SeoBlogError(503, 'Image preparation is unavailable.');
    return imageJobDto(await this.deps.images.retryPreparation({ brandId, jobId, actorId: actor.userId }));
  }

  private async initialCampaignCopy(input:{brand:Brand;article:Article;body:ArticleBody;generation:GenerationRecord|null;profile:BrandProfile;brief:ArticleBrief;actor:string;versionId:string;number:number;claimedJob?:Job;sourceKnowledgeSha?:string}):Promise<{article:Article;drafts:readonly CampaignDraft[];generation:GenerationRecord|null}> {
    const {brand,body,profile,brief}=input;
    const claim=input.claimedJob?{jobId:input.claimedJob.id,leaseOwner:input.claimedJob.leaseOwner,attempts:input.claimedJob.attempts}:null;
    const requestedBy=input.claimedJob?.payload.requestedBy??input.actor;
    if(typeof requestedBy!=='string'||(requestedBy!=='system'&&!validUuid(requestedBy))||(input.claimedJob&&requestedBy!==input.actor))throw new SeoBlogError(403,'Article copy requester does not match the actual write claim.');
    const authority=input.article.campaignGeneration?.authority??(requestedBy==='system'?{origin:'daily' as const,sponsorUserId:brand.settings.programme?.authorisedBy??profile.confirmedBy??''}:{origin:'manual' as const,sponsorUserId:requestedBy});
    const boundary=(decide:Parameters<SeoBlogStore['campaignCopyBoundary']>[0]['decide'])=>this.store.campaignCopyBoundary({brandId:brand.id,articleId:input.article.id,authority,claim,now:this.now(),decide});
    let article=await boundary(s=>{
      if(s.article.campaignGeneration)return {article:s.article};
      const marker:CampaignGeneration={nonce:randomUUID(),estimatedTokens:INITIAL_CAMPAIGN_TOKEN_ESTIMATE,plannedVersionId:input.versionId,plannedVersionNumber:input.number,body,articleGeneration:input.generation,profileSha:programmeSha(profile),knowledgeSha:input.sourceKnowledgeSha??programmeSha(programmeKnowledgeRefs(s.knowledge)),authority,claim,capturedAt:this.now(),startedAt:null,receipt:null,appliedAt:null};
      // Source and genuine authority are checked before saving any provider intent.
      const issue=campaignCopyIssue(s,marker,this.now());if(issue)throw new SeoBlogError(409,issue,'campaign_copy_held');
      return {article:{...s.article,campaignGeneration:marker}};
    });
    let marker=article.campaignGeneration!;
    if(programmeSha(marker.body)!==programmeSha(body)||marker.plannedVersionId!==input.versionId)throw new SeoBlogError(409,'The saved initial article input must be recovered exactly.');
    if(marker.startedAt&&!marker.receipt)throw new SeoBlogError(409,'The social copy call has an uncertain outcome. Its article input is saved; Retry cannot repeat the paid call.','campaign_copy_unknown');
    if(!marker.receipt) {
      // Configuration/budget failure before a start is a labelled free fallback.
      let llm:LlmClient;
      try { llm=await this.methodLlm(brand,profile,'social','promotion:'+input.versionId,body.citations.map(c=>({id:c.sourceId,url:c.url,title:c.title,retrievedAt:c.retrievedAt,passage:c.passage,publishedAt:c.publishedAt,observedPeriod:c.observedPeriod,confidence:c.confidence,primary:false,provider: "recorded",query: ""} as ResearchSource))); await this.requireBudget(brand,'model_tokens',USAGE_ESTIMATES.promotion); }
      catch(error) { if(!(error instanceof SeoBlogError)||error.code.startsWith('method_'))throw error; return {article,drafts:fallbackCampaignDrafts(body),generation:null}; }
      let startedHere=false;
      article=await boundary(s=>{
        const m=s.article.campaignGeneration;
        if(!m||m.nonce!==marker.nonce)throw new SeoBlogError(409,'Initial copy identity changed.');
        if(m.receipt||m.startedAt)return {article:s.article};
        const issue=campaignCopyIssue(s,{...m,claim},this.now());if(issue)throw new SeoBlogError(409,issue,'campaign_copy_held');
        const ceiling=s.brand.settings.budgets.modelTokensPerMonth;
        if(ceiling<=0||s.modelTokensUsed+s.modelTokensReserved+USAGE_ESTIMATES.promotion>ceiling)throw new SeoBlogError(409,`Writing allowance: recorded usage ${s.modelTokensUsed.toLocaleString('en-GB')} tokens; pending copy reservations ${s.modelTokensReserved.toLocaleString('en-GB')} estimated tokens; ceiling ${ceiling.toLocaleString('en-GB')}. This action needs another ${USAGE_ESTIMATES.promotion.toLocaleString('en-GB')} estimated tokens. Review pending work and Publishing settings; reserved estimates are not actual billed usage.`,'budget_exceeded');
        startedHere=true;return {article:{...s.article,campaignGeneration:{...m,claim,startedAt:this.now()}}};
      });
      marker=article.campaignGeneration!;
      if(!startedHere){
        if(!marker.receipt)throw new SeoBlogError(409,'Another worker started this copy call. Await its saved receipt.','campaign_copy_unknown');
      }else{
        let receipt:CampaignCopyReceipt;
        try {const generated=await writeArticleCampaignPromotions(llm,profile,body);receipt={nonce:marker.nonce,at:this.now(),record:generated.record,result:{kind:'accepted',drafts:generated.value.posts}};}
        catch(error){
          if(error instanceof SeoBlogError&&error.code.startsWith('method_'))throw error;
          if(!(error instanceof CampaignGenerationRejectedError))throw new SeoBlogError(409,'The social copy request has an uncertain outcome. The saved article is held; no automatic paid replay will occur.','campaign_copy_unknown');
          receipt={nonce:marker.nonce,at:this.now(),record:error.record,result:{kind:'rejected'}};
        }
        const save=()=>boundary(s=>{
          const m=s.article.campaignGeneration;
          if(!m||m.nonce!==receipt.nonce||!m.startedAt)throw new SeoBlogError(409,'Copy receipt identity changed.');
          if(m.receipt)return {article:s.article};
          return {article:{...s.article,campaignGeneration:{...m,receipt}},usage:{brandId:brand.id,kind:'model_tokens',amount:receipt.record.tokensIn+receipt.record.tokensOut,at:receipt.at,reference:`promotion:${s.article.id}:${m.plannedVersionId}`}};
        });
        // Retry persistence only, using the same known result. Never repeat LLM work.
        try{article=await save();}catch{article=await save();}
        marker=article.campaignGeneration!;
      }
    }
    const receipt=marker.receipt;
    if(!receipt)throw new SeoBlogError(409,'The copy result is still awaiting a durable receipt.','campaign_copy_unknown');
    return {article,drafts:receipt.result.kind==='accepted'?receipt.result.drafts:fallbackCampaignDrafts(body),generation:receipt.result.kind==='accepted'?receipt.record:null};
  }

  private async appendVersion(
    brand: Brand, article: Article, body: ArticleBody, change: VersionChange, changedSectionId: string | null, actor: string,
    generation: GenerationRecord | null, profile: BrandProfile, brief: ArticleBrief,sourceKnowledgeSha?:string, skipPromotionGeneration=false, claimedJob?:Job,
  ): Promise<ArticleVersion> {
    const versions = await this.store.listVersions(brand.id, article.id);
    const prior=versions.find((v)=>v.id===article.currentVersionId);
    if(article.publishedUrl&&body.slug!==new URL(article.publishedUrl).pathname.split('/').filter(Boolean).at(-1))throw new SeoBlogError(409,'An already-published article keeps its original slug and URL.');
    let websiteTarget:ArticleWebsiteTarget|undefined=prior?.websiteTarget&&prior.body.slug===body.slug?{...prior.websiteTarget,deliverySha:websiteSha({body,...Object.fromEntries(Object.entries(prior.websiteTarget).filter(([key])=>key!=='deliverySha'))})}:undefined;
    const contentSha = sha256(body);
    const versionId = article.currentVersionId===null&&!article.campaign&&!article.campaignGeneration?.appliedAt ? article.campaignGeneration?.plannedVersionId??randomUUID() : randomUUID();
    const destinations = (await this.store.listDestinations(brand.id)).filter(d => d.status === 'connected');
    const structure=brand.settings.programme?.structure;
    const destination = destinations.find(d=>d.id===prior?.websiteTarget?.destinationId)??destinations.find(d => d.id === article.schedule?.destinationId)??destinations.find(d=>d.id===structure?.destinationId) ?? (destinations.length === 1 ? destinations[0] : null);
    let websiteGuard:WebsiteVersionGuard|undefined;
    if(!prior?.websiteTarget&&!article.publishedUrl&&structure?.website&&destination?.id===structure.destinationId&&destination.websiteCapability?.protocol==='v2'){
      const candidate:ArticleVersion={...(brief.programme?{programme:brief.programme}:{}),id:versionId,articleId:article.id,brandId:brand.id,number:(versions.at(-1)?.number??0)+1,parentVersionId:article.currentVersionId,change,changedSectionId,createdAt:this.now(),createdBy:actor,body,profileVersion:profile.version,factsSha:profile.factsSha,knowledge:profile.knowledge,briefId:brief.id,planId:brief.planId,generation,contentSha};
      const proposed=reviewedWebsiteTarget({brand,article,version:candidate,destination,publications:[]},[]);
      const {deliverySha:_digest,...snapshot}=proposed;
      websiteTarget={...snapshot,origin:'programme_default',deliverySha:websiteSha({body,...snapshot,origin:'programme_default'})};
      const authority=brief.programme?.authority??(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(actor)?{origin:'manual' as const,sponsorUserId:actor}:{origin:'daily' as const,sponsorUserId:brand.settings.programme?.authorisedBy??profile.confirmedBy??''});
      websiteGuard={expectedVersionId:article.currentVersionId,structureSha:structure.sha,structureVersion:structure.version,destinationId:destination.id,destinationSha:destinationIdentity(destination),profileSha:websiteSha(profile),knowledgeSha:sourceKnowledgeSha??websiteSha(this.knowledgeRefs(await this.activeKnowledge(brand.id))),authority};
    }
    const canonicalUrl = websiteTarget?.target.canonicalUrl ?? article.publishedUrl ?? (destination ? publisherFor(this.deps.publishers, destination.type).publicUrlFor(destination, body.slug) : null);
    let generationRecord: GenerationRecord | null = null;
    const initialCampaign = article.currentVersionId === null && !article.campaign;
    let campaignDrafts: readonly CampaignDraft[] = fallbackCampaignDrafts(body);
    let posts: ArticlePromotionPack['posts'] = (['instagram', 'linkedin'] as const).map(network => ({
      network, title: body.title, copy: `${body.title}\n\n${body.excerpt}\n\nRead the full article.`,
      artworkInstructions: `Create a brand-approved editorial image illustrating “${body.title}”. Review the image before scheduling.`,
    }));
    if(initialCampaign && !skipPromotionGeneration) {
      const result=await this.initialCampaignCopy({brand,article,body,generation,profile,brief,actor,versionId,number:(versions.at(-1)?.number??0)+1,claimedJob,sourceKnowledgeSha});
      article=result.article; campaignDrafts=result.drafts; generationRecord=result.generation;
      posts=campaignDrafts.filter(p=>p.angle==='launch').map(({network,title,copy,artworkInstructions})=>({network,title,copy,artworkInstructions}));
    } else try {
      if (skipPromotionGeneration) throw new GenerationUnavailableError('This image-only edit retains article-text accompanying drafts; no model call was made.');
      await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.promotion);
      {
        const generated = await writeArticlePromotions(await this.methodLlm(brand,profile,'social','promotion:'+versionId,body.citations.map(c=>({id:c.sourceId,url:c.url,title:c.title,retrievedAt:c.retrievedAt,passage:c.passage,publishedAt:c.publishedAt,observedPeriod:c.observedPeriod,confidence:c.confidence,primary:false,provider: "recorded",query: ""} as ResearchSource))), profile, body);
        await this.recordGeneration(brand.id, generated.record, `promotion:${article.id}:${versionId}`);
        posts = generated.value.posts; generationRecord = generated.record;
      }
    } catch (error) {
      if(error instanceof SeoBlogError&&error.code.startsWith('method_'))throw error;
      // Preserve the article/edit when the optional copy stage cannot run. The UI labels this fallback.
      await this.log(brand.id, actor, 'promotion.fallback', initialCampaign
        ? 'Accompanying drafts use labelled article-text templates because model output was unavailable or incomplete. No automatic correction call was made.'
        : `Accompanying drafts use the article excerpt: ${(error as Error).message.slice(0, 160)}`, article.id);
    }
    const promotionPack: ArticlePromotionPack = {
      source: 'relaunch72.seo-blog', brandId: brand.id, articleId: article.id, versionId, contentSha,
      profileVersion: profile.version, factsSha: profile.factsSha, canonicalUrl,
      generation: generationRecord, mode: generationRecord ? 'model' : 'excerpt_fallback', posts,
    };
    const version: ArticleVersion = {
      ...(websiteTarget?{websiteTarget}:{}),
      ...(brief.programme?{programme:brief.programme}:{}),
      id: versionId, articleId: article.id, brandId: brand.id, number: (versions.at(-1)?.number ?? 0) + 1,
      parentVersionId: article.currentVersionId, change, changedSectionId, createdAt: this.now(), createdBy: actor, body,
      profileVersion: profile.version, factsSha: profile.factsSha, knowledge: profile.knowledge, briefId: brief.id, planId: brief.planId,
      generation, contentSha, promotionPack,
    };
    const checks = await this.checkVersion(brand, version);
    // A new version always invalidates the old approval; review-required articles return to Needs approval.
    const nextArticle:Article={
      ...article, slug: body.slug, currentVersionId: version.id, editorialState: 'draft', approval: null, checks, failure: null,
      ...(initialCampaign ? { campaign: createArticleCampaign({ articleVersionId: version.id, articleContentSha: version.contentSha, canonicalUrl,
        drafts: campaignDrafts, createdAt: version.createdAt, createdBy: actor, generation: generationRecord }) } : {}),
      hold: article.hold && ['checks_failed', 'stale_version'].includes(article.hold.reason) ? null : article.hold,
    };
    if(initialCampaign && article.campaignGeneration) {
      const marker=article.campaignGeneration, claim=claimedJob?{jobId:claimedJob.id,leaseOwner:claimedJob.leaseOwner,attempts:claimedJob.attempts}:null;
      await this.store.campaignCopyBoundary({brandId:brand.id,articleId:article.id,authority:marker.authority,claim,now:this.now(),decide:s=>{
        const m=s.article.campaignGeneration;
        if(!m||m.nonce!==marker.nonce||m.appliedAt)throw new SeoBlogError(409,'The article copy completion changed.');
        const issue=campaignCopyIssue(s,{...m,claim},this.now());if(issue)throw new SeoBlogError(409,issue,'campaign_copy_held');
        if(m.startedAt&&!m.receipt)throw new SeoBlogError(409,'The copy call has an uncertain outcome. No automatic paid replay is permitted.','campaign_copy_unknown');
        if(s.article.rowVersion!==article.rowVersion)throw new StaleWriteError('article');
        return {article:{...nextArticle,campaignGeneration:{...m,appliedAt:this.now()}},version,websiteGuard};
      }});
    } else { await this.store.addVersion(version,websiteGuard); await this.store.updateArticle(nextArticle); }
    return version;
  }

  async refreshPromotionVersion(actor: Actor, brandId: string, articleId: string, expectedVersionId: string): Promise<ArticleVersion> {
    const brand = await this.brandFor(actor, brandId);
    const { article, version, profile, brief } = await this.editable(brandId, articleId, expectedVersionId);
    return this.appendVersion(brand, article, version.body, 'metadata_changed', null, actor.userId, null, profile, brief);
  }

  /**
   * Owner approval of one exact accompanying post. The owner session observes
   * the parent tuple now; that observation is stored on the article first so
   * a retried request replays the same canonical command (same attestation
   * instant) instead of inventing a new one. Expired observations are
   * replaced, never extended.
   */
  async approvePromotion(actor: Actor, brandId: string, articleId: string, versionId: string, network: PromotionNetwork, expectedPackSha: string): Promise<void> {
    const brand = await this.brandFor(actor, brandId);
    const { article, version } = await this.editable(brandId, articleId, versionId);
    if (!version.promotionPack || sha256(version.promotionPack) !== expectedPackSha) throw new SeoBlogError(409, 'The accompanying drafts changed. Refresh before approving.');
    if (!version.promotionPack.canonicalUrl) throw new SeoBlogError(409, 'Connect the blog website, then create a new promotion version with its final URL before review.');
    if (!this.deps.promotions) throw new SeoBlogError(503, 'Canonical promotion approval is temporarily unavailable.');
    const { article: observed, observation } = await this.observe(article, version, network, 'approve', actor.userId);
    const link = await this.deps.promotions.approve({ brand, article: observed, version, network, observation,
      recordDraft: async (contentItemId, contentVersionId) => {
        const current = (await this.store.getArticle(brandId, articleId))!;
        await this.store.updateArticle({ ...current, promotionObservations: (current.promotionObservations ?? []).map(o => o.id === observation.id ? { ...o, contentItemId, contentVersionId } : o) });
      } });
    const current = (await this.store.getArticle(brandId, articleId))!;
    if (current.currentVersionId !== versionId) throw new StaleWriteError('article');
    await this.store.updateArticle({ ...current, linkedPromotions: [...(current.linkedPromotions ?? []).filter(p => !(p.articleVersionId === versionId && p.network === network)), link] });
    await this.log(brandId, actor.userId, 'promotion.approved', `${network} accompanying post approved for article version ${version.number}. Delivery remains separately gated.`, articleId);
  }

  private async observe(article: Article, version: ArticleVersion, network: PromotionNetwork, purpose: PromotionObservation['purpose'], userId: string): Promise<{ article: Article; observation: PromotionObservation }> {
    const packSha = sha256(version.promotionPack);
    const nowMs = Date.parse(this.now());
    const existing = (article.promotionObservations ?? []).find(o => o.purpose === purpose && o.articleVersionId === version.id && o.network === network && o.packSha === packSha
      && Date.parse(o.expiresAt) > nowMs && (o.contentVersionId !== null || nowMs - Date.parse(o.observedAt) <= OBSERVATION_CREATE_WINDOW_MS));
    if (existing) return { article, observation: existing };
    const observation: PromotionObservation = {
      id: randomUUID(), purpose, articleVersionId: version.id, network, packSha,
      observedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + OBSERVATION_TTL_MS).toISOString(), observedBy: userId,
      contentItemId: purpose === 'schedule' ? linkedPromotionFor(article, version, network)?.contentItemId ?? null : null,
      contentVersionId: purpose === 'schedule' ? linkedPromotionFor(article, version, network)?.contentVersionId ?? null : null,
    };
    // Keep only live observations plus this one; stale ones can never be replayed anyway.
    const kept = (article.promotionObservations ?? []).filter(o => Date.parse(o.expiresAt) > nowMs - 24 * 3_600_000).slice(-40);
    const updated = await this.store.updateArticle({ ...article, promotionObservations: [...kept, observation] });
    return { article: updated, observation };
  }

  // ─── Social delivery (per-brand registered accounts) ───────────────────

  private social(): SocialRegistry {
    if (!this.deps.social) throw new SeoBlogError(503, 'Social delivery is not available on this server.');
    return this.deps.social;
  }

  async socialOverview(actor: Actor, brandId: string): Promise<SocialOverview> {
    await this.brandFor(actor, brandId);
    if (!this.deps.social) return { profile: null, accounts: [], bindings: [] };
    return this.deps.social.overview(brandId);
  }

  async campaignCalendar(actor:Actor,brandId:string):Promise<import('./campaign-calendar.js').CampaignCalendarEntry[]> {
    const brand=await this.brandFor(actor,brandId);
    const [articles,briefs,publications]=await Promise.all([this.store.listArticles(brandId),this.store.listBriefs(brandId),this.store.listPublications(brandId)]);
    const sources=await Promise.all(articles.filter(a=>a.campaign).map(async article=>({article,version:article.currentVersionId?await this.store.getVersion(brandId,article.currentVersionId):null,proposedAt:briefs.find(b=>b.id===article.briefId)?.suggestedAtUtc??null,publications:publications.filter(p=>p.articleId===article.id)})));
    return campaignCalendarEntries(sources,this.now(),brand.timezone,brand.settings.pauseAll);
  }

  async socialCalendar(actor:Actor,brandId:string,from:string,to:string):Promise<{jobs:readonly import('./campaign-calendar.js').SocialCalendarJob[];links:ReadonlyMap<string,import('./campaign-calendar.js').CampaignJobLink>;available:boolean}> {
    await this.brandFor(actor,brandId);
    if(!socialCalendarWindow(from,to))throw new SeoBlogError(400,'Choose a valid delivery period of no more than 366 days.');
    const reader=this.deps.social?.listCalendar;
    if(!reader)return {jobs:[],links:new Map(),available:false};
    const [jobs,articles,wakeups]=await Promise.all([reader(brandId,from,to),this.store.listArticles(brandId),this.store.listJobs(brandId)]);
    return {jobs,links:campaignJobLinks(articles,wakeups),available:true};
  }

  async socialDiscovery(actor: Actor, brandId: string): Promise<import('./social-discovery.js').SocialDiscovery> {
    await this.brandFor(actor, brandId);
    if (!this.deps.social?.discover) return { state: 'unconfigured', profiles: [], accounts: [], checkedAt: null, detail: 'Verified account discovery is unavailable. Existing bindings have not been changed.' };
    return this.deps.social.discover(brandId);
  }

  async registerSocialProfile(actor: Actor, brandId: string, displayName: string, providerProfileId: string): Promise<void> {
    const brand = await this.brandFor(actor, brandId);
    const result = await this.social().registerProfile(brandId, displayName || `${brand.name} social accounts`, providerProfileId);
    await this.log(brandId, actor.userId, 'social.profile', result.disposition === 'applied' ? 'Zernio profile registered for this brand.' : 'Zernio profile registration replayed.');
  }

  async beginSocialConnect(actor: Actor, brandId: string, network: PromotionNetwork, intentId: string): Promise<{ authUrl: string }> {
    await this.brandFor(actor, brandId);
    if (!validUuid(intentId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const result = await this.social().beginConnect(brandId, network, intentId);
    await this.log(brandId, actor.userId, 'social.connect', `${network} connection handoff prepared. No account is connected until the provider confirms.`);
    return result;
  }

  async completeSocialConnect(actor: Actor, brandId: string, input: { intentId: string; network: PromotionNetwork; providerProfileId: string; providerAccountId: string; username: string; canonicalCallback: string }): Promise<'recorded' | 'replayed'> {
    await this.brandFor(actor, brandId);
    if (!validUuid(input.intentId)) throw new SeoBlogError(400, 'The connection handoff is invalid.');
    const result = await this.social().completeConnect(brandId, input);
    if (result.disposition === 'recorded') await this.log(brandId, actor.userId, 'social.connected', `${input.network} account connected. Register it with caps to enable delivery.`);
    return result.disposition;
  }

  async registerSocialBinding(actor: Actor, brandId: string, input: { network: PromotionNetwork; providerAccountId: string; dailyCap: number; monthlyCap: number }): Promise<void> {
    await this.brandFor(actor, brandId);
    const result = await this.social().registerBinding(brandId, input);
    await this.log(brandId, actor.userId, 'social.binding', `${input.network} account ${result.disposition === 'caps_changed' ? 'caps changed' : result.disposition}: ${input.dailyCap}/day, ${input.monthlyCap}/month${input.dailyCap === 0 || input.monthlyCap === 0 ? ' (delivery off)' : ''}.`);
  }

  async revokeSocialBinding(actor: Actor, brandId: string, bindingId: string): Promise<void> {
    await this.brandFor(actor, brandId);
    await this.social().revokeBinding(brandId, bindingId);
    await this.log(brandId, actor.userId, 'social.binding', 'A registered account was revoked. Queued posts for it will hold.');
  }

  /**
   * Schedules one approved, verified-public accompanying post through the
   * brand's registered account: fresh attestation, canonical planning intent,
   * calendar job. Holds are recorded truthfully on the article instead of
   * silently dropping the slot.
   */
  async scheduleSocial(actor: Actor, brandId: string, articleId: string, versionId: string, network: PromotionNetwork, expectedPackSha: string, localDate: string, localTime: string): Promise<SocialDispatch> {
    const brand = await this.brandFor(actor, brandId);
    if (brand.settings.pauseAll) throw new SeoBlogError(409, 'Publishing is paused for this brand.');
    const when = localToUtc(localDate, localTime, brand.timezone);
    let prepared: { article: Article; version: ArticleVersion; dispatch: SocialDispatch } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { article, version } = await this.editable(brandId, articleId, versionId);
      if (!version.promotionPack || sha256(version.promotionPack) !== expectedPackSha) throw new SeoBlogError(409, 'The accompanying drafts changed. Refresh before scheduling.');
      const articleHold = promotionPublicationHold(article, version, network);
      if (articleHold) throw new SeoBlogError(409, articleHold);
      const overview = await this.social().overview(brandId);
      const accountHold = bindingHold(overview.bindings, network);
      if (accountHold) throw new SeoBlogError(409, accountHold);
      const binding = activeBindingFor(overview.bindings, network)!;
      const existing = (article.socialDispatches ?? []).find(d => d.articleVersionId === versionId && d.network === network && (d.state === 'preparing' || d.state === 'queued'));
      if (existing) {
        if (existing.scheduledFor !== when.utc || existing.packSha !== expectedPackSha || existing.bindingId !== binding.id) {
          throw new SeoBlogError(409, `This post is already queued or reserved for ${utcToLocal(existing.scheduledFor, brand.timezone).date} ${utcToLocal(existing.scheduledFor, brand.timezone).time}. Refresh its original slot; a retry cannot move it.`);
        }
        if (existing.state === 'queued') return existing;
        if (!existing.reservation) throw new SeoBlogError(409, 'This reserved slot needs attention before it can resume.');
        prepared = { article, version, dispatch: existing }; break;
      }
      if (Date.parse(when.utc) < Date.parse(this.now()) + 10 * 60_000) throw new SeoBlogError(400, 'Choose a time at least ten minutes from now.');
      if (Date.parse(when.utc) > Date.parse(this.now()) + 90 * 24 * 3_600_000) throw new SeoBlogError(400, 'Choose a time within the next 90 days.');
      const now = this.now();
      const link = linkedPromotionFor(article, version, network)!;
      const observation: PromotionObservation = { id: randomUUID(), purpose: 'schedule', articleVersionId: versionId, network, packSha: expectedPackSha,
        observedAt: now, expiresAt: new Date(Date.parse(now) + OBSERVATION_TTL_MS).toISOString(), observedBy: actor.userId,
        contentItemId: link.contentItemId, contentVersionId: link.contentVersionId };
      const dispatchId = randomUUID();
      const dispatch: SocialDispatch = { id: dispatchId, articleVersionId: versionId, network, packSha: expectedPackSha, bindingId: binding.id, intentId: dispatchId, jobId: null,
        scheduledFor: when.utc, requestedAt: now, requestedBy: actor.userId, state: 'preparing', detail: 'Recording the slot…', dailyCap: binding.dailyCap, monthlyCap: binding.monthlyCap,
        reservation: { observation, link, binding } };
      try {
        const reserved = await this.store.updateArticle({ ...article, promotionObservations: [...(article.promotionObservations ?? []).slice(-40), observation],
          socialDispatches: [...(article.socialDispatches ?? []), dispatch] });
        prepared = { article: reserved, version, dispatch }; break;
      } catch (error) { if (!(error instanceof StaleWriteError)) throw error; }
    }
    if (!prepared) throw new StaleWriteError('article');
    const base = prepared.dispatch;
    const { observation, link, binding } = base.reservation!;
    let dispatch: SocialDispatch;
    try {
      // The PG adapter first recovers a committed receipt, before checking an expired observation.
      const planned = await this.social().plan({ brand, article: prepared.article, version: prepared.version, network, link, binding, observation, dispatchId: base.id, scheduledFor: base.scheduledFor });
      dispatch = { ...base, intentId: planned.intentId, jobId: planned.jobId, state: 'queued', detail: null, dailyCap: planned.dailyCap, monthlyCap: planned.monthlyCap };
    } catch (error) {
      if (!(error instanceof SocialDeliveryHoldError)) throw error;
      dispatch = { ...base, state: 'held', detail: error.hold };
    }
    let saved = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = (await this.store.getArticle(brandId, articleId))!;
      const recorded = current.socialDispatches?.find(d => d.id === base.id);
      if (recorded?.state === 'queued') return recorded;
      if (!recorded) throw new StaleWriteError('reserved social slot');
      try {
        await this.store.updateArticle({ ...current, socialDispatches: current.socialDispatches!.map(d => d.id === base.id ? dispatch : d) });
        saved = true; break;
      } catch (error) { if (!(error instanceof StaleWriteError)) throw error; }
    }
    if (!saved) throw new StaleWriteError('article');
    await this.log(brandId, actor.userId, dispatch.state === 'queued' ? 'social.queued' : 'social.held', dispatch.state === 'queued'
      ? `${network} post queued for ${localDate} ${when.localTime} through the brand’s registered account; it is re-verified shortly before sending.`
      : `${network} post held: ${dispatch.detail}`, articleId);
    if (dispatch.state === 'held') throw new SeoBlogError(409, dispatch.detail ?? 'The post is held.');
    return dispatch;
  }

  private async checkVersion(brand: Brand, version: ArticleVersion): Promise<CheckReport> {
    const facts = await this.currentFactsKey(brand.id);
    const profile = facts.profile;
    if (!profile) throw new SeoBlogError(409, 'Extract the brand profile first.');
    const [inventory, articles, plan] = await Promise.all([this.store.getInventory(brand.id), this.store.listArticles(brand.id), this.store.getPlan(brand.id, version.planId)]);
    const linkable = linkableUrls(inventory);
    for (const a of articles) if (a.delivery === 'published' && a.publishedUrl) linkable.add(a.publishedUrl);
    const sources = new Map((plan?.sources ?? []).map((s) => [s.id, s]));
    for (const c of version.body.citations) if (!sources.has(c.sourceId)) sources.set(c.sourceId, { id: c.sourceId, url: c.url, title: c.title, retrievedAt: c.retrievedAt,publishedAt:c.publishedAt,observedPeriod:c.observedPeriod,confidence:c.confidence,passage: c.passage, provider: 'recorded', primary: false, query: '' });
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

  async getArticle(actor: Actor, brandId: string, articleId: string): Promise<{ article: Article; version: ArticleVersion | null; versions: ArticleVersion[]; publications: Publication[]; status: string; proposedAt?: string | null }> {
    const brand = await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId);
    if (!article) throw new SeoBlogError(404, 'That article was not found.');
    const [versions, brief] = await Promise.all([this.store.listVersions(brandId, articleId), this.store.getBrief(brandId, article.briefId)]);
    return {
      article, version: versions.find((v) => v.id === article.currentVersionId) ?? null, versions, proposedAt: brief?.suggestedAtUtc ?? null,
      publications: (await this.store.listPublications(brandId, articleId)).map(({websiteSnapshot:_private,...publicRecord})=>publicRecord), status: articleStatusLabel(article, brand.settings),
    };
  }

  async getPostingDrafts(actor:Actor,brandId:string,articleId:string) {
    const detail=await this.getArticle(actor,brandId,articleId),brand=await this.brandFor(actor,brandId);
    if(!detail.version)throw new SeoBlogError(409,'The article is still being written. Its posting drafts will appear when it is ready.');
    const v=detail.version,a=detail.article,profile=await this.store.latestProfile(brandId);
    const source:PostDraftSource={articleId:a.id,brandId,versionId:v.id,contentSha:v.contentSha,profileVersion:v.profileVersion,factsSha:v.factsSha,body:v.body,publicUrl:a.publishedVersionId===v.id?a.publishedUrl:null};
    const saved=[...(a.platformDrafts??[])];
    const drafts=[...saved,...POSTING_PLATFORMS.filter(p=>!saved.some(d=>d.platform===p.id&&currentPostDraft(d).sourceVersionId===v.id)).map(p=>derivePostDraft(source,p.id,brand.name,{id:defaultPostDraftId(a.id,v.id,p.id),actor:actor.userId,at:v.createdAt}))];
    return {...detail,version:v,drafts:drafts.map(d=>({draft:d,saved:saved.some(s=>s.id===d.id),stale:postDraftIsStale(d,{...source,factsSha:profile?.factsSha??source.factsSha})}))};
  }
  async createPostingAnswer(actor:Actor,brandId:string,articleId:string,input:{versionId:string;rowVersion:number;platform:'reddit'|'quora';questionIndex:number}):Promise<PlatformDraft> {
    const data=await this.getPostingDrafts(actor,brandId,articleId),a=data.article,v=data.version;
    if(a.currentVersionId!==input.versionId||a.rowVersion!==input.rowVersion)throw new StaleWriteError('posting workspace');
    if(!['reddit','quora'].includes(input.platform)||!Number.isInteger(input.questionIndex)||!v.body.faqs[input.questionIndex])throw new SeoBlogError(400,'Choose a question answered in this article.');
    const id=defaultPostDraftId(a.id,v.id,input.platform,input.questionIndex),prior=a.platformDrafts?.find(d=>d.id===id);
    if(prior)return prior;
    const brand=await this.brandFor(actor,brandId);
    const next=derivePostDraft({articleId:a.id,brandId,versionId:v.id,contentSha:v.contentSha,profileVersion:v.profileVersion,factsSha:v.factsSha,body:v.body,publicUrl:a.publishedVersionId===v.id?a.publishedUrl:null},input.platform,brand.name,{id,actor:actor.userId,at:this.now(),questionIndex:input.questionIndex});
    await this.store.updateArticle({...a,platformDrafts:[...(a.platformDrafts??[]),next]});return next;
  }
  async savePostingDraft(actor:Actor,brandId:string,articleId:string,input:{versionId:string;rowVersion:number;draftId:string;revisionId:string;commandId:string;title:string;body:string;question:string;targetUrl:string|null}):Promise<PlatformDraft> {
    const data=await this.getPostingDrafts(actor,brandId,articleId),a=data.article;
    const entry=data.drafts.find(d=>d.draft.id===input.draftId);
    if(!entry)throw new SeoBlogError(404,'That posting draft was not found.');
    if(a.currentVersionId!==input.versionId||a.rowVersion!==input.rowVersion)throw new StaleWriteError('posting workspace');
    const next=editPostDraft(entry.draft,input.revisionId,{id:input.commandId,actor:actor.userId,at:this.now(),title:input.title,body:input.body,question:input.question,targetUrl:input.targetUrl});
    await this.store.updateArticle({...a,platformDrafts:[...(a.platformDrafts??[]).filter(d=>d.id!==next.id),next]});
    return next;
  }
  async restorePostingDraft(actor:Actor,brandId:string,articleId:string,input:{versionId:string;rowVersion:number;draftId:string;revisionId:string;restoreId:string;commandId:string}):Promise<void> {
    const data=await this.getPostingDrafts(actor,brandId,articleId),a=data.article;
    if(a.currentVersionId!==input.versionId||a.rowVersion!==input.rowVersion)throw new StaleWriteError('posting workspace');
    const entry=data.drafts.find(d=>d.saved&&d.draft.id===input.draftId);
    if(!entry)throw new SeoBlogError(404,'That saved post was not found.');
    const next=restorePostDraft(entry.draft,input.revisionId,input.restoreId,{id:input.commandId,actor:actor.userId,at:this.now()});
    await this.store.updateArticle({...a,platformDrafts:(a.platformDrafts??[]).map(d=>d.id===next.id?next:d)});
  }

  private campaignService(): SeoBlogCampaignService { return new SeoBlogCampaignService(this.store, this.now, this.deps.campaignReview); }
  private mediaReview(): ArticleMediaReviewService {
    if (!this.deps.mediaReview) throw new SeoBlogError(503, 'Private image review is not configured. No image was approved or released.');
    return this.deps.mediaReview;
  }
  async privateCampaignImage(actor: Actor, brandId: string, assetId: string, sha: string): Promise<import('./media-types.js').SeoMediaPrivateBytes> {
    await this.brandFor(actor, brandId);
    return this.mediaReview().media.loadPrivateAsset(brandId, assetId, sha);
  }
  async reviewCampaignImage(actor: Actor, brandId: string, articleId: string, commandId: string, input: import('./media-types.js').SeoMediaAssetManifestInput): Promise<import('./media-review.js').MediaQualityReview> {
    await this.brandFor(actor, brandId);
    return this.mediaReview().review(actor.userId, brandId, articleId, commandId, input);
  }
  async cropCampaignImage(actor: Actor, brandId: string, articleId: string, versionId: string, commandId: string, candidateAssetId: string, candidateSha256: string, focal: { x: number; y: number }): Promise<void> {
    await this.brandFor(actor, brandId);
    await this.mediaReview().crop(actor.userId, brandId, articleId, versionId, commandId, candidateAssetId, candidateSha256, focal);
  }
  async uploadCampaignImage(actor: Actor, brandId: string, articleId: string, versionId: string, commandId: string, bytes: Buffer, filename: string): Promise<void> {
    await this.brandFor(actor, brandId);
    await this.mediaReview().upload(actor.userId, brandId, articleId, versionId, commandId, bytes, filename);
  }
  async withdrawCampaignImage(actor: Actor, brandId: string, articleId: string, input: import('./media-types.js').SeoMediaWithdrawalInput): Promise<void> {
    await this.brandFor(actor, brandId);
    await this.mediaReview().withdraw(actor.userId, brandId, articleId, input);
  }
  async selectCampaignHero(actor: Actor, brandId: string, articleId: string, expectedVersionId: string, commandId: string, qualityCommandId: string): Promise<ArticleVersion> {
    const brand = await this.brandFor(actor, brandId), media = this.mediaReview();
    let article = await this.store.getArticle(brandId, articleId);
    if (!article) throw new SeoBlogError(404, 'Article not found.');
    const review = article.mediaQualityReviews?.find(r => r.commandId === qualityCommandId);
    if (!review?.canonical || review.manifest.presentation.profile !== 'blog') throw new SeoBlogError(409, 'Review the real blog crop and its exact alt text first.');
    const manifest = review.manifest;
    const reservation = await media.media.reserveMediaUse(brandId, { commandId, articleId, assetId: manifest.assetId, assetSha256: manifest.byteSha256,
      presentation: { slot: 'hero', profile: 'blog', alt: manifest.presentation.alt } });
    const current = article.currentVersionId ? await this.store.getVersion(brandId, article.currentVersionId) : null;
    let next: ArticleVersion;
    if (current?.body.image.url === reservation.prospectiveUrl && current.body.image.alt === reservation.presentation.alt) next = current;
    else {
      const editable = await this.editable(brandId, articleId, expectedVersionId);
      if (editable.article.delivery === 'publishing') throw new SeoBlogError(409, 'Wait for the current publication to finish before changing the hero image.');
      next = await this.appendVersion(brand, editable.article, { ...editable.version.body, image: { kind: manifest.provenance.kind,
        url: reservation.prospectiveUrl, alt: manifest.presentation.alt, provenance: 'Exact privately reviewed editorial crop; public release remains separately gated.',
        width: manifest.width, height: manifest.height } }, 'image_changed', null, actor.userId, null, editable.profile, editable.brief, undefined, true);
    }
    article = (await this.store.getArticle(brandId, articleId))!;
    if (article.currentVersionId !== next.id) throw new StaleWriteError('article');
    await this.store.updateArticle({ ...article, heroMedia: { reservation, quality: review.canonical, authorizations: article.heroMedia?.reservation.commandId === commandId ? article.heroMedia.authorizations : [] } });
    return next;
  }
  async authorizeCampaignHero(actor: Actor, brandId: string, articleId: string, versionId: string, commandId: string): Promise<void> {
    await this.brandFor(actor, brandId);
    const article = await this.store.getArticle(brandId, articleId), version = await this.store.getVersion(brandId, versionId);
    if (!article || !version || article.currentVersionId !== versionId || version.articleId !== articleId || !article.heroMedia) throw new SeoBlogError(409, 'Refresh and select the exact reviewed hero before authorizing this version.');
    const selected = article.heroMedia;
    if (version.body.image.url !== selected.reservation.prospectiveUrl || version.body.image.alt !== selected.reservation.presentation.alt) throw new SeoBlogError(409, 'The hero presentation changed. Review a new exact use.');
    const authorization = await this.mediaReview().media.recordOwnerImageAuthorization(brandId, { commandId, reservationCommandId: selected.reservation.commandId,
      articleVersionId: version.id, articleContentSha256: version.contentSha, reviewedIntentSha256: version.websiteTarget?.deliverySha ?? version.contentSha, canonical: selected.quality });
    const current = (await this.store.getArticle(brandId, articleId))!;
    if (current.currentVersionId !== version.id || current.heroMedia?.reservation.commandId !== selected.reservation.commandId) throw new StaleWriteError('hero image');
    const authorizations = current.heroMedia.authorizations.some(a => a.id === authorization.id) ? current.heroMedia.authorizations : [...current.heroMedia.authorizations, authorization];
    await this.store.updateArticle({ ...current, heroMedia: { ...current.heroMedia, authorizations } });
  }
  async editCampaignPost(actor: Actor, brandId: string, articleId: string, versionId: string, selection: CampaignSelection, edit: { title: string; copy: string; artworkInstructions: string }): Promise<Article> {
    return this.campaignService().edit(actor.userId, brandId, articleId, versionId, selection, edit);
  }
  async selectCampaignPostImage(actor: Actor, brandId: string, articleId: string, versionId: string, selection: CampaignSelection, commandId: string, qualityCommandId: string): Promise<Article> {
    return this.campaignService().selectImage(actor.userId, brandId, articleId, versionId, selection, commandId, qualityCommandId);
  }
  async controlCampaignPost(actor: Actor, brandId: string, articleId: string, versionId: string, selection: CampaignSelection, control: Parameters<SeoBlogCampaignService['control']>[5]): Promise<Article> {
    return this.campaignService().control(actor.userId, brandId, articleId, versionId, selection, control);
  }
  async rebaseCampaign(actor: Actor, brandId: string, articleId: string, versionId: string): Promise<Article> {
    return this.campaignService().rebase(actor.userId, brandId, articleId, versionId);
  }
  async approveCampaignPost(actor: Actor, brandId: string, articleId: string, versionId: string, selection: CampaignSelection): Promise<Article> {
    return this.campaignService().approve(actor.userId, brandId, articleId, versionId, selection);
  }
  async queueCampaignPost(actor: Actor, brandId: string, articleId: string, input: Parameters<SeoBlogCampaignQueueService['request']>[3]): Promise<import('./media-types.js').SeoCampaignQueueInstruction> {
    await this.brandFor(actor, brandId);
    if (!this.deps.campaignQueue) throw new SeoBlogError(503, 'Durable campaign delivery is not configured. No post was queued.');
    return this.deps.campaignQueue.request(actor.userId, brandId, articleId, input);
  }
  async cancelCampaignPostQueue(actor: Actor, brandId: string, articleId: string, queueId: string, commandId: string): Promise<void> {
    await this.brandFor(actor, brandId);
    if (!this.deps.campaignQueue) throw new SeoBlogError(503, 'Campaign delivery is not configured.');
    await this.deps.campaignQueue.cancel(actor.userId, brandId, articleId, queueId, commandId);
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
    if (image.kind === 'generated') throw new SeoBlogError(409, 'Use the Campaign screen to select a prepared image and review its exact description and use.');
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

  private async methodLlm(brand:Brand,profile:BrandProfile,stage:'planning'|'blog'|'revision'|'social',assetRef:string,sources:readonly ResearchSource[],preserveReceiptId?:string|null,copyRequested=false,editorialFormat?:EditorialFormat):Promise<LlmClient>{
    const llm=this.llm();if(!this.deps.methods)return llm;
    const visual=confirmedVisualInputs(profile,await this.store.listKnowledge(brand.id),stage==='social'?'social-post':stage==='revision'?'section':'article-hero');
    const id=assetRef.split(':')[1]!;
    const version=assetRef.startsWith('promotion:')?await this.store.getVersion(brand.id,id):null;
    const article=await this.store.getArticle(brand.id,version?.articleId??id);
    const hero=article?.heroMedia;
    if(hero&&!(article?.mediaWithdrawals?.length)&&hero.quality&&hero.quality.contentSha256){
      // No binary is exposed to the model. A matching canonical manifest is required below.
      const review=article?.mediaQualityReviews?.find(r=>r.canonical?.contentSha256===hero.quality.contentSha256&&r.manifest.assetId===hero.reservation.assetId&&r.manifest.byteSha256===hero.reservation.assetSha256);
      if(review)(visual.assets as {id:string;sha256:string;kind:'illustration'|'evidence';description:string;width?:number;height?:number}[]).push({id:review.manifest.assetId,sha256:review.manifest.byteSha256,kind:review.manifest.provenance.kind==='generated'?'illustration':'evidence',description:review.manifest.presentation.alt,width:review.manifest.width,height:review.manifest.height});
    }
    if(preserveReceiptId){
      const original=await this.deps.methods.store.receipt(brand.id,preserveReceiptId);
      const decision=(original?.sidecar?.decisions as {formatDecision?:EditorialFormat}|undefined)?.formatDecision;
      if(decision)editorialFormat=decision;
    }
    return this.deps.methods.prepare(llm,{brand,profile,stage,assetRef,stages:stage==='blog'?['blog','visual-brief',...(copyRequested?['copy']:[])]:stage==='social'?['social','visual-brief']:[stage],
      sources:[...sources.map(s=>s.id),...sources.map((_,i)=>'S'+(i+1))],preserveReceiptId,
      evidence:{research:sources,visual,editorialFormat},
      baselineTokens:stage==='planning'?USAGE_ESTIMATES.plan:stage==='blog'?USAGE_ESTIMATES.article:stage==='social'?USAGE_ESTIMATES.promotion:USAGE_ESTIMATES.section});
  }

  /** Internal owner command; changes no checkout, price or paid entitlement. */
  async assignMethods(actor:Actor,brandId:string,expectedRevision:number,pins:readonly MethodPin[]):Promise<number>{
    await this.brandFor(actor,brandId);
    if(!this.deps.methods)throw new SeoBlogError(409,'Production methods are disabled.','method_disabled');
    return this.deps.methods.store.assign(brandId,expectedRevision,pins);
  }

  get campaignCreatorsReady():boolean{return Boolean(this.deps.creatorStore&&this.deps.methods);}
  get productionMethodsReady():boolean{return Boolean(this.deps.methods);}
  creators():CampaignCreator {
    if(!this.deps.creatorStore||!this.deps.methods)throw new SeoBlogError(409,'Campaign creators are not enabled yet.');
    return new CampaignCreator(this.deps.creatorStore,this.store,this.deps.methods,this.deps.llm);
  }
  async methodOverview(actor:Actor,brandId:string){
    await this.brandFor(actor,brandId);
    if(!this.deps.methods)return {enabled:false,assignment:null,releases:[],version:PRIVATE_RELEASE_VERSION};
    return {enabled:true,...await this.deps.methods.store.snapshot(brandId),version:PRIVATE_RELEASE_VERSION};
  }
  async activateReviewedMethods(actor:Actor,brandId:string,expectedRevision:number,includeCreators:boolean):Promise<number>{
    return this.setReviewedMethods(actor,brandId,expectedRevision,libraryPins(PRIVATE_RELEASE_VERSION).filter(p=>includeCreators||!['email-writing','advocacy-and-referral'].includes(p.packId)).map(p=>p.packId));
  }
  async setReviewedMethods(actor:Actor,brandId:string,expectedRevision:number,requested:readonly string[]):Promise<number>{
    await this.brandFor(actor,brandId);
    if(!this.deps.methods)throw new SeoBlogError(409,'Production methods are disabled.');
    if(requested.some(id=>['email-writing','advocacy-and-referral'].includes(id))&&!this.campaignCreatorsReady)throw new SeoBlogError(409,'Campaign creators are not enabled yet.');
    const available=libraryPins(PRIVATE_RELEASE_VERSION);
    if(new Set(requested).size!==requested.length||requested.some(id=>!available.some(p=>p.packId===id)))throw new SeoBlogError(400,'Choose only the available reviewed packs.');
    const selected=new Set(requested);if(selected.size)selected.add('production-core');
    const snapshot=await this.deps.methods.store.snapshot(brandId);
    const pins=available.filter(p=>selected.has(p.packId));
    resolveMethods({...snapshot,assignment:{revision:expectedRevision+1,scope:'private-owned-brands',pins}},['planning','blog','copy','social','visual-brief','email','advocacy']);
    return this.deps.methods.store.assign(brandId,expectedRevision,pins);
  }

  async regenerateSection(actor: Actor, brandId: string, articleId: string, expectedVersionId: string, sectionId: string, instruction: string): Promise<ArticleVersion> {
    const brand = await this.brandFor(actor, brandId);
    const { article, version, profile, brief } = await this.editable(brandId, articleId, expectedVersionId);
    const index = version.body.sections.findIndex((s) => s.id === sectionId);
    if (index < 0) throw new SeoBlogError(404, 'That section was not found.');
    await this.requireBudget(brand, 'model_tokens', USAGE_ESTIMATES.section);
    const sources = await this.sourcesForBrief(brandId, brief);
    const result = await rewriteSection(await this.methodLlm(brand,profile,'revision','article:'+articleId,sources,version.generation?.methodReceiptId??null), {
      profile, outline: version.body.sections.map((s) => s.heading), section: version.body.sections[index]!,
      instruction: cleanText(instruction), sources, linkable: await this.linkable(brandId),
    });
    await this.recordGeneration(brandId, result.record, `section:${articleId}`);
    // Only the target section changes; every other section is carried over byte-for-byte.
    const sections = version.body.sections.map((s, i) => (i === index ? { id: s.id, heading: result.value.heading, body: resolveMarkers(result.value.body, result.short) } : s));
    const known = new Set(version.body.citations.map((c) => c.sourceId));
    const citations = [...version.body.citations, ...sources.filter((s) => !known.has(s.id)).map((s) => ({ sourceId: s.id, url: s.url, title: s.title, retrievedAt: s.retrievedAt, publishedAt:s.publishedAt,observedPeriod:s.observedPeriod,confidence:s.confidence,passage: s.passage, public: sections[index]!.body.includes(`[src:${s.id}]`) }))]
      .map((c) => (sections[index]!.body.includes(`[src:${c.sourceId}]`) ? { ...c, public: true } : c));
    const next = await this.appendVersion(brand, article, { ...version.body, sections, citations }, 'section_regenerated', sectionId, actor.userId, result.record, profile, brief);
    await this.log(brandId, actor.userId, 'article.section', `Section “${sections[index]!.heading}” regenerated (version ${next.number}).`, articleId);
    return next;
  }

  // ─── Approval, holds, schedule ───────────────────────────────────────────

  async reviewArticleWebsiteTarget(actor:Actor,brandId:string,articleId:string,input:{expectedVersionId:string;destinationId:string;categoryIds:readonly string[]}):Promise<ArticleVersion> {
    await this.brandFor(actor,brandId);
    const destination=await this.store.getDestination(brandId,input.destinationId);
    if(!destination)throw new SeoBlogError(404,'Website not found.');
    await this.checkDestinationInternal(destination);
    const result=await this.store.reviewWebsiteTarget({brandId,articleId,actorId:actor.userId,destinationId:input.destinationId,expectedVersionId:input.expectedVersionId,decide:(s)=>{
      const target=reviewedWebsiteTarget(s,input.categoryIds);
      if(s.version.websiteTarget?.deliverySha===target.deliverySha)return {article:s.article,version:s.version};
      const id=randomUUID();const version:ArticleVersion={...s.version,id,number:s.version.number+1,parentVersionId:s.version.id,createdAt:this.now(),createdBy:actor.userId,change:'metadata_changed',generation:null,websiteTarget:target,
        ...(s.version.promotionPack?{promotionPack:{...s.version.promotionPack,versionId:id,canonicalUrl:target.target.canonicalUrl}}:{})};
      return {version,article:{...s.article,currentVersionId:id,approval:null,checks:s.article.checks?{...s.article.checks,versionId:id}:null}};
    }});
    await this.log(brandId,actor.userId,'article.target_reviewed',`Website target saved in version ${result.number}; exact-version publication approval remains separate.`,articleId);
    return result;
  }

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
    let result: Awaited<ReturnType<WebsitePublisher['checkConnection']>>;
    try {
      result = await publisher.checkConnection(destination, this.credentialFor(destination));
    } catch (error) {
      result = { ok: false, detail: (error as Error).message };
    }
    const next: Destination = { ...destination, websiteCapability:result.ok?result.websiteCapability:destination.websiteCapability, status: result.ok ? 'connected' : 'failed', statusDetail: result.detail.slice(0, 300), checkedAt: this.now() };
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
    const canonical = version.websiteTarget?.target.canonicalUrl ?? article.publishedUrl ?? (destination ? publisherFor(this.deps.publishers, destination.type).publicUrlFor(destination, version.body.slug) : `${base}/blog/${version.body.slug}/`);
    return renderArticlePage(version.body, {
      siteName: version.websiteTarget?.brandName??brand.name, canonicalUrl: canonical, blogIndexUrl: version.websiteTarget?.target.indexUrl ?? (destination ? publisherFor(this.deps.publishers, destination.type).indexUrlFor(destination) : `${base}/blog/`),
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
    const connection=article.schedule?await this.store.getDestination(brandId,article.schedule.destinationId):null;
    if((connection?.type==='content_api'||connection?.type==='wordpress')&&Date.parse(article.schedule!.publishAtUtc)<=Date.parse(this.now()))await this.checkDestinationInternal(connection);
    const facts = await this.currentFactsKey(brandId);
    if (version && !checksAreCurrent(article.checks, version, facts.key) && Date.parse(article.schedule?.publishAtUtc ?? '') <= Date.parse(this.now())) {
      await this.store.updateArticle({ ...article, checks: await this.checkVersion(brand, version) });
    }
    // The publication-begin boundary: policy is evaluated on locked, current state and the
    // operation + article claim (or hold) are committed atomically. No provider call inside.
    const now = this.now();
    let attempted: Article | null = null;
    const knownOperations = new Set((await this.store.listPublications(brandId, articleId)).map(p => p.id));
    let begun: import('./store.js').BeginResult;
    try { begun = await this.store.beginPublication({
      brandId, articleId, resumePublicationId: null,
      decide: (s) => {
        const f = this.factsKeyFrom(s.profile, s.knowledge);
        const decision = evaluatePublication({ brand: s.brand, article: s.article, version: s.version, checks: s.article.checks, currentFactsSha: f.key, destination: s.destination, now });
        if (decision.decision === 'not_due' || decision.decision === 'skip') return { kind: 'skip', why: decision.decision === 'skip' ? decision.why : 'Not due.' };
        if (decision.decision === 'hold') return { kind: 'hold', article: { ...s.article, hold: { ...decision.hold, at: now } } };
        const issue=this.websitePublicationIssue(s.destination!,s.version!,s.brand.settings,s.article);
        if(issue)return {kind:'hold',article:{...s.article,hold:{reason:'destination',detail:issue,at:now}}};
        const publisher = publisherFor(this.deps.publishers, s.destination!.type);
        if(s.article.publishedUrl&&s.article.publishedUrl!==(s.version!.websiteTarget?.target.canonicalUrl??publisher.publicUrlFor(s.destination!,s.version!.body.slug)))return {kind:'hold',article:{...s.article,hold:{reason:'destination',detail:'This article must keep its original published URL. Reconnect or review its original website target.',at:now}}};
        const target=s.version!.websiteTarget??null;
        const snapshot={destination:s.destination!,brandName:target?.brandName??brand.name,locale:target?.locale??brand.locale,publishedAt:now,target,reviewedIntentSha:target?.deliverySha??s.version!.contentSha};
        const publication: Publication = {
          websiteSnapshot:{...snapshot,requestSha:websiteSha({body:s.version!.body,...snapshot})},
          id: randomUUID(), brandId, articleId, versionId: s.version!.id, contentSha: s.version!.contentSha, versionNumber: s.version!.number,
          destinationId: s.destination!.id,
          // One operation per exact version, destination and owner-set schedule: duplicate workers share it.
          idempotencyKey: `${brandId}:${articleId}:${s.version!.id}:${s.destination!.id}:${s.article.schedule!.setAt}`, scheduledFor: s.article.schedule!.publishAtUtc,
          policy: decision.policy, state: 'prepared', attempts: 0, firstAttemptAt: null, lastAttemptAt: null, providerRef: null,
          publicUrl: target?.target.canonicalUrl??s.article.publishedUrl??publisher.publicUrlFor(s.destination!, s.version!.body.slug), verifiedAt: null, verifyAttempts: 0,
          detail: 'Authorised and recorded before sending.', events: [{ at: now, state: 'prepared', detail: `Authorised by policy rule "${decision.policy.rule}".` }], rowVersion: 1,
        };
        attempted = structuredClone(s.article);
        return { kind: 'begin', publication, article: { ...s.article,deliveryPublicationId:publication.id, delivery: 'publishing', lastAttemptAt: now, failure: null } };
      },
    }); } catch (error) {
      if (!(error instanceof SeoBlogError) || error.code !== 'media_effect_held') throw error;
      await this.projectMediaEffectHold(brandId, articleId, attempted, knownOperations, error.message);
      return 'held';
    }
    if (begun.kind === 'skip') return 'skipped';
    if (begun.kind === 'hold') {
      await this.log(brandId, 'system', 'publish.held', `Not published: ${begun.article!.hold!.detail}`, articleId);
      return 'held';
    }
    await this.attempt(brand, begun.publication, begun.destination, begun.version);
    return 'published';
  }

  private async projectMediaEffectHold(brandId: string, articleId: string, attempted: Article | null, knownOperations: ReadonlySet<string>, detail: string): Promise<void> {
    const current = await this.store.getArticle(brandId, articleId), operations = await this.store.listPublications(brandId, articleId);
    if (attempted && current && current.rowVersion === attempted.rowVersion && !current.hold
      && current.currentVersionId === attempted.currentVersionId && current.delivery === attempted.delivery
      && current.deliveryPublicationId === attempted.deliveryPublicationId
      && current.schedule?.setAt === attempted.schedule?.setAt && current.schedule?.destinationId === attempted.schedule?.destinationId
      && current.schedule?.publishAtUtc === attempted.schedule?.publishAtUtc
      && !operations.some(p => !knownOperations.has(p.id) || ['prepared','submitted','outcome_unknown','verifying'].includes(p.state))) {
      try { await this.store.updateArticle({ ...current, hold: { reason: 'owner', at: this.now(), detail } }); }
      catch (error) { if (!(error instanceof StaleWriteError)) throw error; }
    }
    await this.log(brandId, 'system', 'publish.held', `${detail} This attempt did not begin a new website send.`, articleId);
  }

  /** Append to the operation's own history; identity and earlier events are never rewritten. */
  private pub(p: Publication, patch: Partial<Publication>): Publication {
    const next = { ...p, ...patch };
    const events = [...(p.events ?? []), { at: this.now(), state: next.state, detail: next.detail }].slice(-60);
    return { ...next, events };
  }

  private publishInput(brand: Brand, publication: Publication, destination: Destination, version: ArticleVersion): PublishInput {
    const snapshot=publication.websiteSnapshot;const pinned=snapshot?.destination??destination;
    return {
      ...(snapshot?.target?{websiteTarget:snapshot.target}:{}),
      operationId: publication.id, destination:pinned, credential: this.credentialFor(pinned), brandName: snapshot?.brandName??brand.name, locale: snapshot?.locale??brand.locale,
      articleId: publication.articleId, versionId: publication.versionId, contentSha: publication.contentSha,
      versionNumber: publication.versionNumber ?? version.number, body: version.body,
      publishedAt: snapshot?.publishedAt??publication.firstAttemptAt ?? this.now(),
    };
  }

  private websitePublicationIssue(destination:Destination,version:ArticleVersion,settings:Brand['settings'],article:Article):string|null {
    if(version.websiteTarget)return targetEligibility(destination,version.websiteTarget);
    if(article.publishedUrl===publisherFor(this.deps.publishers,destination.type).publicUrlFor(destination,version.body.slug))return null;
    if(destination.websiteCapability?.protocol==='v2'&&settings.programme?.structure?.destinationId===destination.id&&settings.programme.structure.website)return 'Review and save the installed website root and categories for this exact article version before publishing.';
    return null;
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
        await this.setArticleDelivery(brand.id, p.articleId, 'unknown', null,{},p);
        return p;
      }
      const message = error instanceof PublisherRejectedError || error instanceof SeoBlogError ? error.message : 'The website could not be updated.';
      p = await this.store.updatePublication(this.pub(p, { state: 'failed', detail: message }));
      await this.setArticleDelivery(brand.id, p.articleId, 'failed', message,{},p);
      await this.log(brand.id, 'system', 'publish.failed', message, p.articleId);
      return p;
    }
  }

  private async setArticleDelivery(brandId: string, articleId: string, delivery: Article['delivery'], failure: string | null, extra: Partial<Article> = {},operation?:Publication): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const a = await this.store.getArticle(brandId, articleId);
      if (!a) return;
      if(operation){
        if(a.deliveryPublicationId&&a.deliveryPublicationId!==operation.id)return;
        if(!a.deliveryPublicationId){
          const other=(await this.store.listPublications(brandId,articleId)).some((p)=>p.id!==operation.id&&['prepared','submitted','outcome_unknown','verifying'].includes(p.state));
          if(other||a.lastAttemptAt!==operation.lastAttemptAt)return;
        }
      }
      try {
        const hold = a.hold?.reason==='owner'?a.hold:delivery === 'unknown' ? { reason: 'outcome_unknown' as const, detail: 'The website’s response was lost; reconciling before anything else happens.', at: this.now() }
          : delivery === 'failed' ? { reason: 'destination' as const, detail: failure ?? 'Publishing failed.', at: this.now() } : a.hold;
        await this.store.updateArticle({ ...a, delivery, failure, hold: delivery === 'published' && hold?.reason==='outcome_unknown' ? null : hold, ...extra,...(operation?{deliveryPublicationId:operation.id}:{}) });
        return;
      } catch (error) {
        if (!(error instanceof StaleWriteError)) throw error;
      }
    }
  }

  private async verify(brand: Brand, publication: Publication, version: ArticleVersion): Promise<Publication> {
    const marker = versionMarker(publication.articleId, publication.versionId, publication.contentSha);
    const destination=publication.websiteSnapshot?.destination??await this.store.getDestination(brand.id,publication.destinationId);
    if(!destination)return publication;
    const target=publication.websiteSnapshot?.target;
    const declaredUrls=destination.websiteCapability?.protocol==='v2'&&destination.websiteCapability.capabilities.urlContract===WORDPRESS_URL_CONTRACT;
    const evidence=await observeWebsiteDelivery(this.deps.transport,{...(declaredUrls?{pagination:'wordpress' as const,seoHead:true}:{}),url:publication.publicUrl,marker,indexUrl:target?.target.indexUrl??publisherFor(this.deps.publishers,destination.type).indexUrlFor(destination),categoryUrls:target?.categoryUrls??[],sitemapUrls:target?.sitemapUrls??[`${new URL(publication.publicUrl).origin}/sitemap.xml`],at:this.now()});
    const observed=(publication.websiteObserveAttempts??0)+1;
    const complete=evidence.article.state==='verified'&&evidence.index.state==='verified'&&evidence.categories.every((c)=>c.state==='verified')&&evidence.sitemap.state==='verified';
    const observation={websiteDelivery:evidence,websiteObserveRunId:publication.websiteObserveRunId??randomUUID(),websiteObserveAttempts:observed,websiteObserveAfter:complete||observed>=12?null:new Date(Date.parse(this.now())+(observed<=2?30000:300000)).toISOString()};
    if (evidence.article.state === 'verified') {
      const p = await this.store.updatePublication(this.pub(publication, { ...observation,state: 'published', verifiedAt: this.now(), verifyAttempts: publication.verifyAttempts + 1, detail: complete?'Article, index, categories and served sitemap verified.':'Article and canonical verified live; some index, category or sitemap checks are still pending.' }));
      const current=await this.store.getArticle(brand.id,publication.articleId);
      await this.setArticleDelivery(brand.id, publication.articleId, 'published', null, { publishedVersionId: publication.versionId, publishedUrl: current?.publishedUrl??publication.publicUrl, publishedAt: current?.publishedAt??this.now() },p);
      if(observation.websiteObserveAfter)await this.enqueueObservation(p);
      await this.log(brand.id, 'system', 'publish.verified', `Published and verified at ${publication.publicUrl} (version ${version.number}).`, publication.articleId);
      return p;
    }
    if(publication.state==='published'){
      const current=await this.store.getArticle(brand.id,publication.articleId);
      if(current?.currentVersionId===publication.versionId&&current.publishedVersionId===publication.versionId)await this.setArticleDelivery(brand.id,publication.articleId,'unknown','The latest public article/canonical observation needs attention.',{},publication);
      const next=await this.store.updatePublication(this.pub(publication,{...observation,detail:'Previously verified article: the latest public observation needs attention. No content was re-published.'}));
      if(next.websiteObserveAfter)await this.enqueueObservation(next);return next;
    }
    const attempts = publication.verifyAttempts + 1;
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      const p = await this.store.updatePublication(this.pub(publication, { ...observation,state: 'outcome_unknown', verifyAttempts: attempts, detail: 'The website accepted the change but the exact public article and canonical have not been verified. Check the site’s deployment.' }));
      await this.setArticleDelivery(brand.id, publication.articleId, 'unknown', null,{},p);
      return p;
    }
    return this.store.updatePublication(this.pub(publication, { ...observation,verifyAttempts: attempts, detail: evidence.article.detail }));
  }

  private async enqueueObservation(publication:Publication):Promise<void> {
    const job=websiteWakeJob(publication);if(job)await this.store.enqueueJob(job);
  }

  async reobservePublication(actor:Actor,brandId:string,articleId:string,publicationId:string):Promise<void> {
    const brand=await this.brandFor(actor,brandId);const publication=(await this.store.listPublications(brandId,articleId)).find((p)=>p.id===publicationId);const version=publication?await this.store.getVersion(brandId,publication.versionId):null;
    if(!publication||!version||publication.state!=='published')throw new SeoBlogError(409,'Choose a verified article publication to recheck.');
    await this.verify(brand,{...publication,websiteObserveAttempts:0,websiteObserveRunId:randomUUID()},version);
  }

  async requestSitemapRepair(actor:Actor,brandId:string,articleId:string,input:{publicationId:string;commandId:string;acknowledgeUnknown?:boolean}):Promise<void> {
    const brand=await this.brandFor(actor,brandId);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.commandId))throw new SeoBlogError(400,'Refresh this page before requesting a repair.');
    const publication=(await this.store.listPublications(brandId,articleId)).find((p)=>p.id===input.publicationId);
    if(!publication?.websiteSnapshot||publication.state!=='published')throw new SeoBlogError(409,'This publication has no pinned repairable website snapshot.');
    if(publication.sitemapRepair?.id===input.commandId)return;
    const destination=publication.websiteSnapshot.destination;const publisher=publisherFor(this.deps.publishers,destination.type);
    if(destination.websiteCapability?.protocol!=='v2'||!destination.websiteCapability.capabilities.repair.sitemap||!publisher.repairSitemap||!publisher.inspectSitemapRepair)throw new SeoBlogError(409,'This website does not support sitemap-only repair. Recheck delivery or repair its website integration; the article will not be republished.');
    if(publication.sitemapRepair&&['queued','calling'].includes(publication.sitemapRepair.state))throw new SeoBlogError(409,'This sitemap repair is already queued or being reconciled.');
    if(publication.sitemapRepair?.uncertain&&publication.sitemapRepair.state!=='done'&&!input.acknowledgeUnknown)throw new SeoBlogError(409,'The earlier sitemap repair may already have committed. Recheck first, or explicitly acknowledge a new owner repair intent.');
    const version=(await this.store.getVersion(brandId,publication.versionId))!;const inspected=await publisher.inspectSitemapRepair(this.publishInput(brand,publication,destination,version));
    const result=await this.store.beginPublication({brandId,articleId,resumePublicationId:publication.id,decide:(s)=>{
      const p=s.publication!;
      if(p.rowVersion!==publication.rowVersion)throw new StaleWriteError('publication');
      if(s.brand.settings.pauseAll||s.article.currentVersionId!==p.versionId||s.article.publishedVersionId!==p.versionId||s.article.publishedUrl!==p.publicUrl||s.destination?.status!=='connected'||destinationIdentity(s.destination)!==destinationIdentity(destination))throw new SeoBlogError(409,'The current article, connection or pause control changed. Recheck before requesting a repair.');
      const repair={id:input.commandId,publicationId:p.id,versionId:p.versionId,targetSha:p.websiteSnapshot!.requestSha,sitemapSourceSha:inspected.sourceSha,requestedBy:actor.userId,requestedAt:this.now(),state:inspected.complete?'done' as const:'queued' as const,startedAt:null,providerRef:inspected.complete?inspected.providerRef:null,uncertain:false,reconcileAttempts:0,reconcileAfter:null,detail:inspected.complete?'The repository sitemap already contains this exact entry; waiting for public delivery.':'Owner-authorised sitemap-only repair queued.'};
      return {kind:'hold',article:s.article,publication:{...p,sitemapRepair:repair,sitemapRepairHistory:[...(p.sitemapRepairHistory??[]),...(p.sitemapRepair?[p.sitemapRepair]:[])],websiteObserveAfter:this.now(),websiteObserveRunId:randomUUID(),websiteObserveAttempts:0}};
    }});
    if(result.kind==='hold'&&result.publication){await this.enqueue(brandId,'publish',`sitemap-repair:${input.commandId}`,{sitemapRepair:publication.id});}
  }

  private async processSitemapRepair(brand:Brand,p:Publication):Promise<void> {
    const repair=p.sitemapRepair;if(!repair||!['queued','calling','unknown'].includes(repair.state)||!p.websiteSnapshot)return;
    if(repair.state==='calling'&&repair.startedAt&&Date.parse(this.now())-Date.parse(repair.startedAt)<PREPARED_STALE_MS)return;
    if(repair.state!=='queued'&&repair.reconcileAfter&&repair.reconcileAfter>this.now())return;
    const version=await this.store.getVersion(brand.id,p.versionId);if(!version)return;
    const publisher=publisherFor(this.deps.publishers,p.websiteSnapshot.destination.type);if(!publisher.inspectSitemapRepair||!publisher.repairSitemap)return;
    const input={...this.publishInput(brand,p,p.websiteSnapshot.destination,version),operationId:repair.id,sitemapSourceSha:repair.sitemapSourceSha};
    if(repair.state!=='queued'){
      try{const result=await publisher.inspectSitemapRepair(input);await this.finishSitemapRepair(p,repair.id,result.complete?'done':'held',result.complete?'Sitemap-only repair found in the repository; public delivery will be checked.':'No complete repair receipt was found. No second commit was attempted; review before a new owner intent.',result.providerRef,true);}
      catch(error){await this.finishSitemapRepair(p,repair.id,error instanceof PublisherRejectedError?'held':'unknown',error instanceof PublisherRejectedError?error.message:'The repair outcome remains uncertain. Only read-only reconciliation will run.',null,true);}return;
    }
    let claimed=false;
    const begun=await this.store.beginPublication({brandId:brand.id,articleId:p.articleId,resumePublicationId:p.id,decide:(s)=>{
      const current=s.publication!;const r=current.sitemapRepair;
      if(current.rowVersion!==p.rowVersion||r?.id!==repair.id||r.state!=='queued')return {kind:'skip',why:'Another worker handles this repair.'};
      const permitted=s.repairRequesterAllowed===true&&!s.brand.settings.pauseAll&&current.state==='published'&&s.article.currentVersionId===current.versionId&&s.article.publishedVersionId===current.versionId&&s.article.publishedUrl===current.publicUrl&&s.destination?.status==='connected'&&destinationIdentity(s.destination)===destinationIdentity(current.websiteSnapshot!.destination)&&r.targetSha===current.websiteSnapshot!.requestSha&&r.versionId===current.versionId&&r.publicationId===current.id;
      claimed=permitted;
      return {kind:'hold',article:s.article,publication:{...current,sitemapRepair:{...r,state:permitted?'calling':'held',startedAt:permitted?this.now():null,reconcileAfter:permitted?new Date(Date.parse(this.now())+PREPARED_STALE_MS).toISOString():null,detail:permitted?'Authorised sitemap-only commit started.':'Repair held because current owner, article, website or pause controls changed.'}}};
    }});
    if(!claimed||begun.kind!=='hold'||!begun.publication)return;
    try{const outcome=await publisher.repairSitemap(input);await this.finishSitemapRepair(begun.publication,repair.id,'done','Sitemap-only commit accepted. Article and index bytes were not changed.',outcome.providerRef);}
    catch(error){await this.finishSitemapRepair(begun.publication,repair.id,error instanceof PublisherRejectedError?'held':'unknown',error instanceof PublisherRejectedError?error.message:'The sitemap commit acknowledgement is uncertain; only observation will follow.',null);}
  }

  private async finishSitemapRepair(publication:Publication,id:string,state:'done'|'held'|'unknown',detail:string,providerRef:string|null,reconciled=false):Promise<void> {
    for(let n=0;n<3;n++){
      const p=(await this.store.listPublications(publication.brandId,publication.articleId)).find((v)=>v.id===publication.id);
      if(!p?.sitemapRepair||p.sitemapRepair.id!==id)return;
      if(p.sitemapRepair.state==='done'&&state!=='done')return;
      const count=p.sitemapRepair.reconcileAttempts+(reconciled?1:0);const exhausted=state==='unknown'&&count>=6;
      try{const next=await this.store.updatePublication({...p,sitemapRepair:{...p.sitemapRepair,state:exhausted?'held':state,detail:exhausted?'Read-only repair checks reached their limit. The outcome remains uncertain; review before a new owner intent.':detail,providerRef,uncertain:p.sitemapRepair.uncertain||state==='unknown'||reconciled&&state==='held',reconcileAttempts:count,reconcileAfter:state==='unknown'&&!exhausted?new Date(Date.parse(this.now())+(count<2?30000:300000)).toISOString():null},websiteObserveAfter:this.now(),websiteObserveRunId:randomUUID(),websiteObserveAttempts:0});await this.enqueueObservation(next);return;}
      catch(error){if(n===2||error instanceof SeoBlogError&&!(error instanceof StaleWriteError))throw error;}
    }
  }

  /**
   * Resend a confirmed-absent operation only if it is still authorised now. The same operation
   * id and history are kept. Superseded operations (new version, rescheduled, other destination)
   * are cancelled without touching the site; unauthorised ones (paused, approval missing,
   * failing checks, disconnected destination) are cancelled and the article is held.
   */
  private async resumeAbsent(brand: Brand, publication: Publication): Promise<void> {
    const currentDestination=await this.store.getDestination(brand.id,publication.destinationId);
    if(currentDestination?.type==='content_api'||currentDestination?.type==='wordpress')await this.checkDestinationInternal(currentDestination);
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
        const targetIssue=this.websitePublicationIssue(s.destination!,s.version!,s.brand.settings,s.article);
        const prior=p.websiteSnapshot?.destination;
        const changed=prior&&destinationIdentity(prior)!==destinationIdentity(s.destination!);
        if(targetIssue||changed)return cancel(`Not re-sent: ${targetIssue??'The authorised website connection changed. Review and choose a new publication time.'}`,{reason:'destination',detail:targetIssue??'Website connection changed; review before sending.',at:now});
        return {
          kind: 'begin',
          publication: this.pub(p, { state: 'prepared', policy: decision.policy, detail: 'Confirmed absent; re-authorised on current state and re-sending the same operation.' }),
          article: { ...article,deliveryPublicationId:p.id, delivery: 'publishing', hold: null, lastAttemptAt: now, failure: null },
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
      if(publication.sitemapRepair&&['queued','calling','unknown'].includes(publication.sitemapRepair.state)){await this.processSitemapRepair(brand,publication);continue;}
      if(publication.state==='published'&&publication.websiteObserveAfter&&publication.websiteObserveAfter<=this.now()) {
        const version=await this.store.getVersion(brandId,publication.versionId);if(version){try{await this.verify(brand,publication,version);touched++;}catch(error){if(!(error instanceof StaleWriteError))throw error;}}continue;
      }
      const stalePrepared = publication.state === 'prepared' && Date.parse(this.now()) - Date.parse(publication.lastAttemptAt ?? publication.scheduledFor) > PREPARED_STALE_MS;
      const staleSubmitted = publication.state === 'submitted' && Date.parse(this.now()) - Date.parse(publication.lastAttemptAt ?? publication.scheduledFor) > PREPARED_STALE_MS;
      if (!['outcome_unknown', 'verifying'].includes(publication.state) && !stalePrepared && !staleSubmitted) continue;
      const version = await this.store.getVersion(brandId, publication.versionId);
      const destination = publication.websiteSnapshot?.destination??await this.store.getDestination(brandId, publication.destinationId);
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
          await this.setArticleDelivery(brandId, publication.articleId, 'publishing', null,{},p);
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
          await this.setArticleDelivery(brandId, publication.articleId, 'failed', detail,{},publication);
        }
      } catch (error) {
        if (error instanceof PublisherOutcomeUnknownError) return; // still unknown; try again next tick
        if (error instanceof StaleWriteError) throw error; // concurrent progress, not a failure
        await this.store.updatePublication(this.pub(publication, { state: 'failed', detail: (error as Error).message.slice(0, 300) }));
        await this.setArticleDelivery(brandId, publication.articleId, 'failed', (error as Error).message.slice(0, 300),{},publication);
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
    return (await this.store.listJobs(brandId)).map(imageJobDto);
  }
  async imageJobStatus(actor: Actor, brandId: string, articleId: string, jobId: string): Promise<{ id: string; state: Job['state']; detail: string; prepared: boolean }> {
    await this.brandFor(actor, brandId);
    const job = await this.store.getJob(brandId, jobId);
    const dto = job ? imageJobDto(job) : null, image = dto?.payload.image as Record<string, unknown> | undefined;
    if (!job || !isImageJob(job) || image?.articleId !== articleId) throw new SeoBlogError(404, 'That image task was not found.');
    const result = image.result as Record<string, unknown>;
    return { id: job.id, state: job.state, detail: (job.error ?? job.progress).slice(0, 600), prepared: job.state === 'done' && result.state === 'prepared' };
  }

  async cancelJob(actor: Actor, brandId: string, jobId: string): Promise<Job> {
    await this.brandFor(actor, brandId);
    const job = await this.store.getJob(brandId, jobId);
    if (!job) throw new SeoBlogError(404, 'That task was not found.');
    if (['done', 'failed', 'cancelled'].includes(job.state)) return job;
    if(job.kind==='publish'&&typeof job.payload.websiteObservation==='string'){
      const p=(await this.store.listPublications(brandId)).find((p)=>p.id===job.payload.websiteObservation);
      if(p?.sitemapRepair&&['calling','unknown'].includes(p.sitemapRepair.state))throw new SeoBlogError(409,'This task tracks an uncertain website operation. Read-only reconciliation must continue; it cannot send another write.');
    }
    if(job.kind==='publish'&&typeof job.payload.sitemapRepair==='string'){
      const p=(await this.store.listPublications(brandId)).find((p)=>p.id===job.payload.sitemapRepair);
      if(p?.sitemapRepair&&job.idempotencyKey===`sitemap-repair:${p.sitemapRepair.id}`)await this.store.beginPublication({brandId,articleId:p.articleId,resumePublicationId:p.id,decide:(s)=>{
        const current=s.publication!;const repair=current.sitemapRepair;if(!repair||repair.id!==p.sitemapRepair!.id)return {kind:'skip',why:'Repair intent changed.'};
        if(repair.state==='queued')return {kind:'hold',article:s.article,publication:{...current,sitemapRepair:{...repair,state:'held',detail:'Owner cancelled this repair before it began.'}}};
        return {kind:'hold',article:s.article,publication:current};
      }});
    }
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
    // Short-lived just-in-time attestation of due social slots from the exact current source.
    for (const brandId of (await this.store.socialAttestationBrandIds()).slice(0, 50)) {
      try {
        for (const outcome of await this.store.attestDuePromotions(brandId)) {
          await this.log(brandId, 'system', `social.attest.${outcome.state}`, outcome.detail);
        }
      } catch (error) {
        await this.log(brandId, 'system', 'social.attest.failed', `Attestation pass failed: ${(error as Error).message.slice(0, 160)}`).catch(() => undefined);
      }
    }
    if(this.deps.campaignQueue){
      try{await this.deps.campaignQueue.recover();}
      catch(error){throw new SeoBlogError(503,error instanceof SeoBlogError&&error.code==='campaign_recovery_authority'?'Campaign recovery needs database-authority attention. Existing social proof checks ran independently.':'Campaign recovery is unavailable. Saved instructions are retained; existing social proof checks ran independently.','campaign_recovery_failed');}
    }
    return { jobs: jobs.length, brands: brands.length };
  }

  async runJob(job: Job): Promise<Job> {
    if (job.kind === 'publish' && job.payload.campaignQueue !== undefined) {
      if (!this.deps.campaignQueue) {
        const fresh = await this.store.getJob(job.brandId, job.id);
        if (!fresh || fresh.state !== 'running' || fresh.leaseOwner !== job.leaseOwner || fresh.attempts !== job.attempts) return fresh ?? job;
        return this.store.updateJob({ ...fresh, state: 'blocked', leaseOwner: null, leaseExpiresAt: null, progress: 'Campaign delivery is unavailable on this worker.', error: 'A capable campaign worker is required. No article or social post was published.', updatedAt: this.now() });
      }
      return this.deps.campaignQueue.run(job);
    }
    if (isImageJob(job)) {
      if (this.deps.images) return this.deps.images.run(job);
      const fresh = await this.store.getJob(job.brandId, job.id);
      if (!fresh || fresh.state !== 'running' || fresh.leaseOwner !== job.leaseOwner || fresh.attempts !== job.attempts) return fresh ?? job;
      return this.store.updateJob({ ...fresh, state: 'blocked', leaseOwner: null, leaseExpiresAt: null, progress: 'Image preparation is unavailable on this worker.', error: 'The capable image worker and media storage must be configured before this task can run.', updatedAt: this.now() });
    }
    if (isProfileJob(job)) return this.runProfileJob(job);
    if(job.kind==='plan') return this.runProgrammePlanJob(job);
    let current = job;
    try {
      const fresh = await this.store.getJob(job.brandId, job.id);
      if (!fresh || fresh.state === 'cancelled' || fresh.leaseOwner !== job.leaseOwner || (isArticleWriteJob(job)&&fresh.attempts!==job.attempts)) return fresh ?? job;
      current = await this.store.updateJob({ ...fresh, progress: progressLabel(job.kind), updatedAt: this.now() });
      const p = job.payload as Record<string, unknown>;
      if (p.stage !== undefined) throw new SeoBlogError(409, 'This worker does not support that task stage.');
      if (job.kind === 'inventory') await this.refreshInventory(job.brandId);
      else if (job.kind === 'write') await this.runWrite(job.brandId, { briefId: String(p.briefId), fromVersionId: p.fromVersionId as string | undefined, requestedBy: p.requestedBy as string | undefined },current);
      else if (job.kind === 'publish') {
        if(p.websiteObservation!==undefined||p.sitemapRepair!==undefined){
          if((p.websiteObservation!==undefined&&p.sitemapRepair!==undefined)||typeof(p.websiteObservation??p.sitemapRepair)!=='string')throw new SeoBlogError(409,'Unsupported website delivery task.');
          const publication=(await this.store.listPublications(job.brandId)).find((p)=>p.id===(job.payload.websiteObservation??job.payload.sitemapRepair));
          const brand=await this.store.getBrand(job.brandId);
          if(publication&&brand){
            if(typeof p.sitemapRepair==='string'&&job.idempotencyKey===`sitemap-repair:${publication.sitemapRepair?.id}`)await this.processSitemapRepair(brand,publication);
            else if(typeof p.websiteObservation==='string'){
              if(publication.sitemapRepair&&['calling','unknown'].includes(publication.sitemapRepair.state))await this.processSitemapRepair(brand,publication);
              const fresh=(await this.store.listPublications(job.brandId)).find((v)=>v.id===publication.id);const version=await this.store.getVersion(job.brandId,publication.versionId);
              if(fresh?.state==='published'&&version&&fresh.websiteObserveAfter&&fresh.websiteObserveAfter<=this.now())await this.verify(brand,fresh,version);
            }
          }
        }else await this.dispatchDue(job.brandId);
      }
      else if (job.kind === 'daily') await this.runDaily(job.brandId);
      const latest = (await this.store.getJob(job.brandId, job.id))!;
      if (latest.state === 'cancelled') return latest;
      if(isArticleWriteJob(job)&&(latest.leaseOwner!==job.leaseOwner||latest.attempts!==job.attempts))return latest;
      return await this.store.updateJob({ ...latest, state: 'done', leaseOwner: null, leaseExpiresAt: null, progress: 'Done.', error: null, updatedAt: this.now() });
    } catch (error) {
      const latest = (await this.store.getJob(job.brandId, job.id)) ?? current;
      if (latest.state === 'cancelled') return latest;
      if(isArticleWriteJob(job)&&(latest.leaseOwner!==job.leaseOwner||latest.attempts!==job.attempts))return latest;
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
    const brand=await this.brandFor(actor, brandId);
    const job = await this.store.getJob(brandId, jobId);
    if (!job) throw new SeoBlogError(404, 'That task was not found.');
    if (!['blocked', 'failed'].includes(job.state)) return job;
    if (isImageJob(job)) throw new SeoBlogError(409, 'Image tasks cannot repeat a paid call through Retry. Use Retry preparation for a saved candidate, or explicitly request a new generation intent.');
    let retainsCopyEpoch=false;
    if(isArticleWriteJob(job)) {
      const article=(await this.store.listArticles(brandId)).find(a=>a.briefId===job.payload.briefId);
      retainsCopyEpoch=!!article?.campaignGeneration;
      if(article?.campaignGeneration?.startedAt&&!article.campaignGeneration.receipt)throw new SeoBlogError(409,'The social copy request has an uncertain outcome. Retry cannot repeat it. The saved article input and attempt are retained.','campaign_copy_unknown');
    }
    if(job.kind==='plan'&&!programmeRun(job)?.modelReceipt) {
      const run=programmeRun(job);const profile=await this.store.latestProfile(brandId);
      const hold=brand.settings.programme?.researchHold;
      const seeds=profile?researchQuerySeeds({focus:typeof job.payload.focus==='string'?job.payload.focus:null,audiences:profile.audiences,positioning:profile.positioning,categories:run?.snapshot.categoryLabels??[],limit:USAGE_ESTIMATES.searchPerPlan}):[];
      const complete=!!run&&!run.modelStart&&!run.attempts.some(a=>a.kind!=='metrics'&&!a.receivedAt)&&seeds.length>0&&seeds.every(query=>run.attempts.some(a=>a.receipt&&a.querySha===programmeSha({input:run.snapshot.sha,query,locale:brand.locale,limit:6,provider:this.deps.search.id,kind:'serp'})));
      if(!complete||hold&&hold.jobId!==job.id)throw new SeoBlogError(409,'Research retries retain their history and budget. Review programme status in Topics and explicitly resume with a new intent.');
      return this.store.updateJob({...job,payload:{...job.payload,resumeHoldId:run!.logicalRunId},state:'queued',runAfter:this.now(),error:null,progress:'Continuing with saved searches. No additional search calls.',updatedAt:this.now()});
    }
    if (isProfileJob(job) && profilePayload(job).start && !profilePayload(job).receipt) throw new SeoBlogError(409, 'This model call has an uncertain outcome. Retry cannot repeat it. Review the current profile and explicitly confirm a new extraction in Brand setup.');
    return this.store.updateJob({ ...job, state: 'queued', attempts: isProfileJob(job)||job.kind==='plan'||retainsCopyEpoch ? job.attempts : 0, runAfter: this.now(), error: null, progress: 'Queued again by the owner.', updatedAt: this.now() });
  }

  /** Daily bounded top-up when the brand enables ongoing production. Never replaces accepted plans. */
  async runDaily(brandId: string): Promise<void> {
    const brand = await this.store.getBrand(brandId);
    if (!brand?.settings.ongoingProduction || brand.settings.pauseAll) return;
    const day = this.now().slice(0, 10);
    if (brand.website) await this.enqueue(brandId, 'inventory', `daily-inventory:${day}`, {});
    const [articles, briefs, plans, jobs] = await Promise.all([this.store.listArticles(brandId), this.store.listBriefs(brandId), this.store.listPlans(brandId),this.store.listJobs(brandId)]);
    const legacy=legacyPlanningHold(jobs,brand.settings.programme?.researchAcknowledgements);
    if(legacy&&!brand.settings.programme?.researchHold) {
      const source=jobs.find((j)=>j.id===legacy.jobId)!;const profile=await this.store.latestProfile(brandId);
      await this.store.programmeBoundary({brandId,jobId:source.id,authority:programmeAuthorityFor(source,brand,profile),now:this.now(),decide:(s)=>{
        const current=legacyPlanningHold(s.jobs,s.brand.settings.programme?.researchAcknowledgements);
        if(!current||s.brand.settings.programme?.researchHold) return {job:s.job,writeJob:false};
        return {job:s.job,writeJob:false,settings:{...s.brand.settings,programme:{...s.brand.settings.programme,researchHold:current}},event:{brandId,at:this.now(),actor:'system',kind:'research.legacy_hold',message:'An unresolved older planning task needs owner review. No historical supplier code, cost or usage was invented.',subjectId:current.jobId}};
      }});
      await this.topUpWrites(brandId);return;
    }
    const backlog = articles.filter((a) => a.delivery !== 'published').length;
    const horizonEnd = Date.parse(this.now()) + brand.settings.planningHorizonDays * 86_400_000;
    const future = briefs.filter((b) => ['planned', 'accepted'].includes(b.status) && b.suggestedAtUtc && Date.parse(b.suggestedAtUtc) <= horizonEnd).length
      + articles.filter((a) => a.schedule && Date.parse(a.schedule.publishAtUtc) <= horizonEnd).length;
    const slotsNeeded = Math.ceil((brand.settings.planningHorizonDays / 7) * brand.settings.cadence.perWeek);
    const recentPlan = plans.find((p) => Date.parse(this.now()) - Date.parse(p.createdAt) < 7 * 86_400_000 && p.status === 'proposed');
    if (future < slotsNeeded && !recentPlan && !brand.settings.programme?.researchHold && !jobs.some((j)=>j.kind==='plan'&&['queued','running'].includes(j.state))) {
      await this.enqueue(brandId, 'plan', `daily-plan:${day}`, { focus: brand.settings.programme?.focus??null, excluded: brand.settings.programme?.exclusions??[], sourceArticleUrl: null, requestedBy: 'system' });
    }
    void backlog;
    await this.topUpWrites(brandId);
  }

  /** Draft accepted briefs up to the backlog ceiling; `write:<briefId>` keys make this idempotent. */
  private async topUpWrites(brandId: string): Promise<void> {
    const brand = await this.store.getBrand(brandId);
    if (!brand?.settings.ongoingProduction || brand.settings.pauseAll) return;
    const [articles, briefs, jobs] = await Promise.all([this.store.listArticles(brandId), this.store.listBriefs(brandId), this.store.listJobs(brandId)]);
    const pendingWrites = jobs.filter((j) => isArticleWriteJob(j) && ['queued', 'running'].includes(j.state)).length;
    const backlog = articles.filter((a) => a.delivery !== 'published').length + pendingWrites;
    const room = Math.max(0, brand.settings.backlogCeiling - backlog);
    const queued = new Set(jobs.filter(isArticleWriteJob).map((j) => String((j.payload as { briefId?: string }).briefId)));
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
  if (s.media && typeof s.media.imageGenerationEnabled !== 'boolean') throw new SeoBlogError(400, 'Invalid image generation toggle.');
  validateCadence(s.cadence);
  if (!Number.isInteger(s.planningHorizonDays) || s.planningHorizonDays < 7 || s.planningHorizonDays > 120) throw new SeoBlogError(400, 'Planning horizon must be 7–120 days.');
  if (!Number.isInteger(s.backlogCeiling) || s.backlogCeiling < 0 || s.backlogCeiling > 50) throw new SeoBlogError(400, 'Backlog ceiling must be 0–50 articles.');
  if (!['concise', 'standard', 'in-depth'].includes(s.lengthPreference)) throw new SeoBlogError(400, 'Choose a length preference.');
  for (const [k, v] of Object.entries(s.budgets)) if (!Number.isInteger(v) || v < 0 || v > 1_000_000_000) throw new SeoBlogError(400, `Budget ${k} must be a whole number of 0 or more.`);
  if (s.author && (!s.author.name.trim() || s.author.name.length > 120 || (s.author.url && !/^https:\/\//.test(s.author.url)))) throw new SeoBlogError(400, 'Author needs a name and, optionally, an https:// profile link.');
  for (const key of ['autoPublish', 'pauseAll', 'ongoingProduction', 'autoAcceptPlans'] as const) if (typeof s[key] !== 'boolean') throw new SeoBlogError(400, 'Invalid toggle value.');
}
