/** Bounded offline worker tick. Existing one-shot leases remain the authority. */
import type {Pool} from 'pg';
import {withTransaction} from '../db/transaction.js';
import {SeoBlogError} from '../seo-blog/types.js';
import {checkedEditId} from './media-edit-plan.js';
export type OfflineMediaWork={kind:'probe'|'render-local';id:string};
export interface MediaDispatchPorts {
 pending:(workspaceId:string,limit:number)=>Promise<OfflineMediaWork[]>;
 probe:(workspaceId:string,id:string)=>Promise<unknown>;
 render:(workspaceId:string,id:string)=>Promise<{state:string}>;
}
export async function runOfflineMediaTick(workspace:string,ports:MediaDispatchPorts,options:{env?:NodeJS.ProcessEnv;limit?:number;signal?:AbortSignal}={}){
 const env=options.env??process.env,ws=checkedEditId(workspace),limit=options.limit??3;
 if(env.CREATIVE_MEDIA!=='enabled'||env.RL72_MEDIA_WORKER_ENABLED!=='true'||env.RL72_MEDIA_LOCAL_RENDER_ENABLED!=='true'||env.RL72_MEDIA_DISPATCH_ENABLED!=='true')throw new SeoBlogError(503,'Offline media dispatch disabled');
 if(!Number.isInteger(limit)||limit<1||limit>10)throw new SeoBlogError(400,'Worker batch must contain one to ten items');
 if(options.signal?.aborted)return [];
 const jobs=await ports.pending(ws,limit);
 if(jobs.length>limit)throw new SeoBlogError(409,'Worker discovery exceeded its batch bound');
 // Validate the complete batch before starting any work. Never interpret a new kind as a provider submit.
 for(const job of jobs){checkedEditId(job.id);if(!['probe','render-local'].includes(job.kind))throw new SeoBlogError(409,'Unknown offline work kind');}
 const receipts:Array<{id:string;kind:OfflineMediaWork['kind'];state:'completed'|'held'|'reconciliation_required'}>=[];
 const seen=new Set<string>();
 for(const job of jobs){
  if(options.signal?.aborted)break;
  const key=job.kind+':'+job.id;if(seen.has(key))continue;seen.add(key);
  try{
   let result:unknown;
   if(job.kind==='probe')result=await ports.probe(ws,job.id);
   else result=await ports.render(ws,job.id);
   const state=(result as {state?:string}|null)?.state;
   receipts.push({id:job.id,kind:job.kind,state:state==='reconciliation_required'?'reconciliation_required':state==='failed'?'held':'completed'});
  }catch{receipts.push({id:job.id,kind:job.kind,state:'held'});}
 }
 return receipts;
}
export class PgOfflineMediaDiscovery {
 constructor(private readonly pool:Pick<Pool,'connect'>,private readonly requestId:string){}
 pending(workspaceId:string,limit:number):Promise<OfflineMediaWork[]>{
  const ws=checkedEditId(workspaceId);
  if(!Number.isInteger(limit)||limit<1||limit>10)throw new SeoBlogError(400,'Bounded worker batch required');
  return withTransaction(this.pool,{actorKind:'worker',workspaceId:ws,requestId:this.requestId},async t=>(await t.query<OfflineMediaWork>('SELECT * FROM app_private.creative_media_work_pending($1,$2)',[ws,limit])).rows);
 }
}
