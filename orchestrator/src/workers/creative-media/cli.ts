/**
 * Default-off supervised offline service and diagnostic commands.
 * Usage:
 *   npm --prefix orchestrator run media:worker -- serve
 *   npm --prefix orchestrator run media:worker -- probe <workspace-uuid> <source-uuid>
 *   npm --prefix orchestrator run media:worker -- probe-output <workspace-uuid> <output-uuid>
 *   npm --prefix orchestrator run media:worker -- render-local <workspace-uuid> <job-uuid>
 *   npm --prefix orchestrator run media:worker -- submit <workspace-uuid> <job-uuid>
 *   npm --prefix orchestrator run media:worker -- reconcile <workspace-uuid> <job-uuid>
 * Default OFF. Service discovers bounded workspace UUID batches and enters each
 * tenant scope. It polls offline work and cleanup; never retries paid calls.
 */
import '../../config.js';
import {runMediaService,PgMediaServiceDiscovery} from './service.js';
import {PgMediaRetentionWorker} from '../../creative-studio/media-retention.js';
import {PrivateMediaFiles} from '../../creative-studio/media-private-files.js';
import {PgPrivateObjectProbeWorker,PgPrivateObjectCleanupWorker} from '../../creative-studio/media-object-sources.js';
import {renderLocalVideoFile} from '../../creative-studio/media-local-render.js';
import { randomUUID } from 'node:crypto';
import { createWorkerDatabasePool } from '../../db/pool.js';
import { PgVideoSourceProbeWorker } from '../../creative-studio/media-source-probe.js';
import { PgMediaOutputProbeWorker } from '../../creative-studio/media-output-review.js';
import { PgLocalRenderWorker,runQueuedLocalRender,renderLocalVideo } from '../../creative-studio/media-local-render-pg-store.js';
import { PgVideoAdmissionWorker } from '../../creative-studio/media-admission-pg-store.js';
import { submitApprovedMediaJob } from '../../creative-studio/media-work-executor.js';
import { VizardVideoProvider, ShotstackVideoProvider } from '../../creative-studio/media-providers.js';
import { PgMediaVideoOutputWorker,downloadProviderVideo } from '../../creative-studio/media-video-output-pg-store.js';
import { reconcileMediaJob } from '../../creative-studio/media-reconciler.js';
import {PgOfflineMediaDiscovery,runOfflineMediaTick} from '../../creative-studio/media-worker-dispatch.js';
import { workerCommandGate } from './worker-gate.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
async function main():Promise<void>{
  const [action,workspaceId,id]=process.argv.slice(2);
  workerCommandGate(process.env,action??'');
  if(action!=='serve'&&(!UUID.test(workspaceId??'')||(!['tick','cleanup-objects'].includes(action??'')&&!UUID.test(id??''))))
    throw new Error('Exactly one workspace UUID and source/job UUID required.');
  const pool=createWorkerDatabasePool(process.env);
  try{
    const requestId='rl72-media-worker-'+randomUUID();
    const files=process.env.RL72_MEDIA_PRIVATE_FILES_ENABLED==='true'?new PrivateMediaFiles(process.env.RL72_MEDIA_PRIVATE_FILES_ROOT??''):null;
    const probeSource=async(ws:string,record:string)=>{
      const object=files?await new PgPrivateObjectProbeWorker(pool,requestId,files).run(ws,record):null;
      return object??new PgVideoSourceProbeWorker(pool,requestId).run(ws,record);
    };
    const objectRenderer=files?((object:import('../../creative-studio/media-private-files.js').PrivateMediaObject,probe:import('../../creative-studio/media-source-probe.js').VideoProbe,plan:import('../../creative-studio/media-edit-plan.js').VideoEditPlan)=>renderLocalVideoFile(files,object,probe,plan)):undefined;
    if(action==='serve'){
      const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
      const discovery=new PgMediaServiceDiscovery(pool,requestId);
      try{await runMediaService({workspaces:after=>discovery.workspaces(after),clickRetention:()=>discovery.clickRetention(),
       cleanup:async ws=>{await new PgMediaRetentionWorker(pool,requestId,files).sweep(ws);if(files)await new PgPrivateObjectCleanupWorker(pool,requestId,files).sweep(ws,10);},
       tick:ws=>runOfflineMediaTick(ws,{pending:(w,n)=>new PgOfflineMediaDiscovery(pool,requestId).pending(w,n),probe:probeSource,probeOutput:(w,id)=>new PgMediaOutputProbeWorker(pool,requestId).probe(w,id),render:(w,id)=>runQueuedLocalRender(w,id,{ledger:new PgLocalRenderWorker(pool,requestId),renderer:renderLocalVideo,objectRenderer})},{limit:1,signal:controller.signal}),
       onError:()=>console.error('Offline media batch held; retrying after bounded delay')},{signal:controller.signal});}
      finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}return;
    }
    if(action==='cleanup-objects'){if(!files)throw new Error('Private object storage unavailable');console.log('private object cleanup:',await new PgPrivateObjectCleanupWorker(pool,requestId,files).sweep(workspaceId!));return;}
    if(action==='tick'){
      const receipts=await runOfflineMediaTick(workspaceId!,{
        pending:(ws,n)=>new PgOfflineMediaDiscovery(pool,requestId).pending(ws,n),
        probe:(ws,record)=>probeSource(ws,record),
        probeOutput:(ws,record)=>new PgMediaOutputProbeWorker(pool,requestId).probe(ws,record),
        render:(ws,record)=>runQueuedLocalRender(ws,record,{ledger:new PgLocalRenderWorker(pool,requestId),renderer:renderLocalVideo,objectRenderer}),
      });console.log('offline media batch:',receipts);return;
    }
    if(action==='probe'){
      const result=await probeSource(workspaceId!,id!);
      console.log('private video technical probe:',result.status,result.replayed?'already recorded':'new receipt');
      return;
    }
    if(action==='probe-output'){
      const result=await new PgMediaOutputProbeWorker(pool,requestId).probe(workspaceId!,id!);
      console.log('private provider output technical probe:',result.status,
        result.replayed?'existing receipt':'new receipt');
      return;
    }
    if(action==='render-local'){
      const result=await runQueuedLocalRender(workspaceId!,id!,{
        ledger:new PgLocalRenderWorker(pool,requestId),
        renderer:renderLocalVideo,objectRenderer,
      });
      console.log('private native offline render:',result.state,'job:',result.jobId);
      return;
    }
    const vizard=new VizardVideoProvider(process.env.RL72_MEDIA_VIZARD_API_KEY??'',
      process.env.RL72_MEDIA_PROVIDER_SUBMISSIONS_ALLOWED==='true'||process.env.RL72_MEDIA_PROVIDER_READS_ALLOWED==='true');
    const shotstackEnv=process.env.RL72_MEDIA_SHOTSTACK_ENV==='v1'?'v1':'stage';
    const shotstack=new ShotstackVideoProvider(process.env.RL72_MEDIA_SHOTSTACK_API_KEY??'',
      process.env.RL72_MEDIA_PROVIDER_SUBMISSIONS_ALLOWED==='true'||process.env.RL72_MEDIA_PROVIDER_READS_ALLOWED==='true',
      shotstackEnv);
    const store=new PgMediaVideoOutputWorker(pool,requestId);
    if(action==='submit'){
      const result=await submitApprovedMediaJob(workspaceId!,id!,{
        ledger:new PgVideoAdmissionWorker(pool,requestId),vizard,shotstack});
      console.log('video submission:',result.state,'job:',result.jobId);
      return;
    }
    const result=await reconcileMediaJob(workspaceId!,id!,{
      pending:(ws,job)=>store.pending(ws,job),
      inspectVizard:(providerId)=>vizard.inspect(providerId),
      inspectShotstack:(providerId)=>shotstack.inspect(providerId),
      download:(url)=>downloadProviderVideo(url),
      capture:(input)=>store.capture(input),
    });
    console.log('read-only video reconciliation:',result.state,'assets:',result.assets,
      'provider credit receipt:',result.providerCredits??'unknown');
  }finally{await pool.end();}
}
main().catch(error=>{
  // No raw provider error, URL or credentials are logged.
  console.error('creative media worker stopped:',(error as Error).name);
  process.exitCode=1;
});
