import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DbTransaction } from '../src/db/transaction.js';
import { SeoBlogCampaignQueueService, campaignQueueDateRule, campaignQueueWakeJob, type CampaignQueuePort } from '../src/seo-blog/campaign-queue.js';
import { currentCampaignRevision } from '../src/seo-blog/campaign.js';
import type { SeoCampaignQueueInput, SeoCampaignQueueInstruction, SeoCampaignQueueResult } from '../src/seo-blog/media-types.js';
import { StaleWriteError } from '../src/seo-blog/store.js';
import { campaignFixture } from './seo-blog-campaign-fixtures.js';
import { OWNER } from './seo-blog-fixtures.js';
import { SeoBlogEngine } from '../src/seo-blog/engine.js';

async function fixture() {
  const f = await campaignFixture(), v = f.article.campaign!.variants.find(v => v.network === 'linkedin')!, revision = currentCampaignRevision(v);
  const approval = { revisionId: revision.id, revisionSha256: revision.sha256, contentItemId: randomUUID(), contentVersionId: randomUUID(), contentSha256: 'd'.repeat(64), approvalRequestId: randomUUID(), approvalDecisionId: randomUUID() };
  await f.h.store.updateArticle({ ...f.article, campaign: { ...f.article.campaign!, variants: f.article.campaign!.variants.map(p => p.id === v.id ? { ...p, approval } : p) } });
  const commands = new Map<string, SeoCampaignQueueInstruction>(), jobs = new Map<string, SeoCampaignQueueResult>(); let live = false, freshEligible = true, materializeCalls = 0;
  const t = { async query(_sql: string, values: unknown[]) { await f.h.store.enqueueJob({ ...JSON.parse(String(values[7])), rowVersion: 1 }); return { rows: [], rowCount: 1 }; } } as unknown as DbTransaction;
  const port: CampaignQueuePort = {
    async recordOwnerCampaignQueue(_workspace, input, queued) {
      let saved = commands.get(input.commandId);
      if (!saved) {
        if (!freshEligible) throw Object.assign(Error('Synthetic current control changed'), { code: '55000' });
        const { commandId, ...tuple } = input; saved = { ...tuple, queueIntentId: commandId, authorizingUserId: OWNER.userId, supersedesQueueIntentId: null }; commands.set(commandId, saved);
      }
      await queued(t, saved); return saved;
    },
    cancelOwnerCampaignQueue: async () => undefined,
    async materializeCampaignQueue(_workspace, id) {
      materializeCalls++; const previous = jobs.get(id); if (previous) return previous;
      if (!live) return { kind: 'held', reason: 'parent_unpublished' };
      const instruction = commands.get(id)!;
      const result: SeoCampaignQueueResult = { kind: 'materialized', queueIntentId: id, intentId: id, jobId: randomUUID(), contentVersionId: instruction.contentVersionId, bindingId: instruction.bindingId,
        authorizingUserId: OWNER.userId, executingActor: 'worker', scheduledFor: '2026-11-03T11:00:00.000Z', anchorPublicationId: randomUUID(), anchorVerifiedAt: '2026-11-03T10:00:00.000Z', anchorKind: 'first_verified', timezone: 'Europe/London', dailyCap: 5, monthlyCap: 10 };
      jobs.set(id, result); return result;
    },
    async listCampaignQueueWorkspaces() { return live && !(await f.h.store.getBrand(f.brand.id))!.settings.pauseAll ? [f.brand.id] : []; },
    async listPendingCampaignQueues() { return [...commands.keys()].filter(id => !jobs.has(id)); },
  };
  const input = { versionId: f.version.id, variantId: v.id, revisionId: revision.id, commandId: randomUUID(), bindingId: randomUUID(), dateRule: { kind: 'relative_verified', days: 0, afterMinutes: 60, timezone: f.brand.timezone } };
  return { ...f, input, commands, jobs, port, service: new SeoBlogCampaignQueueService(f.h.store, port, f.h.clock.now),
    setLive: () => { live = true; }, revokeFresh: () => { freshEligible = false; }, calls: () => materializeCalls };
}
test('owner instruction plus existing publish wake is durable before native display save; exact replay recovers after later controls without a second job', async () => {
  const f = await fixture(), normal = f.h.store.updateArticle.bind(f.h.store); let fail = true;
  f.h.store.updateArticle = async article => { if (fail) { fail = false; throw new StaleWriteError('synthetic lost native save'); } return normal(article); };
  const initiallyCommitted = await f.service.request(OWNER.userId, f.brand.id, f.article.id, f.input);
  assert.equal(initiallyCommitted.queueIntentId, f.input.commandId);
  assert.equal(f.commands.size, 1); assert.equal(f.jobs.size, 0); assert.equal((await f.h.store.listJobs(f.brand.id)).length, 1);
  const brand = (await f.h.store.getBrand(f.brand.id))!; await f.h.store.updateBrand({ ...brand, timezone: 'America/New_York' }); f.revokeFresh();
  const recovered = await f.service.request(OWNER.userId, f.brand.id, f.article.id, f.input);
  assert.equal(recovered.queueIntentId, f.input.commandId); assert.equal(f.commands.size, 1); assert.equal((await f.h.store.listJobs(f.brand.id)).length, 1);
  assert.equal(recovered.dateRule.timezone, f.brand.timezone, 'receipt keeps captured date rule rather than today’s timezone');
});
test('draft and paused discovery does no materialization; unpause finds exact live instruction and recovers the one canonical result', async () => {
  const f = await fixture(); await f.service.request(OWNER.userId, f.brand.id, f.article.id, f.input);
  const [claim] = await f.h.store.claimJobs({ now: f.h.clock.now(), owner: 'queue-proof', leaseMs: 60000, limit: 1 });
  const held = await f.service.run(claim!); assert.equal(held.state, 'blocked'); assert.equal(f.jobs.size, 0);
  const calls = f.calls(); await f.service.recover(); assert.equal(f.calls(), calls);
  f.setLive(); let brand = (await f.h.store.getBrand(f.brand.id))!; await f.h.store.updateBrand({ ...brand, settings: { ...brand.settings, pauseAll: true } });
  await f.service.recover(); assert.equal(f.calls(), calls);
  brand = (await f.h.store.getBrand(f.brand.id))!; await f.h.store.updateBrand({ ...brand, settings: { ...brand.settings, pauseAll: false } });
  assert.equal(await f.service.recover(), 1); assert.equal(f.jobs.size, 1);
  const wake = await f.h.store.getJob(f.brand.id, campaignQueueWakeJob(f.brand.id, f.input.commandId, 'instruction', f.h.clock.now()).id);
  assert.equal(wake!.state, 'done'); assert.equal((wake!.payload.campaignQueueResult as SeoCampaignQueueResult).kind, 'materialized');
  await f.service.recover(); assert.equal(f.jobs.size, 1); assert.equal(f.h.site.posts, 0); assert.equal(f.h.llm.calls.length, 0);
});
test('only exact missing-target diagnosis bootstraps via the genuine owner port, after receipt lookup and before same-command retry', async () => {
  const f = await fixture(); let first = true, prepared = 0;
  const original = f.port.recordOwnerCampaignQueue.bind(f.port);
  const port = { ...f.port, async recordOwnerCampaignQueue(workspace: string, input: SeoCampaignQueueInput, queued: Parameters<CampaignQueuePort['recordOwnerCampaignQueue']>[2]) {
    if (first) { first = false; throw Object.assign(Error('seo.campaign_planner_target_missing'), { code: 'P0136' }); }
    return original(workspace, input, queued);
  } };
  const service = new SeoBlogCampaignQueueService(f.h.store, port, f.h.clock.now, undefined, async (brand, binding) => { prepared++; assert.equal(brand, f.brand.id); assert.equal(binding, f.input.bindingId); });
  await service.request(OWNER.userId, f.brand.id, f.article.id, f.input); assert.equal(prepared, 1);
  f.revokeFresh(); await service.request(OWNER.userId, f.brand.id, f.article.id, f.input); assert.equal(prepared, 1, 'known receipt never bootstraps under changed controls');
  await assert.rejects(service.request(OWNER.userId, f.brand.id, f.article.id, { ...f.input, commandId: randomUUID() }), { status: 409 }); assert.equal(prepared, 1);
});
test('date rule syntax cannot silently lower delay, change recipe days, inject extra controls or accept an invalid timezone', () => {
  const good = { kind: 'relative_verified', days: 3, afterMinutes: 60, timezone: 'Europe/London' };
  assert.deepEqual(campaignQueueDateRule(good), good);
  for (const value of [{ ...good, afterMinutes: 5 }, { ...good, days: 2 }, { ...good, extra: true }, { ...good, timezone: 'Invalid/Zone' }]) assert.throws(() => campaignQueueDateRule(value));
  assert.throws(() => campaignQueueDateRule({ kind: 'pinned', atUtc: '2026-11-03', timezone: 'UTC' }));
});

