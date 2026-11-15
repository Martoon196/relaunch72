/**
 * Unified application service for RL72's embedded and standalone media products.
 * The same service handles affiliate and general campaigns and owns all lifecycle
 * checks. External video API calls are opt-in and never fired by merely viewing.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  MediaStore, MediaError, findCampaign, findVariant, newId, nowIso, requiredText, validUrl,
  type Campaign, type CampaignMode, type Rights, type Variant, type Job, type MediaState,
} from './store.js';
import { VizardClips, ShotstackRender } from './providers.js';

export interface CampaignInput {
  name: string; brief: string; mode?: CampaignMode;
  sourceUrl?: string; rights?: Rights; rightsEvidence?: string;
}

function log(d: MediaState, c: Campaign, action: string, detail = ''): void {
  d.audit.unshift({ id: newId(), at: nowIso(), campaignId: c.id, action, detail });
  if (d.audit.length > 500) d.audit.length = 500;
}
function checkSourceRights(c: Campaign): void {
  if (!c.sourceUrl) throw new MediaError('Add a video source URL');
  if (c.rights !== 'owned' && c.rights !== 'licensed') throw new MediaError('Confirm that you own this video or have permission to repurpose it');
  if (c.rights === 'licensed' && !c.rightsEvidence) throw new MediaError('Licensed footage needs a permission/licence reference');
}
function requireTitle(v: Variant): void {
  if (!v.script.trim()) throw new MediaError('Create or enter a script before approval');
}
function promptFor(c: Campaign): string {
  const products = c.products.map((p) => p.name + ' (' + p.merchant + ')').join('; ') || 'none supplied';
  return [
    'Act as a skilled UK video marketing copywriter. Return a concise original script for an educational vertical video.',
    'Do not invent product specifications, test results, prices, sales, reviews or endorsements.',
    'If specific claims lack evidence, mark them as [VERIFY] instead of stating them as facts.',
    'Use clear non-manipulative language. No fake scarcity or customer testimonials.',
    'Always mark affiliate promotional script sections as #ad and give a genuine disclosure.',
    'Structure: HOOK, SCENE 1-3, CTA. Limit 230 spoken words. Do not describe a personal test unless supplied.',
    'Audience niche: ' + c.mode,
    'Campaign: ' + c.name,
    'Brief: ' + c.brief,
    'Products: ' + products,
  ].join('\n');
}

export class MediaEngine {
  constructor(
    readonly store: MediaStore,
    private readonly clips = new VizardClips(),
    private readonly renders = new ShotstackRender(),
    private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? '',
  ) {}
  capabilities() {
    return { scripting: Boolean(this.apiKey), clipping: this.clips.configured,
      rendering: this.renders.configured, publishing: false, editor: 'shotstack-json',
      mode: 'tenant-isolated', liveCallsRequireExplicitAction: true };
  }
  list(tid: string): Promise<MediaState> { return this.store.read(tid); }
  async create(tid: string, req: CampaignInput): Promise<Campaign> {
    return this.store.update(tid, (s) => {
      if (s.campaigns.length >= 100) throw new MediaError('Campaign limit reached', 429);
      const mode = req.mode ?? 'affiliate';
      if (!['affiliate','general'].includes(mode)) throw new MediaError('Invalid campaign mode');
      const rights: Rights = req.rights ?? 'none';
      if (!['owned','licensed','none'].includes(rights)) throw new MediaError('Invalid rights status');
      const sourceUrl = req.sourceUrl ? validUrl(req.sourceUrl, 'Video source') : null;
      if (sourceUrl && rights === 'none') throw new MediaError('Choose owned or licensed for this source');
      const c: Campaign = {
        id: newId(), tenantId: tid, name: requiredText(req.name,'Campaign name',140),
        mode, brief: requiredText(req.brief,'Campaign brief',5000),
        sourceUrl, rights, rightsEvidence: req.rightsEvidence?.trim().slice(0,1000) || null,
        products: [], variants: [], jobs: [], createdAt: nowIso(), updatedAt: nowIso(),
      };
      if (sourceUrl) checkSourceRights(c);
      s.campaigns.unshift(c); log(s,c,'campaign_created');
      return structuredClone(c);
    });
  }
  async product(tid: string, id: string, data: {
    name: string; merchant: string; productUrl: string; affiliateUrl?: string;
  }) {
    return this.store.update(tid, (s) => {
      const c = findCampaign(s,id);
      if (c.products.length >= 100) throw new MediaError('Product limit reached',429);
      const p = {
        id: newId(), name: requiredText(data.name,'Product name',160),
        merchant: requiredText(data.merchant,'Merchant',100),
        productUrl: validUrl(data.productUrl,'Product URL'),
        affiliateUrl: data.affiliateUrl ? validUrl(data.affiliateUrl,'Affiliate URL') : null,
        createdAt: nowIso(),
      };
      c.products.push(p); c.updatedAt = nowIso();
      log(s,c,'product_added',p.name);
      return p;
    });
  }
  async draftScript(tid: string, id: string): Promise<Variant> {
    if (!this.apiKey) throw new MediaError('Configure ANTHROPIC_API_KEY for AI scripting',503);
    const read = await this.store.read(tid);
    const c = findCampaign(read,id);
    if (c.variants.length >= 100) throw new MediaError('Variant limit reached',429);
    const client = new Anthropic({ apiKey: this.apiKey });
    const result = await client.messages.create({
      model: process.env.RL72_MEDIA_SCRIPT_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: promptFor(c) }],
    });
    const script = result.content.filter((part) => part.type === 'text')
      .map((part) => part.text).join('\n').trim();
    if (!script) throw new MediaError('Script provider returned no text',502);
    return this.saveScript(tid,id,script,'AI script');
  }
  async saveScript(tid: string, id: string, script: string, title = 'Script draft'): Promise<Variant> {
    return this.store.update(tid, (s) => {
      const c = findCampaign(s,id);
      if (c.variants.length >= 100) throw new MediaError('Variant limit reached',429);
      const now = nowIso();
      const v: Variant = { id: newId(), title: requiredText(title,'Title',160),
        script: requiredText(script,'Script',10000), mediaUrl:null, timeline:null,
        status:'draft', approvedAt:null, scheduledAt:null, platform:null,
        providerPostId:null, createdAt:now, updatedAt:now };
      c.variants.push(v); c.updatedAt=now; log(s,c,'variant_created');
      return structuredClone(v);
    });
  }
  async edit(tid: string, id: string, variantId: string, input: {
    title?: string; script?: string; timeline?: unknown; mediaUrl?: string;
  }): Promise<Variant> {
    return this.store.update(tid, (s) => {
      const c=findCampaign(s,id), v=findVariant(c,variantId);
      if (v.status==='published') throw new MediaError('Published media cannot be edited; duplicate it instead',409);
      if (v.status==='scheduled') throw new MediaError('Cancel the scheduled post before editing',409);
      if (input.title!==undefined) v.title=requiredText(input.title,'Title',160);
      if (input.script!==undefined) v.script=requiredText(input.script,'Script',10000);
      if (input.timeline!==undefined) {
        if (!input.timeline || typeof input.timeline!=='object' ||
          !('timeline' in input.timeline) || !('output' in input.timeline))
          throw new MediaError('Edit must be a Shotstack timeline/output JSON');
        if (JSON.stringify(input.timeline).length > 150000) throw new MediaError('Timeline too large');
        v.timeline=input.timeline;
      }
      if (input.mediaUrl!==undefined) v.mediaUrl=validUrl(input.mediaUrl,'Media URL');
      v.status='editing'; v.approvedAt=null; v.updatedAt=nowIso(); c.updatedAt=v.updatedAt;
      log(s,c,'variant_edited',variantId);
      return structuredClone(v);
    });
  }
  async approve(tid: string, id: string, variantId: string, flags: {
    claimsVerified?: boolean; rightsVerified?: boolean; adDisclosure?: boolean;
  }): Promise<Variant> {
    return this.store.update(tid, (s) => {
      const c=findCampaign(s,id), v=findVariant(c,variantId);
      if (v.status==='published' || v.status==='scheduled') throw new MediaError('Already published or scheduled',409);
      requireTitle(v);
      if (!flags.claimsVerified || !flags.rightsVerified || (c.mode==='affiliate' && !flags.adDisclosure))
        throw new MediaError('Human must confirm factual claims, rights and affiliate disclosure');
      if (c.sourceUrl) checkSourceRights(c);
      v.status='approved'; v.approvedAt=nowIso(); v.updatedAt=nowIso(); c.updatedAt=v.updatedAt;
      log(s,c,'human_approved',variantId);
      return structuredClone(v);
    });
  }
  async repurpose(tid: string, id: string): Promise<Job> {
    const s=await this.store.read(tid), c=findCampaign(s,id);
    checkSourceRights(c);
    if (!this.clips.configured) throw new MediaError('VIZARD_API_KEY is not configured',503);
    const job=await this.store.update(tid,(d)=>{
      const campaign=findCampaign(d,id);
      const active=campaign.jobs.filter((j)=>j.kind==='clip' && ['queued','processing'].includes(j.status));
      if(active.length) throw new MediaError('A clipping job is already running',409);
      const j: Job={id:newId(),campaignId:id,variantId:null,kind:'clip',provider:'vizard',
        providerId:null,status:'queued',error:null,createdAt:nowIso(),updatedAt:nowIso()};
      campaign.jobs.push(j); log(d,campaign,'clipping_requested');
      return structuredClone(j);
    });
    try{
      const providerId=await this.clips.start(c.sourceUrl!,c.name);
      return this.store.update(tid,(d)=>{
        const j=findCampaign(d,id).jobs.find((x)=>x.id===job.id)!;
        j.providerId=providerId;j.status='processing';j.updatedAt=nowIso();return structuredClone(j);
      });
    }catch(e){
      await this.fail(tid,id,job.id,e);
      throw e;
    }
  }
  async render(tid: string, id: string, variantId: string): Promise<Job> {
    const s=await this.store.read(tid), c=findCampaign(s,id), v=findVariant(c,variantId);
    if(!v.timeline) throw new MediaError('Save a timeline before rendering');
    if(!this.renders.configured) throw new MediaError('SHOTSTACK_API_KEY is not configured',503);
    const job=await this.store.update(tid,(d)=>{
      const campaign=findCampaign(d,id);
      const j:Job={id:newId(),campaignId:id,variantId,kind:'render',provider:'shotstack',
        providerId:null,status:'queued',error:null,createdAt:nowIso(),updatedAt:nowIso()};
      campaign.jobs.push(j);log(d,campaign,'render_requested',variantId);return structuredClone(j);
    });
    try{
      const providerId=await this.renders.start(v.timeline);
      return this.store.update(tid,(d)=>{
        const j=findCampaign(d,id).jobs.find((x)=>x.id===job.id)!;
        j.providerId=providerId;j.status='processing';j.updatedAt=nowIso();return structuredClone(j);
      });
    }catch(e){
      await this.fail(tid,id,job.id,e);throw e;
    }
  }
  private async fail(tid:string,id:string,jobId:string,error:unknown):Promise<void>{
    await this.store.update(tid,(d)=>{
      const c=findCampaign(d,id),j=c.jobs.find((x)=>x.id===jobId);
      if(j){j.status='failed';j.error=error instanceof Error?error.message:'Provider failed';j.updatedAt=nowIso();}
      log(d,c,'job_failed',jobId);
    });
  }
  async poll(tid:string,id:string,jobId:string):Promise<Job>{
    const s=await this.store.read(tid),c=findCampaign(s,id);
    const job=c.jobs.find((j)=>j.id===jobId);
    if(!job)throw new MediaError('Job not found',404);
    if(job.status!=='processing' || !job.providerId)return job;
    try{
      if(job.kind==='clip'){
        const r=await this.clips.check(job.providerId);
        return this.store.update(tid,(d)=>{
          const cc=findCampaign(d,id), j=cc.jobs.find((x)=>x.id===jobId)!;
          if(j.status!=='processing')return structuredClone(j);
          if(r.status==='done'){
            j.status='done';
            for(const clip of r.clips){
              cc.variants.push({id:newId(),title:clip.title,script:clip.transcript,
                mediaUrl:clip.url,timeline:null,status:'draft',approvedAt:null,scheduledAt:null,
                platform:null,providerPostId:null,createdAt:nowIso(),updatedAt:nowIso()});
            }
            log(d,cc,'clipping_completed',String(r.clips.length)+' suggested clips');
          }
          j.updatedAt=nowIso();
          return structuredClone(j);
        });
      }
      const r=await this.renders.check(job.providerId);
      return this.store.update(tid,(d)=>{
        const cc=findCampaign(d,id),j=cc.jobs.find((x)=>x.id===jobId)!;
        if(j.status!=='processing')return structuredClone(j);
        if(r.status==='failed'){j.status='failed';j.error='Shotstack render failed';}
        if(r.status==='done'){
          if(!r.url)throw new MediaError('Render completed without output URL',502);
          const v=findVariant(cc,j.variantId!);
          v.mediaUrl=r.url; v.status='editing';v.approvedAt=null;v.updatedAt=nowIso();
          j.status='done'; log(d,cc,'render_completed','credits: '+String(r.credits ?? 'unknown'));
        }
        j.updatedAt=nowIso();
        return structuredClone(j);
      });
    }catch(e){await this.fail(tid,id,jobId,e);throw e;}
  }
}
