/**
 * SEO blog production engine — domain contracts.
 *
 * One brand is one canonical workspace. Every record below carries its
 * `brandId` (the workspace UUID) and every store/engine call is scoped to the
 * brand the server resolved for the request, never to one named by the browser.
 *
 * Editorial, approval, schedule and delivery state are deliberately separate
 * fields so an article can be approved-but-unscheduled or scheduled-but-held.
 */

export type IsoInstant = string;

export const SEO_BLOG_DEFAULT_LOCALE = 'en-GB';
export const SEO_BLOG_DEFAULT_TIMEZONE = 'Europe/London';

export type LengthPreference = 'concise' | 'standard' | 'in-depth';

export interface BrandCadence {
  /** ISO weekdays (1 = Monday … 7 = Sunday) on which a post may be placed. */
  readonly weekdays: readonly number[];
  /** Local wall-clock time, HH:MM, in the brand timezone. */
  readonly localTime: string;
  /** Maximum posts placed per ISO week. */
  readonly perWeek: number;
}

export interface BrandBudgets {
  /** Model tokens (in + out) per calendar month. 0 blocks generation. */
  readonly modelTokensPerMonth: number;
  /** Research (search) provider calls per calendar month. 0 blocks research. */
  readonly searchCallsPerMonth: number;
  /** Image generations per calendar month. 0 blocks generation of images. */
  readonly imagesPerMonth: number;
}

export interface BrandAuthor {
  readonly name: string;
  readonly url?: string;
}

export interface BrandSettings {
  /** Off by default. On = articles that do not require review may publish without a per-article approval. */
  readonly autoPublish: boolean;
  /** Distinct emergency control: holds every publication that has not started. */
  readonly pauseAll: boolean;
  /** Bounded daily inventory refresh and slot top-up. Off by default. */
  readonly ongoingProduction: boolean;
  /** Automatic production may accept eligible system plans. Off by default. */
  readonly autoAcceptPlans: boolean;
  readonly cadence: BrandCadence;
  readonly planningHorizonDays: number;
  /** Maximum unpublished generated articles before automatic drafting pauses. */
  readonly backlogCeiling: number;
  readonly lengthPreference: LengthPreference;
  readonly budgets: BrandBudgets;
  /** Legitimate author attribution supplied by the owner; null means the brand name is used. */
  readonly author: BrandAuthor | null;
}

export const DEFAULT_BRAND_SETTINGS: BrandSettings = Object.freeze({
  autoPublish: false,
  pauseAll: false,
  ongoingProduction: false,
  autoAcceptPlans: false,
  cadence: Object.freeze({ weekdays: Object.freeze([2, 4]), localTime: '09:00', perWeek: 2 }),
  planningHorizonDays: 30,
  backlogCeiling: 6,
  lengthPreference: 'standard',
  // A new brand has no spend authority until the owner configures ceilings.
  budgets: Object.freeze({ modelTokensPerMonth: 0, searchCallsPerMonth: 0, imagesPerMonth: 0 }),
  author: null,
}) as BrandSettings;

export interface Brand {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly website: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly settings: BrandSettings;
  readonly createdAt: IsoInstant;
  readonly createdBy: string;
  readonly rowVersion: number;
}

// ─── Knowledge ───────────────────────────────────────────────────────────────