test('one brand cap or serialization hold cannot suppress another brand recovery or existing social proof checks',async()=>{
  for(const code of ['55000','40001']){
    const f=await fixture(),second=(await f.h.engine.createBrand(OWNER,{commandId:randomUUID(),name:'Second brand'})).brand,firstId=randomUUID(),secondId=randomUUID(),visited:string[]=[];
    let attestations=0;
    const port:CampaignQueuePort={...f.port,listCampaignQueueWorkspaces:async()=>[f.brand.id,second.id],listPendingCampaignQueues:async ws=>[ws===f.brand.id?firstId:secondId],async materializeCampaignQueue(ws){visited.push(ws);if(ws===f.brand.id)throw Object.assign(Error('Synthetic private cap detail'),{code});return {kind:'held',reason:'parent_changed'};}};
    await f.h.store.enqueueJob({...campaignQueueWakeJob(f.brand.id,firstId,'instruction',f.h.clock.now()),state:'blocked'});
    const queue=new SeoBlogCampaignQueueService(f.h.store,port,f.h.clock.now);
    f.h.store.socialAttestationBrandIds=async()=>[f.brand.id,second.id];f.h.store.attestDuePromotions=async()=>{attestations++;return [];};
    const engine=new SeoBlogEngine({store:f.h.store,llm:null,search:f.h.search,transport:f.h.web,publishers:new Map(),vault:f.h.vault,now:f.h.clock.now,campaignQueue:queue});
    await engine.tick('recovery-isolation');assert.deepEqual(visited,[f.brand.id,second.id]);assert.equal(attestations,2);
    const wake=(await f.h.store.getJob(f.brand.id,campaignQueueWakeJob(f.brand.id,firstId,'instruction',f.h.clock.now()).id))!;
    assert.equal(wake.state,'blocked');assert.equal((wake.payload.campaignQueueResult as SeoCampaignQueueResult).kind,'held');assert.doesNotMatch(wake.error!,/private cap/);
    assert.equal(f.jobs.size,0);assert.equal(f.h.site.posts,0);
  }
});

