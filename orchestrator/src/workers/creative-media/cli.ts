/**
 * Explicit CLI for the ONE canonical Creative Studio, no second data store.
 * Usage:
 *   npm --prefix orchestrator run media:worker -- probe <workspace-uuid> <source-uuid>
 *   npm --prefix orchestrator run media:worker -- probe-output <workspace-uuid> <output-uuid>
 *   npm --prefix orchestrator run media:worker -- submit <workspace-uuid> <job-uuid>
 *   npm --prefix orchestrator run media:worker -- reconcile <workspace-uuid> <job-uuid>
 * Default OFF. Every invocation is scoped to one workspace and one job.
 * Does not loop, auto-publish, create customer charges or auto-retry paid calls.
 */
import '../../config.js';
import { randomUUID } from 'node:crypto';
import { createWorkerDatabasePool } from '../../db/pool.js';
import { PgVideoSourceProbeWorker } from '../../creative-studio/media-source-probe.js';
import { PgMediaOutputProbeWorker } from '../../creative-studio/media-output-review.js';
import { PgVideoAdmissionWorker } from '../../creative-studio/media-admission-pg-store.js';
import { submitApprovedMediaJob } from '../../creative-studio/media-work-executor.js';
import { VizardVideoProvider, ShotstackVideoProvider } from '../../creative-studio/media-providers.js';
import { PgMediaVideoOutputWorker,downloadProviderVideo } from '../../creative-studio/media-video-output-pg-store.js';
import { reconcileMediaJob } from '../../creative-studio/media-reconciler.js';
import { workerCommandGate } from './worker-gate.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
async function main():Promise<void>{
  const [action,workspaceId,id]=process.argv.slice(2);
  workerCommandGate(process.env,action??'');
  if(!UUID.test(workspaceId??'')||!UUID.test(id??''))
    throw new Error('Exactly one workspace UUID and source/job UUID required.');
  const pool=createWorkerDatabasePool(process.env);
  try{
    const requestId='rl72-media-worker-'+randomUUID();
    if(action==='probe'){
      const result=await new PgVideoSourceProbeWorker(pool,requestId).run(workspaceId!,id!);
      console.log('private video technical probe:',result.status,result.replayed?'already recorded':'new receipt');
      return;
    }
    if(action==='probe-output'){
      const result=await new PgMediaOutputProbeWorker(pool,requestId).probe(workspaceId!,id!);
      console.log('private provider output technical probe:',result.status,
        result.replayed?'existing receipt':'new receipt');
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
