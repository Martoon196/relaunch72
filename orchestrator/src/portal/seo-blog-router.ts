/**
 * HTTP surface for the SEO blog area: /portal/seo-blog/…
 *
 * Identity comes from the portal session; every brand id in the path is only
 * a selector — the PostgreSQL store re-checks owner/admin membership of that
 * brand and re-locks the session in each transaction. POSTs require the
 * portal CSRF token and a same-origin request.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PortalSessionIdentity } from './auth-service.js';
import { portalCsrfToken, verifyPortalCsrf } from './session.js';
import type { PortalSeoBlogService } from './seo-blog-service.js';
import {
  activityPage, articlesPage, brandsPage, CALENDAR_SCRIPT, calendarPage, editorPage, overviewPage, publishingPage,
  SEO_BLOG_BASE, SEO_BLOG_SWITCH_TARGETS, setupPage, socialPage, topicsPage, layout, type Shell, type SeoBlogTab,
} from './seo-blog-view.js';
import { USAGE_ESTIMATES, type Actor, type SeoBlogEngine } from '../seo-blog/engine.js';
import { defaultPublishers } from '../seo-blog/publishers/registry.js';
import { SeoBlogError, type BrandSettings, type Brand } from '../seo-blog/types.js';
import { utcToLocal } from '../seo-blog/schedule.js';
import { CENTRAL_ACTION_FEEDBACK_PATH, CENTRAL_ACTION_FEEDBACK_SCRIPT } from './action-feedback.js';
import { PROFILE_STATUS_SCRIPT } from './profile-status.js';
import { KNOWLEDGE_CATEGORY_SCRIPT } from './knowledge-category.js';
import { isProfileJob, profilePayload } from '../seo-blog/profile-jobs.js';
import { campaignPage, type CampaignActionResult } from './seo-blog-campaign-view.js';
import { loadAuthorityProgrammePage } from '../seo-blog/authority-programme-controller.js';
import { authorityProgrammeContent } from '../seo-blog/authority-programme-view.js';
import { CAMPAIGN_IMAGE_STATUS_SCRIPT } from './campaign-image-status.js';
import { briefPage, CREATIVE_JOB_STATUS_SCRIPT, creativeEnquiriesPage, generationPage, renderTaskPage, type ReferenceChoice } from './creative-generation-view.js';
import { holdMessage, isCreativeImageJob } from '../creative-studio/generation.js';
import { campaignDeliveryCalendarPage } from './seo-blog-campaign-calendar-view.js';
import { campaignCreatorsPage, campaignCreatorReviewPage, creatorContentFromForm, creatorTextExport, productionRulesPage } from './campaign-creator-view.js';
import type { CampaignBrief } from '../seo-blog/campaign-creator.js';
import {postingDraftsPage,POSTING_DRAFTS_SCRIPT} from './seo-blog-posting-view.js';
import {exportPostDraft} from '../seo-blog/platform-drafts.js';
import { creativeKitPage, creativeOverviewPage, creativeSetPage } from './creative-studio-view.js';
import { limitsPage } from './seo-blog-limits-view.js';
import { brandDnaPage } from './brand-dna-view.js';
import { websiteLookProposal } from '../creative-studio/website-look.js';
import { limitFromForm } from '../seo-blog/limits.js';
import type { BackgroundChoice } from '../creative-studio/service.js';

export interface SeoBlogRouteInput {
  readonly service: PortalSeoBlogService;
  readonly identity: PortalSessionIdentity | null;
  readonly requestId: string;
  readonly sessionSecret: string;
  readonly vaultReady: boolean;
  readonly applicationName?: string;
  /** Public origin of this portal (for brand enquiry form links). */
  readonly publicOrigin?: string;
  /** Whether provider OAuth callbacks return to this host; connection starts only where they complete. */
  readonly socialConnectHere?: boolean;
  readonly socialConnectHost?: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const BRAND_PATH = new RegExp(`^${SEO_BLOG_BASE}/b/(${UUID})(?:/(.*))?$`, 'i');
// connect-src 'self' lets the same-origin status scripts poll (default-src 'none' otherwise blocks their fetch).
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': PAGE_CSP, ...extra,
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

/** Notices are signed so a crafted link cannot display arbitrary text in the product. */
function signedMessage(secret: string, kind: 'n' | 'e', text: string): string {
  const m = Buffer.from(text.slice(0, 400)).toString('base64url');
  const s = createHmac('sha256', secret).update(`seo-blog:${kind}:${m}`).digest('base64url').slice(0, 22);
  return `${kind}=${m}&s=${s}`;
}

function readMessage(secret: string, url: URL): { notice: string | null; error: string | null } {
  const sig = url.searchParams.get('s') ?? '';
  for (const kind of ['n', 'e'] as const) {
    const m = url.searchParams.get(kind);
    if (!m) continue;
    const expected = createHmac('sha256', secret).update(`seo-blog:${kind}:${m}`).digest('base64url').slice(0, 22);
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      const text = Buffer.from(m, 'base64url').toString('utf8');
      return kind === 'n' ? { notice: text, error: null } : { notice: null, error: text };
    }
  }
  return { notice: null, error: null };
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new SeoBlogError(413, 'That upload is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    size += chunk.length;
    if (size > max) throw new SeoBlogError(413, 'That upload is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

interface FormData { fields: URLSearchParams; file: { filename: string; data: Buffer } | null }

export function parseMultipartForm(body: Buffer, contentType: string): FormData {
  const boundary = /boundary=(?:"([^"]{1,70})"|([^;\s]{1,70}))/i.exec(contentType);
  if (!boundary) throw new SeoBlogError(400, 'Upload the form again.');
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const fields = new URLSearchParams();
  let file: FormData['file'] = null;
  let start = body.indexOf(marker);
  let parts = 0;
  while (start !== -1 && parts++ < 40) {
    const next = body.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const chunk = body.subarray(start + marker.length + 2, next - 2);
    const split = chunk.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = chunk.subarray(0, split).toString('utf8');
      const name = /content-disposition:[^\r\n]*\bname="([^"]{1,40})"/i.exec(headers)?.[1];
      const filename = /content-disposition:[^\r\n]*\bfilename="([^"]{0,200})"/i.exec(headers)?.[1];
      const data = chunk.subarray(split + 4);
      if (name === 'file' && filename !== undefined) {
        if (file) throw new SeoBlogError(400, 'Upload one file at a time.');
        if (filename && data.length) file = { filename: filename.replace(/[\\/]/g, '_'), data: Buffer.from(data) };
      } else if (name) {
        fields.append(name, data.toString('utf8'));
      }
    }
    start = next;
  }
  return { fields, file };
}

function lines(value: string | null): string[] {
  return (value ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 60);
}

function int(value: string | null, field: string): number {
  if (value === null || !/^\d{1,16}$/.test(value.trim()) || !Number.isSafeInteger(Number(value?.trim()))) throw new SeoBlogError(400, `Enter a whole number for ${field}.`);
  return Number(value.trim());
}

/** The studio page a failed creative POST returns to (with its message), instead of the studio overview. */
export function creativeReturnPage(rest: string): string {
  const p = rest.split('/');
  if (p[1] === 'generate') return p[2] && p[3] === 'request' ? `creative/generate/${p[2]}` : 'creative/generate';
  if (p[1] === 'enquiries') return 'creative/enquiries';
  if (p[1] === 's' && p[2]) return `creative/s/${p[2]}`;
  if (p[1] === 'task' && p[2]) return `creative/task/${p[2]}`;
  if (p[1] === 'kit') return 'creative/kit';
  return 'creative';
}