test('unexpected recovery authority failure remains a sanitized failure after independent social proof checks',async()=>{
  const f=await fixture();let attestations=0;
  const queue=new SeoBlogCampaignQueueService(f.h.store,{...f.port,listCampaignQueueWorkspaces:async()=>[f.brand.id],listPendingCampaignQueues:async()=>[randomUUID()],materializeCampaignQueue:async()=>{throw Object.assign(Error('PRIVATE_ACL_DETAIL'),{code:'42501'});}},f.h.clock.now);
  await assert.rejects(queue.recover(),error=>(error as {code?:string}).code==='campaign_recovery_authority'&&!String(error).includes('PRIVATE_ACL_DETAIL'));
  f.h.store.socialAttestationBrandIds=async()=>[f.brand.id];f.h.store.attestDuePromotions=async()=>{attestations++;return [];};
  const engine=new SeoBlogEngine({store:f.h.store,llm:null,search:f.h.search,transport:f.h.web,publishers:new Map(),vault:f.h.vault,now:f.h.clock.now,campaignQueue:queue});
  await assert.rejects(engine.tick('recovery-ACL'),error=>(error as {code?:string}).code==='campaign_recovery_failed'&&!String(error).includes('PRIVATE_ACL_DETAIL'));
  assert.equal(attestations,1);assert.equal(f.jobs.size,0);
});

test('immediate campaign wakeup holds expected conflicts and exposes unexpected failures without suppressing independent JIT',async()=>{
  for(const code of ['55000','40001','42501','XX999']){
    const f=await fixture();await f.service.request(OWNER.userId,f.brand.id,f.article.id,f.input);let attestations=0;
    const queue=new SeoBlogCampaignQueueService(f.h.store,{...f.port,materializeCampaignQueue:async()=>{throw Object.assign(Error('PRIVATE_IMMEDIATE_FAILURE'),{code});}},f.h.clock.now);
    f.h.store.socialAttestationBrandIds=async()=>[f.brand.id];f.h.store.attestDuePromotions=async()=>{attestations++;return [];};
    const engine=new SeoBlogEngine({store:f.h.store,llm:null,search:f.h.search,transport:f.h.web,publishers:new Map(),vault:f.h.vault,now:f.h.clock.now,campaignQueue:queue});
    await engine.tick('immediate-wakeup');assert.equal(attestations,1);
    const wake=(await f.h.store.listJobs(f.brand.id)).find(j=>j.payload.campaignQueue===f.input.commandId)!;
    assert.equal(wake.state,'blocked');assert.doesNotMatch(wake.error!,/PRIVATE_IMMEDIATE_FAILURE/);
    if(code==='55000'||code==='40001')assert.equal((wake.payload.campaignQueueResult as SeoCampaignQueueResult).kind,'held');
    else {assert.equal(wake.payload.campaignQueueResult,undefined);assert.match(wake.progress,/could not confirm/);assert.ok((await f.h.store.listActivity(f.brand.id,20)).some(e=>e.kind==='campaign.recovery.failed'));}
    assert.equal(f.jobs.size,0);assert.equal(f.commands.size,1);
  }
});
