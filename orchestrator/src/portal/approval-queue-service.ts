/**
 * One approval queue for every business the owner manages. This is an aggregator, not a new approval system:
 * every Approve or Refuse calls the same function the item's own page calls, with the same
 * arguments, so the same checks, audit records and idempotency apply. The queue adds only
 * a signed reference that binds what the owner saw (ids, exact hash/version, row version and
 * a server-minted command id) so a changed item is reported as "changed, review it again".
 *
 * Approving content never gives permission to contact a person and never spends money:
 * no enrol, start, send, schedule or paid-generation function is reachable from here.
 *
 * Which business: the browser may ask for one with ?brand=<id>, but the answer always comes from the
 * list of brand workspaces the signed-in user manages (the same PostgreSQL membership check the SEO
 * engine uses). The chosen brand is part of every signed item reference, and each decision re-checks
 * membership of that brand, so an item can never be approved under a different business.
 * Follow-up flows and "Your content" stay with the workspace the session is signed in to.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PortalSessionIdentity } from './auth-service.js';
import type { PortalSeoBlogService } from './seo-blog-service.js';
import type { PortalCompanyContentService } from './company-content-service.js';
import type { PortalFollowupFlowService } from './followup-flow-service.js';
import { PP_FOLLOWUP_SOURCE } from './followup-flow-service.js';
import { exactReviewApprovalToken, verifyExactReviewApprovalToken } from './content-control-room-actions.js';
import { SEO_BLOG_BASE } from './seo-blog-view.js';
import type { SeoBlogEngine } from '../seo-blog/engine.js';
import { sha256 } from '../seo-blog/engine.js';
import { SeoBlogError, type Article, type ArticleBrief, type ArticleVersion, type Brand } from '../seo-blog/types.js';
import { campaignParentHold, currentCampaignRevision } from '../seo-blog/campaign.js';
import { linkedPromotionFor, SEO_BLOG_SOURCE_SYSTEM } from '../seo-blog/promotions.js';
import type { CreatorRecord } from '../seo-blog/campaign-creator.js';
import { setView, type CreativeStudioService } from '../creative-studio/service.js';
import { mediaOf } from '../creative-studio/store.js';
import { PURPOSE_LABELS, type CreativeVersion } from '../creative-studio/types.js';
import { FlowWorkspaceError } from '../followup-sequences/workspace.js';
import { flowMessageContract } from '../followup-sequences/channel-drafts.js';
import { FOLLOWUP_SEQUENCE_SOURCE } from '../followup-sequences/definition.js';
import { MHP_OWNER_EMAIL_SOURCE } from '../mhp/owner-email-content.js';
import { PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM, PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_SYSTEM } from '../company-content-pg/property-predator-owned-seed-attestation-policy.js';
import type { CompanyContentCatalogItem, CompanyContentExactReview, CompanyContentSourceProvenance } from '../company-content-pg/types.js';

export const APPROVAL_QUEUE_ROUTE = '/portal/approvals' as const;
export const APPROVAL_QUEUE_DECIDE_ROUTE = '/portal/approvals/decide' as const;
export const APPROVAL_QUEUE_BATCH_ROUTE = '/portal/approvals/batch' as const;
export const APPROVAL_QUEUE_BATCH_MAX = 20;
/** A page left open longer than this must be refreshed before a decision. */
export const APPROVAL_REF_TTL_MS = 12 * 60 * 60 * 1000;
const PER_KIND_LIMIT = 30;
const ARTICLE_READ_LIMIT = 30;
const CREATIVE_SET_LIMIT = 15;
const CONTENT_REVIEW_LIMIT = 20;
/** "All businesses" counts each business by reading its queue, so only this many are counted; the rest are still listed. */
export const APPROVAL_ALL_COUNT_MAX = 8;

export type ApprovalKind = 'article' | 'plan' | 'campaign_post' | 'promotion' | 'creator' | 'creative' | 'flow' | 'content';
export const APPROVAL_KIND_LABELS: Readonly<Record<ApprovalKind, string>> = Object.freeze({
  article: 'Blog articles', plan: 'Topic plans', campaign_post: 'Social posts for articles', promotion: 'Posts that go with an article',
  creator: 'Campaign drafts', creative: 'Images and videos', flow: 'Follow-up flows', content: 'Your content',
});
const KIND_ORDER: readonly ApprovalKind[] = ['article', 'campaign_post', 'promotion', 'creative', 'content', 'flow', 'creator', 'plan'];

/** Source systems whose approvals belong to another adapter (or to a send rail). The general content adapter never lists them. */
export function ownedElsewhere(source: Pick<CompanyContentSourceProvenance, 'system' | 'itemId'>): boolean {
  const flowMessageSources = (['pp', 'mhp'] as const).flatMap((brand) => (['email', 'sms', 'whatsapp'] as const).map((channel) => flowMessageContract(brand, channel).source));
  if ([SEO_BLOG_SOURCE_SYSTEM, PP_FOLLOWUP_SOURCE, FOLLOWUP_SEQUENCE_SOURCE, MHP_OWNER_EMAIL_SOURCE, ...flowMessageSources].includes(source.system)) return true;
  return source.system === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_SYSTEM && source.itemId === PROPERTY_PREDATOR_OWNED_SEED_PROOF_SOURCE_ITEM;
}

export class ApprovalQueueError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApprovalQueueError'; }
}
const CHANGED = 'This item changed since you looked at it. Review it again.';
function changed(): never { throw new ApprovalQueueError(409, CHANGED); }

// ─── Which business ────────────────────────────────────────────────────────

