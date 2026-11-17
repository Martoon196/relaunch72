/**
 * Default-off supervised offline service and diagnostic commands.
 * Usage:
 *   node --import tsx orchestrator/src/workers/creative-media/cli.ts serve
 *   node --import tsx orchestrator/src/workers/creative-media/cli.ts probe <workspace-uuid> <source-uuid>
 *   node --import tsx orchestrator/src/workers/creative-media/cli.ts render-local <workspace-uuid> <job-uuid>
 * Default OFF. Service discovers bounded workspace UUID batches and enters each
 * tenant scope. It polls offline work and cleanup; never retries paid calls.
 */
import '../../config.js';
import {runMediaService,PgMediaServiceDiscovery} from './service.js';
import {PgNativeVideoJitWorker} from '../../creative-studio/media-native-calendar.js';
import {PgMediaRetentionWorker} from '../../creative-studio/media-retention.js';
import {PrivateMediaFiles} from '../../creative-studio/media-private-files.js';
import {PgPrivateObjectProbeWorker,PgPrivateObjectCleanupWorker} from '../../creative-studio/media-object-sources.js';
import {renderLocalVideoFile} from '../../creative-studio/media-local-render.js';
import { randomUUID } from 'node:crypto';
import { createWorkerDatabasePool } from '../../db/pool.js';
import { PgVideoSourceProbeWorker } from '../../creative-studio/media-source-probe.js';
import { PgLocalRenderWorker,runQueuedLocalRender,renderLocalVideo } from '../../creative-studio/media-local-render-pg-store.js';
import {PgOfflineMediaDiscovery,runOfflineMediaTick} from '../../creative-studio/media-worker-dispatch.js';
import { workerCommandGate } from './worker-gate.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
async function main():Promise<void>{
  const [action,workspaceId,id]=process.argv.slice(2);
  workerCommandGate(process.env,action??'');
  if(action!=='serve'&&(!UUID.test(workspaceId??'')||(!['tick','cleanup-objects','attest-native'].includes(action??'')&&!UUID.test(id??''))))
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
    if(action==='attest-native'){console.log('native proof observations:',await new PgNativeVideoJitWorker(pool,requestId).attest(workspaceId!));return;}
    if(action==='serve'){
      const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
      const discovery=new PgMediaServiceDiscovery(pool,requestId);
      try{await runMediaService({workspaces:after=>discovery.workspaces(after),clickRetention:async()=>{},
       cleanup:async ws=>{if(process.env.RL72_MEDIA_NATIVE_CALENDAR_ENABLED==='true')await new PgNativeVideoJitWorker(pool,requestId).attest(ws);await new PgMediaRetentionWorker(pool,requestId,files).sweep(ws);if(files)await new PgPrivateObjectCleanupWorker(pool,requestId,files).sweep(ws,10);},
       tick:ws=>runOfflineMediaTick(ws,{deferProbe:(w,id)=>new PgOfflineMediaDiscovery(pool,requestId).deferProbe(w,id),pending:(w,n)=>new PgOfflineMediaDiscovery(pool,requestId).pending(w,n),probe:probeSource,render:(w,id)=>runQueuedLocalRender(w,id,{ledger:new PgLocalRenderWorker(pool,requestId),renderer:renderLocalVideo,objectRenderer})},{limit:1,signal:controller.signal}),
       onError:()=>console.error('Offline media batch held; retrying after bounded delay')},{signal:controller.signal});}
      finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}return;
    }
    if(action==='cleanup-objects'){if(!files)throw new Error('Private object storage unavailable');console.log('private object cleanup:',await new PgPrivateObjectCleanupWorker(pool,requestId,files).sweep(workspaceId!));return;}
    if(action==='tick'){
      const receipts=await runOfflineMediaTick(workspaceId!,{
        deferProbe:(ws,id)=>new PgOfflineMediaDiscovery(pool,requestId).deferProbe(ws,id),
        pending:(ws,n)=>new PgOfflineMediaDiscovery(pool,requestId).pending(ws,n),
        probe:(ws,record)=>probeSource(ws,record),
        render:(ws,record)=>runQueuedLocalRender(ws,record,{ledger:new PgLocalRenderWorker(pool,requestId),renderer:renderLocalVideo,objectRenderer}),
      });console.log('offline media batch:',receipts);return;
    }
    if(action==='probe'){
      const result=await probeSource(workspaceId!,id!);
      console.log('private video technical probe:',result.status,result.replayed?'already recorded':'new receipt');
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

  }finally{await pool.end();}
}
main().catch(error=>{
  // No raw provider error, URL or credentials are logged.
  console.error('creative media worker stopped:',(error as Error).name);
  process.exitCode=1;
});