export const KNOWLEDGE_CATEGORIES = [
  'brand_guidelines', 'voice_samples', 'audience_notes', 'product_facts',
  'approved_claims', 'faqs', 'visual_guidance', 'other',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** Categories whose change can alter factual correctness of an article. */
export const FACTUAL_KNOWLEDGE_CATEGORIES: ReadonlySet<KnowledgeCategory> = new Set([
  'product_facts', 'approved_claims', 'faqs', 'brand_guidelines', 'other',
]);

export type KnowledgeFormat = 'pdf' | 'docx' | 'txt' | 'markdown' | 'pasted_text' | 'png' | 'jpeg' | 'webp';

export type ExtractionStatus =
  | 'pending'
  | 'extracted'
  | 'partial'
  | 'image_reference'
  | 'unreadable'
  | 'unsupported'
  | 'rejected';

export interface KnowledgeDocument {
  /** Stable logical document identity; a replacement upload keeps it and increments `version`. */
  readonly id: string;
  readonly brandId: string;
  readonly version: number;
  readonly category: KnowledgeCategory;
  readonly title: string;
  readonly filename: string | null;
  readonly format: KnowledgeFormat | null;
  readonly mime: string | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Private blob reference for the original upload (never a public URL). */
  readonly blobId: string | null;
  readonly status: ExtractionStatus;
  /** Owner-readable explanation of what was or was not ingested. */
  readonly statusDetail: string;
  readonly text: string | null;
  readonly pagesRead: number | null;
  readonly pagesTotal: number | null;
  readonly active: boolean;
  readonly createdAt: IsoInstant;
}

export interface KnowledgeRef {
  readonly documentId: string;
  readonly version: number;
  readonly sha256: string;
  readonly category: KnowledgeCategory;
}

export interface ProfileOffer {
  readonly name: string;
  readonly description: string;
  /** Exactly as written in a knowledge source; never inferred. */
  readonly price: string | null;
  readonly url: string | null;
  readonly sourceDocumentId: string | null;
}

export interface ProfileConflict {
  readonly field: string;
  readonly detail: string;
  readonly documentIds: readonly string[];
}

export interface BrandProfile {
  readonly brandId: string;
  readonly version: number;
  readonly knowledge: readonly KnowledgeRef[];
  readonly summary: string;
  readonly audiences: readonly string[];
  readonly positioning: string;
  readonly offers: readonly ProfileOffer[];
  readonly conversionPages: readonly { readonly url: string; readonly label: string }[];
  readonly voice: {
    readonly tone: readonly string[];
    readonly do: readonly string[];
    readonly dont: readonly string[];
    readonly examples: readonly string[];
  };
  readonly approvedClaims: readonly string[];
  readonly exclusions: readonly string[];
  readonly conflicts: readonly ProfileConflict[];
  readonly missingFacts: readonly string[];
  /** Hash over product facts and approved claims only — the factual invalidation key. */
  readonly factsSha: string;
  readonly source: 'extracted' | 'owner_edited';
  readonly confirmedAt: IsoInstant | null;
  readonly confirmedBy: string | null;
  readonly createdAt: IsoInstant;
  readonly generation: GenerationRecord | null;
}

// ─── Website inventory ───────────────────────────────────────────────────────

export interface InventoryPage {
  readonly url: string;
  readonly canonical: string | null;
  readonly title: string | null;
  readonly headings: readonly string[];
  readonly excerpt: string;
  readonly publishedAt: string | null;
  readonly modifiedAt: string | null;
  readonly fetchStatus: 'ok' | 'http_error' | 'blocked' | 'too_large' | 'not_html' | 'error';
  readonly httpStatus: number | null;
  /** Heuristic: an article/guide-like page rather than an app, legal or checkout page. */
  readonly editorial: boolean;
}

export interface WebsiteInventory {
  readonly brandId: string;
  readonly website: string;
  readonly fetchedAt: IsoInstant;
  readonly sitemapUrls: number;
  readonly pages: readonly InventoryPage[];
  readonly notes: readonly string[];
}

// ─── Research ────────────────────────────────────────────────────────────────

export interface ResearchSource {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly retrievedAt: IsoInstant;
  /** Bounded supporting passage (≤ 600 chars) — evidence, never reusable copy. */
  readonly passage: string;
  readonly provider: string;
  /** Government, regulator, statute, official statistics or the brand's own site. */
  readonly primary: boolean;
  readonly query: string;
}

export type DemandAssessment =
  | {
      readonly kind: 'measured';
      readonly volume: number | null;
      readonly competition: number | null;
      readonly provider: string;
      readonly retrievedAt: IsoInstant;
    }
  | { readonly kind: 'qualitative'; readonly rationale: string };

// ─── Planning ────────────────────────────────────────────────────────────────

export type BriefRole = 'pillar' | 'supporting';
export type SearchIntent = 'buy' | 'compare' | 'learn';
export type DuplicateVerdict = 'distinct' | 'new_angle' | 'update_existing' | 'skip';

export interface DuplicateAssessment {
  readonly verdict: DuplicateVerdict;
  readonly score: number;
  readonly against: string | null;
  readonly againstKind: 'published_page' | 'planned_article' | null;
  readonly advice: string;
}

export type BriefStatus = 'planned' | 'postponed' | 'omitted' | 'accepted' | 'generating' | 'generated' | 'skipped';

export interface ArticleBrief {
  readonly id: string;
  readonly planId: string;
  readonly brandId: string;
  readonly role: BriefRole;
  readonly slug: string;
  readonly workingTitle: string;
  readonly targetQuery: string;
  readonly searchIntent: SearchIntent;
  readonly relatedQuestions: readonly string[];
  readonly angle: string;
  readonly outline: readonly string[];
  readonly keyPoints: readonly string[];
  readonly cta: { readonly label: string; readonly url: string } | null;
  /** Real published brand pages (absolute URLs) or other brief slugs (logical only). */
  readonly internalLinks: readonly string[];
  readonly whyFit: string;
  readonly demand: DemandAssessment;
  readonly sourceIds: readonly string[];
  readonly duplicate: DuplicateAssessment;
  readonly status: BriefStatus;
  readonly suggestedAtUtc: IsoInstant | null;
  readonly articleId: string | null;
}

export interface TopicPlan {
  readonly id: string;
  readonly brandId: string;
  readonly status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  readonly topic: string;
  readonly moneyPage: { readonly url: string; readonly label: string } | null;
  readonly briefIds: readonly string[];
  readonly sources: readonly ResearchSource[];
  readonly inputs: { readonly focus: string | null; readonly excluded: readonly string[]; readonly sourceArticleUrl: string | null };
  readonly profileVersion: number;
  readonly inventoryAt: IsoInstant | null;
  readonly generation: GenerationRecord;
  readonly createdAt: IsoInstant;
  readonly acceptedAt: IsoInstant | null;
}

export interface GenerationRecord {
  readonly mode: 'live' | 'simulated';
  readonly model: string;
  readonly promptVersion: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

// ─── Articles ────────────────────────────────────────────────────────────────

export interface ArticleSection {
  /** Stable across versions so a section can be regenerated in isolation. */
  readonly id: string;
  readonly heading: string;
  /** Restricted Markdown: paragraphs, bullet/numbered lists, **bold**, *italic*, [links](https://…). */
  readonly body: string;
}

export interface ArticleSourceCitation {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly retrievedAt: IsoInstant;
  readonly passage: string;
  /** Public citations are useful to readers; internal-only sources stay private. */
  readonly public: boolean;
}

export interface FeaturedImage {
  readonly kind: 'brand_asset' | 'uploaded' | 'generated' | 'none';
  readonly url: string | null;
  readonly alt: string;
  readonly provenance: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface ArticleBody {
  readonly title: string;
  readonly seoTitle: string;
  readonly metaDescription: string;
  readonly excerpt: string;
  readonly slug: string;
  readonly intro: string;
  readonly sections: readonly ArticleSection[];
  readonly conclusion: string;
  readonly cta: { readonly label: string; readonly url: string } | null;
  readonly faqs: readonly { readonly q: string; readonly a: string }[];
  readonly citations: readonly ArticleSourceCitation[];
  readonly image: FeaturedImage;
  readonly author: BrandAuthor | null;
}

export type VersionChange = 'generated' | 'edited' | 'section_regenerated' | 'regenerated' | 'image_changed' | 'metadata_changed';

export interface ArticlePromotionPack {
  readonly source: 'relaunch72.seo-blog';
  readonly brandId: string;
  readonly articleId: string;
  readonly versionId: string;
  readonly contentSha: string;
  readonly profileVersion: number;
  readonly factsSha: string;
  readonly canonicalUrl: string | null;
  readonly generation: GenerationRecord | null;
  readonly mode: 'model' | 'excerpt_fallback';
  readonly posts: readonly { readonly network: 'instagram' | 'linkedin'; readonly title: string; readonly copy: string; readonly artworkInstructions: string }[];
}

export interface ArticleVersion {
  readonly id: string;
  readonly articleId: string;
  readonly brandId: string;
  readonly number: number;
  readonly parentVersionId: string | null;
  readonly change: VersionChange;
  readonly changedSectionId: string | null;
  readonly createdAt: IsoInstant;
  readonly createdBy: string;
  readonly body: ArticleBody;
  readonly profileVersion: number;
  readonly factsSha: string;
  readonly knowledge: readonly KnowledgeRef[];
  readonly briefId: string;
  readonly planId: string;
  readonly generation: GenerationRecord | null;
  readonly contentSha: string;
  /** Immutable accompanying drafts. Review is separate from blog approval. */
  readonly promotionPack?: ArticlePromotionPack;
}

export type CheckSeverity = 'critical' | 'warning';

export interface CheckIssue {
  readonly code: string;
  readonly severity: CheckSeverity;
  readonly message: string;
  readonly fix: string;
  readonly location: string | null;
}

export interface CheckReport {
  readonly versionId: string;
  readonly contentSha: string;
  readonly factsSha: string;
  readonly ranAt: IsoInstant;
  readonly status: 'pass' | 'warnings' | 'critical';
  readonly issues: readonly CheckIssue[];
}

export type EditorialState = 'researching' | 'writing' | 'draft' | 'failed';
export type DeliveryState = 'none' | 'publishing' | 'published' | 'failed' | 'unknown';

export interface ArticleApproval {
  readonly versionId: string;
  readonly contentSha: string;
  readonly approvedAt: IsoInstant;
  readonly approvedBy: string;
}

export interface ArticleSchedule {
  readonly publishAtUtc: IsoInstant;
  readonly localDate: string;
  readonly localTime: string;
  readonly timezone: string;
  readonly destinationId: string;
  readonly setAt: IsoInstant;
  readonly setBy: string;
}

export interface ArticleHold {
  readonly reason:
    | 'owner' | 'missing_approval' | 'checks_failed' | 'paused' | 'destination' | 'budget'
    | 'outcome_unknown' | 'stale_version' | 'missed_window';
  readonly detail: string;
  readonly at: IsoInstant;
}

export interface Article {
  readonly id: string;
  readonly brandId: string;
  readonly briefId: string;
  readonly planId: string;
  readonly slug: string;
  readonly editorialState: EditorialState;
  readonly currentVersionId: string | null;
  /** Per-article "needs my approval" flag; independent of the brand auto-publish toggle. */
  readonly requiresApproval: boolean;
  readonly approval: ArticleApproval | null;
  readonly checks: CheckReport | null;
  readonly schedule: ArticleSchedule | null;
  readonly hold: ArticleHold | null;
  readonly delivery: DeliveryState;
  readonly publishedVersionId: string | null;
  readonly publishedUrl: string | null;
  readonly lastAttemptAt: IsoInstant | null;
  readonly publishedAt: IsoInstant | null;
  readonly failure: string | null;
  readonly createdAt: IsoInstant;
  readonly rowVersion: number;
  readonly linkedPromotions?: readonly LinkedPromotionRecord[];
  /** Durable owner observations: the exact moment an owner session verified the parent for one canonical command. */
  readonly promotionObservations?: readonly PromotionObservation[];
  /** Per-network delivery state of linked promotions through the brand's registered account. */
  readonly socialDispatches?: readonly SocialDispatch[];
}

export type PromotionNetwork = 'instagram' | 'linkedin';

export interface LinkedPromotionRecord {
  readonly articleVersionId: string;
  readonly network: PromotionNetwork;
  readonly packSha: string;
  readonly contentItemId: string;
  readonly contentVersionId: string;
  readonly approvalRequestId?: string;
  readonly approvalDecisionId: string;
}

/**
 * Source-local observation record. An owner action verifies the parent article
 * tuple at `observedAt`; the canonical command derived from it carries exactly
 * that observation, so a retried request replays the same durable command
 * instead of inventing a fresh timestamp. Expired observations are never
 * extended: the owner observes again, producing a new command.
 */
export interface PromotionObservation {
  readonly id: string;
  readonly purpose: 'approve' | 'schedule';
  readonly articleVersionId: string;
  readonly network: PromotionNetwork;
  readonly packSha: string;
  readonly observedAt: IsoInstant;
  readonly expiresAt: IsoInstant;
  readonly observedBy: string;
  /** Filled once the canonical draft version exists so a resumed approval never re-creates it. */
  readonly contentItemId: string | null;
  readonly contentVersionId: string | null;
}

export interface SocialDispatch {
  readonly id: string;
  readonly articleVersionId: string;
  readonly network: PromotionNetwork;
  readonly packSha: string;
  readonly bindingId: string;
  readonly intentId: string;
  readonly jobId: string | null;
  readonly scheduledFor: IsoInstant;
  readonly requestedAt: IsoInstant;
  readonly requestedBy: string;
  readonly state: 'queued' | 'held';
  readonly detail: string | null;
  readonly dailyCap: number;
  readonly monthlyCap: number;
}

// ─── Destinations & publication ──────────────────────────────────────────────

export const DESTINATION_TYPES = ['github_static', 'content_api'] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export interface Destination {
  readonly id: string;
  readonly brandId: string;
  readonly type: DestinationType;
  readonly label: string;
  /** Validated, non-secret configuration (see publishers/*). */
  readonly config: Readonly<Record<string, string>>;
  /**
   * AES-256-GCM sealed credential (see vault.ts), bound to this brand and
   * destination. Never rendered, logged or returned to a browser.
   */
  readonly sealedCredential: string | null;
  readonly publicBaseUrl: string;
  readonly status: 'unverified' | 'connected' | 'failed';
  readonly statusDetail: string;
  readonly checkedAt: IsoInstant | null;
  readonly createdAt: IsoInstant;
}

export type PublicationState = 'prepared' | 'submitted' | 'outcome_unknown' | 'verifying' | 'published' | 'failed' | 'cancelled';

export interface PolicySnapshot {
  readonly autoPublish: boolean;
  readonly requiresApproval: boolean;
  readonly approvedVersionId: string | null;
  readonly rule: 'approved' | 'auto_unflagged';
  readonly decidedAt: IsoInstant;
}

export interface Publication {
  /** Operation ID — persisted before any provider call. */
  readonly id: string;
  readonly brandId: string;
  readonly articleId: string;
  readonly versionId: string;
  readonly contentSha: string;
  readonly destinationId: string;
  /** brand:article:version:destination:scheduleSetAt — one operation per exact version, destination and owner-set slot. */
  readonly idempotencyKey: string;
  readonly scheduledFor: IsoInstant;
  readonly policy: PolicySnapshot;
  readonly state: PublicationState;
  readonly attempts: number;
  readonly firstAttemptAt: IsoInstant | null;
  readonly lastAttemptAt: IsoInstant | null;
  readonly providerRef: string | null;
  readonly publicUrl: string;
  readonly verifiedAt: IsoInstant | null;
  readonly verifyAttempts: number;
  readonly detail: string;
  /** Exact article version number (monotonic per article) — destinations order versions by it, never by id. */
  readonly versionNumber?: number;
  /** Append-only state history of this operation (unknown outcomes, reconciliation, cancellation). */
  readonly events?: readonly PublicationEvent[];
  readonly rowVersion: number;
}

export interface PublicationEvent {
  readonly at: IsoInstant;
  readonly state: PublicationState;
  readonly detail: string;
}

// ─── Jobs, usage, activity ───────────────────────────────────────────────────

export const JOB_KINDS = ['inventory', 'plan', 'write', 'publish', 'daily'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';

export interface Job {
  readonly id: string;
  readonly brandId: string;
  readonly kind: JobKind;
  /** Stable key; enqueueing the same key returns the existing job. */
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: IsoInstant | null;
  readonly runAfter: IsoInstant;
  readonly progress: string;
  readonly error: string | null;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
  readonly rowVersion: number;
}

export type UsageKind = 'model_tokens' | 'search_calls' | 'images';

export interface UsageRecord {
  readonly brandId: string;
  readonly kind: UsageKind;
  readonly amount: number;
  readonly at: IsoInstant;
  readonly reference: string;
}

export interface ActivityEvent {
  readonly brandId: string;
  readonly at: IsoInstant;
  readonly actor: string;
  readonly kind: string;
  readonly message: string;
  readonly subjectId: string | null;
}

export class SeoBlogError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'seo_blog_error') {
    super(message);
    this.name = 'SeoBlogError';
  }
}