/** ?brand=all: the list of businesses with what is waiting in each. */
export const BRAND_ALL = 'all' as const;
/** ?brand=account: only the signed-in workspace's own items, when that workspace is not itself a brand. */
export const BRAND_ACCOUNT = 'account' as const;
const BRAND_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NO_BUSINESS = 'That business was not found. Nothing was changed.';

export interface QueueBrand { readonly id: string; readonly name: string }
export interface BrandSelection {
  /** Every brand workspace the signed-in user manages, in the order the SEO engine lists them. */
  readonly brands: readonly QueueBrand[];
  /** The business this page is for. Null for "All businesses", for the signed-in account's own items, and when there is no brand. */
  readonly selected: QueueBrand | null;
  readonly view: 'brand' | 'all' | 'account';
  /** The workspace this session is signed in to. Follow-up flows and "Your content" belong to it. */
  readonly sessionWorkspaceId: string;
  /** Whether a new business can be added here (the SEO area is mounted). */
  readonly canAdd: boolean;
}

/**
 * Resolves the business a page is for. The requested id is only a selector: it must be one of the brand
 * workspaces this user manages, otherwise the request is refused (the same answer for a malformed id, an
 * unknown id and somebody else's brand). With nothing requested: the signed-in workspace when it is a
 * brand, otherwise the first brand the user manages.
 */
export async function selectApprovalBrand(seoBlog: PortalSeoBlogService | undefined, identity: PortalSessionIdentity, requestId: string,
  requested: string | null | undefined): Promise<BrandSelection> {
  let managed: Brand[] = [];
  if (seoBlog) {
    try { managed = await seoBlog.engineFor(identity, requestId).listBrands({ userId: identity.userId }); }
    catch (error) { if (!(error instanceof SeoBlogError && [403, 404, 409].includes(error.status))) throw error; }
  }
  const brands = managed.map((b) => ({ id: b.id.toLowerCase(), name: b.name }));
  const base = { brands, sessionWorkspaceId: identity.workspaceId, canAdd: Boolean(seoBlog) };
  const wanted = (requested ?? '').trim();
  if (!wanted) {
    const selected = brands.find((b) => b.id === identity.workspaceId.toLowerCase()) ?? brands[0] ?? null;
    return { ...base, selected, view: selected ? 'brand' : 'account' };
  }
  if (wanted === BRAND_ACCOUNT || (wanted === BRAND_ALL && !brands.length)) return { ...base, selected: null, view: 'account' };
  if (wanted === BRAND_ALL) return { ...base, selected: null, view: 'all' };
  const selected = wanted.length === 36 && BRAND_ID.test(wanted.toLowerCase()) ? brands.find((b) => b.id === wanted.toLowerCase()) : undefined;
  if (!selected) throw new ApprovalQueueError(404, NO_BUSINESS);
  return { ...base, selected, view: 'brand' };
}

/** The brand query string for a link back to the same view. */
export function brandQuery(selection: Pick<BrandSelection, 'selected' | 'view'>): string {
  return selection.view === 'all' ? `?brand=${BRAND_ALL}` : selection.selected ? `?brand=${selection.selected.id}` : `?brand=${BRAND_ACCOUNT}`;
}

// ─── Signed per-item reference ─────────────────────────────────────────────

export interface ApprovalRef {
  readonly k: ApprovalKind;
  /** The business (brand workspace) this item belongs to. Signed with the rest; a decision is only ever made inside it. */
  readonly b: string;
  readonly ids: Readonly<Record<string, string>>;
  /** Expected exact state when the owner looked: hashes, version ids, row versions. */
  readonly x: Readonly<Record<string, string>>;
  /** Server-minted command id: a retried decision replays instead of repeating. */
  readonly c: string;
  /** Separate server-minted command id for a refusal (where one exists). */
  readonly d: string;
  readonly t: number;
  /** Display title for per-item batch results (signed, never trusted from the form). */
  readonly n: string;
}
// v2: the business is part of what is signed. A page minted before that must be refreshed.
const REF_CONTEXT = 'relaunch72:approval-queue-ref:v2\0';
const mac = (secret: string, sessionToken: string, payload: string) => createHmac('sha256', secret).update(REF_CONTEXT).update(sessionToken).update('\0').update(payload).digest('base64url');

export function signApprovalRef(secret: string, sessionToken: string, ref: ApprovalRef): string {
  const payload = Buffer.from(JSON.stringify(ref)).toString('base64url');
  return `${payload}.${mac(secret, sessionToken, payload)}`;
}

/** Null for anything not minted for this session, expired, or malformed. */
export function verifyApprovalRef(secret: string, sessionToken: string, token: string | null | undefined, now: number): ApprovalRef | null {
  if (!secret || !sessionToken || !token || token.length > 6000) return null;
  const [payload, given, extra] = token.split('.');
  if (!payload || !given || extra !== undefined) return null;
  const expected = Buffer.from(mac(secret, sessionToken, payload)), actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const ref = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ApprovalRef;
    if (!KIND_ORDER.includes(ref.k) || typeof ref.b !== 'string' || !BRAND_ID.test(ref.b) || typeof ref.c !== 'string' || typeof ref.d !== 'string' || !Number.isSafeInteger(ref.t)
      || ref.t > now + 60_000 || now - ref.t > APPROVAL_REF_TTL_MS || typeof ref.ids !== 'object' || typeof ref.x !== 'object' || typeof ref.n !== 'string') return null;
    return ref;
  } catch { return null; }
}

// ─── Read model ────────────────────────────────────────────────────────────