export async function handleSeoBlog(req: IncomingMessage, res: ServerResponse, url: URL, input: SeoBlogRouteInput): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '') || SEO_BLOG_BASE;
  const method = req.method ?? 'GET';
  if (method === 'GET' && path === `${SEO_BLOG_BASE}/campaign-image-status.js`) return send(res, 200, CAMPAIGN_IMAGE_STATUS_SCRIPT, 'text/javascript; charset=utf-8');
  if (method === 'GET' && path === `${SEO_BLOG_BASE}/creative-job-status.js`) return send(res, 200, CREATIVE_JOB_STATUS_SCRIPT, 'text/javascript; charset=utf-8');
  if(method==='GET'&&path===`${SEO_BLOG_BASE}/knowledge-kind.js`) return send(res,200,KNOWLEDGE_CATEGORY_SCRIPT,'text/javascript; charset=utf-8');
  if (method === 'GET' && path === `${SEO_BLOG_BASE}/profile-status.js`) return send(res, 200, PROFILE_STATUS_SCRIPT, 'text/javascript; charset=utf-8');
  if (method === 'GET' && path === `${SEO_BLOG_BASE}/posting-drafts.js`) return send(res, 200, POSTING_DRAFTS_SCRIPT, 'text/javascript; charset=utf-8');
  if (method === 'GET' && path === CENTRAL_ACTION_FEEDBACK_PATH) {
    send(res, 200, CENTRAL_ACTION_FEEDBACK_SCRIPT, 'text/javascript; charset=utf-8');
    return;
  }
  if (path === `${SEO_BLOG_BASE}/calendar.js`) {
    send(res, 200, CALENDAR_SCRIPT, 'text/javascript; charset=utf-8');
    return;
  }
  const identity = input.identity;
  if (!identity) return redirect(res, '/portal/login');
  const actor: Actor = { userId: identity.userId };
  const engine: SeoBlogEngine = input.service.engineFor(identity, input.requestId);
  const csrf = portalCsrfToken(input.sessionSecret, identity.sessionToken);
  const brandMatch = BRAND_PATH.exec(path);
  const brandId = brandMatch?.[1]?.toLowerCase() ?? null;
  const rest = brandMatch?.[2] ?? '';
  const back = (tab: string) => `${SEO_BLOG_BASE}/b/${brandId}/${tab}`;
  const ok = (location: string, text: string) => {
    const [address,fragment]=location.split('#');
    return redirect(res, `${address}${address!.includes('?') ? '&' : '?'}${signedMessage(input.sessionSecret, 'n', text)}${fragment?'#'+fragment:''}`);
  };

  try {
    if (method === 'POST') {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if ((origin && host && new URL(origin).host !== host) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        throw new SeoBlogError(403, 'Refresh the page and try again.');
      }
      const contentType = String(req.headers['content-type'] ?? '');
      const multipart = /^multipart\/form-data/i.test(contentType);
      if (!multipart && !/^application\/x-www-form-urlencoded/i.test(contentType)) throw new SeoBlogError(415, 'Use the form on the page.');
      const body = await readBody(req, multipart ? 21 * 1024 * 1024 : 600 * 1024);
      const form: FormData = multipart ? parseMultipartForm(body, contentType) : { fields: new URLSearchParams(body.toString('utf8')), file: null };
      const f = (name: string) => form.fields.get(name);
      if (!verifyPortalCsrf(input.sessionSecret, identity.sessionToken, f('_csrf') ?? undefined)) throw new SeoBlogError(403, 'Your form expired. Refresh the page and try again.');
      if (path === `${SEO_BLOG_BASE}/limits`) {
        const limits = input.service.limitsFor?.(identity, input.requestId);
        if (!limits || !(await limits.allowed())) throw new SeoBlogError(403, 'Only the founder can manage account limits.');
        if (f('action') === 'policy') {
          const version = Number(f('version')), concurrency = Number(f('concurrency'));
          const monthly = f('monthlyUnlimited') === '1' ? null : Number(f('monthly')) * 1_000_000;
          if (!Number.isSafeInteger(version) || version < 1 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10
            || (monthly !== null && (!Number.isSafeInteger(monthly) || monthly < 0 || monthly > 1_000_000_000_000))) throw new SeoBlogError(400, 'Check the platform limits.');
          await limits.policy(version, { enabled: f('enabled') === '1', concurrency, monthlyMicrousd: monthly });
        } else {
          const target = f('target') ?? '', rowVersion = Number(f('rowVersion'));
          if (!new RegExp(`^${UUID}$`, 'i').test(target) || !Number.isSafeInteger(rowVersion) || rowVersion < 1) throw new SeoBlogError(400, 'Refresh and select the account again.');
          await limits.save(target, rowVersion, { modelTokens: limitFromForm(form.fields, 'modelTokens'), searchCalls: limitFromForm(form.fields, 'searchCalls'),
            images: limitFromForm(form.fields, 'images'), studioImages: limitFromForm(form.fields, 'studioImages') });
        }
        return ok(`${SEO_BLOG_BASE}/limits`, 'Limits saved. Usage history and publishing settings are unchanged.');
      }
      return await handlePost(res, engine, actor, path, brandId, rest, form, f, back, ok, input);
    }
    if (method !== 'GET' && method !== 'HEAD') throw new SeoBlogError(405, 'Use the controls on the page.');

    if (path === `${SEO_BLOG_BASE}/switch`) {
      const target = url.searchParams.get('brand') ?? '';
      if (!new RegExp(`^${UUID}$`, 'i').test(target)) throw new SeoBlogError(400, 'Choose a business.');
      // The page to stay on is one of a fixed list; the brand itself is checked for membership by the page it lands on.
      const to = url.searchParams.get('to') ?? '';
      return redirect(res, `${SEO_BLOG_BASE}/b/${target.toLowerCase()}/${(SEO_BLOG_SWITCH_TARGETS as readonly string[]).includes(to) ? to : 'overview'}`);
    }
    const brands = await engine.listBrands(actor);
    const messages = readMessage(input.sessionSecret, url);
    const limits = input.service.limitsFor?.(identity, input.requestId);
    const limitsAvailable = limits ? await limits.allowed() : false;
    if (path === `${SEO_BLOG_BASE}/limits`) {
      if (!limits || !limitsAvailable) throw new SeoBlogError(403, 'Only the founder can manage account limits.');
      return send(res, 200, limitsPage({ brands, brand: null, tab: null, csrf, ...messages, limitsAvailable, applicationName: input.applicationName }, await limits.list()));
    }
    if (path === SEO_BLOG_BASE) {
      // Which door each brand shows ("Start with your website" until it has a card). A brand that cannot be read keeps the default door.
      const dna = new Map((await Promise.all(brands.map(async (b) => [b.id, await engine.brandDnaStatus(actor, b.id).catch(() => undefined)] as const)))
        .flatMap(([id, status]) => status ? [[id, status] as const] : []));
      return send(res, 200, brandsPage({ brands, brand: null, tab: null, csrf, ...messages, limitsAvailable, applicationName: input.applicationName }, randomUUID(), dna));
    }
    if (!brandId) throw new SeoBlogError(404, 'That page was not found.');
    const brand = await engine.getBrand(actor, brandId);
    if (rest === 'image/status') return send(res, 200, JSON.stringify(await engine.imageJobStatus(actor, brandId, url.searchParams.get('article') ?? '', url.searchParams.get('job') ?? '')), 'application/json; charset=utf-8');
    const privateImage = new RegExp(`^media/(${UUID})/([0-9a-f]{64})\\.jpg$`, 'i').exec(rest);
    if (privateImage) {
      const image = await engine.privateCampaignImage(actor, brandId, privateImage[1]!, privateImage[2]!);
      if (image.asset.validation !== 'prepared_jpeg' || image.asset.kind !== 'variant' || image.bytes.byteLength > 600_000
        || createHash('sha256').update(image.bytes).digest('hex') !== privateImage[2]) throw new SeoBlogError(404, 'That private crop is unavailable.');
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(image.bytes.byteLength), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' });
      res.end(method === 'HEAD' ? undefined : image.bytes); return;
    }
    if (rest === 'profile/status') {
      const jobId = url.searchParams.get('job');
      const job = (await engine.listJobs(actor, brandId)).find((j) => j.id === jobId && isProfileJob(j));
      if (!job) throw new SeoBlogError(404, 'That profile task was not found.');
      return send(res, 200, JSON.stringify({ id: job.id, state: job.state, detail: job.error ?? job.progress, resultVersion: profilePayload(job).resultVersion ?? null }), 'application/json; charset=utf-8');
    }
    const shell = (tab: SeoBlogTab): Shell => ({ brands, brand, tab, csrf, ...messages, limitsAvailable, applicationName: input.applicationName,creatorsAvailable:engine.campaignCreatorsReady,methodsAvailable:engine.productionMethodsReady,creativeAvailable:input.service.creativeEnabled===true });
    if (rest === 'creative' || rest.startsWith('creative/')) {
      const studio = input.service.creativeFor?.(identity, input.requestId, engine) ?? null;
      if (!studio) throw new SeoBlogError(404, 'The creative studio is not enabled.');
      const parts = rest.split('/');
      const art = new RegExp(`^creative/art/(${UUID})/([0-9a-f]{64})\\.(jpg|mp4|webm)$`, 'i').exec(rest);
      if (art) {
        const found = await studio.artwork(actor.userId, brandId, art[1]!.toLowerCase(), art[2]!.toLowerCase());
        const v = found.version;
        const ext = v.render.mime === 'video/mp4' ? 'mp4' : v.render.mime === 'video/webm' ? 'webm' : 'jpg';
        if (art[3]!.toLowerCase() !== ext) throw new SeoBlogError(404, 'That artwork was not found.');
        const kind = v.media === 'storyboard' ? '-storyboard' : v.media === 'video' ? '-video' : '';
        const name = `${brand.slug}-${v.conceptKey}${kind}-${v.placement}${v.card ? `-card${v.card}` : ''}-v${v.number}-${v.media === 'storyboard' ? 'not-a-video' : found.approved ? 'approved' : 'draft'}.${ext}`.replace(/[^a-z0-9.-]/giu, '_');
        res.writeHead(200, { 'content-type': v.render.mime, 'content-length': String(found.bytes.byteLength), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer',
          ...(url.searchParams.get('download') === '1' ? { 'content-disposition': `attachment; filename="${name}"` } : {}) });
        res.end(method === 'HEAD' ? undefined : found.bytes); return;
      }
      const logo = /^creative\/kit-logo\/\d+\/([0-9a-f]{64})$/i.exec(rest);
      if (logo) {
        const found = await studio.kitLogo(actor.userId, brandId, logo[1]!.toLowerCase());
        res.writeHead(200, { 'content-type': found.mime, 'content-length': String(found.bytes.byteLength), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' });
        res.end(method === 'HEAD' ? undefined : found.bytes); return;
      }
      const generatedPreview = new RegExp(`^creative/generated/(${UUID})\\.jpg$`, 'i').exec(rest);
      if (generatedPreview) {
        const found = await studio.generatedImage(actor.userId, brandId, generatedPreview[1]!.toLowerCase());
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(found.bytes.byteLength), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' });
        res.end(method === 'HEAD' ? undefined : found.bytes); return;
      }
      const generatedUrl = (generationId: string) => `${SEO_BLOG_BASE}/b/${brandId}/creative/generated/${generationId}.jpg`;
      const savedWithPreview = async () => (await input.service.creativeSavedImages?.(identity, input.requestId, engine, brandId)) ?? [];
      if (rest === 'creative') {
        const overview = await studio.overview(actor.userId, brandId);
        const saved = await savedWithPreview();
        const otherPatterns = await studio.learning().otherBrandPatterns(actor.userId, brandId).catch(() => null);
        const generated = studio.generationAvailable ? await studio.generation().view(actor.userId, brandId).catch(() => null) : null;
        const generatedImages = (generated?.state.generations ?? []).slice(0, 12).map((g) => ({ id: g.id, label: `Generated ${g.createdAt.slice(0, 10)} (${g.width}×${g.height})`,
          previewUrl: generatedUrl(g.id) }));
        const generation = { available: studio.generationAvailable, enabled: generated?.brand.settings.studioImages?.enabled === true, remaining: 0 };
        return send(res, 200, creativeOverviewPage(shell('creative'), { ...overview, otherPatterns, generatedImages, generation, prefill: url.searchParams, savedImages: saved.map((x) => ({ ...x, previewUrl: x.previewAssetId ? `${SEO_BLOG_BASE}/b/${brandId}/media/${x.previewAssetId}/${x.previewSha256}.jpg` : null })), commandId: randomUUID() }));
      }
      // ── Typed-brief image generation ──
      const media = (assetId: string, sha: string) => `${SEO_BLOG_BASE}/b/${brandId}/media/${assetId}/${sha}.jpg`;
      const referenceChoices = async (state?: import('../creative-studio/generation-store.js').GenerationState): Promise<ReferenceChoice[]> => {
        const saved = await savedWithPreview();
        return [...(state?.generations ?? []).slice(0, 12).map((g) => ({ assetId: g.assetId, sha256: g.sha256, label: `Generated ${g.createdAt.slice(0, 10)}`, previewUrl: generatedUrl(g.id) })),
          ...saved.slice(0, 12).map((x) => ({ assetId: x.assetId, sha256: x.sha256, label: x.articleTitle, previewUrl: x.previewAssetId ? media(x.previewAssetId, x.previewSha256!) : media(x.assetId, x.sha256) }))];
      };
      const taskRoute = new RegExp(`^creative/task/(${UUID})$`, 'i').exec(rest);
      if (taskRoute) {
        const task = await studio.renderTask(actor.userId, brandId, taskRoute[1]!.toLowerCase());
        if (task.job.state === 'done' && task.result) return ok(`${SEO_BLOG_BASE}/b/${brandId}/creative/s/${task.result.setId}`, task.result.message);
        return send(res, 200, renderTaskPage(shell('creative'), { job: task.job, label: task.label, retryable: !isCreativeImageJob(task.job) }));
      }
      const jobRoute = new RegExp(`^creative/jobs/(${UUID})$`, 'i').exec(rest);
      if (jobRoute) {
        const status = await studio.jobStatus(actor.userId, brandId, jobRoute[1]!.toLowerCase());
        return send(res, 200, JSON.stringify(status), 'application/json; charset=utf-8');
      }
      if (rest === 'creative/generate') {
        const view = await studio.generation().view(actor.userId, brandId);
        return send(res, 200, generationPage(shell('creative'), { brand: view.brand, state: view.state, policy: view.policy, providerConfigured: view.providerConfigured, references: await referenceChoices(view.state) }));
      }
      const briefRoute = new RegExp(`^creative/generate/(${UUID})$`, 'i').exec(rest);
      if (briefRoute) {
        const briefId = briefRoute[1]!.toLowerCase(), gen = studio.generation();
        const [view, all] = await Promise.all([gen.view(actor.userId, brandId, briefId), gen.view(actor.userId, brandId)]);
        const versions = view.state.briefs.filter((b) => b.id === briefId);
        if (!versions.length) throw new SeoBlogError(404, 'That brief was not found.');
        const current = [...versions].sort((a, b) => b.version - a.version)[0]!;
        const estimate = gen.estimate(view.brand, all.state, view.policy, current.data, view.policyUnreadable);
        return send(res, 200, briefPage(shell('creative'), { brand: view.brand, briefId, versions, state: view.state, estimate, references: await referenceChoices(all.state), previewUrl: generatedUrl }));
      }
      if (rest === 'creative/enquiries') {
        const settings = await studio.enquiries(actor.userId, brandId);
        return send(res, 200, creativeEnquiriesPage(shell('creative'), { settings, brandId, origin: input.publicOrigin ?? null, live: Boolean(input.service.creativeEnquiries) }));
      }
      if (rest === 'creative/kit') {
        const { context, kit } = await studio.context(actor.userId, brandId);
        // Only while no logo is on record, and only when the owner asks to see it: the page itself never calls out to
        // their website. Read through the guarded fetch; shown, never saved, until "Yes, use these".
        const declared = kit?.logo ? null : (await engine.getInventory(actor, brandId).catch(() => null))?.look ?? null;
        const asked = url.searchParams.get('website') === '1';
        const found = declared && asked ? await engine.proposedWebsiteLook(actor, brandId).catch(() => null) : null;
        return send(res, 200, creativeKitPage(shell('creative'), { context, kit, commandId: randomUUID(), proposal: websiteLookProposal(found, kit), websiteHint: Boolean(declared) && !asked }));
      }
      if (parts[1] === 's' && parts[2] && parts.length === 3) {
        const [found, articles, saved, distribution, acquisitions] = await Promise.all([studio.getSet(actor.userId, brandId, parts[2]), engine.listArticles(actor, brandId), savedWithPreview(),
          studio.distribution(actor.userId, brandId, parts[2]).catch(() => null), studio.acquisitionTargets(actor.userId, brandId).catch(() => null)]);
        return send(res, 200, creativeSetPage(shell('creative'), { ...found, articles: articles.map((a) => ({ id: a.article.id, title: a.title })), savedImages: saved, newCommand: () => randomUUID(), rendererReady: studio.rendererReady,
          distribution, acquisitions }));
      }
      throw new SeoBlogError(404, 'That page was not found.');
    }
    if(rest==='methods')return send(res,200,productionRulesPage(shell('methods'),await engine.methodOverview(actor,brandId),engine.campaignCreatorsReady));
    if(rest==='campaigns'||rest.startsWith('campaigns/')){
      const creator=engine.creators(),parts=rest.split('/');
      if(!parts[1]){
        const settings=await engine.methodOverview(actor,brandId),pins=settings.assignment?.pins??[];
        const enabled=(['email','advocacy','acquisition'] as const).filter(kind=>pins.some(p=>p.packId===(kind==='email'?'email-writing':kind==='advocacy'?'advocacy-and-referral':'conversion-copy')));
        const articles=(await engine.listArticles(actor,brandId)).filter(a=>a.article.currentVersionId).map(a=>({id:a.article.id,title:a.title}));
        return send(res,200,campaignCreatorsPage(shell('campaigns'),await engine.getProfile(actor,brandId),await creator.list(actor.userId,brandId),enabled,articles));
      }
      const record=await creator.get(actor.userId,brandId,parts[1]);
      if(parts[2]==='export'){
        const json=await creator.export(actor.userId,brandId,record.id);
        const format=url.searchParams.get('format')==='json'?'json':'txt';
        return send(res,200,format==='json'?json:creatorTextExport(record,JSON.parse(json).content),format==='json'?'application/json; charset=utf-8':'text/plain; charset=utf-8',{'content-disposition':`attachment; filename="campaign.${format}"`});
      }
      const studio=record.brief.kind==='acquisition'?input.service.creativeFor?.(identity,input.requestId,engine)??null:null;
      // undefined = studio off; null = read failed (shown as such); a 404 means no proposal exists yet and is also plan-only.
      const learning=studio?await studio.learning().view(actor.userId,brandId,record.id).catch((error:unknown)=>error instanceof SeoBlogError&&error.status===404?undefined:null):undefined;
      return send(res,200,campaignCreatorReviewPage(shell('campaigns'),record,await engine.getProfile(actor,brandId),learning));
    }
    if (rest === 'authority') {
      if (input.applicationName !== 'Relaunch72 Content') throw new SeoBlogError(404, 'That page was not found.');
      const data = await loadAuthorityProgrammePage(engine, actor, brandId);
      return send(res, 200, layout(shell('authority'), 'Authority', authorityProgrammeContent(data)));
    }
    if (rest === 'dna') return send(res, 200, brandDnaPage({ ...shell('setup'), switchTo: 'dna' }, await engine.brandDna(actor, brandId), randomUUID()));
    const tab = rest.split('/')[0] || 'overview';
    if (tab === 'overview') {
      const [readiness, articles, usage, jobs] = await Promise.all([engine.readiness(actor, brandId), engine.listArticles(actor, brandId), engine.usage(actor, brandId), engine.listJobs(actor, brandId)]);
      return send(res, 200, overviewPage(shell('overview'), { readiness, articles, usage, jobs }));
    }
    if (tab === 'setup') {
      const [documents, profile, inventory, destinations, usage, jobs] = await Promise.all([engine.listKnowledge(actor, brandId), engine.getProfile(actor, brandId), engine.getInventory(actor, brandId), engine.listDestinations(actor, brandId), engine.usage(actor, brandId), engine.listJobs(actor, brandId)]);
      return send(res, 200, setupPage(shell('setup'), { documents, profile, inventory, destinations, usage, jobs, extractionCommandId: randomUUID(), publishers: [...defaultPublishers().values()], vaultReady: input.vaultReady }));
    }
    if (tab === 'topics') {
      const [plans, readiness, jobs, usage] = await Promise.all([engine.listPlans(actor, brandId), engine.readiness(actor, brandId),engine.listJobs(actor,brandId),engine.usage(actor,brandId)]);
      return send(res, 200, topicsPage(shell('topics'), { plans, readiness, jobs, usage, commandId: randomUUID(), estimatePerArticle: USAGE_ESTIMATES.article }));
    }
    if (tab === 'articles') {
      const articleId = rest.split('/')[1];
      if (!articleId) return send(res, 200, articlesPage(shell('articles'), { articles: await engine.listArticles(actor, brandId) }));
      const action = rest.split('/')[2];
      if(action==='posts')return send(res,200,postingDraftsPage(shell('articles'),await engine.getPostingDrafts(actor,brandId,articleId)));
      if(action==='post-export') {
        const data=await engine.getPostingDrafts(actor,brandId,articleId),entry=data.drafts.find(x=>x.draft.id===url.searchParams.get('draft'));
        if(!entry)throw new SeoBlogError(404,'That posting draft was not found.');
        return send(res,200,exportPostDraft(entry.draft),'text/markdown; charset=utf-8',{'content-disposition':`attachment; filename="${entry.draft.platform}-post.md"`});
      }
      if (action === 'campaign') {
        const [detail, jobs] = await Promise.all([engine.getArticle(actor, brandId, articleId), engine.listJobs(actor, brandId)]);
        const social = await engine.socialOverview(actor, brandId).catch(() => null);
        return send(res, 200, campaignPage(shell('articles'), { ...detail, jobs, social, now: new Date().toISOString() }));
      }
      if (action === 'preview') {
        const html = await engine.preview(actor, brandId, articleId, url.searchParams.get('v') ?? undefined);
        return send(res, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': PREVIEW_CSP });
      }
      if (action === 'export') {
        const format = url.searchParams.get('format') === 'html' ? 'html' : 'markdown';
        const file = await engine.exportArticle(actor, brandId, articleId, format);
        return send(res, 200, file.body, file.contentType, { 'content-disposition': `attachment; filename="${file.filename.replace(/[^a-z0-9.-]/gi, '_')}"`, 'content-security-policy': PREVIEW_CSP });
      }
      const [detail, destinations] = await Promise.all([engine.getArticle(actor, brandId, articleId), engine.listDestinations(actor, brandId)]);
      const social = detail.article.linkedPromotions?.length ? await engine.socialOverview(actor, brandId).catch(() => null) : null;
      return send(res, 200, editorPage(shell('articles'), { ...detail, destinations, social }));
    }
    if (tab === 'calendar') {
      const view = (['month', 'week', 'list'] as const).find((v) => v === url.searchParams.get('view')) ?? 'month';
      const requested = url.searchParams.get('date') ?? '';
      const anchor = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : utcToLocal(new Date().toISOString(), brand.timezone).date;
      const [articles, plans, destinations, readiness, jobs, campaignEntries] = await Promise.all([engine.listArticles(actor, brandId), engine.listPlans(actor, brandId), engine.listDestinations(actor, brandId),engine.readiness(actor,brandId),engine.listJobs(actor,brandId),engine.campaignCalendar(actor,brandId)]);
      return send(res, 200, calendarPage(shell('calendar'), { view, anchor, articles, briefs: plans.flatMap((p) => p.briefs), destinations, readiness,jobs,campaignEntries, brandsAll: false }));
    }
    if (tab === 'publishing') return send(res, 200, publishingPage(shell('publishing'), { usage: await engine.usage(actor, brandId) }));
    if (tab === 'social') {
      if(rest==='social/calendar'){
        const today=new Date().toISOString().slice(0,10),end=new Date(Date.parse(`${today}T00:00:00.000Z`)+31*86_400_000).toISOString().slice(0,10);
        const from=url.searchParams.get('from')??today,to=url.searchParams.get('to')??end;
        if(!/^\d{4}-\d{2}-\d{2}$/u.test(from)||!/^\d{4}-\d{2}-\d{2}$/u.test(to))throw new SeoBlogError(400,'Choose valid delivery dates.');
        const start=`${from}T00:00:00.000Z`,stop=`${to}T00:00:00.000Z`;
        return send(res,200,campaignDeliveryCalendarPage(shell('social'),{from:start,to:stop,...await engine.socialCalendar(actor,brandId,start,stop)}));
      }
      return send(res, 200, socialPage(shell('social'), { overview: await engine.socialOverview(actor, brandId), discovery: await engine.socialDiscovery(actor, brandId), connectHere: input.socialConnectHere === true, connectHost: input.socialConnectHost ?? '', intentId: randomUUID() }));
    }
    if (tab === 'activity') {
      const [events, jobs] = await Promise.all([engine.activity(actor, brandId), engine.listJobs(actor, brandId)]);
      return send(res, 200, activityPage(shell('activity'), { events, jobs }));
    }
    throw new SeoBlogError(404, 'That page was not found.');
  } catch (error) {
    const known = error instanceof SeoBlogError;
    const message = known ? error.message : 'The SEO blog area is temporarily unavailable. Nothing was changed.';
    if (!known) console.error('seo-blog: request failed', (error as Error).name);
    if (method === 'POST' && known && error.status < 500 && error.status !== 404 && brandId) {
      const articleAction = rest.split('/')[2] ?? '';
      const tab = rest.startsWith('articles/') ? `articles/${rest.split('/')[1]}${articleAction.startsWith('campaign-') || articleAction.startsWith('image-') ? '/campaign' : ''}`
        : rest.startsWith('creative/') ? creativeReturnPage(rest) : rest.split('/')[0] || 'overview';
      return redirect(res, `${back(tab === 'basics' || tab === 'knowledge' || tab === 'profile' || tab === 'destinations' || tab === 'inventory' || tab==='editorial' ? 'setup' : tab === 'plan' || tab === 'plans' || tab === 'briefs' || tab === 'generate' ? 'topics' : tab === 'settings' ? 'publishing' : tab === 'jobs' ? 'activity' : tab)}?${signedMessage(input.sessionSecret, 'e', message)}`);
    }
    const status = known ? error.status : 503;
    return send(res, status, `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>SEO Blog</title></head><body><main style="max-width:640px;margin:40px auto;font:16px system-ui"><h1>${status === 404 ? 'Not found' : 'Something needs attention'}</h1><p>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p><p><a href="${SEO_BLOG_BASE}">Back to your businesses</a></p></main></body></html>`);
  }
}

async function handlePost(
  res: ServerResponse, engine: SeoBlogEngine, actor: Actor, path: string, brandId: string | null, rest: string, form: FormData,
  f: (name: string) => string | null, back: (tab: string) => string, ok: (location: string, text: string) => void, input: SeoBlogRouteInput,
): Promise<void> {
  if (path === `${SEO_BLOG_BASE}/brands`) {
    // A new business lands on the Brand DNA door ("Start with your website"), not on the long setup page.
    let made: Awaited<ReturnType<SeoBlogEngine['createBrand']>>;
    try { made = await engine.createBrand(actor, { commandId: f('commandId') ?? '', name: f('name') ?? '', website: f('website') }); }
    catch (error) {
      // Stay on the form with the reason (a name that is too short, a duplicate, or an account that may not add one).
      if (error instanceof SeoBlogError && error.status < 500 && error.status !== 404) {
        // The engine says "brand"; every page says "business".
        const text = error.status === 403 ? 'Only the account owner can add a business. Ask them to add it.'
          : error.message.replace(/^Enter a brand name/u, 'Enter a business name');
        return redirect(res, `${SEO_BLOG_BASE}?${signedMessage(input.sessionSecret, 'e', text)}#add-business`);
      }
      throw error;
    }
    const { brand, created } = made;
    return ok(`${SEO_BLOG_BASE}/b/${brand.id}/dna`, created ? `${brand.name} is added. Start with its website.` : `${brand.name} is already here.`);
  }
  if (!brandId) throw new SeoBlogError(404, 'That page was not found.');
  const parts = rest.split('/');
  const rowVersion = () => int(f('rowVersion'), 'the form version');
  switch (parts[0]) {
    case 'creative': {
      const identity = input.identity!;
      const studio = input.service.creativeFor?.(identity, input.requestId, engine) ?? null;
      if (!studio) throw new SeoBlogError(404, 'The creative studio is not enabled.');
      const home = `${SEO_BLOG_BASE}/b/${brandId}/creative`;
      const commandId = f('commandId') ?? '';
      // Rendering runs in the background worker as a durable job; this request only records it (and stores any uploaded
      // background), then sends the owner to the task page, which follows the job and opens the result when it is ready.
      const queued = async (operation: Parameters<typeof studio.enqueueRender>[3]) => {
        const job = await studio.enqueueRender(actor.userId, brandId, commandId, operation);
        return ok(`${home}/task/${job.id}`, 'Saved. The artwork is being rendered on the server; you can leave this page.');
      };
      const background = (): BackgroundChoice => {
        const kind = f('background') ?? 'neutral';
        if (kind === 'keep') return { kind: 'keep' };
        if (kind === 'upload') { if (!form.file?.data.length) throw new SeoBlogError(400, 'Choose an image file to upload.'); return { kind: 'upload', bytes: form.file.data }; }
        if (kind === 'saved') { const [assetId, sha] = (f('saved') ?? '').split(':'); return { kind: 'saved', assetId: assetId ?? '', sha256: sha ?? '' }; }
        if (kind === 'generated') return { kind: 'generated', generationId: (f('generated') ?? '').toLowerCase() };
        return { kind: 'neutral' };
      };
      if (parts[1] === 'generate') {
        const gen = studio.generation();
        if (parts[2] === 'settings') {
          await gen.configure(actor.userId, brandId, rowVersion(), f('enabled') === '1', int(f('perMonth'), 'the studio image allowance'));
          return ok(`${home}/generate#generation-settings`, 'Studio image allowance saved. Nothing was requested or charged.');
        }
        if (parts[2] === 'brief') {
          const refs = form.fields.getAll('reference').map((v) => { const [assetId, sha256] = v.split(':'); return { assetId: assetId ?? '', sha256: sha256 ?? '' }; });
          const saved = await gen.saveBrief(actor.userId, brandId, commandId, { title: f('title') ?? '', text: f('text') ?? '', size: f('size') ?? '', useVisualGuidance: f('useVisualGuidance') === '1', references: refs },
            f('briefId') ? (f('briefId') ?? '').toLowerCase() : undefined);
          return ok(`${home}/generate/${saved.briefId}`, saved.replayed ? 'This brief was already saved.' : `Brief saved (version ${saved.version}). Review the cost before generating. Nothing was charged.`);
        }
        if (parts[2] && parts[3] === 'request') {
          const briefId = parts[2].toLowerCase();
          if (f('confirm') !== '1' && f('confirmedNewIntent') !== '1') throw new SeoBlogError(400, 'Tick the confirmation to use one paid image from this brand\u2019s allowances.');
          const result = await gen.request(actor.userId, brandId, briefId, int(f('version'), 'the brief version'), commandId, f('confirmedNewIntent') === '1', f('replacesIntentId') || null);
          if ('reason' in result) return ok(`${home}/generate/${briefId}`, result.reason === 'new_intent_confirmation_required' ? 'This brief version already has a paid image. Confirm that you want another paid request.' : holdMessage(result.reason));
          return ok(`${home}/generate/${briefId}`, 'Image request saved. It runs on the server; you can leave this page. One paid request is made only if the allowance and policy checks still pass when it starts.');
        }
        throw new SeoBlogError(404, 'That page was not found.');
      }
      if (parts[1] === 'enquiries') {
        if (parts[2] === 'rotate') {
          await studio.rotateEnquiryKey(actor.userId, brandId, int(f('rowVersion'), 'the settings version'));
          return ok(`${home}/enquiries`, 'New form address issued. The old hosted link and embed code no longer work; update the page your links open.');
        }
        const saved = await studio.saveEnquiries(actor.userId, brandId, { enabled: f('enabled') === '1', privacyUrl: (f('privacyUrl') ?? '').trim(),
          newStageId: f('newStageId') ?? '', qualifiedStageId: f('qualifiedStageId') ?? '', expectedVersion: int(f('rowVersion'), 'the settings version') });
        return ok(`${home}/enquiries`, saved.enabled ? 'Enquiry form saved and switched on. Add it to the page your tracked links open.' : 'Enquiry settings saved. The form is off.');
      }
      if (parts[1] === 'task' && parts[2] && parts[3] === 'retry') {
        const task = await studio.renderTask(actor.userId, brandId, parts[2].toLowerCase());
        await engine.retryJob(actor, brandId, task.job.id);
        return ok(`${home}/task/${task.job.id}`, 'Task queued again. It replays the same request; nothing is duplicated.');
      }
      if (parts[1] === 'kit' && parts[2] === 'use-website') {
        // "Yes, use these": the same saveKit path as a typed kit. The logo is fetched again through the guarded
        // transport and must be the very file the owner was shown; the colour is the one stored from their site.
        const { kit } = await studio.context(actor.userId, brandId);
        const proposal = websiteLookProposal(await engine.proposedWebsiteLook(actor, brandId), kit);
        if (!proposal?.usable) throw new SeoBlogError(409, 'There is nothing from your website we can use. Choose your logo and colours below.');
        if ((f('logoSha') ?? '') !== (proposal.logo?.sha256 ?? '') || (f('colour') ?? '').toLowerCase() !== (proposal.colour ?? '')) {
          throw new SeoBlogError(409, 'The logo or colour on your website changed since you looked. Check what we found now, then choose again.');
        }
        await studio.saveKit(actor.userId, brandId, commandId, { palette: proposal.palette, typography: kit?.typography, disclosure: kit?.disclosure ?? '', restricted: (kit?.restrictedPhrases ?? []).join('\n'),
          logo: proposal.logo ? { kind: 'upload', bytes: proposal.logo.bytes, label: 'Logo from your website' } : { kind: 'keep' }, expectedVersion: int(f('expectedVersion'), 'the kit version') });
        return ok(`${home}/kit`, proposal.logo && proposal.colour ? 'Saved. Your logo and main colour from your website are now in use.' : proposal.logo ? 'Saved. Your logo from your website is now in use.' : 'Saved. Your main colour from your website is now in use.');
      }
      if (parts[1] === 'kit') {
        const action = f('logo_action') ?? 'keep';
        const logo = action === 'remove' ? { kind: 'remove' as const } : action === 'upload' && form.file?.data.length ? { kind: 'upload' as const, bytes: form.file.data, label: f('logo_label') ?? '' } : { kind: 'keep' as const };
        const kit = await studio.saveKit(actor.userId, brandId, commandId, { palette: { primary: f('primary') ?? '', accent: f('accent') ?? '', dark: f('dark') ?? '', light: f('light') ?? '' },
          typography: f('typography') ?? undefined, disclosure: f('disclosure') ?? '', restricted: f('restricted') ?? '', logo, expectedVersion: int(f('expectedVersion'), 'the kit version') });
        return ok(home, `Creative kit version ${kit.version} saved. Earlier image approvals for this brand now need a refresh.`);
      }
      if (parts[1] === 'draft') {
        // Only the creative request fields travel into the job row: never the CSRF token, command id or background selectors.
        const raw: Record<string, string | string[]> = {};
        for (const key of new Set(form.fields.keys())) {
          if (['_csrf', 'commandId', 'background', 'saved', 'generated', 'file'].includes(key)) continue;
          raw[key] = key === 'placements' ? form.fields.getAll(key).slice(0, 8) : (form.fields.get(key) ?? '').slice(0, 2000);
        }
        return queued({ op: 'draft', raw, background: background() });
      }
      if (parts[1] === 's' && parts[2] && (parts[3] === 'concept' || parts[3] === 'refresh') && parts[4]) {
        const heads = (f('heads') ?? '').split(',').filter(Boolean);
        if (parts[3] === 'refresh') return queued({ op: 'refresh', setId: parts[2], conceptKey: parts[4], heads });
        const headlines = form.fields.getAll('card_headline'), bodies = form.fields.getAll('card_body');
        const patch = { ...(f('hook') !== null ? { hook: f('hook')! } : {}), ...(f('headline') !== null ? { headline: f('headline')! } : {}), ...(f('body') !== null ? { body: f('body')! } : {}),
          ...(f('cta') !== null ? { cta: f('cta')! } : {}), ...(headlines.length ? { cards: headlines.map((h, i) => ({ headline: h, body: bodies[i] ?? '' })) } : {}), illustrativeTag: f('illustrative') === '1' };
        return queued({ op: 'edit', setId: parts[2], conceptKey: parts[4], heads, patch, background: background() });
      }
      if (parts[1] === 's' && parts[2] && parts[3] === 'storyboard' && parts[4]) {
        return queued({ op: 'storyboard', setId: parts[2], conceptKey: parts[4], placement: f('placement') ?? 'vertical', likeness: f('likeness') === '1' });
      }
      if (parts[1] === 'v' && parts[2] && parts[3] === 'scenes') {
        const count = Math.min(9, Math.max(0, Number(f('scene_count') ?? 0)));
        const scenes = Array.from({ length: count }, (_, i) => ({ headline: f(`scene.${i}.headline`) ?? '', body: f(`scene.${i}.body`) ?? '', durationMs: Number(f(`scene.${i}.duration`)),
          motion: (f(`scene.${i}.motion`) ?? 'none') as never, showCta: f(`scene.${i}.cta`) === '1', script: f(`scene.${i}.script`) ?? '', remove: f(`scene.${i}.remove`) === '1' }))
          .filter((x) => !x.remove && x.headline.trim()).map(({ remove: _r, ...x }) => x);
        return queued({ op: 'storyboard_edit', versionId: parts[2], scenes });
      }
      if (parts[1] === 'v' && parts[2] && parts[3] === 'video') {
        return queued({ op: 'video', versionId: parts[2] });
      }
      if (parts[1] === 'v' && parts[2] && parts[3]) {
        const version = parts[2];
        const located = await studio.artworkSet(actor.userId, brandId, version);
        const back = `${home}/s/${located}#v-${version}`;
        if (parts[3] === 'approve') {
          await studio.approve(actor.userId, brandId, version, commandId, f('sha') ?? '', f('figures_confirmed') === '1');
          return ok(back, 'Approved this exact asset. Captions, campaigns, schedules and paid adverts are not approved by this.');
        }
        if (parts[3] === 'focal') return queued({ op: 'focal', versionId: version, focal: { x: Number(f('x')), y: Number(f('y')) } });
        if (parts[3] === 'handoff') {
          // `article:<id>` or `acq:<campaignId>:<conceptIndex>:<channel>`; legacy `article` field still accepted.
          const raw = (f('target') ?? (f('article') ? `article:${f('article')}` : '')).toLowerCase(), bits = raw.split(':');
          const target = bits[0] === 'article' && bits.length === 2 ? { kind: 'article_campaign' as const, articleId: bits[1]! }
            : bits[0] === 'acq' && bits.length === 4 && /^\d{1,2}$/u.test(bits[2]!) ? { kind: 'creator_campaign' as const, campaignId: bits[1]!, concept: Number(bits[2]), channel: bits[3]! } : null;
          if (!target) throw new SeoBlogError(400, 'Choose where to hand this artwork off.');
          const result = await studio.handoff(actor.userId, brandId, version, commandId, target);
          const route = result.handoff?.route;
          return ok(`${home}/s/${located}#distribution`, result.replayed ? 'This hand-off was already recorded.' : route === 'article_media'
            ? 'Added to the article’s private images. Review it there, choose it for a post and plan the post. Nothing was published, scheduled or spent.'
            : route === 'tracked_link' ? 'Tracked link issued for this artwork. Post it yourself; nothing was published or spent.'
            : 'Recorded for download only: no connected integration accepts this format. Nothing was published or spent.');
        }
      }
      throw new SeoBlogError(404, 'That page was not found.');
    }
    case 'methods': {
      if(parts[1]==='update'||parts[1]==='disable'){
        await engine.setReviewedMethods(actor,brandId,int(f('revision'),'the current rule assignment'),parts[1]==='disable'?[]:form.fields.getAll('packId'));
        return ok(back('methods'),parts[1]==='disable'?'Production packs switched off for this brand.':'Production pack choices saved for this brand.');
      }
      if(parts[1]!=='activate')throw new SeoBlogError(404,'That action was not found.');
      await engine.activateReviewedMethods(actor,brandId,int(f('revision'),'the current rule assignment'),f('creators')==='1');
      return ok(back('methods'),'Reviewed production rules assigned to this brand.');
    }
    case 'campaigns': {
      const creator=engine.creators();
      if(parts[1]==='create'){
        const profile=await engine.getProfile(actor,brandId),index=int(f('ctaIndex'),'the next-step link');
        const cta=profile?.conversionPages[index];if(!cta)throw new SeoBlogError(400,'Choose a confirmed next-step link.');
        const brief:CampaignBrief={kind:f('kind') as CampaignBrief['kind'],name:f('name')??'',goal:f('goal')??'',audience:f('audience')??'',purpose:f('purpose') as CampaignBrief['purpose'],count:int(f('count'),'the email count'),cta,
          offerName:f('offerName')||null,permissionContext:f('permissionContext')??'',customerMoment:f('customerMoment')??'',consentProcess:f('consentProcess')??'',incentiveTerms:f('incentiveTerms')??'None',
          ...(f('kind')==='acquisition'?{objective:(f('objective')??'') as CampaignBrief['objective'],channels:form.fields.getAll('channels') as CampaignBrief['channels'],articleIds:form.fields.getAll('articleId')}:{})};
        const r=await creator.create(actor.userId,brandId,f('commandId')??'',brief);
        return ok(back('campaigns/'+r.id),r.state==='draft'?'Campaign draft ready for review.':'Campaign saved. Review its current state before starting another run.');
      }
      const id=parts[1];if(!id)throw new SeoBlogError(404,'Campaign not found.');
      if(parts[2]==='recover'){
        const r=await creator.recover(actor.userId,brandId,id);
        return ok(back('campaigns/'+id),r.version?'Recovered the saved draft without another model call.':'Saved run checked. No new generation was started.');
      }
      if(parts[2]==='edit'){
        const record=await creator.get(actor.userId,brandId,id);
        await creator.edit(actor.userId,brandId,id,rowVersion(),f('contentSha')??'',creatorContentFromForm(record,form.fields));
        return ok(back('campaigns/'+id),'New draft version saved. Review it before export.');
      }
      if(['findings','pattern','pattern-withdraw','guidance'].includes(parts[2]??'')){
        const learning=input.service.creativeFor?.(input.identity!,input.requestId,engine)?.learning();
        if(!learning)throw new SeoBlogError(404,'The learning journal is not enabled for this brand.');
        const here=back('campaigns/'+id)+'#learning';
        if(parts[2]==='findings'){const r=await learning.record(actor.userId,brandId,id,f('commandId')??'');return ok(here,r.replayed?'These findings were already recorded.':'Findings recorded with today’s date and the exact outcomes they cite. Nothing was changed or started.');}
        if(parts[2]==='pattern'){await learning.sharePattern(actor.userId,brandId,f('findingId')??'',f('statement')??'',f('commandId')??'');return ok(here,'General pattern shared with your other brands. It carries no figures, names or offers, and you can withdraw it.');}
        if(parts[2]==='pattern-withdraw'){await learning.withdrawPattern(actor.userId,brandId,f('patternId')??'',f('commandId')??'');return ok(here,'Pattern withdrawn. Your other brands no longer see it.');}
        await learning.copyToGuidance(actor.userId,brandId,id,f('findingId')??'',f('acknowledge')==='1');
        return ok(back('setup'),'Findings saved to brand guidance as an audience note. Setup still shows the profile as confirmed for blog writing; use “Re-extract from current guidance”, then confirm, before the creative studio and campaign creators can use this brand again.');
      }
      if(parts[2]==='approve'){
        await creator.approve(actor.userId,brandId,id,rowVersion(),f('contentSha')??'',f('reviewed')==='1');
        return ok(back('campaigns/'+id),'This campaign draft is approved for export. Nothing was sent.');
      }
      throw new SeoBlogError(404,'That campaign action was not found.');
    }
    case 'dna': {
      // Brand DNA front door. Hidden fields carry positions and the card number only; every value shown to the owner
      // (an answer, a price) is read back from the stored card inside the engine.
      const here = back('dna');
      const whole = (name: string): number => {
        const raw = (f(name) ?? '').trim();
        if (!/^\d{1,9}$/.test(raw)) throw new SeoBlogError(400, 'Reload the page and try again.');
        return Number(raw);
      };
      if (parts[1] === 'read' && parts.length === 2) {
        await engine.requestBrandDna(actor, brandId, { commandId: f('commandId') ?? '', website: f('website'), readAgain: f('again') === '1', acknowledgePriorUsage: f('acknowledgePriorUsage') === '1' });
        return ok(here, 'Reading your website. It carries on in the background.');
      }
      if (parts[1] === 'settle' && parts.length === 2) {
        const picked = (f('choice') ?? '').trim();
        if (picked !== 'typed' && !/^\d{1,3}$/.test(picked)) throw new SeoBlogError(400, 'Choose one of the answers first.');
        await engine.settleBrandDnaConflict(actor, brandId, whole('version'), whole('conflict'), picked === 'typed' ? { kind: 'typed', text: f('typed') ?? '' } : { kind: 'option', index: Number(picked) });
        return ok(here, 'Answer saved.');
      }
      if (parts[1] === 'edit' && parts.length === 2) {
        await engine.correctBrandDna(actor, brandId, whole('version'), { summary: f('summary') ?? '', audiences: lines(f('audiences')), approvedClaims: lines(f('approvedClaims')), exclusions: lines(f('exclusions')), voiceDont: lines(f('voiceDont')) });
        return ok(here, 'Your changes are saved. Confirm the card to use it.');
      }
      if (parts[1] === 'confirm' && parts.length === 2) {
        await engine.confirmBrandDna(actor, brandId, whole('version'));
        return ok(here, 'Your Brand DNA is confirmed.');
      }
      break;
    }
    case 'basics': {
      await engine.updateBrandBasics(actor, brandId, { rowVersion: rowVersion(), website: f('website'), locale: (f('locale') ?? 'en-GB').trim(), timezone: (f('timezone') ?? 'Europe/London').trim() });
      return ok(back('setup'), 'Saved.');
    }
    case 'inventory': {
      await engine.requestInventory(actor, brandId);
      return ok(back('setup'), 'Reading the website. This continues in the background.');
    }
    case 'knowledge': {
      if(parts[2]==='category'&&parts[1]) {
        await engine.changeKnowledgeCategory(actor,brandId,parts[1],int(f('version'),'the document version'),f('category')??'');
        return ok(back('setup'),'Guidance kind saved as a new version. Original files and history were retained.');
      }
      if (parts[2] === 'retire' && parts[1]) {
        await engine.retireKnowledge(actor, brandId, parts[1]);
        return ok(back('setup'), 'Document retired. Re-extract the profile to apply the change.');
      }
      if (!form.file && !f('pastedText')?.trim()) throw new SeoBlogError(400, 'Choose a file or paste some text.');
      const doc = await engine.uploadKnowledge(actor, brandId, {
        category: f('category') ?? '', title: f('title') ?? '', filename: form.file?.filename ?? null, bytes: form.file?.data ?? null,
        pastedText: form.file ? null : (f('pastedText')?.trim() ? f('pastedText') : null), replacesDocumentId: f('replaces') || null,
      });
      return ok(back('setup'), `${doc.title}: ${doc.statusDetail}`);
    }
    case 'profile': {
      if (parts[1] === 'extract') {
        const job = await engine.requestProfileExtraction(actor, brandId, { commandId: f('commandId') ?? '', baseVersion: int(f('baseVersion'), 'the profile version'), acknowledgePriorUsage: f('acknowledgePriorUsage') === '1' });
        return ok(back('setup'), job.state === 'done' ? 'That extraction is ready. Review and confirm the profile.' : `Profile extraction ${job.state}. ${job.error ?? job.progress}`);
      }
      if (parts[1] === 'confirm') { await engine.confirmProfile(actor, brandId, int(f('version'), 'the profile version')); return ok(back('setup'), 'Profile confirmed.'); }
      if (parts[1] === 'edit') {
        const current = await engine.getProfile(actor, brandId);
        if (!current) throw new SeoBlogError(409, 'Extract a profile first.');
        const expectedVersion = int(f('version'), 'the profile version');
        if (current.version !== expectedVersion) throw new SeoBlogError(409, 'The brand profile changed. Reload it before saving your edits.');
        // Indices refer only to this stored version. Source references never come from the form.
        for (const key of form.fields.keys()) {
          if (!key.startsWith('conflict_') && !key.startsWith('missingFact_')) continue;
          const match = /^(conflict|missingFact)_(0|[1-9]\d*)_(field|detail|text|resolved)$/.exec(key);
          const count = match?.[1] === 'conflict' ? current.conflicts.length : current.missingFacts.length;
          if (!match || Number(match[2]) >= count || form.fields.getAll(key).length !== 1
            || (match[1] === 'conflict' ? !['field', 'detail', 'resolved'].includes(match[3]!) : !['text', 'resolved'].includes(match[3]!))) {
            throw new SeoBlogError(400, 'That profile issue is not in this version. Reload and try again.');
          }
        }
        const issueText = (key: string, previous: string, maximum: number): string => {
          const value = f(key);
          if (value === null) return previous;
          const text = value.trim();
          if (!text || text.length > maximum) throw new SeoBlogError(400, `Keep a description for each unresolved issue (up to ${maximum} characters), or explicitly mark it resolved.`);
          return text;
        };
        const conflicts = current.conflicts.flatMap((item, i) => f(`conflict_${i}_resolved`) === '1' ? [] : [{
          ...item, field: issueText(`conflict_${i}_field`, item.field, 200), detail: issueText(`conflict_${i}_detail`, item.detail, 2000),
        }]);
        const missingFacts = current.missingFacts.flatMap((item, i) => f(`missingFact_${i}_resolved`) === '1' ? [] : [issueText(`missingFact_${i}_text`, item, 2000)]);
        await engine.editProfile(actor, brandId, expectedVersion, {
          summary: (f('summary') ?? '').slice(0, 1200), positioning: (f('positioning') ?? '').slice(0, 1200), audiences: lines(f('audiences')),
          approvedClaims: lines(f('approvedClaims')), exclusions: lines(f('exclusions')), voice: { ...current.voice, dont: lines(f('voiceDont')) },
          conflicts, missingFacts,
        });
        return ok(back('setup'), 'Profile saved. Confirm it to use it.');
      }
      break;
    }
    case 'destinations': {
      if (parts[2] === 'check' && parts[1]) {
        const d = await engine.checkDestination(actor, brandId, parts[1]);
        return ok(back('setup'), `${d.label}: ${d.statusDetail}`);
      }
      const config: Record<string, string> = {};
      for (const [k, v] of form.fields) if (k.startsWith('cfg_')) config[k.slice(4)] = v;
      const d = await engine.connectDestination(actor, brandId, { type: f('type') ?? '', label: f('label') ?? '', config, credential: f('credential') ?? '' });
      return ok(back('setup'), `${d.label}: ${d.statusDetail}`);
    }
    case 'plan': {
      if(f('resumeHoldId')&&f('confirmResearchResume')!=='1') throw new SeoBlogError(400,'Confirm that you want a new research intent within your remaining allowance.');
      await engine.requestPlan(actor, brandId, {
        commandId: f('commandId') ?? '', focus: f('focus'), excluded: (f('excluded') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        sourceArticleUrl: f('sourceArticleUrl'),
        resumeHoldId:f('resumeHoldId'),
      });
      return ok(back('topics'), 'Planning started. Research and planning continue in the background.');
    }
    case 'editorial': {
      const categories:{id:string;label:string;slug:string}[]=[];
      for(let i=0;i<15;i++) {
        const id=f(`category_${i}_id`);const label=f(`category_${i}_label`)??'';const slug=f(`category_${i}_slug`)??'';
        if(!id||f(`category_${i}_include`)!=='1'||(!label.trim()&&!slug.trim())) continue;
        categories.push({id,label,slug});
      }
      await engine.approveEditorialStructure(actor,brandId,{rowVersion:rowVersion(),scanId:f('scanId')??'',scanSha:f('scanSha')??'',destinationId:f('destinationId')??'',root:f('root')??'',categories,newCategoryAddresses:f('newCategoryAddresses')==='1'});
      return ok(back('setup'),'Editorial guidance approved. Categories guide drafts; existing URLs and website routes were not changed.');
    }
    case 'plans': {
      if (parts[2] === 'accept' && parts[1]) { await engine.acceptPlan(actor, brandId, parts[1]); return ok(back('topics'), 'Plan accepted.'); }
      break;
    }
    case 'briefs': {
      const status = parts[2];
      if (parts[1] && (status === 'planned' || status === 'omitted' || status === 'postponed')) {
        await engine.setBriefStatus(actor, brandId, parts[1], status);
        return ok(back('topics'), 'Updated.');
      }
      break;
    }
    case 'generate': {
      const ids = form.fields.getAll('brief');
      const estimate = await engine.estimate(actor, brandId, ids);
      await engine.requestArticles(actor, brandId, ids);
      return ok(back('articles'), `Writing ${ids.length} article(s), about ${estimate.modelTokens.toLocaleString('en-GB')} tokens of ${estimate.remainingTokens.toLocaleString('en-GB')} remaining this month. Progress continues if you leave this page.`);
    }
    case 'calendar': {
      if (parts[1] === 'autoplace') {
        const r = await engine.autoPlaceArticles(actor, brandId, f('destinationId') ?? '');
        return ok(back('calendar'), `${r.placed} placed, ${r.unplaced} left unscheduled.`);
      }
      break;
    }
    case 'settings': {
      const brand = await engine.getBrand(actor, brandId);
      if(parts[1]==='authorise') {
        await engine.updateSettings(actor,brandId,rowVersion(),{ongoingProduction:brand.settings.ongoingProduction});
        return ok(back('publishing'),'Your current managing-owner authority was saved for the draft programme. Existing research holds still need an explicit resume.');
      }
      if (parts[1] === 'toggle') {
        if (f('name') === 'imageGenerationEnabled') {
          await engine.updateSettings(actor, brandId, rowVersion(), { media: { imageGenerationEnabled: f('value') === '1', authorizedBy: actor.userId, authorizedAt: new Date().toISOString() } });
          return ok(back('publishing'), 'Image production preference saved. Existing allowances and image approvals are unchanged.');
        }
        const name = f('name') as keyof BrandSettings;
        if (!['autoPublish', 'pauseAll', 'ongoingProduction', 'autoAcceptPlans'].includes(name)) throw new SeoBlogError(400, 'Unknown control.');
        await engine.updateSettings(actor, brandId, rowVersion(), { [name]: f('value') === '1' } as Partial<BrandSettings>);
        return ok(back('publishing'), 'Saved.');
      }
      await engine.updateSettings(actor, brandId, rowVersion(), settingsFromForm(brand, form.fields));
      return ok(back('publishing'), 'Settings saved.');
    }
    case 'social': {
      if (parts[1] === 'profile') { await engine.registerSocialProfile(actor, brandId, (f('displayName') ?? '').trim(), f('providerProfileId') ?? ''); return ok(back('social'), 'Zernio profile registered. Connect this brand’s accounts next.'); }
      if (parts[1] === 'connect') {
        const network = f('network');
        if (network !== 'instagram' && network !== 'linkedin') throw new SeoBlogError(400, 'Choose a network.');
        if (f('confirm') !== 'CONNECT') throw new SeoBlogError(400, 'Confirm the connection.');
        if (input.socialConnectHere !== true) throw new SeoBlogError(409, `Connect accounts from ${input.socialConnectHost ?? 'the host that receives the provider callback'}.`);
        const { authUrl } = await engine.beginSocialConnect(actor, brandId, network, f('intentId') ?? '');
        return send(res, 200, `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>Connect ${network}</title></head><body><main style="max-width:640px;margin:40px auto;font:16px system-ui"><h1>Continue to ${network}</h1><p>A one-use provider handoff is ready. Review and approve the account permissions with the provider; nothing is connected until it confirms.</p><p><a href="${authUrl.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}" rel="noopener noreferrer">Continue to ${network}</a></p><p><a href="${back('social')}">Back</a></p></main></body></html>`, 'text/html; charset=utf-8', { 'referrer-policy': 'no-referrer' });
      }
      if (parts[1] === 'bind') {
        const network = f('network');
        if (network !== 'instagram' && network !== 'linkedin') throw new SeoBlogError(400, 'Choose a network.');
        await engine.registerSocialBinding(actor, brandId, { network, providerAccountId: f('providerAccountId') ?? '', dailyCap: int(f('dailyCap'), 'posts per day'), monthlyCap: int(f('monthlyCap'), 'posts per month') });
        return ok(back('social'), 'Account registered. Caps of 0 keep delivery off until you raise them.');
      }
      if (parts[1] === 'revoke') { await engine.revokeSocialBinding(actor, brandId, f('bindingId') ?? ''); return ok(back('social'), 'Account revoked. Queued posts for it will hold.'); }
      break;
    }
    case 'jobs': {
      if (parts[1] && parts[2] === 'cancel') { await engine.cancelJob(actor, brandId, parts[1]); return ok(back('activity'), 'Task cancelled.'); }
      if (parts[1] && parts[2] === 'retry') { const task=await engine.retryJob(actor, brandId, parts[1]); return ok(back(task.kind==='plan'?'topics':'activity'), task.kind==='plan'?'Your plan is continuing from its saved progress.':'Task queued again.'); }
      if (parts[1] && parts[2] === 'image-retry') { await engine.retryImagePreparation(actor, brandId, parts[1]); return ok(back('activity'), 'Saved image queued for local preparation. No new image generation was requested.'); }
      break;
    }
    case 'articles': {
      const articleId = parts[1];
      const action = parts[2];
      if (!articleId) break;
      const here = back(`articles/${articleId}`);
      const campaignHere = `${here}/campaign`;
      const postFields=()=>({versionId:f('versionId')??'',rowVersion:Number(f('rowVersion')),draftId:f('draftId')??'',revisionId:f('revisionId')??'',commandId:f('commandId')??''});
      if(action==='post-save') {
        const d=await engine.savePostingDraft(actor,brandId,articleId,{...postFields(),title:f('title')??'',body:f('body')??'',question:f('question')??'',targetUrl:f('targetUrl')??null});
        return ok(`${here}/posts#post-${d.id}`,'New post version saved.');
      }
      if(action==='post-restore') {
        await engine.restorePostingDraft(actor,brandId,articleId,{...postFields(),restoreId:f('restoreId')??''});
        return ok(`${here}/posts#post-${f('draftId')??''}`,'Earlier text restored as a new post version.');
      }
      if(action==='post-answer') {
        const platform=f('platform');if(platform!=='reddit'&&platform!=='quora')throw new SeoBlogError(400,'Choose Reddit or Quora for this answer.');
        const d=await engine.createPostingAnswer(actor,brandId,articleId,{versionId:f('versionId')??'',rowVersion:Number(f('rowVersion')),platform,questionIndex:Number(f('questionIndex'))});
        return ok(`${here}/posts#post-${d.id}`,'Answer prepared from the article FAQ.');
      }
      const campaignSelection = () => ({ variantId: f('variantId') ?? '', revisionId: f('revisionId') ?? '' });
      const renderCampaignResults = async (batchResults: readonly CampaignActionResult[]) => {
        const [detail, jobs, brands, brand, social] = await Promise.all([engine.getArticle(actor, brandId, articleId), engine.listJobs(actor, brandId),
          engine.listBrands(actor), engine.getBrand(actor, brandId), engine.socialOverview(actor, brandId).catch(() => null)]);
        return send(res, 200, campaignPage({ brands, brand, tab: 'articles', csrf: portalCsrfToken(input.sessionSecret, input.identity!.sessionToken), applicationName: input.applicationName },
          { ...detail, jobs, social, now: new Date().toISOString(), batchResults }));
      };
      if (action === 'image-upload') {
        if (!form.file) throw new SeoBlogError(400, 'Choose a JPEG original.');
        await engine.uploadCampaignImage(actor, brandId, articleId, f('versionId') ?? '', f('commandId') ?? '', form.file.data, form.file.filename);
        return ok(campaignHere, 'Owner JPEG saved privately and three real crops prepared locally. Review the pixels and description before selecting a use.');
      }
      if (action === 'image-withdraw') {
        if (f('acknowledgeWithdrawal') !== '1') throw new SeoBlogError(400, 'Explicitly confirm which public/social image uses you are withdrawing.');
        const scope = f('scope'), common = { commandId: f('commandId') ?? '', assetSha256: f('assetSha256') ?? '', reason: (f('reason') ?? '').trim() };
        if (scope !== 'asset' && scope !== 'release') throw new SeoBlogError(400, 'Choose the exact withdrawal scope.');
        await engine.withdrawCampaignImage(actor, brandId, articleId, scope === 'asset' ? { ...common, scope, assetId: f('assetId') ?? '' } : { ...common, scope, releaseId: f('releaseId') ?? '' });
        return ok(campaignHere, 'Explicit image withdrawal recorded. Affected public URLs stop serving pixels and new deliveries are held; history is retained.');
      }
      if (action === 'image-quality-review') {
        const profile = f('profile'); if (profile !== 'blog' && profile !== 'instagram' && profile !== 'linkedin') throw new SeoBlogError(400, 'Choose a supported image crop.');
        await engine.reviewCampaignImage(actor, brandId, articleId, f('commandId') ?? '', { assetId: f('assetId') ?? '', assetSha256: f('assetSha256') ?? '', profile, alt: (f('alt') ?? '').trim() });
        return ok(campaignHere, 'Exact private crop and alt text approved for quality. Select a separate hero or social use for the final version.');
      }
      if (action === 'image-crop') {
        const x = Number(f('focalX')), y = Number(f('focalY'));
        if (!f('focalX') || !f('focalY') || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) throw new SeoBlogError(400, 'Choose horizontal and vertical focal positions from 0 to 100.');
        await engine.cropCampaignImage(actor, brandId, articleId, f('versionId') ?? '', f('commandId') ?? '', f('candidateAssetId') ?? '', f('candidateSha256') ?? '', { x: x / 100, y: y / 100 });
        return ok(campaignHere, 'New private crops prepared from the saved original. Review their exact pixels and alt text; no image provider was called.');
      }
      if (action === 'image-select-hero') { const v = await engine.selectCampaignHero(actor, brandId, articleId, f('versionId') ?? '', f('commandId') ?? '', f('qualityCommandId') ?? ''); return ok(campaignHere, `Hero URL pinned in article version ${v.number}. Review the final target, authorize this exact use, then approve the blog.`); }
      if (action === 'image-authorize-hero') { await engine.authorizeCampaignHero(actor, brandId, articleId, f('versionId') ?? '', f('commandId') ?? ''); return ok(campaignHere, 'Exact final-version hero use authorized. Pixels remain private until the publication transaction releases this same URL.'); }
      if (action === 'campaign-select-image') { await engine.selectCampaignPostImage(actor, brandId, articleId, f('versionId') ?? '', campaignSelection(), f('commandId') ?? '', f('qualityCommandId') ?? ''); return ok(campaignHere, 'New exact post revision and image use saved. Review its text and image together before post approval.'); }
      if (action === 'image-request') {
        const result = await engine.requestArticleImage(actor, brandId, articleId, f('versionId') ?? '', { commandId: f('commandId') ?? '', confirmedNewIntent: f('confirmedNewIntent') === '1', replacesIntentId: f('replacesIntentId') });
        return ok(campaignHere, result.kind === 'held' ? result.detail : 'Image preparation queued. Progress is saved; you can leave this page.');
      }
      if (action === 'campaign-edit') {
        await engine.editCampaignPost(actor, brandId, articleId, f('versionId') ?? '', campaignSelection(), { title: (f('title') ?? '').trim(), copy: (f('copy') ?? '').trim(), artworkInstructions: (f('artworkInstructions') ?? '').trim() });
        return ok(campaignHere, 'New post revision saved. Review its exact text and image use again; other posts and the blog are unchanged.');
      }
      if (action === 'campaign-rebase') { await engine.rebaseCampaign(actor, brandId, articleId, f('versionId') ?? ''); return ok(campaignHere, 'New parent-bound campaign revisions saved. Earlier history, owner text, dates and omissions are retained; approvals must be renewed.'); }
      if (action === 'campaign-omit' || action === 'campaign-pin' || action === 'campaign-relative') {
        await engine.controlCampaignPost(actor, brandId, articleId, f('versionId') ?? '', campaignSelection(), action === 'campaign-omit' ? { kind: 'omit', omitted: f('omitted') === '1' } : action === 'campaign-pin' ? { kind: 'pin', localDate: f('localDate') ?? '', localTime: f('localTime') ?? '' } : { kind: 'relative' });
        return ok(campaignHere, 'Campaign choice saved. No external post was queued or moved.');
      }
      if (action === 'campaign-approve') { await engine.approveCampaignPost(actor, brandId, articleId, f('versionId') ?? '', campaignSelection()); return ok(campaignHere, 'Exact post approved. Public delivery remains separately gated by the live blog, account and current controls.'); }
      if (action === 'campaign-queue') {
        let dateRule: unknown; try { dateRule = JSON.parse(f('dateRule') ?? ''); } catch { throw new SeoBlogError(400, 'Refresh and review the campaign date.'); }
        const command = { versionId: f('versionId') ?? '', ...campaignSelection(), commandId: f('commandId') ?? '', bindingId: f('bindingId') ?? '', dateRule };
        try { await engine.queueCampaignPost(actor, brandId, articleId, command); }
        catch (error) { return renderCampaignResults([{ title: 'Delivery instruction', confirmed: false, detail: error instanceof SeoBlogError ? error.message : 'Result not confirmed. Recover this same instruction before creating a new one.', retry: command }]); }
        return ok(campaignHere, 'Delivery instruction safely recorded. The worker waits for this exact blog to be independently verified live, then checks the captured date, approvals, image, account and current controls.');
      }
      if (action === 'campaign-queue-cancel') { await engine.cancelCampaignPostQueue(actor, brandId, articleId, f('queueIntentId') ?? '', f('commandId') ?? ''); return ok(campaignHere, 'Future delivery instruction cancelled. Any already uncertain provider outcome can still be reconciled; no new send was authorized.'); }
      if (action === 'campaign-queue-selected') {
        const detail = await engine.getArticle(actor, brandId, articleId), results: CampaignActionResult[] = [];
        if (!detail.version || detail.version.id !== f('versionId')) throw new SeoBlogError(409, 'The blog changed. Refresh before authorizing delivery.');
        for (const variant of detail.article.campaign?.variants ?? []) {
          const revisionId = f(`queue_${variant.id}`); if (!revisionId) continue;
          const title = `${variant.network} · ${variant.angle.replace('_', ' ')}`;
          let command: CampaignActionResult['retry'];
          try {
            let dateRule: unknown; try { dateRule = JSON.parse(f(`queueDate_${variant.id}`) ?? ''); } catch { throw new SeoBlogError(400, 'Refresh and review this post date.'); }
            command = { versionId: detail.version.id, variantId: variant.id, revisionId, commandId: f(`queueCommand_${variant.id}`) ?? '', bindingId: f(`queueBinding_${variant.id}`) ?? '', dateRule };
            await engine.queueCampaignPost(actor, brandId, articleId, command);
            results.push({ title, confirmed: true, detail: 'Genuine delivery instruction saved. Waiting for exact live blog and current delivery controls.' });
          } catch (error) { results.push({ title, confirmed: false, detail: error instanceof SeoBlogError ? error.message : 'Result not confirmed. Recover this same instruction before creating a new one.', ...(command ? { retry: command } : {}) }); }
        }
        return renderCampaignResults(results.length ? results : [{ title: 'No posts selected', confirmed: false, detail: 'Choose eligible exact post revisions to authorize.' }]);
      }
      if (action === 'campaign-approve-selected') {
        const detail = await engine.getArticle(actor, brandId, articleId);
        const exactVersion = detail.version;
        if (!exactVersion || exactVersion.id !== f('versionId')) throw new SeoBlogError(409, 'The blog changed. Refresh before reviewing posts.');
        const results: { title: string; confirmed: boolean; detail: string }[] = [];
        for (const variant of detail.article.campaign?.variants ?? []) {
          const selected = f(`approve_${variant.id}`); if (!selected) continue;
          const title = `${variant.network} · ${variant.angle.replace('_', ' ')}`;
          try { await engine.approveCampaignPost(actor, brandId, articleId, exactVersion.id, { variantId: variant.id, revisionId: selected }); results.push({ title, confirmed: true, detail: 'Exact post approved. Scheduling and public delivery remain separately gated.' }); }
          catch (error) { results.push({ title, confirmed: false, detail: error instanceof SeoBlogError ? error.message : 'Approval result not confirmed. Refresh and review this exact item before retrying.' }); }
        }
        return renderCampaignResults(results.length ? results : [{ title: 'No posts selected', confirmed: false, detail: 'Choose eligible exact post revisions to approve.' }]);
      }
      if(action==='website-target'){
        const v=await engine.reviewArticleWebsiteTarget(actor,brandId,articleId,{expectedVersionId:f('versionId')??'',destinationId:f('destinationId')??'',categoryIds:form.fields.getAll('categoryId')});
        return ok(here,`Website target saved in version ${v.number}. Review and approve that exact version before publication.`);
      }
      if(action==='delivery-recheck'){await engine.reobservePublication(actor,brandId,articleId,f('publicationId')??'');return ok(here,'Public delivery checks updated. No article was republished.');}
      if(action==='sitemap-repair'){await engine.requestSitemapRepair(actor,brandId,articleId,{publicationId:f('publicationId')??'',commandId:f('commandId')??'',acknowledgeUnknown:f('acknowledgeUnknown')==='1'});return ok(here,'Sitemap-only repair intent recorded. Article and index bytes will not be republished.');}
      if (action === 'edit') {
        const ids = form.fields.getAll('sectionId'), headings = form.fields.getAll('sectionHeading'), bodies = form.fields.getAll('sectionBody');
        if (ids.length !== headings.length || ids.length !== bodies.length) throw new SeoBlogError(400, 'Refresh the editor and try again.');
        const questions=form.fields.getAll('faqQuestion'),answers=form.fields.getAll('faqAnswer'),editFaqs=f('faqEditor')==='1';
        if(editFaqs&&(questions.length!==answers.length||questions.length>8||questions.some(q=>!q.trim()||q.length>200)||answers.some(a=>!a.trim()||a.length>1500)))throw new SeoBlogError(400,'Each FAQ needs a question and answer within the shown limits. Refresh the editor and try again.');
        const current = (await engine.getArticle(actor, brandId, articleId)).version;
        const imageUrl = (f('imageUrl') ?? '').trim();
        const imageChanged = current && (imageUrl !== (current.body.image.url ?? '') || (f('imageAlt') ?? '') !== current.body.image.alt);
        const v = await engine.editArticle(actor, brandId, articleId, f('versionId') ?? '', {
          title: f('title') ?? '', slug: f('slug') ?? '', seoTitle: f('seoTitle') ?? '', metaDescription: f('metaDescription') ?? '', excerpt: f('excerpt') ?? '',
          intro: f('intro') ?? '', conclusion: f('conclusion') ?? '',
          sections: ids.map((id, i) => ({ id, heading: headings[i]!, body: bodies[i]! })),
          ...(editFaqs?{faqs:questions.map((q,i)=>({q:q.trim(),a:answers[i]!.trim()}))}:{}),
          ...(imageChanged ? { image: imageUrl ? { kind: 'brand_asset', url: imageUrl, alt: f('imageAlt') ?? '', provenance: '', width: null, height: null } : { kind: 'none', url: null, alt: f('imageAlt') ?? '', provenance: '', width: null, height: null } } : {}),
        });
        return ok(here, `Saved as version ${v.number}. Checks ran again.`);
      }
      if (action === 'regenerate-section') {
        const v = await engine.regenerateSection(actor, brandId, articleId, f('versionId') ?? '', f('sectionId') ?? '', f('instruction') ?? '');
        return ok(here, `Section regenerated as version ${v.number}. Other sections are unchanged.`);
      }
      if (action === 'regenerate') { await engine.requestRegeneration(actor, brandId, articleId, f('versionId') ?? ''); return ok(here, 'Regenerating in the background. The current version stays available.'); }
      if (action === 'promotion-refresh') {
        await engine.refreshPromotionVersion(actor, brandId, articleId, f('versionId') ?? '');
        return ok(here, 'A new article and promotion version is ready for review. Previous linked approvals no longer authorise delivery.');
      }
      if (action === 'promotion-approve') {
        const network = f('network');
        if (network !== 'instagram' && network !== 'linkedin') throw new SeoBlogError(400, 'Choose an accompanying post.');
        await engine.approvePromotion(actor, brandId, articleId, f('versionId') ?? '', network, f('packSha') ?? '');
        return ok(here, 'Exact accompanying post approved. It is held until the same blog version and URL are verified public and a brand-owned account is connected.');
      }
      if (action === 'social-schedule') {
        const network = f('network');
        if (network !== 'instagram' && network !== 'linkedin') throw new SeoBlogError(400, 'Choose an accompanying post.');
        const d = await engine.scheduleSocial(actor, brandId, articleId, f('versionId') ?? '', network, f('packSha') ?? '', (f('localDate') ?? '').trim(), (f('localTime') ?? '').trim());
        return ok(here, `${network} post queued for ${d.scheduledFor.slice(0, 16).replace('T', ' ')} UTC through the brand’s registered account. It is re-verified shortly before sending.`);
      }
      if (action === 'checks') { const c = await engine.rerunChecks(actor, brandId, articleId); return ok(here, `Checks: ${c.issues.length} issue(s).`); }
      if (action === 'approve') { await engine.approve(actor, brandId, articleId, f('versionId') ?? ''); return ok(here, 'Approved.'); }
      if (action === 'approval-flag') { await engine.setRequiresApproval(actor, brandId, articleId, rowVersion(), f('required') === '1'); return ok(here, 'Saved.'); }
      if (action === 'hold') { await engine.hold(actor, brandId, articleId, rowVersion(), f('held') === '1'); return ok(here, f('held') === '1' ? 'Held.' : 'Hold released.'); }
      if (action === 'schedule') {
        const a = await engine.schedule(actor, brandId, articleId, rowVersion(), { localDate: f('localDate') ?? '', localTime: f('localTime') ?? '', destinationId: f('destinationId') ?? '' });
        return ok(here, `Scheduled for ${a.schedule!.localDate} ${a.schedule!.localTime}. Nothing changes on the website until then.`);
      }
      if (action === 'unschedule') { await engine.unschedule(actor, brandId, articleId, rowVersion()); return ok(here, 'Schedule cancelled.'); }
      if (action === 'proposal') {
        await engine.moveProposedDate(actor, brandId, articleId, rowVersion(), f('localDate') ?? '', f('localTime') ?? '');
        return ok(back('calendar'), 'Proposed date moved. No website publication was scheduled.');
      }
      break;
    }
  }
  throw new SeoBlogError(404, 'That action was not found.');
}

function settingsFromForm(brand: Brand, form: URLSearchParams): Partial<BrandSettings> {
  const authorName = (form.get('authorName') ?? '').trim();
  const authorUrl = (form.get('authorUrl') ?? '').trim();
  const length = form.get('length');
  return {
    ...(form.has('programmeFocus')?{programme:{focus:form.get('programmeFocus')??'',exclusions:lines(form.get('programmeExclusions'))}}:{}),
    cadence: { weekdays: form.getAll('weekday').map(Number), localTime: form.get('localTime') ?? brand.settings.cadence.localTime, perWeek: int(form.get('perWeek'), 'posts per week') },
    planningHorizonDays: int(form.get('horizon'), 'the planning horizon'),
    backlogCeiling: int(form.get('backlog'), 'the backlog ceiling'),
    lengthPreference: length === 'concise' || length === 'in-depth' ? length : 'standard',
    budgets: { modelTokensPerMonth: int(form.get('modelTokens'), 'the writing budget'), searchCallsPerMonth: int(form.get('searchCalls'), 'the research budget'), imagesPerMonth: int(form.get('images'), 'the image budget') },
    author: authorName ? { name: authorName.slice(0, 120), ...(authorUrl ? { url: authorUrl } : {}) } : null,
  };
}
