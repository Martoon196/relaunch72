/** Durable owner instructions feed the existing canonical social scheduler only after verification. */
import { createHash } from 'node:crypto';
import type { DbTransaction } from '../db/transaction.js';
import type { SeoCampaignQueueDateRule, SeoCampaignQueueInput, SeoCampaignQueueInstruction, SeoCampaignQueueResult } from './media-types.js';
import type { SeoBlogStore } from './store.js';
import { SeoBlogError, type Job } from './types.js';
import { isValidTimeZone } from './schedule.js';

export interface CampaignQueuePointer {
  readonly instruction: SeoCampaignQueueInstruction;
  readonly result?: SeoCampaignQueueResult;
  readonly cancelled?: boolean;
}
export interface CampaignQueuePort {
  recordOwnerCampaignQueue(workspace: string, input: SeoCampaignQueueInput, onQueued: (t: DbTransaction, instruction: SeoCampaignQueueInstruction) => Promise<void>): Promise<SeoCampaignQueueInstruction>;
  cancelOwnerCampaignQueue(workspace: string, input: { queueIntentId: string; commandId: string }): Promise<unknown>;
  materializeCampaignQueue(workspace: string, queueId: string): Promise<SeoCampaignQueueResult>;
  listCampaignQueueWorkspaces(options?: { afterId?: string; limit?: number }): Promise<readonly string[]>;
  listPendingCampaignQueues(workspace: string, options?: { afterId?: string; limit?: number }): Promise<readonly string[]>;
}
export interface CampaignRecoveryCursor { brand: string | null; readonly queues: Map<string, string | null> }
function ownerQueueFailure(error: unknown): never {
  if (error instanceof SeoBlogError) throw error;
  const code = (error as {code?:string}).code;
  if (code === '42501') throw new SeoBlogError(403, 'Your current owner session or brand delivery authority could not be confirmed.');
  if (code === '22023') throw new SeoBlogError(400, 'Review the exact post, date rule and connected account before authorizing delivery.');
  if (code === '55000') throw new SeoBlogError(409, 'This delivery instruction is held. Check the current post/image approval, blog target, date, pause and connected account limits.');
  if (code === '40001' || code === '23505') throw new SeoBlogError(409, 'Another exact instruction or slot changed. Recover the saved instruction before authorizing a new one.');
  throw error;
}
function materializationFailure(error:unknown):SeoCampaignQueueResult {
  const code=(error as {code?:string}).code;
  if(code==='55000'||code==='40001')return {kind:'held',reason:code==='40001'?'concurrent_change':'current_controls_held'};
  throw new SeoBlogError(503,code==='42501'?'Campaign recovery could not confirm its database authority. No successful materialization is claimed.':'Campaign recovery is temporarily unavailable. Saved instructions and receipt identities are retained.',code==='42501'?'campaign_recovery_authority':'campaign_recovery_failed');
}
export function campaignQueueWakeJob(brandId: string, queueId: string, event: string, now: string): Job {
  const key = `campaign-queue:${queueId}:${event}`, sha = createHash('sha256').update(`${brandId}:${key}`).digest('hex');
  const id = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-5${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
  return { id, brandId, kind: 'publish', idempotencyKey: key, payload: { campaignQueue: queueId }, state: 'queued',
    attempts: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, runAfter: now, createdAt: now, updatedAt: now,
    progress: 'Campaign delivery instruction queued for eligibility checks.', error: null, rowVersion: 1 };
}
export async function persistCampaignQueueWake(t: DbTransaction, brandId: string, queueId: string, event: string, now: string): Promise<void> {
  const job = campaignQueueWakeJob(brandId, queueId, event, now), { rowVersion: _version, ...data } = job;
  await t.query(`INSERT INTO app.seo_blog_jobs(workspace_id,id,kind,idempotency_key,state,run_after,lease_expires_at,data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
    [brandId, job.id, job.kind, job.idempotencyKey, job.state, job.runAfter, null, JSON.stringify(data)]);
}
export function campaignQueueDateRule(value: unknown): SeoCampaignQueueDateRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SeoBlogError(400, 'Review a supported campaign date rule.');
  const rule = value as Record<string, unknown>;
  if (typeof rule.timezone !== 'string' || !isValidTimeZone(rule.timezone)) throw new SeoBlogError(400, 'Review a valid captured campaign timezone.');
  const timezone = rule.timezone;
  if (rule.kind === 'relative_verified' && Object.keys(rule).length === 4 && (rule.days === 0 || rule.days === 3 || rule.days === 7) && rule.afterMinutes === 60) return { kind: rule.kind, days: rule.days, afterMinutes: 60, timezone };
  if (rule.kind === 'pinned' && Object.keys(rule).length === 3 && typeof rule.atUtc === 'string' && Number.isFinite(Date.parse(rule.atUtc)) && new Date(rule.atUtc).toISOString() === rule.atUtc) return { kind: rule.kind, atUtc: rule.atUtc, timezone };
  throw new SeoBlogError(400, 'Review a supported exact or relative campaign date.');
}
export class SeoBlogCampaignQueueService {
  constructor(private readonly store: SeoBlogStore, private readonly port: CampaignQueuePort, private readonly now: () => string,
    private readonly recovery: CampaignRecoveryCursor = { brand: null, queues: new Map() },
    private readonly prepareTarget?: (brandId: string, bindingId: string) => Promise<void>) {}
  /** Existing worker-cycle safety net, not another scheduler. SQL lists only current live/unpaused pending instructions. */
  async recover(): Promise<number> {
    const brands = await this.port.listCampaignQueueWorkspaces({ ...(this.recovery.brand ? { afterId: this.recovery.brand } : {}), limit: 6 });
    this.recovery.brand = brands.length === 6 ? brands.at(-1)! : null;
    let materialized = 0;
    for (const brand of brands) {
      const after = this.recovery.queues.get(brand);
      const pending = await this.port.listPendingCampaignQueues(brand, { ...(after ? { afterId: after } : {}), limit: 6 });
      if (pending.length === 6) this.recovery.queues.set(brand, pending.at(-1)!); else this.recovery.queues.delete(brand);
      for (const id of pending) {
        let result:SeoCampaignQueueResult;
        try { result=await this.port.materializeCampaignQueue(brand,id); }
        catch(error){result=materializationFailure(error);}
        if (result.kind === 'materialized') materialized++;
        // Reflect a committed receipt in its deterministic native wakeup when it is not leased.
        // A concurrent claim/CAS loss never changes the receipt or creates another operation.
        const wake = await this.store.getJob(brand, campaignQueueWakeJob(brand, id, 'instruction', this.now()).id);
        if (wake && wake.state !== 'running' && wake.state !== 'cancelled') {
          try { await this.store.updateJob({ ...wake, state: result.kind === 'materialized' ? 'done' : 'blocked',
            payload: { ...wake.payload, campaignQueueResult: result }, progress: result.kind === 'materialized' ? 'Exact approved post entered the connected social calendar.' : 'Delivery instruction is held by current controls or a concurrent change. Its exact identity is retained.',
            error: result.kind === 'materialized' ? null : 'No new delivery was admitted. Review account limits, current approvals and programme controls.', updatedAt: this.now() }); } catch (error) { if (!(error instanceof SeoBlogError && error.status === 409)) throw error; }
        }
      }
    }
    return materialized;
  }
  async request(actorId: string, brandId: string, articleId: string, input: { versionId: string; variantId: string; revisionId: string; commandId: string; bindingId: string; dateRule: unknown }): Promise<SeoCampaignQueueInstruction> {
    if (!await this.store.canManage(actorId, brandId)) throw new SeoBlogError(403, 'You cannot manage this brand.');
    const brand = await this.store.getBrand(brandId), article = await this.store.getArticle(brandId, articleId), version = await this.store.getVersion(brandId, input.versionId);
    if (!brand || !article || !version || version.articleId !== articleId || !article.campaign) throw new SeoBlogError(404, 'That campaign was not found.');
    const variant = article.campaign.variants.find(v => v.id === input.variantId), revision = variant?.revisions.find(r => r.id === input.revisionId);
    if (!variant || !revision || revision.articleVersionId !== version.id || revision.articleContentSha !== version.contentSha) throw new SeoBlogError(409, 'The exact reviewed campaign revision was not found.');
    const approval = [variant.approval, ...(variant.approvalHistory ?? [])].find(a => a?.revisionId === revision.id && a.revisionSha256 === revision.sha256);
    if (!approval) throw new SeoBlogError(409, 'Approve the exact post before recording a delivery instruction.');
    // Old exact tuple can reach the receipt-first SQL command after later edits.
    // A NEW stale command still fails the locked current-source admission there.
    const command: SeoCampaignQueueInput = { commandId: input.commandId, articleId, articleVersionId: version.id,
      articleContentSha: version.contentSha, variantId: variant.id, variantRevisionId: revision.id, variantSha256: revision.sha256,
      contentVersionId: approval.contentVersionId, bindingId: input.bindingId, dateRule: campaignQueueDateRule(input.dateRule) };
    const onQueued = (t: DbTransaction, saved: SeoCampaignQueueInstruction) => persistCampaignQueueWake(t, brandId, saved.queueIntentId, 'instruction', this.now());
    let instruction: SeoCampaignQueueInstruction;
    try {
      try { instruction = await this.port.recordOwnerCampaignQueue(brandId, command, onQueued); }
      catch (error) {
        const db = error as { code?: string; message?: string };
        if (!this.prepareTarget || db.code !== 'P0136' || db.message !== 'seo.campaign_planner_target_missing') throw error;
        // This narrow setup path is reached only after the receipt-first command found no commit.
        await this.prepareTarget(brandId, input.bindingId);
        instruction = await this.port.recordOwnerCampaignQueue(brandId, command, onQueued);
      }
    } catch (error) { ownerQueueFailure(error); }
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.store.getArticle(brandId, articleId);
      if (!current?.campaign) break;
      const pointers = current.campaign.queueInstructions ?? [];
      if (pointers.some(p => p.instruction.queueIntentId === instruction.queueIntentId)) break;
      if (pointers.length >= 128) break; // Display history cannot revoke a committed genuine instruction.
      try { await this.store.updateArticle({ ...current, campaign: { ...current.campaign, queueInstructions: [...pointers, { instruction }] } }); break; }
      catch (error) { if (!(error instanceof SeoBlogError && error.status === 409)) throw error; }
    }
    return instruction;
  }
  async cancel(actorId: string, brandId: string, articleId: string, queueId: string, commandId: string): Promise<void> {
    if (!await this.store.canManage(actorId, brandId)) throw new SeoBlogError(403, 'You cannot manage this brand.');
    // SQL derives the actual instruction's brand/owner/target; the native pointer is not authority.
    try { await this.port.cancelOwnerCampaignQueue(brandId, { queueIntentId: queueId, commandId }); }
    catch (error) { ownerQueueFailure(error); }
    const article = await this.store.getArticle(brandId, articleId);
    if (article?.campaign) await this.store.updateArticle({ ...article, campaign: { ...article.campaign,
      queueInstructions: (article.campaign.queueInstructions ?? []).map(p => p.instruction.queueIntentId === queueId ? { ...p, cancelled: true } : p) } });
  }
  async run(job: Job): Promise<Job> {
    const queueId = job.payload.campaignQueue;
    const current = await this.store.getJob(job.brandId, job.id);
    if (!current || current.state !== 'running' || current.leaseOwner !== job.leaseOwner || current.attempts !== job.attempts) return current ?? job;
    if (job.kind !== 'publish' || typeof queueId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(queueId)
      || Object.keys(job.payload).some(key => key !== 'campaignQueue' && key !== 'campaignQueueResult')) return this.store.updateJob({ ...current, state: 'blocked', leaseOwner: null, leaseExpiresAt: null,
        progress: 'Unsupported campaign delivery task held.', error: 'This task is not a recognised exact campaign wakeup. No article or post was published.', updatedAt: this.now() });
    // This SQL-only capability derives the genuine immutable instruction and all current gates.
    let result:SeoCampaignQueueResult;
    try {result=await this.port.materializeCampaignQueue(job.brandId,queueId);}
    catch(error){
      try{result=materializationFailure(error);}
      catch(failure){
        const latest=await this.store.getJob(job.brandId,job.id);
        if(!latest||latest.state!=='running'||latest.leaseOwner!==job.leaseOwner||latest.attempts!==job.attempts)return latest??job;
        const detail=(failure as SeoBlogError).message;
        const blocked=await this.store.updateJob({...latest,state:'blocked',leaseOwner:null,leaseExpiresAt:null,progress:'Campaign delivery could not confirm its database outcome.',error:detail,updatedAt:this.now()});
        await this.store.recordActivity({brandId:job.brandId,at:this.now(),actor:'system',kind:'campaign.recovery.failed',message:detail,subjectId:queueId}).catch(()=>undefined);
        return blocked;
      }
    }
    const latest = await this.store.getJob(job.brandId, job.id);
    if (!latest || latest.state !== 'running' || latest.leaseOwner !== job.leaseOwner || latest.attempts !== job.attempts) return latest ?? job;
    return this.store.updateJob({ ...latest, state: result.kind === 'materialized' ? 'done' : 'blocked', leaseOwner: null, leaseExpiresAt: null,
      progress: result.kind === 'materialized' ? 'Exact approved post entered the connected social calendar.' : 'Delivery instruction is held. Review its live-blog, date, approval and account controls.',
      error: result.kind === 'materialized' ? null : 'Campaign delivery is not currently eligible. No provider call was made.',
      payload: { ...latest.payload, campaignQueueResult: result }, updatedAt: this.now() });
  }
}
