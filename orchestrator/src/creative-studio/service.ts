/**
 * Creative Studio: brand-aware image and ad creative for any brand in the
 * existing multi-brand programme. Draft → compare → edit → approve → download
 * or hand to an existing campaign. Nothing here publishes, schedules, sends or
 * starts ad spend. New paid image generation is not started from this
 * service: it reuses images already produced (and receipted) by the existing
 * durable article-image pipeline, owner uploads, or a neutral background.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { SeoBlogStore } from '../seo-blog/store.js';
import { SeoBlogError, type Article, type ArticleVersion } from '../seo-blog/types.js';
import { essentialGaps, resolveCreativeContext, type ContextGap, type CreativeBrandContext } from './brand-context.js';
import { clip, copyIssues, COPY_LIMITS, draftConcepts, factsCorpus, type ArticleSourceText } from './concepts.js';
import { verifyCreativeImage, CreativeImageError, type VerifiedImage } from './image-input.js';
import { isPlacementId, PLACEMENTS, type PlacementId } from './placements.js';
import { MOTIONS, parseHex, RendererUnavailableError, VIDEO_LIMITS, type ArtworkInput, type ArtworkRenderer, type MotionId } from './renderer.js';
import { campaignUtm } from '../seo-blog/acquisition-assembly.js';
import type { AcquisitionChannel, AcquisitionProposal, CampaignCreatorStore, CreatorRecord } from '../seo-blog/campaign-creator.js';
import type { ArticleLocalImageProposal, LocalImageOrigin } from '../seo-blog/image-campaign.js';
import { ARTICLE_MEDIA_PROFILE, ATTRIBUTION_LIMITS, creativeTrackedLink, exportLadder, handoffRoute, postLadder, trackedLinkLadder,
  type DeliveryRecord, type OutcomeRead, type StageEvidence } from './distribution.js';
import { buildLearning, findingsText, generalPatternIssues, type LearningSnapshot, type LearningStore, type PatternRow, type RecordedFinding } from './learning.js';
import { mediaOf, variantKey, approvalProblem, type CreativeLibraryStore, type CreativeSetRecord } from './store.js';
import {
  CREATIVE_PURPOSES, type BackgroundComponent, type BrandKit, type ConceptComponents, type ContextInputs, type CreativeApproval,
  type CreativeHandoff, type HandoffTarget, type CreativePurpose, type CreativeRequest, type CreativeSet, type CreativeVersion, type Palette, type StoredImageRef,
  type ArtworkIssue, type Storyboard, type StoryboardScene,
} from './types.js';

export const STORYBOARD_LIMITS = Object.freeze({ minScenes: 2, maxScenes: VIDEO_LIMITS.scenes, headline: 90, body: 160, script: 400 });
const MOTION_CYCLE: readonly MotionId[] = ['zoom_in', 'pan_left', 'zoom_out', 'pan_right'];
const MOTION_LABEL: Readonly<Record<MotionId, string>> = { zoom_in: 'slow zoom in', zoom_out: 'slow zoom out', pan_left: 'pan left', pan_right: 'pan right', none: 'still' };

/** Content that could present invented customers or reviews as real. Blocking: no permissioned testimonial flow exists here. */
export function endorsementIssues(texts: readonly string[]): ArtworkIssue[] {
  const all = texts.join('\n');
  const patterns = [/["“][^"”]{8,}["”]\s*[—–-]\s*\p{Lu}/u, /★{2,}|\b[1-5](?:\.\d)?\s*(?:\/\s*5|stars?)\b/iu,
    /\b(?:testimonials?|customer reviews?|our (?:customers|clients) say|said (?:one|a) (?:customer|client)|verified (?:buyer|customer)|real customer)\b/iu];
  return patterns.some((p) => p.test(all)) ? [{ code: 'fictional_endorsement', blocking: true, detail: 'Video copy must not present customer quotes, ratings or reviews. Real testimonials need a separate, permissioned process that this studio does not provide.' }] : [];
}

/** Starter scenes from a concept's own copy: opening, supporting point(s), end card. No new facts are introduced. */
export function draftScenes(concept: ConceptComponents): StoryboardScene[] {
  if (concept.cards.length) return concept.cards.map((c, i) => ({ headline: clip(c.headline, STORYBOARD_LIMITS.headline), body: clip(c.body, STORYBOARD_LIMITS.body),
    showCta: i === concept.cards.length - 1 && Boolean(concept.cta), durationMs: 3000, motion: MOTION_CYCLE[i % 4]!, script: clip(c.headline, STORYBOARD_LIMITS.script) }));
  const scenes: StoryboardScene[] = [{ headline: clip(concept.headline, STORYBOARD_LIMITS.headline), body: '', showCta: false, durationMs: 3500, motion: 'zoom_in',
    script: clip([concept.hook, concept.headline].filter(Boolean).join('. '), STORYBOARD_LIMITS.script) }];
  if (concept.body) {
    const [first, ...rest] = concept.body.split(/(?<=[.!?])\s+/u);
    scenes.push({ headline: clip(first!, STORYBOARD_LIMITS.headline), body: clip(rest.join(' '), STORYBOARD_LIMITS.body), showCta: false, durationMs: 4000, motion: 'pan_left', script: clip(concept.body, STORYBOARD_LIMITS.script) });
  }
  scenes.push({ headline: clip(concept.cta || concept.headline, STORYBOARD_LIMITS.headline), body: '', showCta: Boolean(concept.cta), durationMs: 3000, motion: 'none', script: clip(concept.cta, STORYBOARD_LIMITS.script) });
  return scenes;
}

export function validateScenes(raw: readonly Partial<StoryboardScene>[], concept: ConceptComponents): StoryboardScene[] {
  if (raw.length < STORYBOARD_LIMITS.minScenes || raw.length > STORYBOARD_LIMITS.maxScenes) throw new SeoBlogError(400, `A storyboard has ${STORYBOARD_LIMITS.minScenes} to ${STORYBOARD_LIMITS.maxScenes} scenes.`);
  const scenes = raw.map((r) => {
    const durationMs = Math.round(Number(r.durationMs) / 500) * 500;
    if (!(durationMs >= VIDEO_LIMITS.sceneMs[0] && durationMs <= VIDEO_LIMITS.sceneMs[1])) throw new SeoBlogError(400, 'Each scene lasts between 1.5 and 8 seconds.');
    if (!MOTIONS.includes(r.motion as MotionId)) throw new SeoBlogError(400, 'Choose a supported motion.');
    const headline = text(r.headline, STORYBOARD_LIMITS.headline);
    if (!headline) throw new SeoBlogError(400, 'Every scene needs on-screen text.');
    if (r.showCta && !concept.cta) throw new SeoBlogError(400, 'This concept has no call to action to show.');
    return Object.freeze({ headline, body: text(r.body, STORYBOARD_LIMITS.body), showCta: Boolean(r.showCta), durationMs, motion: r.motion as MotionId, script: text(r.script, STORYBOARD_LIMITS.script) });
  });
  if (scenes.reduce((n, x) => n + x.durationMs, 0) > VIDEO_LIMITS.totalMs) throw new SeoBlogError(400, 'Keep the whole video to 30 seconds or less.');
  return scenes;
}

/** Honest, local-only estimate for rendering a storyboard: planned length and approximate server time; never a provider cost. */
export function videoEstimate(storyboard: Pick<Storyboard, 'scenes'>) {
  const ms = storyboard.scenes.reduce((n, x) => n + x.durationMs, 0);
  return Object.freeze({ durationMs: ms, renderSecondsApprox: Math.ceil(ms / 1000 + storyboard.scenes.length * 1.5 + 4), providerAttempts: 0, providerCostMinor: 0 });
}

/** The existing article media path (owner upload → exact preparation → review → use → post → posting plan). */
export interface ArticleMediaPort {
  importApproved(actorId: string, brandId: string, articleId: string, commandId: string, bytes: Buffer, profile: 'blog' | 'instagram' | 'linkedin', origin: LocalImageOrigin): Promise<ArticleLocalImageProposal>;
}
/** The existing brand guidance (knowledge) store. Saving changes brand memory and needs the profile re-confirmed. */
export interface GuidancePort {
  saveAudienceNote(actorId: string, brandId: string, title: string, text: string): Promise<{ documentId: string }>;
}
/** Read-only views of existing delivery receipts and CRM outcomes (SQL boundary in 0143). */
export interface DistributionReadPort {
  delivery(brandId: string, queueIntentIds: readonly string[]): Promise<DeliveryRecord[]>;
  outcomes(brandId: string, utmCampaign: string): Promise<OutcomeRead>;
}

export type CreativeBrandPort = Pick<SeoBlogStore, 'getBrand' | 'canManage' | 'latestProfile' | 'listKnowledge' | 'putBlob' | 'getBlob' | 'getArticle' | 'getVersion' | 'listArticles'>;

/** Images already generated and receipted by the existing article-image pipeline. */
export interface SavedGeneratedImage {
  readonly assetId: string;
  readonly sha256: string;
  readonly articleId: string;
  readonly articleTitle: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly preparedAt: string;
}
export interface SavedImagePort {
  list(actorId: string, brandId: string): Promise<SavedGeneratedImage[]>;
  load(actorId: string, brandId: string, assetId: string, sha256: string): Promise<Buffer>;
}

export type BackgroundChoice =
  | { readonly kind: 'neutral' }
  | { readonly kind: 'upload'; readonly bytes: Buffer }
  | { readonly kind: 'saved'; readonly assetId: string; readonly sha256: string }
  | { readonly kind: 'keep' };

export interface ConceptPatch {
  readonly hook?: string;
  readonly headline?: string;
  readonly body?: string;
  readonly cta?: string;
  readonly illustrativeTag?: boolean;
  readonly cards?: readonly { headline: string; body: string }[];
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const text = (value: unknown, limit: number) => typeof value === 'string' ? clip(value, limit) : '';
export const MAX_RENDERS_PER_COMMAND = 24;

export class CreativeStudioService {
  private readonly now: () => string;
  private readonly newId: () => string;
  constructor(private readonly deps: {
    readonly library: CreativeLibraryStore;
    readonly brands: CreativeBrandPort;
    readonly renderer: ArtworkRenderer;
    readonly savedImages?: SavedImagePort;
    /** Milestone 4 ports onto existing integrations; each is optional and absent ports leave hand-offs record-only. */
    readonly articleMedia?: ArticleMediaPort;
    readonly creators?: Pick<CampaignCreatorStore, 'get' | 'list'>;
    readonly distribution?: DistributionReadPort;
    /** Milestone 5: learning journal (append-only) and the existing brand guidance store for owner-chosen copies. */
    readonly learning?: LearningStore;
    readonly guidance?: GuidancePort;
    readonly now?: () => string;
    readonly newId?: () => string;
  }) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? randomUUID;
  }

  get rendererReady(): boolean { return this.deps.renderer.available(); }

  private async authorise(actorId: string, brandId: string) {
    if (!UUID.test(brandId)) throw new SeoBlogError(404, 'That brand was not found.');
    if (!(await this.deps.brands.canManage(actorId, brandId))) throw new SeoBlogError(403, 'You do not manage this brand.');
    const brand = await this.deps.brands.getBrand(brandId);
    if (!brand) throw new SeoBlogError(404, 'That brand was not found.');
    return brand;
  }

  async context(actorId: string, brandId: string): Promise<{ context: CreativeBrandContext; kit: BrandKit | null }> {
    const brand = await this.authorise(actorId, brandId);
    const [profile, knowledge, kit] = await Promise.all([this.deps.brands.latestProfile(brandId), this.deps.brands.listKnowledge(brandId), this.deps.library.latestKit(brandId)]);
    return { context: resolveCreativeContext({ brand, profile, knowledge, kit }), kit };
  }
  private inputs(context: CreativeBrandContext): ContextInputs {
    if (!context.confirmed || context.profileVersion === null || !context.factsSha) throw new SeoBlogError(409, 'Confirm the brand profile in Setup before creating artwork.');
    return { profileVersion: context.profileVersion, factsSha: context.factsSha, kitVersion: context.kitVersion };
  }

  async overview(actorId: string, brandId: string) {
    const { context, kit } = await this.context(actorId, brandId);
    const [sets, articles, saved] = await Promise.all([
      this.deps.library.listSets(brandId), this.deps.brands.listArticles(brandId),
      this.deps.savedImages ? this.deps.savedImages.list(actorId, brandId).catch(() => []) : Promise.resolve([]),
    ]);
    return { context, kit, sets, articles: articles.map((a) => ({ id: a.id, title: articleTitle(a), currentVersionId: a.currentVersionId })), savedImages: saved, rendererReady: this.rendererReady };
  }

  // ─── Brand kit ────────────────────────────────────────────────────────────
  async saveKit(actorId: string, brandId: string, commandId: string, input: {
    readonly palette: Palette; readonly disclosure: string; readonly restricted: string;
    readonly logo: { kind: 'keep' } | { kind: 'remove' } | { kind: 'upload'; bytes: Buffer; label: string };
    readonly expectedVersion: number;
  }): Promise<BrandKit> {
    await this.authorise(actorId, brandId);
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const palette = Object.fromEntries((['primary', 'accent', 'dark', 'light'] as const).map((k) => {
      const value = input.palette[k]?.trim().toLowerCase() ?? '';
      if (!parseHex(value)) throw new SeoBlogError(400, `Enter the ${k} colour as a six-digit hex value such as #1f4fd1.`);
      return [k, value.startsWith('#') ? value : `#${value}`];
    })) as unknown as Palette;
    const current = await this.deps.library.latestKit(brandId);
    if ((current?.version ?? 0) !== input.expectedVersion) throw new SeoBlogError(409, 'The creative kit changed. Refresh and review it.');
    let logo: BrandKit['logo'] = input.logo.kind === 'keep' ? current?.logo ?? null : null;
    if (input.logo.kind === 'upload') logo = { ...(await this.storeImage(brandId, input.logo.bytes)), label: text(input.logo.label, 80) || 'Approved logo' };
    const restrictedPhrases = input.restricted.split(/\r?\n/u).map((l) => clip(l, 80)).filter((l) => l.length >= 3).slice(0, 30);
    const disclosure = text(input.disclosure, COPY_LIMITS.disclosure) || null;
    const body = { palette, logo: logo ? { sha256: logo.sha256, mime: logo.mime, width: logo.width, height: logo.height, label: logo.label } : null, disclosure, restrictedPhrases };
    const kit: BrandKit = Object.freeze({ brandId, version: input.expectedVersion + 1, ...body, logo, sha256: sha(canonical(body)), createdBy: actorId, createdAt: this.now() });
    await this.deps.library.saveKit(brandId, commandId, sha(canonical({ ...body, version: kit.version })), kit);
    return kit;
  }

  private async storeImage(brandId: string, bytes: Buffer): Promise<StoredImageRef> {
    let image: VerifiedImage;
    try { image = verifyCreativeImage(bytes); } catch (e) { throw new SeoBlogError(400, e instanceof CreativeImageError ? e.message : 'That image could not be read.'); }
    const blobId = await this.deps.brands.putBlob(brandId, image.bytes, image.mime);
    return Object.freeze({ blobId, sha256: image.sha256, mime: image.mime, width: image.width, height: image.height });
  }
  private async loadImage(brandId: string, ref: StoredImageRef): Promise<VerifiedImage> {
    const blob = await this.deps.brands.getBlob(brandId, ref.blobId);
    if (!blob || sha(blob.bytes) !== ref.sha256) throw new SeoBlogError(409, 'A stored image failed its integrity check. Nothing was rendered.');
    return verifyCreativeImage(blob.bytes);
  }

  /** The creative set a version belongs to (for redirects). */
  async artworkSet(actorId: string, brandId: string, versionId: string): Promise<string> {
    await this.authorise(actorId, brandId);
    const found = UUID.test(versionId) ? await this.deps.library.getVersion(brandId, versionId) : null;
    if (!found) throw new SeoBlogError(404, 'That artwork version was not found.');
    return found.version.setId;
  }

  /** Exact bytes of the current kit's approved logo, for owner review. */
  async kitLogo(actorId: string, brandId: string, sha256: string): Promise<{ bytes: Buffer; mime: 'image/jpeg' | 'image/png' }> {
    await this.authorise(actorId, brandId);
    const kit = await this.deps.library.latestKit(brandId);
    if (!kit?.logo || kit.logo.sha256 !== sha256) throw new SeoBlogError(404, 'That logo was not found.');
    const image = await this.loadImage(brandId, kit.logo);
    return { bytes: image.bytes, mime: image.mime };
  }

  // ─── Requests ─────────────────────────────────────────────────────────────
  parseRequest(context: CreativeBrandContext, raw: Readonly<Record<string, string | readonly string[] | undefined>>): CreativeRequest {
    const one = (k: string) => { const v = raw[k]; return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : ''; };
    const purpose = one('purpose') as CreativePurpose;
    if (!CREATIVE_PURPOSES.includes(purpose)) throw new SeoBlogError(400, 'Choose what the artwork is for.');
    const placementsRaw = raw.placements; const list = typeof placementsRaw === 'string' ? [placementsRaw] : [...(placementsRaw ?? [])];
    const placements = [...new Set(list)].filter(isPlacementId) as PlacementId[];
    if (!placements.length || placements.length > 5) throw new SeoBlogError(400, 'Choose at least one format.');
    if (purpose === 'carousel' && placements.some((p) => p !== 'square' && p !== 'portrait')) throw new SeoBlogError(400, 'Carousels use square or portrait cards.');
    const conceptCount = Math.trunc(Number(one('concepts') || '1'));
    if (!(conceptCount >= 1 && conceptCount <= 3)) throw new SeoBlogError(400, 'Choose one to three concepts.');
    const cardCount = purpose === 'carousel' ? Math.trunc(Number(one('cards') || '4')) : 0;
    if (purpose === 'carousel' && !(cardCount >= 2 && cardCount <= 5)) throw new SeoBlogError(400, 'A carousel has two to five cards.');
    const sourceKind = one('source_kind');
    let source: CreativeRequest['source'];
    if (sourceKind === 'offer') source = { kind: 'offer', name: one('offer') };
    else if (sourceKind === 'article') source = { kind: 'article', articleId: one('article').toLowerCase(), articleVersionId: '', title: '' };
    else if (sourceKind === 'brief') {
      const brief = text(one('brief'), 1200);
      if (brief.length < 10) throw new SeoBlogError(400, 'Write a short brief of at least a sentence.');
      if (/https?:\/\/|www\./iu.test(brief)) throw new SeoBlogError(400, 'Leave links out of the brief; choose an approved destination instead.');
      source = { kind: 'brief', text: brief };
    } else throw new SeoBlogError(400, 'Choose an offer, an article or a written brief.');
    const audienceChoice = one('audience');
    const audience = audienceChoice === '__custom' ? text(one('audience_custom'), 80) || null : context.audiences.includes(audienceChoice) ? audienceChoice : null;
    const destinationUrl = one('destination');
    const destination = context.destinations.find((d) => d.url === destinationUrl) ?? null;
    const renders = conceptCount * placements.length * Math.max(1, cardCount);
    if (renders > MAX_RENDERS_PER_COMMAND) throw new SeoBlogError(400, `That would produce ${renders} images. Choose fewer formats, concepts or cards (up to ${MAX_RENDERS_PER_COMMAND}).`);
    return Object.freeze({ purpose, source, audience, destination, placements, conceptCount, cardCount });
  }

  /** Honest usage for a request: local renders are free; this studio starts no new paid provider call. */
  estimate(request: CreativeRequest, background: BackgroundChoice['kind']) {
    const renders = request.conceptCount * request.placements.length * Math.max(1, request.cardCount);
    return Object.freeze({ renders, providerAttempts: 0, providerCostMinor: 0,
      note: background === 'saved' ? 'Reuses an image already generated and paid for by the article image pipeline. No new provider call.'
        : background === 'upload' ? 'Uses your uploaded image. No provider call.' : 'Uses a neutral brand-colour background. No provider call.' });
  }

  private async article(brandId: string, articleId: string): Promise<{ article: Article; version: ArticleVersion; source: ArticleSourceText }> {
    const article = UUID.test(articleId) ? await this.deps.brands.getArticle(brandId, articleId) : null;
    const version = article?.currentVersionId ? await this.deps.brands.getVersion(brandId, article.currentVersionId) : null;
    if (!article || !version || version.brandId !== brandId) throw new SeoBlogError(404, 'That article was not found.');
    const body = version.body;
    return { article, version, source: { title: body.title, excerpt: body.excerpt, headings: body.sections.map((s) => s.heading), bodyText: body.sections.map((s) => `${s.heading}\n${s.body}`).join('\n') } };
  }

  private async background(actorId: string, brandId: string, choice: BackgroundChoice, keep: BackgroundComponent | null): Promise<BackgroundComponent> {
    if (choice.kind === 'neutral') return { kind: 'neutral' };
    if (choice.kind === 'keep') { if (!keep) throw new SeoBlogError(400, 'Choose a background.'); return keep; }
    if (choice.kind === 'upload') return { kind: 'image', image: await this.storeImage(brandId, choice.bytes), origin: 'owner_upload', label: 'Owner-uploaded image', provenance: { source: 'owner_upload' } };
    const port = this.deps.savedImages;
    if (!port) throw new SeoBlogError(409, 'Saved generated images are not available here.');
    const saved = (await port.list(actorId, brandId)).find((s) => s.assetId === choice.assetId && s.sha256 === choice.sha256);
    if (!saved) throw new SeoBlogError(404, 'That saved image is not available for this brand.');
    const bytes = await port.load(actorId, brandId, saved.assetId, saved.sha256);
    if (sha(bytes) !== saved.sha256) throw new SeoBlogError(409, 'The saved image failed its integrity check.');
    return { kind: 'image', image: await this.storeImage(brandId, bytes), origin: 'generated_article_image', label: `Generated illustration for “${clip(saved.articleTitle, 60)}”`,
      provenance: { source: 'seo_article_image_pipeline', articleId: saved.articleId, intentId: saved.intentId, attemptId: saved.attemptId, candidateAssetId: saved.assetId, candidateSha256: saved.sha256, model: 'gpt-image-2' } };
  }

  // ─── Rendering ────────────────────────────────────────────────────────────
  private async render(brandId: string, context: CreativeBrandContext, kit: BrandKit | null, specs: readonly {
    readonly setId: string; readonly purpose: CreativePurpose; readonly conceptKey: string; readonly concept: ConceptComponents;
    readonly placement: PlacementId; readonly card: number; readonly focal: { x: number; y: number };
    readonly number: number; readonly parentVersionId: string | null; readonly change: string; readonly corpus: string;
  }[], actorId: string): Promise<CreativeVersion[]> {
    if (!this.deps.renderer.available()) throw new SeoBlogError(503, 'The artwork renderer is not installed on this server. No artwork was produced and nothing was charged.');
    const inputs = this.inputs(context);
    const images = new Map<string, VerifiedImage>();
    const image = async (ref: StoredImageRef) => { if (!images.has(ref.sha256)) images.set(ref.sha256, await this.loadImage(brandId, ref)); return images.get(ref.sha256)!; };
    const logo = kit?.logo ? await image(kit.logo) : null;
    const artwork: ArtworkInput[] = [];
    for (const s of specs) {
      const c = s.concept, cards = c.cards, total = cards.length, card = s.card > 0 ? cards[s.card - 1] : null;
      const article = s.purpose === 'article_image';
      artwork.push({ placement: PLACEMENTS[s.placement], palette: context.palette, brandName: context.brandName, logo,
        background: c.background.kind === 'image' ? await image(c.background.image) : null, focal: s.focal,
        hook: card ? (s.card === 1 ? c.hook || null : null) : c.hook || null,
        headline: card ? card.headline : c.headline,
        body: article ? null : (card ? card.body : c.body) || null,
        cta: article ? null : card ? (s.card === total ? c.cta || null : null) : c.cta || null,
        disclosure: context.disclosure, illustrativeTag: c.illustrativeTag, card: card ? { current: s.card, total } : null });
    }
    let rendered: Awaited<ReturnType<ArtworkRenderer['renderBatch']>>;
    try { rendered = await this.deps.renderer.renderBatch(artwork); }
    catch (error) { if (error instanceof RendererUnavailableError) throw new SeoBlogError(503, error.message); throw error; }
    const out: CreativeVersion[] = [];
    for (const [i, s] of specs.entries()) {
      const r = rendered[i]!;
      const blobId = await this.deps.brands.putBlob(brandId, r.bytes, r.mime);
      const c = s.concept;
      const componentShas = Object.freeze({
        hook: sha(c.hook), headline: sha(c.headline), body: sha(c.body), cta: sha(c.cta), cards: sha(canonical(c.cards)),
        background: sha(canonical(c.background)), illustrativeTag: sha(String(c.illustrativeTag)), focal: sha(canonical(s.focal)),
        kit: sha(canonical({ version: context.kitVersion, kitSha: kit?.sha256 ?? null })), disclosure: sha(context.disclosure ?? ''),
      });
      const specSha256 = sha(canonical({ componentShas, placement: s.placement, card: s.card, renderer: this.deps.renderer.version }));
      const issues = [...copyIssues(c, context, s.corpus), ...r.issues];
      out.push(Object.freeze({ id: this.newId(), setId: s.setId, brandId, conceptKey: s.conceptKey, placement: s.placement, card: s.card,
        number: s.number, parentVersionId: s.parentVersionId, change: s.change, concept: c, variant: Object.freeze({ focal: s.focal }),
        context: inputs, componentShas, specSha256, contextSha256: context.contextSha256,
        render: Object.freeze({ rendererVersion: this.deps.renderer.version, blobId, sha256: r.sha256, mime: r.mime, width: r.width, height: r.height,
          byteLength: r.bytes.byteLength, contrast: r.contrast, scrimAlpha: r.scrimAlpha, headlineSize: r.headlineSize }),
        issues: Object.freeze(issues), createdBy: actorId, createdAt: this.now() }));
    }
    return out;
  }

  private corpus(context: CreativeBrandContext, articleText: ArticleSourceText | null): string { return factsCorpus(context, articleText); }

  // ─── Commands ─────────────────────────────────────────────────────────────
  async draft(actorId: string, brandId: string, commandId: string, raw: Readonly<Record<string, string | readonly string[] | undefined>>, choice: BackgroundChoice): Promise<{ setId: string; note: string | null; replayed: boolean }> {
    const { context, kit } = await this.context(actorId, brandId);
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    let request = this.parseRequest(context, raw);
    const gaps: ContextGap[] = essentialGaps(context, request.purpose, request.source, request.destination);
    let articleText: ArticleSourceText | null = null;
    if (request.source.kind === 'article') {
      const found = await this.article(brandId, request.source.articleId);
      articleText = found.source;
      request = { ...request, source: { kind: 'article', articleId: found.article.id, articleVersionId: found.version.id, title: clip(found.source.title, 140) } };
    }
    if (gaps.length) throw new SeoBlogError(409, gaps.map((g) => `${g.detail} ${g.action}`).join(' '));
    const inputSha = sha(canonical({ request, background: choice.kind === 'upload' ? { kind: 'upload', sha: sha(choice.bytes) } : choice, context: context.contextSha256 }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { setId: replay.id, note: null, replayed: true };
    const background = await this.background(actorId, brandId, choice, null);
    const { concepts, note } = draftConcepts({ context, request, article: articleText, background });
    if (!concepts.length) throw new SeoBlogError(409, 'No concept can be drafted from the approved facts for this source. Add an offer, approved claims or positioning, or write a brief.');
    const set: CreativeSet = Object.freeze({ id: this.newId(), brandId, request, requestSha256: sha(canonical(request)), contextSha256: context.contextSha256, createdBy: actorId, createdAt: this.now() });
    const corpus = this.corpus(context, articleText);
    const specs = concepts.flatMap((concept, i) => request.placements.flatMap((placement) =>
      (request.cardCount ? Array.from({ length: concept.cards.length }, (_, k) => k + 1) : [0]).map((card) => ({
        setId: set.id, purpose: request.purpose, conceptKey: `c${i + 1}`, concept, placement, card, focal: { x: 0.5, y: 0.5 },
        number: 1, parentVersionId: null, change: 'initial draft', corpus }))));
    const versions = await this.render(brandId, context, kit, specs, actorId);
    const receipt = await this.deps.library.createSet(brandId, commandId, inputSha, set, versions, this.inputs(context));
    return { setId: receipt.id, note, replayed: receipt.replayed };
  }

  async getSet(actorId: string, brandId: string, setId: string) {
    const { context } = await this.context(actorId, brandId);
    const record = UUID.test(setId) ? await this.deps.library.getSet(brandId, setId) : null;
    if (!record) throw new SeoBlogError(404, 'That creative set was not found.');
    return { context, record, view: setView(record, context) };
  }

  private async headsFor(brandId: string, setId: string, conceptKey: string, expectedHeads: readonly string[]) {
    const record = await this.deps.library.getSet(brandId, setId);
    if (!record) throw new SeoBlogError(404, 'That creative set was not found.');
    const heads = currentHeads(record).filter((v) => v.conceptKey === conceptKey && mediaOf(v) === 'image');
    if (!heads.length) throw new SeoBlogError(404, 'That concept was not found.');
    if (expectedHeads.length && (heads.length !== expectedHeads.length || heads.some((h) => !expectedHeads.includes(h.id)))) throw new SeoBlogError(409, 'This concept changed while you were editing. Refresh and review the current version.');
    return { record, heads };
  }
  // ─── Storyboards and video ────────────────────────────────────────────────
  private sceneArtwork(context: CreativeBrandContext, logo: VerifiedImage | null, background: VerifiedImage | null, concept: ConceptComponents, scenes: readonly StoryboardScene[],
    placement: PlacementId, focal: { x: number; y: number }, overlay: boolean): ArtworkInput[] {
    return scenes.map((scene, i) => ({ placement: PLACEMENTS[placement], palette: context.palette, brandName: context.brandName, logo, background, focal,
      hook: i === 0 ? concept.hook || null : null, headline: scene.headline, body: scene.body || null, cta: scene.showCta ? concept.cta || null : null,
      disclosure: context.disclosure, illustrativeTag: concept.illustrativeTag, card: null, captureOverlay: overlay }));
  }
  private async motionVersion(input: { readonly brandId: string; readonly actorId: string; readonly context: CreativeBrandContext; readonly kit: BrandKit | null;
    readonly base: CreativeVersion; readonly media: 'storyboard' | 'video'; readonly storyboard: Storyboard; readonly head: CreativeVersion | null; readonly change: string;
    readonly corpus: string; readonly frameIssues: readonly ArtworkIssue[]; readonly render: CreativeVersion['render']; readonly extraIssues?: readonly ArtworkIssue[] }): Promise<CreativeVersion> {
    const { base, storyboard, context, kit } = input;
    const scenesText = storyboard.scenes.flatMap((x) => [x.headline, x.body, x.script]);
    const copy = copyIssues({ hook: base.concept.hook, headline: storyboard.scenes.map((x) => x.headline).join(' '), body: storyboard.scenes.map((x) => `${x.body} ${x.script}`).join(' '), cta: base.concept.cta, cards: [] }, context, input.corpus);
    const componentShas = Object.freeze({ scenes: sha(canonical(storyboard.scenes)), background: sha(canonical(base.concept.background)), focal: sha(canonical(base.variant.focal)),
      illustrativeTag: sha(String(base.concept.illustrativeTag)), kit: sha(canonical({ version: context.kitVersion, kitSha: kit?.sha256 ?? null })), disclosure: sha(context.disclosure ?? ''),
      source: sha(canonical({ storyboard: storyboard.sourceStoryboardVersionId ?? null, spec: storyboard.sourceStoryboardSpecSha256 ?? null })) });
    return Object.freeze({ id: this.newId(), setId: base.setId, brandId: input.brandId, conceptKey: base.conceptKey, media: input.media, placement: base.placement, card: 0,
      number: (input.head?.number ?? 0) + 1, parentVersionId: input.head?.id ?? null, change: input.change, concept: base.concept,
      variant: Object.freeze({ focal: base.variant.focal, storyboard: Object.freeze(storyboard) }), context: this.inputs(context), componentShas,
      specSha256: sha(canonical({ componentShas, media: input.media, placement: base.placement, renderer: this.deps.renderer.version })), contextSha256: context.contextSha256,
      render: input.render, issues: Object.freeze([...copy, ...endorsementIssues(scenesText), ...input.frameIssues, ...(input.extraIssues ?? [])]), createdBy: input.actorId, createdAt: this.now() });
  }
  private async storyboardRender(brandId: string, actorId: string, context: CreativeBrandContext, kit: BrandKit | null, base: CreativeVersion, storyboard: Storyboard, head: CreativeVersion | null, change: string, corpus: string): Promise<CreativeVersion> {
    const renderer = this.deps.renderer;
    if (!renderer.available() || !renderer.renderContactSheet) throw new SeoBlogError(503, 'The artwork renderer is not installed on this server. No storyboard was produced.');
    const background = base.concept.background.kind === 'image' ? await this.loadImage(brandId, base.concept.background.image) : null;
    const logo = kit?.logo ? await this.loadImage(brandId, kit.logo) : null;
    try {
      const inputs = this.sceneArtwork(context, logo, background, base.concept, storyboard.scenes, base.placement, base.variant.focal, false);
      const captions = storyboard.scenes.map((x) => ({ caption: `${(x.durationMs / 1000).toFixed(1)} s · ${MOTION_LABEL[x.motion]}`, script: x.script || null }));
      const title = `${context.brandName} · Concept ${base.conceptKey.slice(1)} · ${PLACEMENTS[base.placement].label}`;
      // One browser session when the renderer offers it; otherwise two bounded steps.
      const { frames, sheet } = renderer.renderStoryboard
        ? await renderer.renderStoryboard(inputs, captions, title)
        : await (async () => { const f = await renderer.renderBatch(inputs); return { frames: f, sheet: await renderer.renderContactSheet!(f.map((x, i) => ({ image: x.bytes, ...captions[i]! })), title) }; })();
      const blobId = await this.deps.brands.putBlob(brandId, sheet.bytes, 'image/jpeg');
      const frameIssues = frames.flatMap((f, i) => f.issues.map((x) => ({ ...x, detail: `Scene ${i + 1}: ${x.detail}` })));
      return this.motionVersion({ brandId, actorId, context, kit, base, media: 'storyboard', storyboard, head, change, corpus, frameIssues,
        render: Object.freeze({ rendererVersion: renderer.version, blobId, sha256: sha(sheet.bytes), mime: 'image/jpeg', width: sheet.width, height: sheet.height, byteLength: sheet.bytes.byteLength,
          durationMs: storyboard.scenes.reduce((n, x) => n + x.durationMs, 0), contrast: Object.freeze(Object.fromEntries(frames.map((f, i) => { const values = Object.values(f.contrast); return [`scene${i + 1}`, values.length ? Math.min(...values) : 21]; }))), scrimAlpha: 0, headlineSize: 0 }) });
    } catch (error) { if (error instanceof RendererUnavailableError) throw new SeoBlogError(503, error.message); throw error; }
  }
  private async motionContext(actorId: string, brandId: string, setId: string, conceptKey: string, placement: PlacementId) {
    const { context, kit } = await this.context(actorId, brandId);
    const record = UUID.test(setId) ? await this.deps.library.getSet(brandId, setId) : null;
    if (!record) throw new SeoBlogError(404, 'That creative set was not found.');
    const heads = currentHeads(record).filter((v) => v.conceptKey === conceptKey);
    const images = heads.filter((v) => mediaOf(v) === 'image');
    if (!images.length) throw new SeoBlogError(404, 'That concept was not found.');
    const base = images.find((v) => v.placement === placement) ?? images[0]!;
    const head = (media: 'storyboard' | 'video') => heads.find((v) => mediaOf(v) === media && v.placement === placement) ?? null;
    const corpus = this.corpus(context, await this.articleFor(brandId, record.set));
    return { context, kit, record, base: { ...base, placement, variant: { focal: base.placement === placement ? base.variant.focal : { x: 0.5, y: 0.5 } } } as CreativeVersion, head, corpus };
  }

  /** Estimated local render time for a video; no provider call or charge. */
  videoEstimate(storyboard: Storyboard) { return videoEstimate(storyboard); }

  async createStoryboard(actorId: string, brandId: string, setId: string, conceptKey: string, placement: PlacementId, commandId: string, likenessPermission: boolean): Promise<{ replayed: boolean }> {
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    if (!['square', 'portrait', 'vertical', 'landscape'].includes(placement)) throw new SeoBlogError(400, 'Choose a square, portrait, vertical or landscape video format.');
    await this.authorise(actorId, brandId);
    const inputSha = sha(canonical({ setId, conceptKey, placement, likenessPermission, action: 'storyboard' }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true };
    const m = await this.motionContext(actorId, brandId, setId, conceptKey, placement);
    if (m.base.concept.background.kind === 'image' && m.base.concept.background.origin === 'owner_upload' && !likenessPermission) {
      throw new SeoBlogError(400, 'Confirm that you have permission for any identifiable person shown in the uploaded image before using it in video.');
    }
    const storyboard: Storyboard = { scenes: draftScenes(m.base.concept), likenessPermission };
    const version = await this.storyboardRender(brandId, actorId, m.context, m.kit, m.base, storyboard, m.head('storyboard'), m.head('storyboard') ? 'new storyboard from concept' : 'initial storyboard', m.corpus);
    await this.deps.library.appendVersions(brandId, commandId, inputSha, setId, [version], this.inputs(m.context));
    return { replayed: false };
  }

  /** Scene-level revision: a new storyboard version; unchanged scenes keep their exact text and timing. */
  async editStoryboard(actorId: string, brandId: string, storyboardVersionId: string, commandId: string, scenesRaw: readonly Partial<StoryboardScene>[]): Promise<{ replayed: boolean; changed: string[] }> {
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const { context } = await this.context(actorId, brandId);
    const inputSha = sha(canonical({ storyboardVersionId, scenesRaw, action: 'scenes', context: context.contextSha256 }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true, changed: [] };
    const found = UUID.test(storyboardVersionId) ? await this.deps.library.getVersion(brandId, storyboardVersionId) : null;
    if (!found || mediaOf(found.version) !== 'storyboard') throw new SeoBlogError(404, 'That storyboard was not found.');
    if (!found.head) throw new SeoBlogError(409, 'A newer storyboard exists. Edit the current version.');
    const before = found.version.variant.storyboard!;
    const scenes = validateScenes(scenesRaw, found.version.concept);
    const changed = scenes.flatMap((x, i) => { const b = before.scenes[i]; if (!b) return [`scene ${i + 1} added`];
      return (['headline', 'body', 'showCta', 'durationMs', 'motion', 'script'] as const).filter((k) => x[k] !== b[k]).map((k) => `scene ${i + 1} ${k === 'durationMs' ? 'duration' : k === 'showCta' ? 'button' : k}`); });
    if (scenes.length < before.scenes.length) changed.push(`${before.scenes.length - scenes.length} scene(s) removed`);
    // Saving an unchanged storyboard after the brand facts or kit changed re-renders it under the current context.
    const c = this.inputs(context);
    const stale = found.version.context.profileVersion !== c.profileVersion || found.version.context.factsSha !== c.factsSha || found.version.context.kitVersion !== c.kitVersion;
    if (!changed.length && !stale) return { replayed: false, changed };
    const change = changed.length ? `edited ${changed.join(', ')}` : 'refreshed from current brand context';
    if (!changed.length) changed.push('refreshed from current brand context');
    const m = await this.motionContext(actorId, brandId, found.version.setId, found.version.conceptKey, found.version.placement);
    const version = await this.storyboardRender(brandId, actorId, m.context, m.kit, { ...m.base, variant: { focal: found.version.variant.focal } } as CreativeVersion,
      { scenes, likenessPermission: before.likenessPermission }, found.version, change, m.corpus);
    await this.deps.library.appendVersions(brandId, commandId, inputSha, found.version.setId, [version], this.inputs(m.context));
    return { replayed: false, changed };
  }

  /** Render a real, playback-verified video from one exact storyboard version. Local only: no provider call or charge. */
  async renderVideo(actorId: string, brandId: string, storyboardVersionId: string, commandId: string): Promise<{ replayed: boolean; playable: boolean }> {
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const { context, kit } = await this.context(actorId, brandId);
    const inputSha = sha(canonical({ storyboardVersionId, action: 'video' }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true, playable: true };
    const found = UUID.test(storyboardVersionId) ? await this.deps.library.getVersion(brandId, storyboardVersionId) : null;
    if (!found || mediaOf(found.version) !== 'storyboard') throw new SeoBlogError(404, 'That storyboard was not found.');
    if (!found.head) throw new SeoBlogError(409, 'A newer storyboard exists. Render the current version.');
    const sb = found.version;
    if (sb.issues.some((x) => x.blocking)) throw new SeoBlogError(409, 'Resolve the storyboard’s blocking issues before rendering a video.');
    const c = this.inputs(context);
    if (sb.context.profileVersion !== c.profileVersion || sb.context.factsSha !== c.factsSha || sb.context.kitVersion !== c.kitVersion) throw new SeoBlogError(409, 'Brand facts or the creative kit changed since this storyboard was made. Save the storyboard again first.');
    const renderer = this.deps.renderer;
    if (!renderer.available() || !renderer.renderVideo) throw new SeoBlogError(503, 'The video renderer is not installed on this server. No video was produced.');
    const m = await this.motionContext(actorId, brandId, sb.setId, sb.conceptKey, sb.placement);
    const background = sb.concept.background.kind === 'image' ? await this.loadImage(brandId, sb.concept.background.image) : null;
    const logo = kit?.logo ? await this.loadImage(brandId, kit.logo) : null;
    const scenes = sb.variant.storyboard!.scenes;
    try {
      const inputs = this.sceneArtwork(context, logo, background, sb.concept, scenes, sb.placement, sb.variant.focal, true);
      const timing = scenes.map((x) => ({ durationMs: x.durationMs, motion: x.motion }));
      const size = { width: PLACEMENTS[sb.placement].width, height: PLACEMENTS[sb.placement].height, palette: context.palette };
      const { frames, video } = renderer.renderSceneVideo
        ? await renderer.renderSceneVideo(inputs, timing, { ...size, background, focal: sb.variant.focal })
        : await (async () => {
          const f = await renderer.renderBatch(inputs);
          if (f.some((x) => !x.overlay)) throw new SeoBlogError(503, 'This renderer cannot capture the overlay layer needed for video. No video was produced.');
          return { frames: f, video: await renderer.renderVideo!({ ...size, scenes: f.map((x, i) => ({ background, focal: sb.variant.focal, overlay: x.overlay!, durationMs: timing[i]!.durationMs, motion: timing[i]!.motion })) }) };
        })();
      const blobId = await this.deps.brands.putBlob(brandId, video.bytes, video.mime);
      const storyboard: Storyboard = { scenes, likenessPermission: sb.variant.storyboard!.likenessPermission, sourceStoryboardVersionId: sb.id, sourceStoryboardSpecSha256: sb.specSha256 };
      const playbackOk = video.playable && video.measuredDurationMs !== null && Math.abs(video.measuredDurationMs - video.durationMs) <= 1000;
      const version = await this.motionVersion({ brandId, actorId, context, kit, base: { ...sb, variant: { focal: sb.variant.focal } } as CreativeVersion, media: 'video', storyboard,
        head: m.head('video'), change: `rendered from storyboard version ${sb.number}`, corpus: m.corpus, frameIssues: frames.flatMap((f, i) => f.issues.map((x) => ({ ...x, detail: `Scene ${i + 1}: ${x.detail}` }))),
        render: Object.freeze({ rendererVersion: renderer.version, blobId, sha256: video.sha256, mime: video.mime, width: video.width, height: video.height, byteLength: video.byteLength,
          durationMs: video.durationMs, measuredDurationMs: video.measuredDurationMs, codec: video.codec, container: video.container, contrast: Object.freeze({}), scrimAlpha: 0, headlineSize: 0 }),
        extraIssues: playbackOk ? [] : [{ code: 'not_playable', blocking: true, detail: 'The recorded file did not pass the playback check (dimensions, length or a decodable frame). It cannot be approved; render it again.' }] });
      await this.deps.library.appendVersions(brandId, commandId, inputSha, sb.setId, [version], c);
      return { replayed: false, playable: playbackOk };
    } catch (error) { if (error instanceof RendererUnavailableError) throw new SeoBlogError(503, error.message); throw error; }
  }

  private async articleFor(brandId: string, set: CreativeSet): Promise<ArticleSourceText | null> {
    return set.request.source.kind === 'article' ? (await this.article(brandId, set.request.source.articleId)).source : null;
  }

  /** Edit concept-level copy or background. Only that concept's placements get new versions; other concepts and their approvals are untouched. */
  async editConcept(actorId: string, brandId: string, setId: string, conceptKey: string, commandId: string, expectedHeads: readonly string[], patch: ConceptPatch, choice: BackgroundChoice): Promise<{ replayed: boolean; changed: string[] }> {
    const { context, kit } = await this.context(actorId, brandId);
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const inputSha = sha(canonical({ setId, conceptKey, expectedHeads: [...expectedHeads].sort(), patch, background: choice.kind === 'upload' ? { kind: 'upload', sha: sha(choice.bytes) } : choice }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true, changed: [] };
    const { record, heads } = await this.headsFor(brandId, setId, conceptKey, expectedHeads);
    const before = heads[0]!.concept;
    const background = await this.background(actorId, brandId, choice, before.background);
    const cards = patch.cards ? patch.cards.map((c) => Object.freeze({ headline: text(c.headline, COPY_LIMITS.cardHeadline), body: text(c.body, COPY_LIMITS.cardBody) })) : before.cards;
    if (cards.length !== before.cards.length || cards.some((c) => !c.headline)) throw new SeoBlogError(400, 'Every card needs a headline.');
    const next: ConceptComponents = Object.freeze({ ...before,
      hook: patch.hook !== undefined ? text(patch.hook, COPY_LIMITS.hook) : before.hook,
      headline: patch.headline !== undefined ? text(patch.headline, COPY_LIMITS.headline) : before.headline,
      body: patch.body !== undefined ? text(patch.body, COPY_LIMITS.body) : before.body,
      cta: patch.cta !== undefined ? text(patch.cta, COPY_LIMITS.cta) : before.cta,
      illustrativeTag: patch.illustrativeTag ?? before.illustrativeTag, background, cards: Object.freeze(cards) });
    if (!next.headline) throw new SeoBlogError(400, 'The headline cannot be empty.');
    const changed = (['hook', 'headline', 'body', 'cta', 'illustrativeTag', 'background', 'cards'] as const).filter((k) => canonical(next[k]) !== canonical(before[k]));
    if (!changed.length) return { replayed: false, changed };
    const corpus = this.corpus(context, await this.articleFor(brandId, record.set));
    const versions = await this.render(brandId, context, kit, heads.map((h) => ({ setId, purpose: record.set.request.purpose, conceptKey, concept: next, placement: h.placement,
      card: h.card, focal: h.variant.focal, number: h.number + 1, parentVersionId: h.id, change: `edited ${changed.join(', ')}`, corpus })), actorId);
    await this.deps.library.appendVersions(brandId, commandId, inputSha, setId, versions, this.inputs(context));
    return { replayed: false, changed };
  }

  /** Placement-level edit: move the focal point of one format only. */
  async editFocal(actorId: string, brandId: string, versionId: string, commandId: string, focal: { x: number; y: number }): Promise<{ replayed: boolean }> {
    const { context, kit } = await this.context(actorId, brandId);
    if (!UUID.test(commandId) || ![focal.x, focal.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) throw new SeoBlogError(400, 'Choose a focal point inside the image.');
    const inputSha = sha(canonical({ versionId, focal }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true };
    const found = UUID.test(versionId) ? await this.deps.library.getVersion(brandId, versionId) : null;
    if (!found || mediaOf(found.version) !== 'image') throw new SeoBlogError(404, 'That artwork version was not found.');
    if (!found.head) throw new SeoBlogError(409, 'A newer version of this artwork exists. Edit the current version.');
    const v = found.version, record = (await this.deps.library.getSet(brandId, v.setId))!;
    const corpus = this.corpus(context, await this.articleFor(brandId, record.set));
    const versions = await this.render(brandId, context, kit, [{ setId: v.setId, purpose: record.set.request.purpose, conceptKey: v.conceptKey, concept: v.concept,
      placement: v.placement, card: v.card, focal: { x: Number(focal.x.toFixed(3)), y: Number(focal.y.toFixed(3)) }, number: v.number + 1, parentVersionId: v.id, change: 'moved focal point', corpus }], actorId);
    await this.deps.library.appendVersions(brandId, commandId, inputSha, v.setId, versions, this.inputs(context));
    return { replayed: false };
  }

  /** Re-render a concept from the current brand facts and kit after they changed. Copy is kept; checks re-run. */
  async refreshConcept(actorId: string, brandId: string, setId: string, conceptKey: string, commandId: string, expectedHeads: readonly string[]): Promise<{ replayed: boolean }> {
    const { context, kit } = await this.context(actorId, brandId);
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const inputSha = sha(canonical({ setId, conceptKey, expectedHeads: [...expectedHeads].sort(), refresh: context.contextSha256 }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true };
    const { record, heads } = await this.headsFor(brandId, setId, conceptKey, expectedHeads);
    const corpus = this.corpus(context, await this.articleFor(brandId, record.set));
    const versions = await this.render(brandId, context, kit, heads.map((h) => ({ setId, purpose: record.set.request.purpose, conceptKey, concept: h.concept,
      placement: h.placement, card: h.card, focal: h.variant.focal, number: h.number + 1, parentVersionId: h.id, change: 'refreshed from current brand context', corpus })), actorId);
    await this.deps.library.appendVersions(brandId, commandId, inputSha, setId, versions, this.inputs(context));
    return { replayed: false };
  }

  /** Approve one exact image version. It does not approve captions, campaigns, schedules or paid adverts. */
  async approve(actorId: string, brandId: string, versionId: string, commandId: string, expectedRenderSha256: string, figuresConfirmed: boolean): Promise<{ replayed: boolean; approvalId: string }> {
    const { context } = await this.context(actorId, brandId);
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const inputSha = sha(canonical({ versionId, expectedRenderSha256, figuresConfirmed }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true, approvalId: replay.id };
    const found = UUID.test(versionId) ? await this.deps.library.getVersion(brandId, versionId) : null;
    if (!found) throw new SeoBlogError(404, 'That artwork version was not found.');
    const current = this.inputs(context);
    const approval: CreativeApproval = Object.freeze({ id: this.newId(), versionId, context: current, renderSha256: expectedRenderSha256, specSha256: found.version.specSha256,
      contextSha256: context.contextSha256, figuresConfirmed, scope: 'image_only', approvedBy: actorId, approvedAt: this.now() });
    const problem = approvalProblem(found.version, found.head, approval, current);
    if (problem) throw new SeoBlogError(409, problem);
    const receipt = await this.deps.library.approve(brandId, commandId, inputSha, approval, current);
    return { replayed: receipt.replayed, approvalId: receipt.id };
  }

  /** Exact stored bytes of a version, verified against its digest. `approved` is true only for a currently usable approval. */
  async artwork(actorId: string, brandId: string, versionId: string, expectedSha256: string): Promise<{ bytes: Buffer; version: CreativeVersion; approved: boolean }> {
    const { context } = await this.context(actorId, brandId);
    const found = UUID.test(versionId) ? await this.deps.library.getVersion(brandId, versionId) : null;
    if (!found || found.version.render.sha256 !== expectedSha256) throw new SeoBlogError(404, 'That artwork was not found.');
    const blob = await this.deps.brands.getBlob(brandId, found.version.render.blobId);
    if (!blob || sha(blob.bytes) !== found.version.render.sha256) throw new SeoBlogError(409, 'The stored artwork failed its integrity check.');
    const approved = Boolean(found.approval) && context.confirmed && approvalProblem(found.version, found.head, found.approval!, { profileVersion: context.profileVersion!, factsSha: context.factsSha!, kitVersion: context.kitVersion }) === null;
    return { bytes: Buffer.from(blob.bytes), version: found.version, approved };
  }

  /**
   * Hand an approved exact version to an existing integration. Images in an exact article format enter that article's
   * existing private media path; acquisition campaigns receive a tracked link carrying campaign and artwork identities;
   * anything else is recorded for download. Nothing is published, scheduled, sent or spent here.
   */
  async handoff(actorId: string, brandId: string, versionId: string, commandId: string, target: HandoffTarget): Promise<{ replayed: boolean; handoff: CreativeHandoff | null }> {
    const { context } = await this.context(actorId, brandId);
    if (!UUID.test(commandId) || !UUID.test(versionId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const inputSha = sha(canonical({ versionId, target }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true, handoff: null };
    const found = await this.deps.library.getVersion(brandId, versionId);
    if (!found?.approval) throw new SeoBlogError(409, 'Approve this exact artwork version before adding it to a campaign.');
    const current = { profileVersion: context.profileVersion!, factsSha: context.factsSha!, kitVersion: context.kitVersion };
    if (!context.confirmed || approvalProblem(found.version, found.head, found.approval, current)) throw new SeoBlogError(409, 'This approval is no longer current. Refresh and approve the current artwork.');
    const { route, note } = handoffRoute(found.version, target.kind);
    const base = { id: this.newId(), versionId, approvalId: found.approval.id, target, state: 'ready_for_review' as const, route, routeNote: note, createdBy: actorId, createdAt: this.now() };
    let handoff: CreativeHandoff;
    if (target.kind === 'article_campaign') {
      if (!UUID.test(target.articleId) || !(await this.deps.brands.getArticle(brandId, target.articleId))) throw new SeoBlogError(404, 'That article was not found.');
      if (route === 'article_media') {
        if (!this.deps.articleMedia) throw new SeoBlogError(503, 'Article images are not configured here. Download the artwork instead.');
        const blob = await this.deps.brands.getBlob(brandId, found.version.render.blobId);
        if (!blob || sha(blob.bytes) !== found.version.render.sha256) throw new SeoBlogError(409, 'The stored artwork failed its integrity check.');
        const profile = ARTICLE_MEDIA_PROFILE[found.version.placement]!;
        // Deterministic per hand-off command: a retry replays the same media receipt instead of adding another image.
        const proposal = await this.deps.articleMedia.importApproved(actorId, brandId, target.articleId, derivedId(`creative-handoff-media:${commandId}`), Buffer.from(blob.bytes), profile,
          { kind: 'creative_studio', creativeVersionId: versionId, creativeSha256: found.version.render.sha256, placement: found.version.placement });
        const variant = proposal.variants.find((v) => v.profile === profile);
        if (!variant) throw new SeoBlogError(409, 'The article image was not prepared. Nothing was added.');
        handoff = Object.freeze({ ...base, articleMedia: Object.freeze({ candidateAssetId: proposal.candidateAssetId, candidateSha256: proposal.candidateSha256, variantAssetId: variant.assetId, variantSha256: variant.sha256, profile }) });
      } else handoff = Object.freeze(base);
    } else {
      const record = this.deps.creators && UUID.test(target.campaignId) ? await this.deps.creators.get(brandId, target.campaignId) : null;
      const proposal = acquisitionProposal(record);
      if (!record || !proposal) throw new SeoBlogError(404, 'That acquisition campaign proposal was not found.');
      const link = Number.isInteger(target.concept) && typeof target.channel === 'string'
        ? creativeTrackedLink(record.brief, record.id, proposal, target.concept!, target.channel as AcquisitionChannel, versionId) : null;
      if (!link) throw new SeoBlogError(400, 'Choose one of this proposal’s concepts and one of its channels.');
      handoff = Object.freeze({ ...base, trackedLink: link });
    }
    const receipt = await this.deps.library.handoff(brandId, commandId, inputSha, handoff, this.inputs(context));
    return { replayed: receipt.replayed, handoff };
  }

  /** Milestone 5 learning operations over the same ports. */
  learning(): CreativeLearning {
    return new CreativeLearning(this, { ...(this.deps.creators ? { creators: this.deps.creators } : {}), ...(this.deps.distribution ? { distribution: this.deps.distribution } : {}),
      ...(this.deps.learning ? { learning: this.deps.learning } : {}), ...(this.deps.guidance ? { guidance: this.deps.guidance } : {}), brands: this.deps.brands, now: this.now, newId: this.newId });
  }

  /** Acquisition proposals this brand can attach artwork to, with their concepts and channels. */
  async acquisitionTargets(actorId: string, brandId: string): Promise<{ id: string; name: string; concepts: { index: number; name: string; channels: AcquisitionChannel[] }[] }[]> {
    await this.context(actorId, brandId);
    if (!this.deps.creators) return [];
    const rows = await this.deps.creators.list(brandId);
    return rows.flatMap((r) => { const p = acquisitionProposal(r); return p ? [{ id: r.id, name: r.brief.name, concepts: p.concepts.map((c, index) => ({ index, name: c.name, channels: [...c.channels] })) }] : []; }).slice(0, 20);
  }

  /**
   * Distribution ladder for every hand-off of one set, read from existing receipts and CRM records.
   * States that cannot be observed are reported as such; nothing is inferred or estimated.
   */
  async distribution(actorId: string, brandId: string, setId: string): Promise<{ handoffId: string; versionId: string; route: string; label: string; posts: { label: string; ladder: StageEvidence[] }[] }[]> {
    await this.context(actorId, brandId);
    const record = UUID.test(setId) ? await this.deps.library.getSet(brandId, setId) : null;
    if (!record) throw new SeoBlogError(404, 'That creative set was not found.');
    const out: { handoffId: string; versionId: string; route: string; label: string; posts: { label: string; ladder: StageEvidence[] }[] }[] = [];
    const outcomeCache = new Map<string, OutcomeRead | null>();
    for (const h of record.handoffs.slice(-40)) {
      if (h.route === 'article_media' && h.articleMedia && h.target.kind === 'article_campaign') {
        const article = await this.deps.brands.getArticle(brandId, h.target.articleId);
        const campaign = article?.campaign;
        const uses = (campaign?.variants ?? []).flatMap((variant) => variant.revisions.filter((r) => r.media?.assetId === h.articleMedia!.variantAssetId)
          .map((r) => ({ variant, revision: r, plan: campaign?.queueInstructions?.filter((q) => q.instruction.variantId === variant.id && q.instruction.variantRevisionId === r.id).at(-1) ?? null })));
        const queues = uses.flatMap((u) => u.plan ? [u.plan.instruction.queueIntentId] : []);
        const rows = queues.length && this.deps.distribution ? await this.deps.distribution.delivery(brandId, queues).catch(() => [] as DeliveryRecord[]) : [];
        const posts = uses.length ? uses.map((u) => ({ label: `${u.variant.network === 'instagram' ? 'Instagram' : 'LinkedIn'} post · ${u.variant.angle.replace('_', ' ')}`,
          ladder: postLadder(h, u.plan ? rows.find((x) => x.queueIntentId === u.plan!.instruction.queueIntentId) ?? null : null, Boolean(u.plan)) }))
          : [{ label: 'Not yet chosen for a post', ladder: postLadder(h, null, false) }];
        out.push({ handoffId: h.id, versionId: h.versionId, route: h.route, label: article ? `Article images · ${articleTitle(article)}` : 'Article images', posts });
      } else if (h.route === 'tracked_link' && h.trackedLink) {
        const key = h.trackedLink.utmCampaign;
        if (!outcomeCache.has(key)) outcomeCache.set(key, this.deps.distribution ? await this.deps.distribution.outcomes(brandId, key).catch(() => null) : null);
        out.push({ handoffId: h.id, versionId: h.versionId, route: h.route, label: `Acquisition campaign · concept ${h.trackedLink.concept + 1} · ${h.trackedLink.channel}`,
          posts: [{ label: h.trackedLink.url, ladder: trackedLinkLadder(h, outcomeCache.get(key)!) }] });
      } else {
        out.push({ handoffId: h.id, versionId: h.versionId, route: h.route ?? 'export_only', label: h.target.kind === 'article_campaign' ? 'Recorded for download (earlier hand-off or unsupported format)' : 'Recorded', posts: [{ label: 'Download only', ladder: exportLadder(h) }] });
      }
    }
    return out;
  }

  /** Real outcomes for one acquisition proposal, by concept and artwork, with the attribution limits stated. */
  async campaignOutcomes(actorId: string, brandId: string, campaignId: string): Promise<{ utmCampaign: string; read: OutcomeRead | null; limits: readonly string[] } | null> {
    await this.context(actorId, brandId);
    const record = this.deps.creators && UUID.test(campaignId) ? await this.deps.creators.get(brandId, campaignId) : null;
    if (!record || !acquisitionProposal(record)) return null;
    const utmCampaign = campaignUtm(record.brief, record.id);
    const read = this.deps.distribution ? await this.deps.distribution.outcomes(brandId, utmCampaign).catch(() => null) : null;
    return { utmCampaign, read, limits: ATTRIBUTION_LIMITS };
  }
}

export interface LearningView {
  readonly utmCampaign: string;
  readonly read: OutcomeRead | null;
  readonly snapshot: LearningSnapshot | null;
  readonly recorded: readonly RecordedFinding[];
  readonly patterns: readonly PatternRow[];
  readonly limits: readonly string[];
  readonly guidanceAvailable: boolean;
}

export class CreativeLearning {
  constructor(private readonly studio: CreativeStudioService, private readonly deps: { creators?: Pick<CampaignCreatorStore, 'get' | 'list'>; distribution?: DistributionReadPort; learning?: LearningStore; guidance?: GuidancePort; brands: CreativeBrandPort; now: () => string; newId: () => string }) {}
  private async campaign(actorId: string, brandId: string, campaignId: string) {
    await this.studio.context(actorId, brandId);
    const record = this.deps.creators && UUID.test(campaignId) ? await this.deps.creators.get(brandId, campaignId) : null;
    const proposal = acquisitionProposal(record);
    if (!record || !proposal) throw new SeoBlogError(404, 'That acquisition campaign proposal was not found.');
    return { record, proposal, utmCampaign: campaignUtm(record.brief, record.id) };
  }
  /** Current findings computed from a fresh outcome read, the dated journal and this brand's shared patterns. Read-only. */
  async view(actorId: string, brandId: string, campaignId: string): Promise<LearningView> {
    const { proposal, utmCampaign } = await this.campaign(actorId, brandId, campaignId);
    const read = this.deps.distribution ? await this.deps.distribution.outcomes(brandId, utmCampaign).catch(() => null) : null;
    const [recorded, patterns] = this.deps.learning ? await Promise.all([this.deps.learning.listFindings(brandId, campaignId).catch(() => []), this.deps.learning.patterns(brandId, 'mine').catch(() => [])]) : [[], []];
    return { utmCampaign, read, snapshot: read ? buildLearning(read, proposal) : null, recorded, patterns, limits: ATTRIBUTION_LIMITS, guidanceAvailable: Boolean(this.deps.guidance) };
  }
  /** Record today's findings with the exact evidence read. SQL recomputes the evidence and refuses anything not observed. */
  async record(actorId: string, brandId: string, campaignId: string, commandId: string): Promise<{ replayed: boolean; id: string }> {
    if (!this.deps.learning || !this.deps.distribution) throw new SeoBlogError(503, 'The learning journal is not configured here. Nothing was recorded.');
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const { proposal, utmCampaign } = await this.campaign(actorId, brandId, campaignId);
    const read = await this.deps.distribution.outcomes(brandId, utmCampaign);
    const snapshot = buildLearning(read, proposal);
    const finding: RecordedFinding = { id: this.deps.newId(), campaignId, utmCampaign, read, snapshot, recordedBy: actorId, recordedAt: this.deps.now() };
    // One record per owner command; the evidence counts identify what was recorded.
    return this.deps.learning.recordFinding(brandId, commandId, sha(canonical({ campaignId, buckets: read.buckets.map((b) => [b.utmContent, b.leads, b.qualified, b.booked, b.sold, b.customers]) })), finding);
  }
  /** Share one owner-written general pattern with the same person's other brands. Brand-specific content is refused. */
  async sharePattern(actorId: string, brandId: string, findingId: string, statement: string, commandId: string): Promise<{ replayed: boolean; id: string }> {
    if (!this.deps.learning) throw new SeoBlogError(503, 'The learning journal is not configured here.');
    const { context } = await this.studio.context(actorId, brandId);
    const brand = await this.deps.brands.getBrand(brandId);
    const profile = await this.deps.brands.latestProfile(brandId);
    const host = brand?.website ? new URL(brand.website).hostname.replace(/^www\./u, '') : '';
    const issues = generalPatternIssues(statement, [context.brandName, brand?.name ?? '', host, ...(profile?.offers ?? []).map((o) => o.name)]);
    if (issues.length) throw new SeoBlogError(400, issues.join(' '));
    if (!UUID.test(commandId) || !UUID.test(findingId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const decision = { id: this.deps.newId(), patternId: this.deps.newId(), findingId, statement: statement.trim(), state: 'shared' as const, decidedBy: actorId, decidedAt: this.deps.now() };
    return this.deps.learning.decidePattern(brandId, commandId, sha(canonical({ findingId, statement: decision.statement })), decision);
  }
  async withdrawPattern(actorId: string, brandId: string, patternId: string, commandId: string): Promise<{ replayed: boolean; id: string }> {
    if (!this.deps.learning) throw new SeoBlogError(503, 'The learning journal is not configured here.');
    await this.studio.context(actorId, brandId);
    if (!UUID.test(commandId) || !UUID.test(patternId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    const current = (await this.deps.learning.patterns(brandId, 'mine')).find((p) => p.patternId === patternId);
    if (!current || current.state !== 'shared') throw new SeoBlogError(409, 'Only a currently shared pattern can be withdrawn.');
    return this.deps.learning.decidePattern(brandId, commandId, sha(canonical({ withdraw: patternId })),
      { id: this.deps.newId(), patternId, findingId: current.findingId, statement: current.statement, state: 'withdrawn', decidedBy: actorId, decidedAt: this.deps.now() });
  }
  /** Patterns the same person shared from their other brands. Labelled as patterns, never evidence for this brand. */
  async otherBrandPatterns(actorId: string, brandId: string): Promise<PatternRow[]> {
    await this.studio.context(actorId, brandId);
    return this.deps.learning ? this.deps.learning.patterns(brandId, 'other').catch(() => []) : [];
  }
  /** Owner-chosen copy of one recorded finding set into the existing brand guidance as audience notes. */
  async copyToGuidance(actorId: string, brandId: string, campaignId: string, findingId: string, acknowledged: boolean): Promise<{ documentId: string }> {
    if (!this.deps.guidance || !this.deps.learning) throw new SeoBlogError(503, 'Brand guidance is not available here.');
    if (!acknowledged) throw new SeoBlogError(400, 'Confirm that you understand the brand profile must be refreshed and confirmed again.');
    const { record } = await this.campaign(actorId, brandId, campaignId);
    const finding = (await this.deps.learning.listFindings(brandId, campaignId)).find((f) => f.id === findingId);
    if (!finding) throw new SeoBlogError(404, 'That recorded finding was not found.');
    return this.deps.guidance.saveAudienceNote(actorId, brandId, `Campaign findings · ${record.brief.name} · ${finding.recordedAt.slice(0, 10)}`.slice(0, 160), findingsText(finding.snapshot, finding.recordedAt, record.brief.name));
  }
}

function acquisitionProposal(record: CreatorRecord | null): AcquisitionProposal | null {
  return record?.brief.kind === 'acquisition' && record.version && 'concepts' in record.version.content ? record.version.content as AcquisitionProposal : null;
}
function derivedId(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function articleTitle(a: Article): string { const t = a.slug.replace(/-/gu, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }

export function currentHeads(record: CreativeSetRecord): CreativeVersion[] {
  const heads = new Map<string, CreativeVersion>();
  for (const v of record.versions) { const k = variantKey(v); if (!heads.has(k) || heads.get(k)!.number < v.number) heads.set(k, v); }
  return [...heads.values()];
}

export type ApprovalState = 'approved' | 'stale' | 'unapproved';
export function setView(record: CreativeSetRecord, context: CreativeBrandContext) {
  const heads = currentHeads(record);
  const current = context.confirmed ? { profileVersion: context.profileVersion!, factsSha: context.factsSha!, kitVersion: context.kitVersion } : null;
  const concepts = [...new Set(heads.filter((h) => mediaOf(h) === 'image').map((h) => h.conceptKey))].sort().map((key) => {
    const all = heads.filter((h) => h.conceptKey === key).sort((a, b) => a.placement.localeCompare(b.placement) || a.card - b.card).map((v) => {
      const approval = record.approvals.find((a) => a.versionId === v.id) ?? null;
      const state: ApprovalState = approval ? (current && approvalProblem(v, true, approval, current) === null ? 'approved' : 'stale') : 'unapproved';
      const history = record.versions.filter((x) => variantKey(x) === variantKey(v)).sort((a, b) => b.number - a.number);
      const stale = !current || v.context.profileVersion !== current.profileVersion || v.context.factsSha !== current.factsSha || v.context.kitVersion !== current.kitVersion;
      return { version: v, approval, state, staleContext: stale, history, handoffs: record.handoffs.filter((h) => h.versionId === v.id) };
    });
    const variants = all.filter((x) => mediaOf(x.version) === 'image');
    return { key, concept: variants[0]!.version.concept, variants, storyboards: all.filter((x) => mediaOf(x.version) === 'storyboard'), videos: all.filter((x) => mediaOf(x.version) === 'video') };
  });
  return { concepts };
}
