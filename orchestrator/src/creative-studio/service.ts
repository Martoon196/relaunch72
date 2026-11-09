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
import { parseHex, RendererUnavailableError, type ArtworkInput, type ArtworkRenderer } from './renderer.js';
import { variantKey, approvalProblem, type CreativeLibraryStore, type CreativeSetRecord } from './store.js';
import {
  CREATIVE_PURPOSES, type BackgroundComponent, type BrandKit, type ConceptComponents, type ContextInputs, type CreativeApproval,
  type CreativeHandoff, type CreativePurpose, type CreativeRequest, type CreativeSet, type CreativeVersion, type Palette, type StoredImageRef,
} from './types.js';

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

  private corpus(context: CreativeBrandContext, set: CreativeSet, articleText: ArticleSourceText | null): string {
    return factsCorpus(context, articleText);
  }

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
    const corpus = this.corpus(context, set, articleText) + (request.source.kind === 'brief' ? '' : '');
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
    const heads = currentHeads(record).filter((v) => v.conceptKey === conceptKey);
    if (!heads.length) throw new SeoBlogError(404, 'That concept was not found.');
    if (expectedHeads.length && (heads.length !== expectedHeads.length || heads.some((h) => !expectedHeads.includes(h.id)))) throw new SeoBlogError(409, 'This concept changed while you were editing. Refresh and review the current version.');
    return { record, heads };
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
    const corpus = this.corpus(context, record.set, await this.articleFor(brandId, record.set));
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
    if (!found) throw new SeoBlogError(404, 'That artwork version was not found.');
    if (!found.head) throw new SeoBlogError(409, 'A newer version of this artwork exists. Edit the current version.');
    const v = found.version, record = (await this.deps.library.getSet(brandId, v.setId))!;
    const corpus = this.corpus(context, record.set, await this.articleFor(brandId, record.set));
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
    const corpus = this.corpus(context, record.set, await this.articleFor(brandId, record.set));
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

  /** Hand an approved exact version to an existing campaign as a draft input. Nothing is published, scheduled or spent. */
  async handoff(actorId: string, brandId: string, versionId: string, commandId: string, target: CreativeHandoff['target']): Promise<{ replayed: boolean }> {
    const { context } = await this.context(actorId, brandId);
    if (!UUID.test(commandId)) throw new SeoBlogError(400, 'Refresh the page and try again.');
    if (target.kind === 'article_campaign' && !(await this.deps.brands.getArticle(brandId, target.articleId))) throw new SeoBlogError(404, 'That campaign was not found.');
    const inputSha = sha(canonical({ versionId, target }));
    const replay = await this.deps.library.commandResult(brandId, commandId, inputSha);
    if (replay) return { replayed: true };
    const found = UUID.test(versionId) ? await this.deps.library.getVersion(brandId, versionId) : null;
    if (!found?.approval) throw new SeoBlogError(409, 'Approve this exact artwork version before adding it to a campaign.');
    const handoff: CreativeHandoff = Object.freeze({ id: this.newId(), versionId, approvalId: found.approval.id, target, state: 'ready_for_review', createdBy: actorId, createdAt: this.now() });
    const receipt = await this.deps.library.handoff(brandId, commandId, inputSha, handoff, this.inputs(context));
    return { replayed: receipt.replayed };
  }
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
  const concepts = [...new Set(heads.map((h) => h.conceptKey))].sort().map((key) => {
    const variants = heads.filter((h) => h.conceptKey === key).sort((a, b) => a.placement.localeCompare(b.placement) || a.card - b.card).map((v) => {
      const approval = record.approvals.find((a) => a.versionId === v.id) ?? null;
      const state: ApprovalState = approval ? (current && approvalProblem(v, true, approval, current) === null ? 'approved' : 'stale') : 'unapproved';
      const history = record.versions.filter((x) => variantKey(x) === variantKey(v)).sort((a, b) => b.number - a.number);
      const stale = !current || v.context.profileVersion !== current.profileVersion || v.context.factsSha !== current.factsSha || v.context.kitVersion !== current.kitVersion;
      return { version: v, approval, state, staleContext: stale, history, handoffs: record.handoffs.filter((h) => h.versionId === v.id) };
    });
    return { key, concept: variants[0]!.version.concept, variants };
  });
  return { concepts };
}