export interface ApprovalItem {
  readonly kind: ApprovalKind;
  readonly ref: string;
  readonly label: string;
  readonly title: string;
  readonly preview: string;
  readonly why: string;
  readonly since: string | null;
  readonly imageHref?: string | null;
  readonly videoHref?: string | null;
  /** ready: Approve works now. blocked: the item's own page must be used first (reason given). */
  readonly state: 'ready' | 'blocked';
  readonly blockedReason?: string;
  /** The item's existing confirmation, shown as a required tick box. Such items are never batched. */
  readonly confirmation?: string;
  readonly refuseLabel?: string;
  readonly editHref: string;
  readonly editLabel: string;
  readonly batchable: boolean;
}
export interface ApprovalSection { readonly kind: ApprovalKind; readonly label: string; readonly items: readonly ApprovalItem[]; readonly error?: string }
export interface ApprovalQueueSnapshot {
  readonly sections: readonly ApprovalSection[]; readonly total: number; readonly ready: number;
  readonly selection: BrandSelection;
  /** The business every item on this page is signed for: the form sends it back and it must match each item. */
  readonly brandKey: string;
  /** True when the signed-in workspace's own sections (flows, Your content) are part of this page. */
  readonly sessionSections: boolean;
}
export interface ApprovalBrandCount { readonly brand: QueueBrand; readonly total: number | null; readonly ready: number | null; readonly counted: boolean }
export interface ApprovalOverview { readonly selection: BrandSelection; readonly rows: readonly ApprovalBrandCount[] }
export interface ApprovalDecisionResult { readonly ok: boolean; readonly title: string; readonly message: string }

export interface ApprovalQueueDependencies {
  readonly sessionSecret: string;
  readonly seoBlog?: PortalSeoBlogService;
  readonly flows?: Pick<PortalFollowupFlowService, 'snapshot' | 'publish'>;
  readonly companyContent?: PortalCompanyContentService;
  /** Follow-up flows are listed only where their own workspace runs (Property Predator host). */
  readonly flowsAvailable?: boolean;
  readonly now?: () => number;
  readonly newId?: () => string;
}

