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
  SEO_BLOG_BASE, setupPage, socialPage, topicsPage, layout, type Shell, type SeoBlogTab,
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
import { campaignDeliveryCalendarPage } from './seo-blog-campaign-calendar-view.js';
import { campaignCreatorsPage, campaignCreatorReviewPage, creatorContentFromForm, creatorTextExport, productionRulesPage } from './campaign-creator-view.js';
import type { CampaignBrief } from '../seo-blog/campaign-creator.js';
import {postingDraftsPage,POSTING_DRAFTS_SCRIPT} from './seo-blog-posting-view.js';
import {exportPostDraft} from '../seo-blog/platform-drafts.js';

export interface SeoBlogRouteInput {
  readonly service: PortalSeoBlogService;
  readonly identity: PortalSessionIdentity | null;
  readonly requestId: string;
  readonly sessionSecret: string;
  readonly vaultReady: boolean;
  readonly applicationName?: string;
  /** Whether provider OAuth callbacks return to this host; connection starts only where they complete. */
  readonly socialConnectHere?: boolean;
  readonly socialConnectHost?: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const BRAND_PATH = new RegExp(`^${SEO_BLOG_BASE}/b/(${UUID})(?:/(.*))?$`, 'i');
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
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
  if (value === null || !/^\d{1,10}$/.test(value.trim())) throw new SeoBlogError(400, `Enter a whole number for ${field}.`);
  return Number(value.trim());
}

export async function handleSeoBlog(req: IncomingMessage, res: ServerResponse, url: URL, input: SeoBlogRouteInput): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '') || SEO_BLOG_BASE;
  const method = req.method ?? 'GET';
  if (method === 'GET' && path === `${SEO_BLOG_BASE}/campaign-image-status.js`) return send(res, 200, CAMPAIGN_IMAGE_STATUS_SCRIPT, 'text/javascript; charset=utf-8');
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
      return await handlePost(res, engine, actor, path, brandId, rest, form, f, back, ok, input);
    }
    if (method !== 'GET' && method !== 'HEAD') throw new SeoBlogError(405, 'Use the controls on the page.');

    if (path === `${SEO_BLOG_BASE}/switch`) {
      const target = url.searchParams.get('brand') ?? '';
      if (!new RegExp(`^${UUID}$`, 'i').test(target)) throw new SeoBlogError(400, 'Choose a brand.');
      return redirect(res, `${SEO_BLOG_BASE}/b/${target.toLowerCase()}/overview`);
    }
    const brands = await engine.listBrands(actor);
    const messages = readMessage(input.sessionSecret, url);
    if (path === SEO_BLOG_BASE) {
      return send(res, 200, brandsPage({ brands, brand: null, tab: null, csrf, ...messages, applicationName: input.applicationName }, randomUUID()));
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
    const shell = (tab: SeoBlogTab): Shell => ({ brands, brand, tab, csrf, ...messages, applicationName: input.applicationName,creatorsAvailable:engine.campaignCreatorsReady,methodsAvailable:engine.productionMethodsReady });
    if(rest==='methods')return send(res,200,productionRulesPage(shell('methods'),await engine.methodOverview(actor,brandId),engine.campaignCreatorsReady));
    if(rest==='campaigns'||rest.startsWith('campaigns/')){
      const creator=engine.creators(),parts=rest.split('/');
      if(!parts[1]){
        const settings=await engine.methodOverview(actor,brandId),pins=settings.assignment?.pins??[];
        const enabled=(['email','advocacy'] as const).filter(kind=>pins.some(p=>p.packId===(kind==='email'?'email-writing':'advocacy-and-referral')));
        return send(res,200,campaignCreatorsPage(shell('campaigns'),await engine.getProfile(actor,brandId),await creator.list(actor.userId,brandId),enabled));
      }
      const record=await creator.get(actor.userId,brandId,parts[1]);
      if(parts[2]==='export'){
        const json=await creator.export(actor.userId,brandId,record.id);
        const format=url.searchParams.get('format')==='json'?'json':'txt';
        return send(res,200,format==='json'?json:creatorTextExport(record,JSON.parse(json).content),format==='json'?'application/json; charset=utf-8':'text/plain; charset=utf-8',{'content-disposition':`attachment; filename="campaign.${format}"`});
      }
      return send(res,200,campaignCreatorReviewPage(shell('campaigns'),record,await engine.getProfile(actor,brandId)));
    }
    if (rest === 'authority') {
      if (input.applicationName !== 'Relaunch72 Content') throw new SeoBlogError(404, 'That page was not found.');
      const data = await loadAuthorityProgrammePage(engine, actor, brandId);
      return send(res, 200, layout(shell('authority'), 'Authority', authorityProgrammeContent(data)));
    }
    const tab = rest.split('/')[0] || 'overview';
    if (tab === 'overview') {
      const [readiness, articles, usage, jobs] = await Promise.all([engine.readiness(actor, brandId), engine.listArticles(actor, brandId), engine.usage(actor, brandId), engine.listJobs(actor, brandId)]);
      const apollo = await input.service.apolloUsage?.(identity, input.requestId, brandId) ?? null;
      return send(res, 200, overviewPage(shell('overview'), { readiness, articles, usage, jobs, apollo }));
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
      const tab = rest.startsWith('articles/') ? `articles/${rest.split('/')[1]}${articleAction.startsWith('campaign-') || articleAction.startsWith('image-') ? '/campaign' : ''}` : rest.split('/')[0] || 'overview';
      return redirect(res, `${back(tab === 'basics' || tab === 'knowledge' || tab === 'profile' || tab === 'destinations' || tab === 'inventory' || tab==='editorial' ? 'setup' : tab === 'plan' || tab === 'plans' || tab === 'briefs' || tab === 'generate' ? 'topics' : tab === 'settings' ? 'publishing' : tab === 'jobs' ? 'activity' : tab)}?${signedMessage(input.sessionSecret, 'e', message)}`);
    }
    const status = known ? error.status : 503;
    return send(res, status, `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>SEO Blog</title></head><body><main style="max-width:640px;margin:40px auto;font:16px system-ui"><h1>${status === 404 ? 'Not found' : 'Something needs attention'}</h1><p>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p><p><a href="${SEO_BLOG_BASE}">Back to brands</a></p></main></body></html>`);
  }
}