const clip = (text: string, max = 600) => { const t = text.replace(/\s+/gu, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const angleLabel = (angle: string) => angle.replace(/_/gu, ' ');
const networkLabel = (network: string) => network === 'instagram' ? 'Instagram' : network === 'linkedin' ? 'LinkedIn' : network;

interface Ctx { identity: PortalSessionIdentity; requestId: string; now: number }
const SESSION_KINDS: ReadonlySet<ApprovalKind> = new Set(['flow', 'content']);
interface Seo { engine: SeoBlogEngine; actor: { userId: string }; brandId: string }

export class ApprovalQueueService {
  constructor(private readonly deps: ApprovalQueueDependencies) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private newId(): string { return this.deps.newId?.() ?? randomUUID(); }

  private seo(ctx: Ctx, brandId: string): Seo | null {
    if (!this.deps.seoBlog) return null;
    return { engine: this.deps.seoBlog.engineFor(ctx.identity, ctx.requestId), actor: { userId: ctx.identity.userId }, brandId };
  }
  private studio(ctx: Ctx, seo: Seo): CreativeStudioService | null {
    return this.deps.seoBlog?.creativeFor?.(ctx.identity, ctx.requestId, seo.engine) ?? null;
  }
  /** Signs an item for its business: the SEO brand it was read from, or the signed-in workspace for flows and Your content. */
  private sign(ctx: Ctx, brandId: string, k: ApprovalKind, title: string, ids: Record<string, string>, x: Record<string, string>): string {
    return signApprovalRef(this.deps.sessionSecret, ctx.identity.sessionToken, { k, b: brandId.toLowerCase(), ids, x, c: this.newId(), d: this.newId(), t: ctx.now, n: clip(title, 120) });
  }

  /** The businesses this user manages and the one a request is for. Refuses an id the user does not manage. */
  select(identity: PortalSessionIdentity, requestId: string, requested?: string | null): Promise<BrandSelection> {
    return selectApprovalBrand(this.deps.seoBlog, identity, requestId, requested);
  }

  /** One business's queue. `requested` is the untrusted ?brand value; it is resolved against the managed brand list here. */
  async list(identity: PortalSessionIdentity, requestId: string, requested?: string | null): Promise<ApprovalQueueSnapshot> {
    const selection = await this.select(identity, requestId, requested);
    if (selection.view === 'all') throw new ApprovalQueueError(400, 'Choose one business to see its items.');
    return this.listFor({ identity, requestId, now: this.now() }, selection);
  }

  /** "All businesses": each business with what is waiting in it. A business that cannot be counted says so; it is never shown as zero. */
  async overview(identity: PortalSessionIdentity, requestId: string): Promise<ApprovalOverview> {
    const selection = await this.select(identity, requestId, BRAND_ALL);
    const ctx: Ctx = { identity, requestId, now: this.now() };
    const rows = await Promise.all(selection.brands.map(async (brand, index): Promise<ApprovalBrandCount> => {
      if (index >= APPROVAL_ALL_COUNT_MAX) return { brand, total: null, ready: null, counted: false };
      try {
        const snapshot = await this.listFor(ctx, { ...selection, selected: brand, view: 'brand' });
        // A section that could not be read makes the number a guess, so no number is shown.
        if (snapshot.sections.some((s) => s.error)) return { brand, total: null, ready: null, counted: true };
        return { brand, total: snapshot.total, ready: snapshot.ready, counted: true };
      } catch { return { brand, total: null, ready: null, counted: true }; }
    }));
    return { selection, rows };
  }

  private async listFor(ctx: Ctx, selection: BrandSelection): Promise<ApprovalQueueSnapshot> {
    const { identity } = ctx;
    const seo = selection.selected ? this.seo(ctx, selection.selected.id) : null;
    // Flows and Your content are read through the session, so they only ever belong to the signed-in workspace.
    const sessionSections = !selection.selected || selection.selected.id === identity.workspaceId.toLowerCase();
    const loaders: [ApprovalKind, () => Promise<ApprovalItem[] | null>][] = [];
    if (seo) {
      // Shared by three sections; a failure is reported by each section that needs it, never thrown from here.
      const articles = Promise.resolve().then(() => this.articleData(seo));
      articles.catch(() => undefined);
      const briefs = Promise.resolve().then(() => seo.engine.listPlans(seo.actor, seo.brandId)).catch(() => []);
      loaders.push(['article', async () => this.listArticles(ctx, seo, await articles, await briefs)]);
      loaders.push(['campaign_post', async () => this.listCampaignPosts(ctx, seo, await articles)]);
      loaders.push(['promotion', async () => this.listPromotions(ctx, seo, await articles)]);
      loaders.push(['plan', async () => this.listPlans(ctx, seo)]);
      loaders.push(['creator', async () => this.listCreators(ctx, seo)]);
      loaders.push(['creative', async () => this.listCreative(ctx, seo)]);
    }
    if (sessionSections && this.deps.flows && this.deps.flowsAvailable) loaders.push(['flow', async () => this.listFlows(ctx)]);
    if (sessionSections && this.deps.companyContent) loaders.push(['content', async () => this.listContent(ctx)]);
    const settled = await Promise.all(loaders.map(async ([kind, load]) => {
      try {
        const items = await load();
        return items === null ? null : { kind, label: APPROVAL_KIND_LABELS[kind], items: items.slice(0, PER_KIND_LIMIT) } as ApprovalSection;
      } catch (error) {
        // An area that is not set up for this workspace is simply absent; anything else is reported, not hidden.
        if (error instanceof SeoBlogError && (error.status === 404 || error.status === 409)) return null;
        return { kind, label: APPROVAL_KIND_LABELS[kind], items: [], error: 'These could not be loaded just now. Nothing was changed.' } as ApprovalSection;
      }
    }));
    const sections = settled.filter((s): s is ApprovalSection => s !== null && (s.items.length > 0 || Boolean(s.error)))
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    const all = sections.flatMap((s) => s.items);
    return { sections, total: all.length, ready: all.filter((i) => i.state === 'ready').length, selection,
      brandKey: (selection.selected?.id ?? identity.workspaceId).toLowerCase(), sessionSections };
  }

  // ── A–D: SEO articles and their posts ──
  private async articleData(seo: Seo): Promise<{ article: Article; version: ArticleVersion; status: string; title: string }[]> {
    const listed = await seo.engine.listArticles(seo.actor, seo.brandId);
    const candidates = listed.filter((x) => x.article.currentVersionId && !['Published', 'Publishing', 'Researching', 'Writing', 'Failed'].includes(x.status))
      .sort((a, b) => b.article.createdAt.localeCompare(a.article.createdAt)).slice(0, ARTICLE_READ_LIMIT);
    const out: { article: Article; version: ArticleVersion; status: string; title: string }[] = [];
    for (const c of candidates) {
      const detail = await seo.engine.getArticle(seo.actor, seo.brandId, c.article.id);
      if (detail.version) out.push({ article: detail.article, version: detail.version, status: detail.status, title: c.title });
    }
    return out;
  }
  private articleHref(seo: Seo, articleId: string, suffix = '') { return `${SEO_BLOG_BASE}/b/${seo.brandId}/articles/${articleId}${suffix}`; }

  private listArticles(ctx: Ctx, seo: Seo, data: Awaited<ReturnType<ApprovalQueueService['articleData']>>, plans: { briefs: ArticleBrief[] }[]): ApprovalItem[] {
    const briefs = plans.flatMap((p) => p.briefs);
    return data.filter((d) => d.status === 'Needs approval').map(({ article, version, title }) => {
      const brief = briefs.find((b) => b.id === article.briefId);
      const critical = article.checks?.status === 'critical';
      return {
        kind: 'article', label: 'Blog article', title, since: version.createdAt,
        ref: this.sign(ctx, seo.brandId, 'article', title, { articleId: article.id, versionId: version.id }, { rowVersion: String(article.rowVersion), contentSha: version.contentSha }),
        preview: clip(`${version.body.excerpt} ${version.body.intro}`), why: brief ? clip(`${brief.whyFit}${brief.targetQuery ? ` Search: “${brief.targetQuery}”.` : ''}`, 400) : 'Written from your accepted topic plan.',
        state: critical ? 'blocked' : 'ready', ...(critical ? { blockedReason: 'Checks found a serious problem. Fix it in the editor first; approval cannot override it.' } : {}),
        refuseLabel: 'Not now — keep off the website', editHref: this.articleHref(seo, article.id), editLabel: 'Read the full article', batchable: !critical,
      } satisfies ApprovalItem;
    });
  }

  private listCampaignPosts(ctx: Ctx, seo: Seo, data: Awaited<ReturnType<ApprovalQueueService['articleData']>>): ApprovalItem[] {
    const out: ApprovalItem[] = [];
    for (const { article, version, title } of data) {
      const campaign = article.campaign;
      if (!campaign || article.currentVersionId !== version.id) continue;
      for (const variant of campaign.variants) {
        if (variant.omitted) continue;
        let revision;
        try { revision = currentCampaignRevision(variant); } catch { continue; }
        if (variant.approval?.revisionId === revision.id && variant.approval.revisionSha256 === revision.sha256) continue;
        let hold: string | null;
        try { hold = campaignParentHold(article, version, campaign, variant, false); } catch (error) { hold = error instanceof Error ? error.message : CHANGED; }
        const media = revision.media && (variant.mediaAuthorization?.revisionId !== revision.id || variant.mediaAuthorization.revisionSha256 !== revision.sha256 || variant.mediaAuthorization.mediaUseId !== revision.media.useId)
          ? 'Authorise the exact image for this post on its campaign page first.' : null;
        const blocked = hold ?? media;
        out.push({
          kind: 'campaign_post', label: `${networkLabel(variant.network)} post`, title: revision.title || `${networkLabel(variant.network)} · ${angleLabel(variant.angle)}`, since: revision.createdAt,
          ref: this.sign(ctx, seo.brandId, 'campaign_post', revision.title || `${networkLabel(variant.network)} post`, { articleId: article.id, versionId: version.id, variantId: variant.id, revisionId: revision.id }, { revisionSha: revision.sha256 }),
          preview: clip(`${revision.copy}${revision.canonicalUrl ? ` ${revision.canonicalUrl}` : ''}`), why: `Planned ${angleLabel(variant.angle)} post for your article “${title}”.${revision.media ? ' Includes an image.' : ''}`,
          state: blocked ? 'blocked' : 'ready', ...(blocked ? { blockedReason: blocked } : {}), refuseLabel: 'Leave this post out',
          editHref: this.articleHref(seo, article.id, '/campaign'), editLabel: 'Edit on the campaign page', batchable: !blocked,
        });
      }
    }
    return out;
  }

  private listPromotions(ctx: Ctx, seo: Seo, data: Awaited<ReturnType<ApprovalQueueService['articleData']>>): ApprovalItem[] {
    const out: ApprovalItem[] = [];
    for (const { article, version, title } of data) {
      const pack = version.promotionPack;
      if (!pack || article.currentVersionId !== version.id) continue;
      const packSha = sha256(pack);
      for (const post of pack.posts) {
        if (linkedPromotionFor(article, version, post.network)) continue;
        const blocked = pack.canonicalUrl ? null : 'Connect the blog website, then create a new promotion version with its final address.';
        out.push({
          kind: 'promotion', label: `${networkLabel(post.network)} post`, title: post.title, since: version.createdAt,
          ref: this.sign(ctx, seo.brandId, 'promotion', post.title, { articleId: article.id, versionId: version.id, network: post.network }, { packSha }),
          preview: clip(`${post.copy}${pack.canonicalUrl ? ` ${pack.canonicalUrl}` : ''}`), why: `Goes out with your article “${title}” once it is live.`,
          state: blocked ? 'blocked' : 'ready', ...(blocked ? { blockedReason: blocked } : {}), editHref: this.articleHref(seo, article.id), editLabel: 'Read the full article', batchable: !blocked,
        });
      }
    }
    return out;
  }

  private async listPlans(ctx: Ctx, seo: Seo): Promise<ApprovalItem[]> {
    const plans = await seo.engine.listPlans(seo.actor, seo.brandId);
    return plans.filter((p) => p.plan.status === 'proposed' && p.briefs.some((b) => b.status === 'planned')).map(({ plan, briefs }) => {
      const planned = briefs.filter((b) => b.status === 'planned');
      return {
        kind: 'plan', label: 'Topic plan', title: plan.topic, since: plan.createdAt,
        ref: this.sign(ctx, seo.brandId, 'plan', plan.topic, { planId: plan.id }, { planned: planned.map((b) => b.id).sort().join(',') }),
        preview: clip(planned.map((b) => `• ${b.workingTitle}`).join(' '), 700), why: clip(planned[0]?.whyFit ?? 'Suggested from your brand profile and research.', 400),
        state: 'ready', refuseLabel: 'Not now — drop these ideas', editHref: `${SEO_BLOG_BASE}/b/${seo.brandId}/topics`, editLabel: 'Open topics',
        batchable: true,
      } satisfies ApprovalItem;
    });
  }

  private async listCreators(ctx: Ctx, seo: Seo): Promise<ApprovalItem[] | null> {
    if (!seo.engine.campaignCreatorsReady) return null;
    const records = await seo.engine.creators().list(seo.actor.userId, seo.brandId);
    return records.filter((r): r is CreatorRecord & { version: NonNullable<CreatorRecord['version']> } => r.state === 'draft' && r.version !== null).map((r) => ({
      kind: 'creator', label: r.brief.kind === 'acquisition' ? 'Campaign proposal' : r.brief.kind === 'email' ? 'Email campaign' : 'Campaign draft', title: r.version.content.title || r.brief.name, since: r.version.createdAt,
      ref: this.sign(ctx, seo.brandId, 'creator', r.version.content.title || r.brief.name, { campaignId: r.id }, { rowVersion: String(r.rowVersion), contentSha: r.version.contentSha }),
      preview: clip(r.version.content.summary), why: clip(`Goal: ${r.brief.goal}`, 300), state: 'ready',
      confirmation: r.brief.kind === 'acquisition' ? 'I reviewed the evidence, wording and commercial claims of this exact proposal.' : 'I reviewed the wording, facts and permission process for this exact draft.',
      editHref: `${SEO_BLOG_BASE}/b/${seo.brandId}/campaigns/${r.id}`, editLabel: 'Open the full draft', batchable: false,
    } satisfies ApprovalItem));
  }

  private async listCreative(ctx: Ctx, seo: Seo): Promise<ApprovalItem[] | null> {
    const studio = this.studio(ctx, seo);
    if (!studio) return null;
    const overview = await studio.overview(seo.actor.userId, seo.brandId);
    const sets = [...overview.sets].sort((a, b) => b.set.createdAt.localeCompare(a.set.createdAt)).slice(0, CREATIVE_SET_LIMIT);
    const out: ApprovalItem[] = [];
    const base = `${SEO_BLOG_BASE}/b/${seo.brandId}/creative`;
    const art = (v: CreativeVersion) => `${base}/art/${v.id}/${v.render.sha256}.${v.render.mime === 'video/mp4' ? 'mp4' : v.render.mime === 'video/webm' ? 'webm' : 'jpg'}`;
    for (const summary of sets) {
      const { record, context } = await studio.getSet(seo.actor.userId, seo.brandId, summary.set.id);
      for (const concept of setView(record, context).concepts) {
        for (const entry of [...concept.variants, ...concept.videos]) {
          if (entry.state === 'approved') continue;
          const v = entry.version, video = mediaOf(v) === 'video';
          const blocking = v.issues.find((i) => i.blocking);
          const blocked = entry.staleContext ? 'Brand facts or the creative kit changed since this was made. Refresh it in Creative Studio first.'
            : blocking ? `Fix this first: ${blocking.detail}` : null;
          const figures = v.issues.some((i) => i.code === 'unsupported_figure');
          out.push({
            kind: 'creative', label: video ? 'Video' : 'Image', title: clip(`${v.concept.headline || v.concept.hook || 'Artwork'}`, 120), since: v.createdAt,
            ref: this.sign(ctx, seo.brandId, 'creative', v.concept.headline || 'Artwork', { setId: record.set.id, versionId: v.id }, { renderSha: v.render.sha256 }),
            preview: clip([v.concept.hook, v.concept.body, v.concept.cta].filter(Boolean).join(' · ')), why: clip(`${PURPOSE_LABELS[record.set.request.purpose] ?? 'Creative'} made in Creative Studio. ${v.change}`, 300),
            ...(video ? { videoHref: art(v) } : { imageHref: art(v) }),
            state: blocked ? 'blocked' : 'ready', ...(blocked ? { blockedReason: blocked } : {}),
            ...(figures ? { confirmation: 'I confirm the flagged figures are accurate.' } : {}),
            editHref: `${base}/s/${record.set.id}#v-${v.id}`, editLabel: 'Edit in Creative Studio', batchable: !blocked && !figures,
          });
        }
      }
    }
    return out;
  }

  // ── G: Property Predator follow-up flows ──
  private async listFlows(ctx: Ctx): Promise<ApprovalItem[]> {
    const snapshot = await this.deps.flows!.snapshot(ctx.identity, ctx.requestId);
    const latest = new Map<string, CompanyContentCatalogItem>();
    for (const item of snapshot.catalog.items) { const seen = latest.get(item.contentItemId); if (!seen || seen.versionNumber < item.versionNumber) latest.set(item.contentItemId, item); }
    return [...latest.values()].filter((i) => !(i.approvalStatus === 'approved' && !i.approvalStale)).map((item) => ({
      kind: 'flow', label: 'Follow-up flow', title: item.title, since: item.createdAt,
      ref: this.sign(ctx, ctx.identity.workspaceId, 'flow', item.title, { itemId: item.contentItemId, versionId: item.contentVersionId }, { contentSha: item.contentSha256 }),
      preview: `Version ${item.versionNumber}. Approving publishes this flow and the messages in it. It does not start the flow, add anyone or send anything.`,
      why: 'A follow-up flow you saved and have not published yet.', state: 'ready',
      editHref: `/portal/follow-ups?item=${encodeURIComponent(item.contentItemId)}&version=${encodeURIComponent(item.contentVersionId)}`, editLabel: 'Open the flow and its messages', batchable: true,
    } satisfies ApprovalItem));
  }

  // ── H: general company content (Your content) ──
  private async listContent(ctx: Ctx): Promise<ApprovalItem[] | null> {
    const service = this.deps.companyContent!;
    const outcome = await service.snapshot({ sessionToken: ctx.identity.sessionToken, requestId: ctx.requestId }, { limit: 100 });
    if (!outcome.ok) { if (outcome.kind === 'forbidden' || outcome.kind === 'unauthenticated') return null; throw new Error(outcome.kind); }
    const pending = outcome.snapshot.catalog.items.filter((i) => i.approvalStatus === 'pending' && !i.approvalStale && i.approvalRequestId && !ownedElsewhere(i.source)).slice(0, CONTENT_REVIEW_LIMIT);
    const out: ApprovalItem[] = [];
    for (const item of pending) {
      const edit = { editHref: `/portal/content?item=${encodeURIComponent(item.contentItemId)}&version=${encodeURIComponent(item.contentVersionId)}`, editLabel: 'Open in Your content' };
      const review = service.review ? await service.review({ sessionToken: ctx.identity.sessionToken, requestId: ctx.requestId }, { contentItemId: item.contentItemId, contentVersionId: item.contentVersionId }) : null;
      const exact: CompanyContentExactReview | null = review?.ok ? review.snapshot.review : null;
      const ready = Boolean(exact && exact.contentSha256 === item.contentSha256 && exact.approvalStatus === 'pending' && !exact.approvalStale && exact.approvalRequestId === item.approvalRequestId && service.decideExactReviewedApproval);
      const pictureMissing = Boolean(exact?.social?.artworkInstructions && !exact.social.image);
      const ids = { itemId: item.contentItemId, versionId: item.contentVersionId, approvalRequestId: item.approvalRequestId! };
      const token = ready ? exactReviewApprovalToken(this.deps.sessionSecret, ctx.identity.sessionToken,
        { contentItemId: item.contentItemId, contentVersionId: item.contentVersionId, approvalRequestId: item.approvalRequestId!, contentSha256: item.contentSha256 }, ctx.now) : '';
      const preview = exact?.social ? `${exact.social.publicationCopy}${exact.social.ctaUrl ? ` ${exact.social.ctaUrl}` : ''}` : exact?.email ? `${exact.email.subject} — ${exact.email.bodyText}` : '';
      const blocked = !ready ? 'Open it in Your content to see the exact version before deciding.' : pictureMissing ? 'Add the picture first: this post only has image instructions.' : null;
      out.push({
        kind: 'content', label: exact?.social ? `${exact.social.platform} post` : exact?.email ? 'Email' : 'Content', title: item.title, since: item.createdAt,
        ref: this.sign(ctx, ctx.identity.workspaceId, 'content', item.title, ids, { contentSha: item.contentSha256, exact: token }), preview: clip(preview || 'Exact content is shown on its own page.'),
        why: 'A draft in Your content that is waiting for your decision.', state: blocked ? 'blocked' : 'ready', ...(blocked ? { blockedReason: blocked } : {}),
        refuseLabel: 'Refuse', ...edit, batchable: false,
      });
    }
    return out;
  }

  // ─── Decisions ───────────────────────────────────────────────────────────

  /** One item through its own existing function. Throws ApprovalQueueError (or the area's own error) with owner-facing copy. */
  async decide(identity: PortalSessionIdentity, requestId: string, ref: ApprovalRef, action: 'approve' | 'refuse', confirmed: boolean): Promise<string> {
    const ctx: Ctx = { identity, requestId, now: this.now() };
    const { ids, x } = ref;
    // The business comes from the signed reference only. Flows and Your content act through the session, so their
    // reference must name the signed-in workspace; everything else must name a brand this user still manages.
    if (SESSION_KINDS.has(ref.k) ? ref.b !== identity.workspaceId.toLowerCase() : !BRAND_ID.test(ref.b)) changed();
    const need = async (): Promise<Seo> => {
      const seo = this.seo(ctx, ref.b);
      if (!seo) throw new ApprovalQueueError(404, 'This area is not available here.');
      try { await seo.engine.getBrand(seo.actor, ref.b); }
      catch (error) { if (error instanceof SeoBlogError && [403, 404].includes(error.status)) throw new ApprovalQueueError(404, NO_BUSINESS); throw error; }
      return seo;
    };
    const noRefuse = () => { throw new ApprovalQueueError(400, 'Refusing is not available for this item. Leave it, or edit it on its own page.'); };
    switch (ref.k) {
      case 'article': {
        const seo = await need(), d = await seo.engine.getArticle(seo.actor, seo.brandId, ids.articleId!);
        if (!d.version || d.version.id !== ids.versionId || d.version.contentSha !== x.contentSha) changed();
        if (action === 'refuse') {
          if (String(d.article.rowVersion) !== x.rowVersion) changed();
          await seo.engine.hold(seo.actor, seo.brandId, ids.articleId!, Number(x.rowVersion), true);
          return 'Held. It will not be published until you release the hold.';
        }
        if (d.article.approval?.versionId === ids.versionId) return 'Already approved. Nothing changed.';
        await seo.engine.approve(seo.actor, seo.brandId, ids.articleId!, ids.versionId!);
        return 'Approved. Publishing still follows its own schedule and checks.';
      }
      case 'plan': {
        const seo = await need(), found = (await seo.engine.listPlans(seo.actor, seo.brandId)).find((p) => p.plan.id === ids.planId);
        if (!found) changed();
        const planned = found!.briefs.filter((b) => b.status === 'planned');
        if (action === 'approve' && found!.plan.status === 'accepted') return 'Already accepted. Nothing changed.';
        if (found!.plan.status !== 'proposed' || planned.map((b) => b.id).sort().join(',') !== x.planned) changed();
        if (action === 'refuse') {
          for (const brief of planned) await seo.engine.setBriefStatus(seo.actor, seo.brandId, brief.id, 'omitted');
          return 'These ideas were dropped. You can restore them on the topics page.';
        }
        await seo.engine.acceptPlan(seo.actor, seo.brandId, ids.planId!);
        return 'Plan accepted. No articles are written until you ask for them.';
      }
      case 'campaign_post': {
        const seo = await need(), d = await seo.engine.getArticle(seo.actor, seo.brandId, ids.articleId!);
        const variant = d.article.campaign?.variants.find((v) => v.id === ids.variantId);
        if (!d.version || d.version.id !== ids.versionId || !variant || variant.currentRevisionId !== ids.revisionId) changed();
        const revision = currentCampaignRevision(variant!);
        if (revision.sha256 !== x.revisionSha) changed();
        const selection = { variantId: ids.variantId!, revisionId: ids.revisionId! };
        if (action === 'refuse') {
          await seo.engine.controlCampaignPost(seo.actor, seo.brandId, ids.articleId!, ids.versionId!, selection, { kind: 'omit', omitted: true });
          return 'Left out of the campaign. You can include it again on the campaign page.';
        }
        await seo.engine.approveCampaignPost(seo.actor, seo.brandId, ids.articleId!, ids.versionId!, selection);
        return 'Post approved. Scheduling and posting are still separate steps.';
      }
      case 'promotion': {
        if (action === 'refuse') noRefuse();
        const seo = await need(), d = await seo.engine.getArticle(seo.actor, seo.brandId, ids.articleId!);
        const network = ids.network === 'instagram' || ids.network === 'linkedin' ? ids.network : changed();
        if (!d.version || d.version.id !== ids.versionId || !d.version.promotionPack || sha256(d.version.promotionPack) !== x.packSha) changed();
        if (linkedPromotionFor(d.article, d.version!, network)) return 'Already approved. Nothing changed.';
        await seo.engine.approvePromotion(seo.actor, seo.brandId, ids.articleId!, ids.versionId!, network, x.packSha!);
        return 'Post approved. It waits until the article is live and an account is connected.';
      }
      case 'creator': {
        if (action === 'refuse') noRefuse();
        const seo = await need(), creator = seo.engine.creators(), r = await creator.get(seo.actor.userId, seo.brandId, ids.campaignId!);
        if (!r.version || r.version.contentSha !== x.contentSha) changed();
        if (r.state === 'approved' && r.approval?.contentSha === x.contentSha) return 'Already approved. Nothing changed.';
        if (String(r.rowVersion) !== x.rowVersion) changed();
        await creator.approve(seo.actor.userId, seo.brandId, ids.campaignId!, Number(x.rowVersion), x.contentSha!, confirmed);
        return 'Campaign draft approved for export. Nothing was sent.';
      }
      case 'creative': {
        if (action === 'refuse') noRefuse();
        const seo = await need(), studio = this.studio(ctx, seo);
        if (!studio) throw new ApprovalQueueError(404, 'Creative Studio is not available here.');
        const { record, context } = await studio.getSet(seo.actor.userId, seo.brandId, ids.setId!);
        const entry = setView(record, context).concepts.flatMap((c) => [...c.variants, ...c.videos]).find((e) => e.version.id === ids.versionId);
        if (!entry || entry.version.render.sha256 !== x.renderSha) changed();
        if (entry!.state === 'approved') return 'Already approved. Nothing changed.';
        const receipt = await studio.approve(seo.actor.userId, seo.brandId, ids.versionId!, ref.c, x.renderSha!, confirmed);
        return receipt.replayed ? 'Already recorded. Nothing changed.' : 'Approved this exact asset. Captions, campaigns, schedules and paid adverts are not approved by this.';
      }
      case 'flow': {
        if (action === 'refuse') noRefuse();
        if (!this.deps.flows || !this.deps.flowsAvailable) throw new ApprovalQueueError(404, 'Follow-up flows are not available here.');
        const snapshot = await this.deps.flows.snapshot(identity, requestId);
        const item = snapshot.catalog.items.find((i) => i.contentItemId === ids.itemId && i.contentVersionId === ids.versionId);
        if (!item || item.contentSha256 !== x.contentSha) changed();
        if (item!.approvalStatus === 'approved' && !item!.approvalStale) return 'Already published. Nothing changed.';
        await this.deps.flows.publish(identity, requestId, ids.itemId!, ids.versionId!, ref.c, ctx.now);
        return 'Flow and its messages published. Nothing was started, no one was added and nothing was sent.';
      }
      case 'content': {
        const service = this.deps.companyContent;
        if (!service) throw new ApprovalQueueError(404, 'Your content is not available here.');
        const who = { sessionToken: identity.sessionToken, requestId };
        const exact = { contentItemId: ids.itemId!, contentVersionId: ids.versionId!, approvalRequestId: ids.approvalRequestId!, contentSha256: x.contentSha! };
        const outcome = action === 'refuse'
          ? await service.decideApproval(who, { commandKey: ref.d, approvalRequestId: exact.approvalRequestId, decision: 'rejected', decisionNote: null })
          : await (async () => {
            if (!service.decideExactReviewedApproval || !verifyExactReviewApprovalToken(this.deps.sessionSecret, identity.sessionToken, x.exact, exact, ctx.now)) {
              throw new ApprovalQueueError(409, 'This check has expired or the item changed. Refresh and review it again.');
            }
            return service.decideExactReviewedApproval(who, { commandKey: ref.c, approvalRequestId: exact.approvalRequestId, decision: 'approved', decisionNote: null,
              contentItemId: exact.contentItemId, contentVersionId: exact.contentVersionId, contentSha256: exact.contentSha256 });
          })();
        if (!outcome.ok) throw new ApprovalQueueError(outcome.kind === 'forbidden' ? 403 : 409, outcome.message);
        if (outcome.disposition === 'replayed') return 'Already recorded. Nothing changed.';
        return action === 'refuse' ? 'Refused. It will not be used.' : 'Approved. Posting is still a separate step.';
      }
    }
  }

  /** Approve each selected item through its own path, one at a time. A failure never undoes or blocks the others. */
  async batch(identity: PortalSessionIdentity, requestId: string, refs: readonly ApprovalRef[]): Promise<ApprovalDecisionResult[]> {
    const results: ApprovalDecisionResult[] = [];
    for (const ref of refs) {
      const title = ref.n;
      if (!BATCHABLE.has(ref.k)) { results.push({ ok: false, title, message: 'Approve this one on its own, with its confirmation.' }); continue; }
      try { results.push({ ok: true, title, message: await this.decide(identity, requestId, ref, 'approve', false) }); }
      catch (error) { results.push({ ok: false, title, message: decisionErrorMessage(error) }); }
    }
    return results;
  }
}

/** Kinds that may be approved in a batch. Items needing a confirmation are excluded per item at render time and fail safe here. */
const BATCHABLE: ReadonlySet<ApprovalKind> = new Set(['article', 'plan', 'campaign_post', 'promotion', 'creative', 'flow']);

export function decisionErrorMessage(error: unknown): string {
  if (error instanceof ApprovalQueueError || error instanceof SeoBlogError || error instanceof FlowWorkspaceError) return error.message;
  return 'The result was not confirmed. Refresh and check this item before trying again.';
}
export function decisionErrorStatus(error: unknown): number {
  return error instanceof ApprovalQueueError || error instanceof SeoBlogError || error instanceof FlowWorkspaceError ? error.status : 503;
}