async function handlePost(
  res: ServerResponse, engine: SeoBlogEngine, actor: Actor, path: string, brandId: string | null, rest: string, form: FormData,
  f: (name: string) => string | null, back: (tab: string) => string, ok: (location: string, text: string) => void, input: SeoBlogRouteInput,
): Promise<void> {
  if (path === `${SEO_BLOG_BASE}/brands`) {
    const { brand, created } = await engine.createBrand(actor, { commandId: f('commandId') ?? '', name: f('name') ?? '', website: f('website') });
    return ok(`${SEO_BLOG_BASE}/b/${brand.id}/setup`, created ? `${brand.name} created. Add its website and guidance next.` : `${brand.name} already exists.`);
  }
  if (!brandId) throw new SeoBlogError(404, 'That page was not found.');
  const parts = rest.split('/');
  const rowVersion = () => int(f('rowVersion'), 'the form version');
  switch (parts[0]) {
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
          offerName:f('offerName')||null,permissionContext:f('permissionContext')??'',customerMoment:f('customerMoment')??'',consentProcess:f('consentProcess')??'',incentiveTerms:f('incentiveTerms')??'None'};
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
      if(parts[2]==='approve'){
        await creator.approve(actor.userId,brandId,id,rowVersion(),f('contentSha')??'',f('reviewed')==='1');
        return ok(back('campaigns/'+id),'This campaign draft is approved for export. Nothing was sent.');
      }
      throw new SeoBlogError(404,'That campaign action was not found.');
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
        const current = (await engine.getArticle(actor, brandId, articleId)).version;
        const imageUrl = (f('imageUrl') ?? '').trim();
        const imageChanged = current && (imageUrl !== (current.body.image.url ?? '') || (f('imageAlt') ?? '') !== current.body.image.alt);
        const v = await engine.editArticle(actor, brandId, articleId, f('versionId') ?? '', {
          title: f('title') ?? '', slug: f('slug') ?? '', seoTitle: f('seoTitle') ?? '', metaDescription: f('metaDescription') ?? '', excerpt: f('excerpt') ?? '',
          intro: f('intro') ?? '', conclusion: f('conclusion') ?? '',
          sections: ids.map((id, i) => ({ id, heading: headings[i]!, body: bodies[i]! })),
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
